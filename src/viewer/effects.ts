import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';

export type EffectsParams = {
  bloomEnabled: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  vignetteEnabled: boolean;
  vignetteDarkness: number;
  vignetteOffset: number;
  smokeEnabled: boolean;
  smokeDensity: number;
  smokeSpeed: number;
  /** Overall opacity of fog particles + sheets (0–1). */
  fogOpacity: number;
  flashEnabled: boolean;
  flashIntensity: number;
  flashDecay: number;
  fogDensity: number;
  grainEnabled: boolean;
  /** Film grain amount (0–1). */
  grainStrength: number;
};

export const DEFAULT_EFFECTS_PARAMS: EffectsParams = {
  bloomEnabled: true,
  bloomStrength: 0.42,
  bloomRadius: 0.55,
  bloomThreshold: 0.58,
  vignetteEnabled: true,
  vignetteDarkness: 1.15,
  vignetteOffset: 1.55,
  smokeEnabled: true,
  smokeDensity: 0.58,
  smokeSpeed: 0.16,
  fogOpacity: 0.62,
  flashEnabled: false,
  flashIntensity: 0,
  flashDecay: 5.8,
  fogDensity: 0.012,
  grainEnabled: true,
  grainStrength: 0.085,
};

export type EffectsHandle = {
  composer: EffectComposer;
  params: EffectsParams;
  smoke: THREE.Group;
  fogPlanes: THREE.Group;
  flashLight: THREE.PointLight;
  applyParams: () => void;
  triggerFlash: (peak?: number) => void;
  resize: (width: number, height: number) => void;
  update: (dt: number, elapsed: number) => void;
  render: () => void;
};

/** Cool charcoal-blue atmosphere — matches cinematic wet-studio refs. */
const FOG_COLOR = 0x0a1018;
const FOG_PARTICLE_COLOR = 0xa8c4e0;
const BILLBOARD_COUNT = 48;
const MIST_PARTICLE_COUNT = 120;
const FOG_BOUNDS = { x: 12, zMin: -8, zMax: 3.5, yMax: 1.35 };

type SmokeBillboard = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  baseOpacity: number;
  spin: number;
  driftPhase: number;
  baseScale: number;
  vel: number;
};

/** Subtle animated film grain (post). */
const FilmGrainShader = {
  name: 'FilmGrainShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    amount: { value: 0.08 },
    enabled: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float amount;
    uniform float enabled;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      if (enabled < 0.5 || amount < 0.001) {
        gl_FragColor = color;
        return;
      }
      float n = hash(vUv * vec2(1920.0, 1080.0) + fract(time) * 97.0);
      n = (n - 0.5) * 2.0 * amount;
      color.rgb += n;
      gl_FragColor = color;
    }
  `,
};

/** Soft, cloudy sprite — less hot-spot than smoke. */
function createFogSpriteTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base soft disc — cool mist, not warm smoke
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(0.4, 'rgba(220,235,255,0.14)');
  gradient.addColorStop(0.75, 'rgba(140,170,210,0.05)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Irregular cloudy blobs for a less "perfect disc" look
  for (let i = 0; i < 8; i++) {
    const cx = size * (0.25 + Math.random() * 0.5);
    const cy = size * (0.25 + Math.random() * 0.5);
    const r = size * (0.12 + Math.random() * 0.22);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const a = 0.06 + Math.random() * 0.1;
    g.addColorStop(0, `rgba(230,240,255,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Dense wispy smoke atlas tile — closer to classic smoke-PNG demos
 * (Nik Lever / deploy3 style) while staying cool-tinted.
 */
function createSmokeBillboardTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // Layered irregular plumes
  for (let i = 0; i < 28; i++) {
    const cx = size * (0.2 + Math.random() * 0.6);
    const cy = size * (0.2 + Math.random() * 0.6);
    const rx = size * (0.12 + Math.random() * 0.28);
    const ry = size * (0.1 + Math.random() * 0.26);
    const rot = Math.random() * Math.PI;
    const a = 0.05 + Math.random() * 0.14;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, `rgba(235,242,255,${a})`);
    g.addColorStop(0.45, `rgba(170,195,225,${a * 0.55})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Soft circular falloff so edges never hard-clip
  const edge = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.12,
    size / 2,
    size / 2,
    size * 0.48,
  );
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(0.65, 'rgba(0,0,0,0.15)');
  edge.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Wide soft alpha for ground / backdrop fog sheets. */
function createFogPlaneTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  for (let i = 0; i < 18; i++) {
    const cx = size * Math.random();
    const cy = size * (0.35 + Math.random() * 0.4);
    const rx = size * (0.18 + Math.random() * 0.35);
    const ry = size * (0.08 + Math.random() * 0.18);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    const a = 0.08 + Math.random() * 0.14;
    g.addColorStop(0, `rgba(230,240,255,${a})`);
    g.addColorStop(0.55, `rgba(120,150,190,${a * 0.35})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Soft edge falloff
  const edge = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.2,
    size / 2,
    size / 2,
    size * 0.55,
  );
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function seedFogParticle(
  positions: Float32Array,
  velocities: Float32Array,
  phases: Float32Array,
  i: number,
) {
  // Bias toward ground and behind / around the car
  const yBias = Math.random() ** 1.8;
  positions[i * 3] = (Math.random() - 0.5) * FOG_BOUNDS.x;
  positions[i * 3 + 1] = yBias * FOG_BOUNDS.yMax;
  positions[i * 3 + 2] =
    FOG_BOUNDS.zMin + Math.random() * (FOG_BOUNDS.zMax - FOG_BOUNDS.zMin);
  velocities[i] = 0.04 + Math.random() * 0.1;
  phases[i] = Math.random() * Math.PI * 2;
}

function seedBillboardPose(mesh: THREE.Mesh) {
  const yBias = Math.random() ** 1.6;
  mesh.position.set(
    (Math.random() - 0.5) * FOG_BOUNDS.x,
    0.08 + yBias * FOG_BOUNDS.yMax,
    FOG_BOUNDS.zMin + Math.random() * (FOG_BOUNDS.zMax - FOG_BOUNDS.zMin),
  );
  mesh.rotation.set(
    -Math.PI / 2 + (Math.random() - 0.5) * 0.35,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 0.4,
  );
}

function createFogPlanes(spriteMap: THREE.Texture): {
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
} {
  const group = new THREE.Group();
  group.name = 'FogPlanes';
  const materials: THREE.MeshBasicMaterial[] = [];

  const sheets: Array<{
    w: number;
    h: number;
    x: number;
    y: number;
    z: number;
    rotX: number;
    rotY: number;
    opacity: number;
  }> = [
    // Low ground sheet under / around the car
    { w: 14, h: 8, x: 0, y: 0.12, z: -1.5, rotX: -Math.PI / 2, rotY: 0, opacity: 0.2 },
    // Front mist catching headlight bloom
    { w: 10, h: 6, x: 0, y: 0.28, z: 1.8, rotX: -Math.PI / 2.05, rotY: 0, opacity: 0.14 },
    // Slightly raised mid mist
    { w: 12, h: 7, x: 0.4, y: 0.35, z: -2.2, rotX: -Math.PI / 2.15, rotY: 0.08, opacity: 0.14 },
    // Vertical-ish backdrop haze in front of the logo
    { w: 10, h: 4.5, x: 0, y: 1.1, z: -5.2, rotX: 0, rotY: 0, opacity: 0.16 },
    // Soft side volume
    { w: 8, h: 3.5, x: -2.5, y: 0.7, z: -3.5, rotX: -0.15, rotY: 0.35, opacity: 0.1 },
  ];

  for (const s of sheets) {
    const mat = new THREE.MeshBasicMaterial({
      map: spriteMap,
      color: new THREE.Color(FOG_PARTICLE_COLOR),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      opacity: s.opacity,
      fog: true,
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.rotation.set(s.rotX, s.rotY, 0);
    mesh.renderOrder = 2;
    group.add(mesh);
  }

  return { group, materials };
}

function createSmokeBillboards(map: THREE.Texture): {
  group: THREE.Group;
  billboards: SmokeBillboard[];
} {
  const group = new THREE.Group();
  group.name = 'SmokeBillboards';
  const billboards: SmokeBillboard[] = [];
  const geo = new THREE.PlaneGeometry(1, 1);

  for (let i = 0; i < BILLBOARD_COUNT; i++) {
    const baseOpacity = 0.1 + Math.random() * 0.16;
    const baseScale = 2.4 + Math.random() * 3.6;
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: new THREE.Color(FOG_PARTICLE_COLOR),
      transparent: true,
      depthWrite: false,
      // Normal blending reads more like volume smoke; additive mist is layered separately
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      opacity: baseOpacity,
      fog: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    seedBillboardPose(mesh);
    mesh.scale.setScalar(baseScale);
    mesh.renderOrder = 3;
    group.add(mesh);
    billboards.push({
      mesh,
      mat,
      baseOpacity,
      spin: (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.22),
      driftPhase: Math.random() * Math.PI * 2,
      baseScale,
      vel: 0.05 + Math.random() * 0.12,
    });
  }

  return { group, billboards };
}

export function createEffects(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): EffectsHandle {
  const params: EffectsParams = { ...DEFAULT_EFFECTS_PARAMS };

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    params.bloomStrength,
    params.bloomRadius,
    params.bloomThreshold,
  );
  composer.addPass(bloomPass);

  const vignettePass = new ShaderPass(VignetteShader);
  composer.addPass(vignettePass);

  const grainPass = new ShaderPass(FilmGrainShader);
  composer.addPass(grainPass);

  composer.addPass(new OutputPass());

  const fogSprite = createFogSpriteTexture();
  const smokeMap = createSmokeBillboardTexture();
  const fogPlaneMap = createFogPlaneTexture();

  const smoke = new THREE.Group();
  smoke.name = 'FogSmoke';
  scene.add(smoke);

  const { group: billboardGroup, billboards } = createSmokeBillboards(smokeMap);
  smoke.add(billboardGroup);

  const positions = new Float32Array(MIST_PARTICLE_COUNT * 3);
  const velocities = new Float32Array(MIST_PARTICLE_COUNT);
  const phases = new Float32Array(MIST_PARTICLE_COUNT);
  for (let i = 0; i < MIST_PARTICLE_COUNT; i++) {
    seedFogParticle(positions, velocities, phases, i);
  }

  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mistMat = new THREE.PointsMaterial({
    map: fogSprite,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: new THREE.Color(FOG_PARTICLE_COLOR),
    size: 2.2,
    sizeAttenuation: true,
    opacity: 0.16,
    fog: true,
  });
  const mistPoints = new THREE.Points(mistGeo, mistMat);
  mistPoints.name = 'FogMist';
  mistPoints.frustumCulled = false;
  mistPoints.renderOrder = 4;
  smoke.add(mistPoints);

  const { group: fogPlanes, materials: fogPlaneMats } = createFogPlanes(fogPlaneMap);
  scene.add(fogPlanes);

  const flashLight = new THREE.PointLight(0xffffff, 0, 40, 1.4);
  flashLight.position.set(0, 4, 3);
  scene.add(flashLight);

  scene.fog = new THREE.FogExp2(FOG_COLOR, params.fogDensity);

  const applyParams = () => {
    bloomPass.enabled = params.bloomEnabled;
    bloomPass.strength = params.bloomStrength;
    bloomPass.radius = params.bloomRadius;
    bloomPass.threshold = params.bloomThreshold;

    vignettePass.enabled = params.vignetteEnabled;
    vignettePass.uniforms['darkness'].value = params.vignetteDarkness;
    vignettePass.uniforms['offset'].value = params.vignetteOffset;

    const on = params.smokeEnabled;
    smoke.visible = on;
    fogPlanes.visible = on;

    const opacity = THREE.MathUtils.clamp(params.fogOpacity, 0, 1);
    const density = params.smokeDensity;

    mistMat.opacity = (0.05 + density * 0.18) * opacity;
    mistMat.size = 1.6 + density * 2.8;

    for (const b of billboards) {
      b.mat.opacity = b.baseOpacity * (0.55 + density * 1.1) * opacity;
      const s = b.baseScale * (0.75 + density * 0.7);
      b.mesh.scale.setScalar(s);
    }

    const planeBase = [0.16, 0.12, 0.12, 0.14, 0.09];
    fogPlaneMats.forEach((mat, i) => {
      mat.opacity =
        (planeBase[i] ?? 0.1) * (0.5 + density * 0.9) * opacity;
    });

    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.density = params.fogDensity;
      scene.fog.color.setHex(FOG_COLOR);
    }

    grainPass.enabled = params.grainEnabled && params.grainStrength > 0.001;
    grainPass.uniforms['amount'].value = params.grainStrength;
    grainPass.uniforms['enabled'].value = grainPass.enabled ? 1 : 0;
  };

  const triggerFlash = (peak = 12) => {
    params.flashEnabled = true;
    params.flashIntensity = peak;
    flashLight.intensity = peak;
  };

  const resize = (width: number, height: number) => {
    composer.setSize(width, height);
    bloomPass.resolution.set(width, height);
  };

  const wrapBillboard = (mesh: THREE.Mesh) => {
    let { x, y, z } = mesh.position;
    if (x < -FOG_BOUNDS.x * 0.5) x += FOG_BOUNDS.x;
    if (x > FOG_BOUNDS.x * 0.5) x -= FOG_BOUNDS.x;
    if (z < FOG_BOUNDS.zMin) z = FOG_BOUNDS.zMax;
    if (z > FOG_BOUNDS.zMax) z = FOG_BOUNDS.zMin;
    if (y < 0.05) y = 0.05;
    if (y > FOG_BOUNDS.yMax) y = FOG_BOUNDS.yMax * 0.88;
    mesh.position.set(x, y, z);
  };

  const update = (dt: number, elapsed: number) => {
    grainPass.uniforms['time'].value = elapsed;

    if (params.smokeEnabled) {
      const speed = params.smokeSpeed;

      for (const b of billboards) {
        const { mesh, spin, driftPhase, vel } = b;
        // Classic deploy3-style slow spin is what sells the volume
        mesh.rotation.z += spin * speed * dt;
        mesh.position.x +=
          Math.sin(elapsed * 0.2 + driftPhase) * vel * speed * dt * 1.8;
        mesh.position.z +=
          Math.cos(elapsed * 0.16 + driftPhase * 1.2) * vel * speed * dt * 1.2;
        // Gentle lift within the ground layer — not chimney smoke
        mesh.position.y +=
          Math.sin(elapsed * 0.28 + driftPhase) * 0.018 * speed +
          0.01 * speed * dt;
        wrapBillboard(mesh);
      }

      const pos = mistGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < MIST_PARTICLE_COUNT; i++) {
        const phase = phases[i];
        let x = pos.getX(i);
        let y = pos.getY(i);
        let z = pos.getZ(i);

        x += Math.sin(elapsed * 0.22 + phase) * velocities[i] * speed * dt * 1.6;
        z += Math.cos(elapsed * 0.18 + phase * 1.3) * velocities[i] * speed * dt * 1.1;
        y += Math.sin(elapsed * 0.35 + phase * 0.7) * 0.014 * speed;

        if (x < -FOG_BOUNDS.x * 0.5) x += FOG_BOUNDS.x;
        if (x > FOG_BOUNDS.x * 0.5) x -= FOG_BOUNDS.x;
        if (z < FOG_BOUNDS.zMin) z = FOG_BOUNDS.zMax;
        if (z > FOG_BOUNDS.zMax) z = FOG_BOUNDS.zMin;
        if (y < 0.02) y = 0.02 + Math.abs(Math.sin(phase)) * 0.05;
        if (y > FOG_BOUNDS.yMax) y = FOG_BOUNDS.yMax * 0.85;

        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;

      fogPlanes.children.forEach((child, i) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.rotation.z = Math.sin(elapsed * 0.08 + i) * 0.04;
        child.position.x += Math.sin(elapsed * 0.12 + i * 1.7) * 0.0008;
      });
    }

    if (params.flashIntensity > 0.01) {
      params.flashIntensity = Math.max(
        0,
        params.flashIntensity - params.flashDecay * dt * params.flashIntensity,
      );
      flashLight.intensity = params.flashIntensity;
    } else {
      flashLight.intensity = 0;
    }
  };

  const render = () => {
    if (
      params.bloomEnabled ||
      params.vignetteEnabled ||
      (params.grainEnabled && params.grainStrength > 0.001)
    ) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  };

  applyParams();

  return {
    composer,
    params,
    smoke,
    fogPlanes,
    flashLight,
    applyParams,
    triggerFlash,
    resize,
    update,
    render,
  };
}
