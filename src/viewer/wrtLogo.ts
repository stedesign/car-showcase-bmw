import * as THREE from 'three';
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js';

export type LogoPreset = 'idle' | 'paddock' | 'strobe';

export type WrtLogoParams = {
  enabled: boolean;
  intensity: number;
  opacity: number;
  emissiveColor: string;
  strobeEnabled: boolean;
  strobeHz: number;
  strobeDuty: number;
  strobeMin: number;
  strobeMax: number;
  scale: number;
  distance: number;
  height: number;
  /** Project a readable WRT reflection onto the floor (not a tiny mirror speck). */
  reflectionEnabled: boolean;
  /** Overall strength of the floor reflection (0–1). */
  reflectionOpacity: number;
  /** How hard the reflection fades toward the camera (0–1). */
  reflectionFade: number;
  /** How far the floor reflection stretches toward the camera (world units before logo scale). */
  reflectionLength: number;
};

export const DEFAULT_LOGO_PARAMS: WrtLogoParams = {
  enabled: true,
  intensity: 2.5,
  opacity: 0.91,
  emissiveColor: '#ffffff',
  strobeEnabled: true,
  strobeHz: 8.1,
  strobeDuty: 0.55,
  strobeMin: 1.7,
  strobeMax: 9.05,
  scale: 1.1,
  distance: 9.6,
  height: 1.35,
  reflectionEnabled: true,
  reflectionOpacity: 0.58,
  reflectionFade: 0.72,
  reflectionLength: 2.6,
};

export type WrtLogoHandle = {
  group: THREE.Group;
  params: WrtLogoParams;
  light: THREE.PointLight;
  applyParams: () => void;
  applyPreset: (preset: LogoPreset) => void;
  update: (elapsed: number) => void;
  setVisible: (visible: boolean) => void;
  bindReflector: (reflector: Reflector) => void;
};

/**
 * Fade along plane V. Geometry puts logo contact at uv.y=1 and the camera end at uv.y=0,
 * so alpha stays high at the logo and falls off toward the camera.
 */
function createFloorFadeAlphaMap(fade: number): THREE.CanvasTexture {
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(4, h);
  const t = THREE.MathUtils.clamp(fade, 0, 1);

  for (let y = 0; y < h; y++) {
    // Canvas row 0 = texture top = uv.y 1
    const uvY = 1 - y / (h - 1);
    // 0 at logo contact, 1 toward camera
    const along = 1 - uvY;
    const a = Math.round(255 * (1 - t * along * along * (3 - 2 * along)));
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = a; // MeshBasicMaterial alphaMap reads green
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export async function createWrtLogo(
  textureUrl = '/brand/wrt-logo.png',
): Promise<WrtLogoHandle> {
  const params: WrtLogoParams = { ...DEFAULT_LOGO_PARAMS };
  const group = new THREE.Group();
  group.name = 'WrtLogo';

  const map = await new THREE.TextureLoader().loadAsync(textureUrl);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  // Mirrored copy for the floor projection (reads as a reflection).
  const floorMap = map.clone();
  floorMap.colorSpace = THREE.SRGBColorSpace;
  floorMap.anisotropy = 8;
  floorMap.wrapS = THREE.ClampToEdgeWrapping;
  floorMap.wrapT = THREE.ClampToEdgeWrapping;
  floorMap.repeat.y = -1;
  floorMap.offset.y = 1;
  floorMap.needsUpdate = true;

  const image = map.image as HTMLImageElement;
  const aspect = image.width / image.height;
  const geometry = new THREE.PlaneGeometry(aspect, 1);

  // White-on-transparent mark → additive neon (storyboard Panel 8)
  const material = new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(params.emissiveColor),
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'WrtLogoMain';
  group.add(mesh);

  let fadeAlphaMap = createFloorFadeAlphaMap(params.reflectionFade);
  const floorReflectionMaterial = new THREE.MeshBasicMaterial({
    map: floorMap,
    alphaMap: fadeAlphaMap,
    color: new THREE.Color(params.emissiveColor),
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  // Flat on the ground: readable WRT stretch from the logo toward the camera.
  const floorReflection = new THREE.Mesh(geometry, floorReflectionMaterial);
  floorReflection.name = 'WrtLogoFloorReflection';
  floorReflection.rotation.x = -Math.PI / 2;
  floorReflection.renderOrder = 3;
  group.add(floorReflection);

  // Soft fill only — a strong point light creates a blown specular on the wet floor.
  const light = new THREE.PointLight(params.emissiveColor, 2.5, 16, 2.2);
  light.position.set(0, 0, 0.6);
  group.add(light);

  let lastFade = params.reflectionFade;

  const logoOpacity = (level: number, min = 0.12) =>
    THREE.MathUtils.clamp(level / 4, min, 1) *
    THREE.MathUtils.clamp(params.opacity, 0, 1);

  const syncReflectionFadeMap = () => {
    if (Math.abs(params.reflectionFade - lastFade) < 0.001) return;
    lastFade = params.reflectionFade;
    fadeAlphaMap.dispose();
    fadeAlphaMap = createFloorFadeAlphaMap(params.reflectionFade);
    floorReflectionMaterial.alphaMap = fadeAlphaMap;
    floorReflectionMaterial.needsUpdate = true;
  };

  const syncFloorReflection = (logoOp: number) => {
    const length = Math.max(0.2, params.reflectionLength);
    // Parent scale already applies params.scale; stretch only along the floor axis.
    floorReflection.scale.set(1, length, 1);
    // Sit just above concrete overlay; start at the logo plane and extend toward +Z.
    floorReflection.position.set(0, -params.height + 0.008, length * 0.5);
    floorReflection.visible = params.enabled && params.reflectionEnabled;
    floorReflectionMaterial.opacity =
      logoOp * THREE.MathUtils.clamp(params.reflectionOpacity, 0, 1);
  };

  const applyParams = () => {
    group.visible = params.enabled;
    group.scale.setScalar(params.scale);
    group.position.set(0, params.height, -params.distance);
    material.color.set(params.emissiveColor);
    floorReflectionMaterial.color.set(params.emissiveColor);
    light.color.set(params.emissiveColor);
    syncReflectionFadeMap();
    if (!params.strobeEnabled) {
      const op = logoOpacity(params.intensity, 0.2);
      material.opacity = op;
      syncFloorReflection(op);
      light.intensity = params.intensity * 0.85;
    } else {
      syncFloorReflection(material.opacity);
    }
  };

  const applyPreset = (preset: LogoPreset) => {
    if (preset === 'idle') {
      Object.assign(params, {
        strobeEnabled: false,
        intensity: 1.8,
        strobeHz: 0.5,
        strobeDuty: 0.7,
        strobeMin: 1.2,
        strobeMax: 2.2,
      });
    } else if (preset === 'paddock') {
      Object.assign(params, {
        strobeEnabled: true,
        intensity: 2.5,
        strobeHz: 1.2,
        strobeDuty: 0.55,
        strobeMin: 0.35,
        strobeMax: 4.5,
      });
    } else {
      Object.assign(params, {
        strobeEnabled: true,
        intensity: 3.5,
        strobeHz: 4.5,
        strobeDuty: 0.28,
        strobeMin: 0.05,
        strobeMax: 8,
      });
    }
    applyParams();
  };

  const update = (elapsed: number) => {
    if (!params.enabled) return;

    let level = params.intensity;
    if (params.strobeEnabled) {
      const phase = (elapsed * params.strobeHz) % 1;
      const on = phase < params.strobeDuty;
      if (params.strobeHz >= 3) {
        level = on ? params.strobeMax : params.strobeMin;
      } else {
        const wave = 0.5 + 0.5 * Math.sin(elapsed * params.strobeHz * Math.PI * 2);
        level = THREE.MathUtils.lerp(params.strobeMin, params.strobeMax, wave);
      }
    }

    const op = logoOpacity(level);
    material.opacity = op;
    syncFloorReflection(op);
    light.intensity = level * 0.85;
  };

  const bindReflector = (reflector: Reflector) => {
    const previous = reflector.onBeforeRender;
    reflector.onBeforeRender = (renderer, scene, camera, geometryArg, materialArg, groupArg) => {
      const useFloor = params.enabled && params.reflectionEnabled;
      const prevFloor = floorReflection.visible;
      const prevMain = mesh.visible;

      // Floor decal is the readable reflection — hide it and the elevated mark from the
      // mirror pass so we don't get a tiny competing speck under the logo.
      floorReflection.visible = false;
      if (useFloor) mesh.visible = false;

      previous.call(
        reflector,
        renderer,
        scene,
        camera,
        geometryArg,
        materialArg,
        groupArg,
      );

      floorReflection.visible = prevFloor;
      mesh.visible = prevMain;
    };
  };

  applyParams();

  return {
    group,
    params,
    light,
    applyParams,
    applyPreset,
    update,
    setVisible: (visible: boolean) => {
      params.enabled = visible;
      applyParams();
    },
    bindReflector,
  };
}
