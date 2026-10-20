import * as THREE from 'three';

/** Material names baked into the BMW M Hybrid V8 glTF. */
const WHITE_GLOW = 'White light glow';
const RED_GLOW = 'Red light glow';
const EXT_LIGHTS = 'EXT_LIGHTS';

/** Base emissive intensity for edge LED housings (no baked emissive). Scaled by edgeStrength. */
const EDGE_BASE_INTENSITY = 5;

/**
 * Albedo multiplier for EXT_LIGHTS. The baked map has stark white LED discs that
 * read as stickers when unlit — keep the housing dark and drive “on” via emissive only.
 */
const EDGE_ALBEDO_SCALE = 0.14;

/** Dual-tone kidney outline (viewer left = ice cyan, right = vermilion). */
const GRILLE_LEFT_COLOR = new THREE.Color(0x35d4ff);
const GRILLE_RIGHT_COLOR = new THREE.Color(0xff4210);
const GRILLE_BASE_INTENSITY = 4.5;

/**
 * Point-light pools only affect objects on this layer (the concrete overlay).
 * Keeps intakes / interior from being washed out by headlight fill.
 */
export const GROUND_LIGHT_LAYER = 1;

/** Soft radial falloff for ground reflection discs. */
function createGlowSpriteTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft longitudinal falloff for headlight volume cones. */
function createBeamTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(
    size / 2,
    size * 0.15,
    0,
    size / 2,
    size * 0.55,
    size * 0.55,
  );
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.04)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type CarLightsParams = {
  /** Master on/off for all car emissive lights. */
  enabled: boolean;
  /** Kidney-grille outline strips (`White light glow`). */
  grilleEnabled: boolean;
  grilleStrength: number;
  /** Outer headlight LED clusters (`EXT_LIGHTS`). */
  edgeEnabled: boolean;
  edgeStrength: number;
  /** Rear red glow (`Red light glow`). */
  redEnabled: boolean;
  redStrength: number;
  /** Soft light pools + point lights on the concrete floor. */
  groundGlow: boolean;
  groundGlowStrength: number;
  /** Soft volumetric cones in front of headlights. */
  beamsEnabled: boolean;
  beamStrength: number;
};

export const DEFAULT_CAR_LIGHTS_PARAMS: CarLightsParams = {
  enabled: true,
  grilleEnabled: true,
  grilleStrength: 2.4,
  edgeEnabled: true,
  edgeStrength: 1.1,
  redEnabled: true,
  redStrength: 1.2,
  groundGlow: true,
  groundGlowStrength: 1.65,
  beamsEnabled: true,
  beamStrength: 0.85,
};

type GlowEntry = {
  material: THREE.MeshStandardMaterial;
  originalIntensity: number;
  /** When set, tint emissive (dual-tone kidneys). */
  tint?: THREE.Color;
  baseIntensity?: number;
};

type EdgeEntry = {
  material: THREE.MeshStandardMaterial;
  originalColor: THREE.Color;
  originalEmissive: THREE.Color;
  originalEmissiveMap: THREE.Texture | null;
  originalEmissiveIntensity: number;
};

type GroundPool = {
  kind: 'grille' | 'edge' | 'red';
  disc: THREE.Mesh;
  light: THREE.PointLight;
  /** Base disc scale at strength 1. */
  baseScale: number;
  /** Point-light intensity at channel strength 1. */
  baseLightIntensity: number;
};

type BeamEntry = {
  mesh: THREE.Mesh;
};

type SplitMesh = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
};

export type CarLightsHandle = {
  params: CarLightsParams;
  /**
   * Collect glow materials from a freshly loaded model root.
   * @param worldParent scene (or equivalent) for ground pools — not modelRoot,
   *   so hiding the car never parents the floor FX under a hidden group by mistake.
   */
  bind: (root: THREE.Object3D, worldParent?: THREE.Object3D) => void;
  /** Drop anchors before the current model meshes are disposed. */
  unbind: () => void;
  /** Hide ground pools / beams with the car; floor mesh stays independent. */
  setCarVisible: (visible: boolean) => void;
  applyParams: () => void;
  dispose: () => void;
};

function isStandard(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  return (
    mat instanceof THREE.MeshStandardMaterial ||
    mat instanceof THREE.MeshPhysicalMaterial
  );
}

function meshUsesMaterial(mesh: THREE.Mesh, name: string): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.some((m) => m.name === name);
}

/** World-space centroid of a mesh. */
function meshCentroid(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  mesh.geometry.boundingBox!.getCenter(center);
  return mesh.localToWorld(center);
}

/**
 * Average world positions of EXT_LIGHTS verts in the front bumper band,
 * split into left / right headlight clusters.
 */
function frontEdgeAnchors(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.attributes.position;
  if (!pos) return [];

  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const v = new THREE.Vector3();

  // Front band of the car (model sits nose +Z).
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (v.z < 1.6) continue;
    if (v.x < -0.35) left.push(v.clone());
    else if (v.x > 0.35) right.push(v.clone());
  }

  const avg = (pts: THREE.Vector3[]) => {
    if (!pts.length) return null;
    const out = new THREE.Vector3();
    for (const p of pts) out.add(p);
    return out.multiplyScalar(1 / pts.length);
  };

  return [avg(left), avg(right)].filter(Boolean) as THREE.Vector3[];
}

/**
 * Split a mesh into two geometries by local-space face centroid along an axis.
 * Returns null when every triangle lands on the same side of `threshold`.
 */
function splitGeometryByLocalAxis(
  geometry: THREE.BufferGeometry,
  axis: 'x' | 'y' | 'z',
  threshold = 0,
): { negative: THREE.BufferGeometry; positive: THREE.BufferGeometry } | null {
  const pos = geometry.attributes.position;
  if (!pos) return null;

  const index = geometry.index;
  const triCount = index ? index.count / 3 : pos.count / 3;
  if (triCount < 2) return null;

  const negativeIdx: number[] = [];
  const positiveIdx: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

  const readTri = (t: number) => {
    let i0: number;
    let i1: number;
    let i2: number;
    if (index) {
      i0 = index.getX(t * 3);
      i1 = index.getX(t * 3 + 1);
      i2 = index.getX(t * 3 + 2);
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const centroid = (a.getComponent(axisIndex) +
      b.getComponent(axisIndex) +
      c.getComponent(axisIndex)) /
      3;
    return { i0, i1, i2, centroid };
  };

  let hasNegative = false;
  let hasPositive = false;
  for (let t = 0; t < triCount; t++) {
    const { i0, i1, i2, centroid } = readTri(t);
    if (centroid < threshold) {
      negativeIdx.push(i0, i1, i2);
      hasNegative = true;
    } else {
      positiveIdx.push(i0, i1, i2);
      hasPositive = true;
    }
  }

  if (!hasNegative || !hasPositive) return null;

  const build = (indices: number[]) => {
    const geo = geometry.clone();
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  };

  return {
    negative: build(negativeIdx),
    positive: build(positiveIdx),
  };
}

/** Kidney outline: left / right by local X. */
function splitGeometryByLocalX(
  geometry: THREE.BufferGeometry,
): { left: THREE.BufferGeometry; right: THREE.BufferGeometry } | null {
  const split = splitGeometryByLocalAxis(geometry, 'x', 0);
  if (!split) return null;
  return { left: split.negative, right: split.positive };
}

/**
 * EXT_LIGHTS spans nose LED housings and rear white chevron faces.
 * Anything behind this local Z stays unlit so only Red light glow shows aft.
 */
const REAR_EXT_LIGHTS_Z = -1.0;

export function createCarLights(): CarLightsHandle {
  const params: CarLightsParams = { ...DEFAULT_CAR_LIGHTS_PARAMS };
  const grille: GlowEntry[] = [];
  const red: GlowEntry[] = [];
  const edge: EdgeEntry[] = [];
  const pools: GroundPool[] = [];
  const beams: BeamEntry[] = [];
  const splitMeshes: SplitMesh[] = [];
  /** Original meshes hidden while split clones are shown (grille + rear EXT_LIGHTS). */
  const hiddenSourceMeshes: THREE.Mesh[] = [];

  const glowGroup = new THREE.Group();
  glowGroup.name = 'CarLightGroundGlow';
  let carVisible = true;
  const glowTexture = createGlowSpriteTexture();
  const beamTexture = createBeamTexture();

  const restoreEdge = (entry: EdgeEntry) => {
    const { material } = entry;
    material.color.copy(entry.originalColor);
    material.emissive.copy(entry.originalEmissive);
    material.emissiveMap = entry.originalEmissiveMap;
    material.emissiveIntensity = entry.originalEmissiveIntensity;
    material.needsUpdate = true;
  };

  const clearPools = () => {
    for (const pool of pools) {
      glowGroup.remove(pool.disc);
      glowGroup.remove(pool.light);
      pool.disc.geometry.dispose();
      (pool.disc.material as THREE.Material).dispose();
      pool.light.dispose();
    }
    pools.length = 0;
  };

  const clearBeams = () => {
    for (const beam of beams) {
      glowGroup.remove(beam.mesh);
      beam.mesh.geometry.dispose();
      (beam.mesh.material as THREE.Material).dispose();
    }
    beams.length = 0;
  };

  const clearSplitMeshes = () => {
    for (const split of splitMeshes) {
      split.mesh.removeFromParent();
      split.geometry.dispose();
      split.material.dispose();
    }
    splitMeshes.length = 0;
    for (const mesh of hiddenSourceMeshes) {
      mesh.visible = true;
    }
    hiddenSourceMeshes.length = 0;
  };

  const unbind = () => {
    // Do not restore materials here — the model may already be mid-dispose.
    clearPools();
    clearBeams();
    clearSplitMeshes();
    grille.length = 0;
    red.length = 0;
    edge.length = 0;
    glowGroup.removeFromParent();
  };

  const attachSplitClone = (
    source: THREE.Mesh,
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    name: string,
  ): THREE.Mesh => {
    const clone = new THREE.Mesh(geometry, material);
    clone.name = name;
    clone.position.copy(source.position);
    clone.quaternion.copy(source.quaternion);
    clone.scale.copy(source.scale);
    clone.matrix.copy(source.matrix);
    clone.matrixAutoUpdate = source.matrixAutoUpdate;
    if (!source.matrixAutoUpdate) clone.matrixWorldNeedsUpdate = true;
    source.parent?.add(clone);
    splitMeshes.push({ mesh: clone, geometry, material });
    return clone;
  };

  const addPool = (
    kind: GroundPool['kind'],
    worldPos: THREE.Vector3,
    color: THREE.ColorRepresentation,
    baseScale: number,
    baseLightIntensity: number,
  ) => {
    const discMat = new THREE.MeshBasicMaterial({
      map: glowTexture,
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(worldPos.x, 0.006, worldPos.z);
    disc.scale.setScalar(baseScale);
    disc.renderOrder = 4;
    disc.frustumCulled = false;
    glowGroup.add(disc);

    // Sit just above the floor so fill stays on the concrete, not up into the nose.
    const light = new THREE.PointLight(color, 0, 2.8, 2.4);
    light.position.set(worldPos.x, 0.06, worldPos.z);
    light.layers.set(GROUND_LIGHT_LAYER);
    glowGroup.add(light);

    pools.push({ kind, disc, light, baseScale, baseLightIntensity });
  };

  const addBeam = (worldPos: THREE.Vector3) => {
    const mat = new THREE.MeshBasicMaterial({
      map: beamTexture,
      color: 0xe8f4ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: true,
    });
    // Cone points along +Y; we reorient so it shoots forward (+Z).
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.2, 24, 1, true), mat);
    mesh.position.set(worldPos.x, worldPos.y * 0.35 + 0.2, worldPos.z + 0.15);
    mesh.rotation.x = Math.PI / 2;
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    glowGroup.add(mesh);
    beams.push({ mesh });
  };

  const makeGrilleMaterial = (
    source: THREE.MeshStandardMaterial,
    tint: THREE.Color,
  ): THREE.MeshStandardMaterial => {
    const mat = source.clone();
    mat.name = `${WHITE_GLOW} dual`;
    mat.emissive.copy(tint);
    mat.emissiveMap = null;
    mat.color.copy(tint);
    mat.emissiveIntensity = 0;
    mat.toneMapped = false;
    mat.needsUpdate = true;
    return mat;
  };

  const registerGrilleMat = (
    mat: THREE.MeshStandardMaterial,
    tint: THREE.Color,
  ) => {
    grille.push({
      material: mat,
      originalIntensity: GRILLE_BASE_INTENSITY,
      tint: tint.clone(),
      baseIntensity: GRILLE_BASE_INTENSITY,
    });
  };

  /**
   * Dual-tone the kidney outline: cyan (viewer left / -X) and orange (+X).
   * Prefer a geometric split when one mesh spans both kidneys.
   */
  const setupDualGrille = (
    grilleMeshes: THREE.Mesh[],
    sourceMat: THREE.MeshStandardMaterial | null,
  ) => {
    if (!sourceMat || !grilleMeshes.length) return;

    for (const mesh of grilleMeshes) {
      const split = splitGeometryByLocalX(mesh.geometry);
      if (split) {
        const leftMat = makeGrilleMaterial(sourceMat, GRILLE_LEFT_COLOR);
        const rightMat = makeGrilleMaterial(sourceMat, GRILLE_RIGHT_COLOR);

        attachSplitClone(mesh, split.left, leftMat, 'GrilleGlowLeft');
        attachSplitClone(mesh, split.right, rightMat, 'GrilleGlowRight');
        registerGrilleMat(leftMat, GRILLE_LEFT_COLOR);
        registerGrilleMat(rightMat, GRILLE_RIGHT_COLOR);

        mesh.visible = false;
        hiddenSourceMeshes.push(mesh);
        continue;
      }

      // Whole mesh on one side — tint by world centroid.
      const center = meshCentroid(mesh);
      const tint = center.x < 0 ? GRILLE_LEFT_COLOR : GRILLE_RIGHT_COLOR;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!isStandard(mat) || mat.name !== WHITE_GLOW) continue;
        mat.emissive.copy(tint);
        mat.emissiveMap = null;
        mat.toneMapped = false;
        mat.needsUpdate = true;
        registerGrilleMat(mat, tint);
      }
    }
  };

  const prepareEdgeMaterial = (
    mat: THREE.MeshStandardMaterial,
  ): THREE.MeshStandardMaterial => {
    edge.push({
      material: mat,
      originalColor: mat.color.clone(),
      originalEmissive: mat.emissive.clone(),
      originalEmissiveMap: mat.emissiveMap,
      originalEmissiveIntensity: mat.emissiveIntensity,
    });
    // Dim albedo so white LED discs blend into the housing when unlit.
    mat.color.multiplyScalar(EDGE_ALBEDO_SCALE);
    mat.emissive.set(1, 1, 1);
    mat.emissiveMap = mat.map;
    mat.emissiveIntensity = 0;
    mat.toneMapped = false;
    mat.needsUpdate = true;
    return mat;
  };

  /**
   * Light only the front EXT_LIGHTS housings. Rear white chevron faces share
   * the same glTF material — keep them dark so Red light glow reads alone.
   */
  const setupEdgeLights = (edgeMeshes: THREE.Mesh[]) => {
    const seen = new Set<THREE.Material>();

    for (const mesh of edgeMeshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const sourceMat = mats.find(
        (m): m is THREE.MeshStandardMaterial =>
          isStandard(m) && m.name === EXT_LIGHTS,
      );
      if (!sourceMat) continue;

      const split = splitGeometryByLocalAxis(
        mesh.geometry,
        'z',
        REAR_EXT_LIGHTS_Z,
      );
      if (split) {
        const frontMat = prepareEdgeMaterial(sourceMat.clone());
        frontMat.name = `${EXT_LIGHTS} front`;

        // Rear white layers: keep albedo, never emissive.
        const rearMat = sourceMat.clone();
        rearMat.name = `${EXT_LIGHTS} rear`;
        rearMat.emissive.set(0, 0, 0);
        rearMat.emissiveMap = null;
        rearMat.emissiveIntensity = 0;
        rearMat.needsUpdate = true;

        attachSplitClone(mesh, split.positive, frontMat, 'EdgeLightsFront');
        attachSplitClone(mesh, split.negative, rearMat, 'EdgeLightsRear');

        mesh.visible = false;
        hiddenSourceMeshes.push(mesh);
        continue;
      }

      // Entirely on one side of the car — only light if it's the front half.
      if (seen.has(sourceMat)) continue;
      seen.add(sourceMat);
      const center = meshCentroid(mesh);
      if (center.z < REAR_EXT_LIGHTS_Z) {
        sourceMat.emissive.set(0, 0, 0);
        sourceMat.emissiveMap = null;
        sourceMat.emissiveIntensity = 0;
        sourceMat.needsUpdate = true;
        continue;
      }
      prepareEdgeMaterial(sourceMat);
    }
  };

  const setCarVisible = (visible: boolean) => {
    carVisible = visible;
    glowGroup.visible = visible;
  };

  const bind = (root: THREE.Object3D, worldParent?: THREE.Object3D) => {
    // Restore previous EXT_LIGHTS mats only when they are still live.
    for (const entry of edge) restoreEdge(entry);
    unbind();
    const seen = new Set<THREE.Material>();
    const edgeMeshes: THREE.Mesh[] = [];
    let redMesh: THREE.Mesh | null = null;
    const grilleMeshes: THREE.Mesh[] = [];
    let grilleSourceMat: THREE.MeshStandardMaterial | null = null;

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;

      if (meshUsesMaterial(obj, EXT_LIGHTS)) edgeMeshes.push(obj);
      if (meshUsesMaterial(obj, WHITE_GLOW)) grilleMeshes.push(obj);
      if (!redMesh && meshUsesMaterial(obj, RED_GLOW)) redMesh = obj;

      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!isStandard(mat) || seen.has(mat)) continue;
        seen.add(mat);

        if (mat.name === WHITE_GLOW) {
          grilleSourceMat = mat;
        } else if (mat.name === RED_GLOW) {
          red.push({
            material: mat,
            originalIntensity: mat.emissiveIntensity || 1,
          });
        }
        // EXT_LIGHTS is prepared in setupEdgeLights (front only).
      }
    });

    // Place ground pools / dual grille from mesh anchors (model already on floor).
    root.updateWorldMatrix(true, true);
    setupDualGrille(grilleMeshes, grilleSourceMat);
    setupEdgeLights(edgeMeshes);
    root.updateWorldMatrix(true, true);

    // Dual kidney pools — prefer live grille splits, else approximate from first grille mesh.
    const grilleAnchors: Array<{ pos: THREE.Vector3; color: THREE.Color }> = [];
    for (const split of splitMeshes) {
      if (
        split.mesh.name !== 'GrilleGlowLeft' &&
        split.mesh.name !== 'GrilleGlowRight'
      ) {
        continue;
      }
      const c = meshCentroid(split.mesh);
      grilleAnchors.push({
        pos: c,
        color: c.x < 0 ? GRILLE_LEFT_COLOR : GRILLE_RIGHT_COLOR,
      });
    }
    if (!grilleAnchors.length && grilleMeshes[0]) {
      const c = meshCentroid(grilleMeshes[0]);
      grilleAnchors.push(
        { pos: new THREE.Vector3(c.x - 0.32, c.y, c.z), color: GRILLE_LEFT_COLOR },
        { pos: new THREE.Vector3(c.x + 0.32, c.y, c.z), color: GRILLE_RIGHT_COLOR },
      );
    }
    for (const a of grilleAnchors) {
      addPool('grille', a.pos, a.color, 1.15, 2.8);
    }

    // Prefer the lit front split mesh when present; else original EXT_LIGHTS mesh.
    const frontEdgeMesh =
      splitMeshes.find((s) => s.mesh.name === 'EdgeLightsFront')?.mesh ??
      edgeMeshes[0] ??
      null;
    if (frontEdgeMesh) {
      const anchors = frontEdgeAnchors(frontEdgeMesh);
      for (const a of anchors) {
        addPool('edge', a, 0xf5fbff, 1.25, 4.2);
        addBeam(a);
      }
    }

    if (redMesh) {
      const c = meshCentroid(redMesh);
      addPool('red', c, 0xff2200, 1.5, 1.8);
    }

    // Parent to the scene (not modelRoot) so car hide never swallows floor FX /
    // leave the concrete ground looking like it vanished with the vehicle.
    const parent = worldParent ?? root.parent ?? root;
    parent.add(glowGroup);
    glowGroup.visible = carVisible;

    applyParams();
  };

  const applyGlow = (
    entries: GlowEntry[],
    channelOn: boolean,
    strength: number,
  ) => {
    const on = params.enabled && channelOn;
    for (const entry of entries) {
      const base = entry.baseIntensity ?? entry.originalIntensity;
      if (entry.tint) {
        entry.material.emissive.copy(entry.tint);
      }
      entry.material.emissiveIntensity = on ? base * strength : 0;
    }
  };

  const applyEdge = () => {
    const on = params.enabled && params.edgeEnabled;
    for (const entry of edge) {
      entry.material.emissiveIntensity = on
        ? EDGE_BASE_INTENSITY * params.edgeStrength
        : 0;
    }
  };

  const channelLevel = (kind: GroundPool['kind']): number => {
    if (!params.enabled || !params.groundGlow) return 0;
    if (kind === 'grille') {
      return params.grilleEnabled ? params.grilleStrength : 0;
    }
    if (kind === 'edge') {
      return params.edgeEnabled ? params.edgeStrength : 0;
    }
    return params.redEnabled ? params.redStrength : 0;
  };

  const applyGround = () => {
    const boost = params.groundGlowStrength;
    for (const pool of pools) {
      const level = channelLevel(pool.kind) * boost;
      const mat = pool.disc.material as THREE.MeshBasicMaterial;
      mat.opacity = THREE.MathUtils.clamp(0.22 + level * 0.32, 0, 1);
      pool.disc.scale.setScalar(
        pool.baseScale * (0.85 + Math.min(level, 12) * 0.1),
      );
      pool.disc.visible = level > 0.001;
      pool.light.intensity = pool.baseLightIntensity * level;
      pool.light.visible = level > 0.001;
    }
  };

  const applyBeams = () => {
    const on = params.enabled && params.edgeEnabled && params.beamsEnabled;
    const level = on ? params.edgeStrength * params.beamStrength : 0;
    for (const beam of beams) {
      const mat = beam.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = THREE.MathUtils.clamp(0.08 + level * 0.12, 0, 0.55);
      beam.mesh.visible = level > 0.001;
      const s = 0.85 + Math.min(level, 8) * 0.06;
      beam.mesh.scale.set(s, 1 + Math.min(level, 6) * 0.08, s);
    }
  };

  const applyParams = () => {
    applyGlow(grille, params.grilleEnabled, params.grilleStrength);
    applyGlow(red, params.redEnabled, params.redStrength);
    applyEdge();
    applyGround();
    applyBeams();
  };

  const dispose = () => {
    for (const entry of edge) restoreEdge(entry);
    unbind();
    glowTexture.dispose();
    beamTexture.dispose();
  };

  return {
    params,
    bind,
    unbind,
    setCarVisible,
    applyParams,
    dispose,
  };
}
