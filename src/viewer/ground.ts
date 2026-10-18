import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { GROUND_LIGHT_LAYER } from './carLights';

const TEXTURE_BASE = '/textures/concrete_floor';
const TILE_REPEAT = 4;
const PUDDLE_MAP_SIZE = 1024;

export type GroundHandle = {
  group: THREE.Group;
  reflector: Reflector;
  overlay: THREE.Mesh;
  shadowCatcher: THREE.Mesh;
  setReflectivity: (value: number) => void;
  /** 0 = uniform wet film, 1 = strong puddle contrast. */
  setPuddleStrength: (value: number) => void;
  setVisible: (visible: boolean) => void;
};

function configureMap(
  texture: THREE.Texture,
  colorSpace?: THREE.ColorSpace,
): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(TILE_REPEAT, TILE_REPEAT);
  texture.anisotropy = 8;
  if (colorSpace) texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

async function loadFloorMaps(): Promise<{
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  roughnessImage: HTMLImageElement | ImageBitmap;
}> {
  const loader = new THREE.TextureLoader();
  const [albedo, roughness, normal, ao] = await Promise.all([
    loader.loadAsync(`${TEXTURE_BASE}/diff.jpg`),
    loader.loadAsync(`${TEXTURE_BASE}/rough.jpg`),
    loader.loadAsync(`${TEXTURE_BASE}/nor_gl.jpg`),
    loader.loadAsync(`${TEXTURE_BASE}/ao.jpg`),
  ]);

  configureMap(albedo, THREE.SRGBColorSpace);
  configureMap(roughness);
  configureMap(normal);
  configureMap(ao);

  const roughnessImage = roughness.image as HTMLImageElement | ImageBitmap;

  return { albedo, roughness, normal, ao, roughnessImage };
}

/** Hash for stable procedural puddles (no Math.random flicker). */
function hash2(ix: number, iy: number): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Composite the authored roughness map with darker wet puddles.
 * Darker = wetter = lower roughness → soft broken reflections.
 */
function buildPuddledRoughness(
  baseImage: HTMLImageElement | ImageBitmap,
  strength: number,
): THREE.CanvasTexture {
  const size = PUDDLE_MAP_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.drawImage(baseImage as CanvasImageSource, 0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  const t = THREE.MathUtils.clamp(strength, 0, 1);

  // Sparse puddle seeds in texture space
  const puddles: { x: number; y: number; rx: number; ry: number; depth: number }[] =
    [];
  for (let i = 0; i < 14; i++) {
    puddles.push({
      x: hash2(i, 1),
      y: hash2(i, 2),
      rx: 0.04 + hash2(i, 3) * 0.12,
      ry: 0.03 + hash2(i, 4) * 0.09,
      depth: 0.35 + hash2(i, 5) * 0.55,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;

      // Fine grit so reflections break up even without puddles
      const grit =
        (hash2(x * 0.37, y * 0.37) - 0.5) * 0.08 +
        (hash2(x * 0.11, y * 0.19) - 0.5) * 0.05;

      let wet = 0;
      for (const p of puddles) {
        const dx = (u - p.x) / p.rx;
        const dy = (v - p.y) / p.ry;
        const d = dx * dx + dy * dy;
        if (d < 1) {
          const falloff = (1 - d) * (1 - d);
          wet = Math.max(wet, falloff * p.depth);
        }
      }

      // Soft edge noise so puddles aren't perfect ellipses
      wet *= 0.75 + hash2(x * 0.5, y * 0.5) * 0.5;

      const base = data[i]! / 255;
      // Wet spots pull toward ~0.08–0.15 roughness; dry stays grit-up
      const puddleTarget = 0.1 + (1 - wet) * 0.15;
      const mixed = THREE.MathUtils.lerp(base, puddleTarget, wet * t);
      const out = THREE.MathUtils.clamp(mixed + grit * (1 - wet * t * 0.7), 0.05, 0.95);
      const c = Math.round(out * 255);
      data[i] = c;
      data[i + 1] = c;
      data[i + 2] = c;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(TILE_REPEAT, TILE_REPEAT);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export async function createGround(
  width = 40,
  height = 40,
): Promise<GroundHandle> {
  const group = new THREE.Group();
  group.name = 'Ground';

  const maps = await loadFloorMaps();

  const reflector = new Reflector(new THREE.PlaneGeometry(width, height), {
    color: new THREE.Color(0x0a0a0a),
    textureWidth: 2048,
    textureHeight: 2048,
    clipBias: 0.003,
  });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.y = 0;
  group.add(reflector);

  const overlayGeo = new THREE.PlaneGeometry(width, height);
  // aoMap samples uv2 in MeshStandardMaterial
  overlayGeo.setAttribute('uv2', overlayGeo.attributes.uv.clone());

  let puddleStrength = 0.55;
  let puddleRough = buildPuddledRoughness(maps.roughnessImage, puddleStrength);

  const overlayMat = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    roughnessMap: puddleRough,
    normalMap: maps.normal,
    aoMap: maps.ao,
    // Darken the albedo toward a wet sealed-concrete charcoal look
    color: new THREE.Color(0x222226),
    // Concrete is dielectric — keep metalness near zero
    metalness: 0.02,
    // Roughness map × this scalar → wet sealed finish (not dry matte)
    roughness: 0.42,
    // Softer relief than asphalt so slab pores don't overwhelm the car
    normalScale: new THREE.Vector2(0.4, 0.4),
    aoMapIntensity: 0.85,
    envMapIntensity: 0.22,
    transparent: true,
    opacity: 0.42,
  });

  const overlay = new THREE.Mesh(overlayGeo, overlayMat);
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.y = 0.002;
  overlay.receiveShadow = true;
  // Receive car-light ground pools without lighting the vehicle body.
  overlay.layers.enable(GROUND_LIGHT_LAYER);
  group.add(overlay);

  // Transparent materials barely show shadows; ShadowMaterial only draws the umbra.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.ShadowMaterial({
      opacity: 0.55,
      transparent: true,
      depthWrite: false,
    }),
  );
  shadowCatcher.name = 'ShadowCatcher';
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = 0.004;
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 2;
  group.add(shadowCatcher);

  const setReflectivity = (value: number) => {
    const t = THREE.MathUtils.clamp(value, 0, 1);
    // Higher reflectivity → more mirror through a thinner concrete film
    overlayMat.opacity = 1 - t * 0.78;
    // Slightly glossier when more reflective (puddle map still breaks it up)
    overlayMat.roughness = THREE.MathUtils.lerp(0.55, 0.28, t);
    reflector.visible = t > 0.02;
  };

  const setPuddleStrength = (value: number) => {
    puddleStrength = THREE.MathUtils.clamp(value, 0, 1);
    const next = buildPuddledRoughness(maps.roughnessImage, puddleStrength);
    const prev = puddleRough;
    puddleRough = next;
    overlayMat.roughnessMap = next;
    overlayMat.needsUpdate = true;
    prev.dispose();
  };

  const setVisible = (visible: boolean) => {
    group.visible = visible;
  };

  setReflectivity(0.88);

  return {
    group,
    reflector,
    overlay,
    shadowCatcher,
    setReflectivity,
    setPuddleStrength,
    setVisible,
  };
}
