import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

export type AmbientShadowQuality = 'Low' | 'Normal' | 'High';

export type AmbientShadowParams = {
  enabled: boolean;
  /** Softness of the contact shadow (maps to blur passes). */
  radius: number;
  /** Contact lift + capture height. */
  bias: number;
  tint: string;
  quality: AmbientShadowQuality;
  opacity: number;
};

export const DEFAULT_AMBIENT_SHADOW_PARAMS: AmbientShadowParams = {
  enabled: true,
  radius: 333.1,
  bias: 0.42,
  tint: '#000000',
  quality: 'Normal',
  opacity: 0.72,
};

const QUALITY_RESOLUTION: Record<AmbientShadowQuality, number> = {
  Low: 256,
  Normal: 512,
  High: 1024,
};

export type AmbientShadowsHandle = {
  group: THREE.Group;
  params: AmbientShadowParams;
  applyParams: () => void;
  setSize: (width: number, height: number) => void;
  setCenter: (x: number, z: number) => void;
  update: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    hideWhileRendering: THREE.Object3D[],
  ) => void;
  dispose: () => void;
};

function blurAmount(radius: number): number {
  return THREE.MathUtils.clamp(radius / 50, 0, 15);
}

function captureHeight(bias: number): number {
  return 0.55 + THREE.MathUtils.clamp(bias, 0, 1) * 2.2;
}

export function createAmbientShadows(
  planeSize = 14,
): AmbientShadowsHandle {
  const params: AmbientShadowParams = { ...DEFAULT_AMBIENT_SHADOW_PARAMS };

  const group = new THREE.Group();
  group.name = 'AmbientShadows';

  let resolution = QUALITY_RESOLUTION[params.quality];
  let renderTarget = makeTarget(resolution);
  let renderTargetBlur = makeTarget(resolution);

  const planeGeometry = new THREE.PlaneGeometry(planeSize, planeSize).rotateX(
    Math.PI / 2,
  );

  const planeMaterial = new THREE.MeshBasicMaterial({
    map: renderTarget.texture,
    color: new THREE.Color(params.tint),
    opacity: params.opacity,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });

  const plane = new THREE.Mesh(planeGeometry, planeMaterial);
  plane.name = 'AmbientShadowPlane';
  plane.renderOrder = 3;
  // Flip V — orthographic depth render is upside-down relative to the plane UVs
  plane.scale.y = -1;
  group.add(plane);

  const blurPlane = new THREE.Mesh(planeGeometry);
  blurPlane.visible = false;
  group.add(blurPlane);

  const shadowCamera = new THREE.OrthographicCamera(
    -planeSize / 2,
    planeSize / 2,
    planeSize / 2,
    -planeSize / 2,
    0,
    captureHeight(params.bias),
  );
  shadowCamera.rotation.x = Math.PI / 2; // look up into the car underbody
  group.add(shadowCamera);

  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.userData.darkness = { value: 1.35 };
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = depthMaterial.userData.darkness;
    shader.fragmentShader = /* glsl */ `
      uniform float darkness;
      ${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
      )}
    `;
  };
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;

  const horizontalBlurMaterial = new THREE.ShaderMaterial(HorizontalBlurShader);
  horizontalBlurMaterial.depthTest = false;
  const verticalBlurMaterial = new THREE.ShaderMaterial(VerticalBlurShader);
  verticalBlurMaterial.depthTest = false;

  const applyParams = () => {
    group.visible = params.enabled;
    planeMaterial.color.set(params.tint);
    planeMaterial.opacity = params.opacity;
    plane.position.y = 0.0015 + params.bias * 0.012;
    shadowCamera.far = captureHeight(params.bias);
    shadowCamera.updateProjectionMatrix();

    const nextRes = QUALITY_RESOLUTION[params.quality];
    if (nextRes !== resolution) {
      resolution = nextRes;
      renderTarget.dispose();
      renderTargetBlur.dispose();
      renderTarget = makeTarget(resolution);
      renderTargetBlur = makeTarget(resolution);
      planeMaterial.map = renderTarget.texture;
      planeMaterial.needsUpdate = true;
    }
  };

  const setSize = (width: number, height: number) => {
    const halfW = width / 2;
    const halfH = height / 2;
    shadowCamera.left = -halfW;
    shadowCamera.right = halfW;
    shadowCamera.top = halfH;
    shadowCamera.bottom = -halfH;
    shadowCamera.updateProjectionMatrix();

    plane.geometry.dispose();
    const geo = new THREE.PlaneGeometry(width, height).rotateX(Math.PI / 2);
    plane.geometry = geo;
    blurPlane.geometry = geo;
  };

  const setCenter = (x: number, z: number) => {
    group.position.x = x;
    group.position.z = z;
  };

  const blurShadow = (renderer: THREE.WebGLRenderer, amount: number) => {
    blurPlane.visible = true;

    blurPlane.material = horizontalBlurMaterial;
    horizontalBlurMaterial.uniforms.tDiffuse!.value = renderTarget.texture;
    horizontalBlurMaterial.uniforms.h!.value = (amount * 1) / 256;
    renderer.setRenderTarget(renderTargetBlur);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.material = verticalBlurMaterial;
    verticalBlurMaterial.uniforms.tDiffuse!.value = renderTargetBlur.texture;
    verticalBlurMaterial.uniforms.v!.value = (amount * 1) / 256;
    renderer.setRenderTarget(renderTarget);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.visible = false;
  };

  const update = (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    hideWhileRendering: THREE.Object3D[],
  ) => {
    if (!params.enabled) return;

    const initialBackground = scene.background;
    const initialOverride = scene.overrideMaterial;
    const initialClearAlpha = renderer.getClearAlpha();
    const hidden: { obj: THREE.Object3D; wasVisible: boolean }[] = [];

    group.visible = false;
    for (const obj of hideWhileRendering) {
      hidden.push({ obj, wasVisible: obj.visible });
      obj.visible = false;
    }

    scene.background = null;
    scene.overrideMaterial = depthMaterial;
    renderer.setClearAlpha(0);

    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    renderer.render(scene, shadowCamera);

    scene.overrideMaterial = initialOverride;

    const blur = blurAmount(params.radius);
    blurShadow(renderer, blur);
    // Second pass removes ringing artifacts (three.js contact-shadow example)
    blurShadow(renderer, blur * 0.4);

    renderer.setRenderTarget(null);
    renderer.setClearAlpha(initialClearAlpha);
    scene.background = initialBackground;

    for (const { obj, wasVisible } of hidden) {
      obj.visible = wasVisible;
    }
    group.visible = true;
  };

  const dispose = () => {
    renderTarget.dispose();
    renderTargetBlur.dispose();
    plane.geometry.dispose();
    planeMaterial.dispose();
    depthMaterial.dispose();
    horizontalBlurMaterial.dispose();
    verticalBlurMaterial.dispose();
  };

  applyParams();

  return {
    group,
    params,
    applyParams,
    setSize,
    setCenter,
    update,
    dispose,
  };
}

function makeTarget(resolution: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(resolution, resolution);
  target.texture.generateMipmaps = false;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  return target;
}
