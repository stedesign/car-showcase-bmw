import * as THREE from 'three';

export type CarMotionParams = {
  /** Master on/off for wheel spin and camera shake. */
  enabled: boolean;
  /** 0–1 → wheel angular velocity. */
  wheelSpeed: number;
  /** 0–1 → high-frequency camera vibration amplitude. */
  shake: number;
};

export const DEFAULT_CAR_MOTION_PARAMS: CarMotionParams = {
  enabled: false,
  /** Non-zero so turning On immediately reads as racing. */
  wheelSpeed: 0.75,
  shake: 0.4,
};

/** rad/s at wheelSpeed = 1 — fast enough that spokes read as a smear. */
const MAX_WHEEL_RAD_PER_SEC = 140;

const HUB_COUNT = 4;
/** Extra rotated copies per spinning mesh (excluding the solid). */
const BLUR_GHOSTS = 16;
/** Half-angle of the smear fan at wheelSpeed = 1 (radians ~75°). */
const BLUR_HALF_ANGLE = 1.35;

export type CarMotionHandle = {
  params: CarMotionParams;
  /** Discover / split wheel hubs under the loaded car. */
  bind: (modelRoot: THREE.Object3D) => void;
  unbind: () => void;
  applyParams: () => void;
  /** Shake amount to feed the camera layer (0 when disabled). */
  effectiveShake: () => number;
  /** How many hub pivots were bound (0 = spin unavailable). */
  hubCount: () => number;
  update: (dt: number) => void;
  dispose: () => void;
};

type GhostEntry = {
  mesh: THREE.Mesh;
  materials: THREE.Material[];
};

type HubEntry = {
  /** Static world anchor (brakes live here). */
  anchor: THREE.Group;
  /** Rotating tire + rim. */
  spin: THREE.Group;
  ghosts: GhostEntry[];
};

/** GLTF multi-primitive wheels arrive as a Group named *Wheel*, not a Mesh. */
function findWheelRoot(root: THREE.Object3D): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (found) return;
    if (/wheel/i.test(obj.name)) found = obj;
  });
  return found;
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) meshes.push(obj);
  });
  return meshes;
}

function materialName(mat: THREE.Material | THREE.Material[]): string {
  const list = Array.isArray(mat) ? mat : [mat];
  return list.map((m) => m.name || '').join(' ');
}

function isTireMaterial(mat: THREE.Material | THREE.Material[]): boolean {
  return /tire/i.test(materialName(mat));
}

function isRimMaterial(mat: THREE.Material | THREE.Material[]): boolean {
  return /rim/i.test(materialName(mat));
}

function isBrakeMaterial(mat: THREE.Material | THREE.Material[]): boolean {
  return /brake|caliper|rotor/i.test(materialName(mat));
}

/** Tire + rim spin; brakes (and anything else) stay fixed. */
function meshRole(
  mat: THREE.Material | THREE.Material[],
): 'spin' | 'brake' {
  if (isBrakeMaterial(mat)) return 'brake';
  if (isTireMaterial(mat) || isRimMaterial(mat)) return 'spin';
  // Unknown wheel parts (mechanicals) stay with the caliper / upright.
  return 'brake';
}

/** k-means on XZ; returns k cluster centers. */
function kMeansXZ(points: THREE.Vector3[], k: number, iters = 14): THREE.Vector3[] {
  if (!points.length) return [];
  const box = new THREE.Box3().setFromPoints(points);
  const min = box.min;
  const max = box.max;
  const seeds: THREE.Vector3[] = [
    new THREE.Vector3(min.x, 0, min.z),
    new THREE.Vector3(min.x, 0, max.z),
    new THREE.Vector3(max.x, 0, min.z),
    new THREE.Vector3(max.x, 0, max.z),
  ].slice(0, k);
  while (seeds.length < k) {
    seeds.push(points[Math.floor(Math.random() * points.length)]!.clone());
  }

  const assign = new Int32Array(points.length);
  for (let iter = 0; iter < iters; iter++) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const s = seeds[c]!;
        const dx = p.x - s.x;
        const dz = p.z - s.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sums = Array.from({ length: k }, () => ({ x: 0, y: 0, z: 0, n: 0 }));
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]!]!;
      const p = points[i]!;
      s.x += p.x;
      s.y += p.y;
      s.z += p.z;
      s.n += 1;
    }
    for (let c = 0; c < k; c++) {
      const s = sums[c]!;
      if (s.n > 0) {
        seeds[c]!.set(s.x / s.n, s.y / s.n, s.z / s.n);
      }
    }
  }
  return seeds;
}

function nearestHub(x: number, z: number, hubs: THREE.Vector3[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < hubs.length; i++) {
    const h = hubs[i]!;
    const dx = x - h.x;
    const dz = z - h.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Axle is along X — fit hub center from tire verts:
 * X = mid-width, YZ = outer-ring centroid.
 */
function fitTireHubCenter(points: THREE.Vector3[]): THREE.Vector3 | null {
  if (points.length < 8) return null;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }
  const n = points.length;
  const mx = sx / n;
  const my = sy / n;
  const mz = sz / n;

  const radii: number[] = [];
  for (const p of points) {
    const dy = p.y - my;
    const dz = p.z - mz;
    radii.push(Math.sqrt(dy * dy + dz * dz));
  }
  radii.sort((a, b) => a - b);
  const medianR = radii[Math.floor(radii.length / 2)]!;
  const minR = medianR * 0.55;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  let cn = 0;
  for (const p of points) {
    const dy = p.y - my;
    const dz = p.z - mz;
    const r = Math.sqrt(dy * dy + dz * dz);
    if (r < minR) continue;
    cx += p.x;
    cy += p.y;
    cz += p.z;
    cn += 1;
  }
  if (cn < 8) {
    return new THREE.Vector3(mx, my, mz);
  }
  return new THREE.Vector3(cx / cn, cy / cn, cz / cn);
}

type PreparedMesh = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  castShadow: boolean;
  receiveShadow: boolean;
  isTire: boolean;
  role: 'spin' | 'brake';
};

function cloneGhostMaterials(
  source: THREE.Material | THREE.Material[],
): THREE.Material[] {
  const list = Array.isArray(source) ? source : [source];
  return list.map((m) => {
    const c = m.clone();
    c.transparent = true;
    c.depthWrite = false;
    c.opacity = 0;
    // Additive-ish smear reads faster on dark rims.
    if ('blending' in c) {
      c.blending = THREE.NormalBlending;
    }
    c.needsUpdate = true;
    return c;
  });
}

/**
 * Bake each wheel mesh into `parent` local space, cluster into 4 hubs.
 * Tire + rim spin; brake discs / calipers stay fixed on the anchor.
 */
function splitWheelMeshes(
  meshes: THREE.Mesh[],
  wheelRoot: THREE.Object3D,
  parent: THREE.Object3D,
): HubEntry[] {
  parent.updateWorldMatrix(true, true);
  wheelRoot.updateWorldMatrix(true, true);

  const parentInv = parent.matrixWorld.clone().invert();
  const prepared: PreparedMesh[] = [];

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const toParent = parentInv.clone().multiply(mesh.matrixWorld);
    const geom = mesh.geometry.clone();
    geom.applyMatrix4(toParent);
    const role = meshRole(mesh.material);
    prepared.push({
      geometry: geom,
      material: mesh.material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      isTire: isTireMaterial(mesh.material),
      role,
    });
  }

  const sample: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  const sampleFrom = (prep: PreparedMesh, budget: number) => {
    const pos = prep.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / budget));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      sample.push(v.clone());
    }
  };
  const tirePreps = prepared.filter((p) => p.isTire);
  if (tirePreps.length) {
    for (const prep of tirePreps) sampleFrom(prep, 3000);
  } else {
    for (const prep of prepared.filter((p) => p.role === 'spin')) sampleFrom(prep, 2000);
  }

  const roughHubs = kMeansXZ(sample, HUB_COUNT);
  if (roughHubs.length < HUB_COUNT) {
    for (const prep of prepared) prep.geometry.dispose();
    return [];
  }

  const tirePointsByHub: THREE.Vector3[][] = Array.from(
    { length: HUB_COUNT },
    () => [],
  );
  for (const prep of tirePreps.length ? tirePreps : prepared) {
    const pos = prep.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) continue;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      const h = nearestHub(v.x, v.z, roughHubs);
      tirePointsByHub[h]!.push(v.clone());
    }
  }

  const hubs: THREE.Vector3[] = roughHubs.map((rough, h) => {
    const fitted = fitTireHubCenter(tirePointsByHub[h]!);
    return fitted ?? rough.clone();
  });

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const c = new THREE.Vector3();

  type HubBuild = {
    anchor: THREE.Group;
    spin: THREE.Group;
    brakes: THREE.Group;
  };

  const builds: HubBuild[] = hubs.map((hub, h) => {
    const anchor = new THREE.Group();
    anchor.name = `WheelAnchor_${h}`;
    anchor.position.copy(hub);
    const spin = new THREE.Group();
    spin.name = `WheelSpin_${h}`;
    const brakes = new THREE.Group();
    brakes.name = `WheelBrake_${h}`;
    anchor.add(spin);
    anchor.add(brakes);
    return { anchor, spin, brakes };
  });

  for (let mi = 0; mi < prepared.length; mi++) {
    const prep = prepared[mi]!;
    const geom = prep.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) continue;
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const normal = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = geom.getAttribute('uv') as THREE.BufferAttribute | undefined;

    const hubTris: number[][] = Array.from({ length: HUB_COUNT }, () => []);

    for (let t = 0; t < triCount; t++) {
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
      d.fromBufferAttribute(pos, i2);
      c.set((a.x + b.x + d.x) / 3, (a.y + b.y + d.y) / 3, (a.z + b.z + d.z) / 3);
      const hub = nearestHub(c.x, c.z, hubs);
      hubTris[hub]!.push(i0, i1, i2);
    }

    for (let h = 0; h < HUB_COUNT; h++) {
      const verts = hubTris[h]!;
      if (verts.length < 3) continue;
      const hub = hubs[h]!;
      const oldToNew = new Map<number, number>();
      const newPositions: number[] = [];
      const newNormals: number[] = [];
      const newUvs: number[] = [];
      const newIndices: number[] = [];

      const ensureVert = (oldIdx: number): number => {
        const existing = oldToNew.get(oldIdx);
        if (existing != null) return existing;
        const ni = newPositions.length / 3;
        oldToNew.set(oldIdx, ni);
        newPositions.push(
          pos.getX(oldIdx) - hub.x,
          pos.getY(oldIdx) - hub.y,
          pos.getZ(oldIdx) - hub.z,
        );
        if (normal) {
          newNormals.push(normal.getX(oldIdx), normal.getY(oldIdx), normal.getZ(oldIdx));
        }
        if (uv) {
          newUvs.push(uv.getX(oldIdx), uv.getY(oldIdx));
        }
        return ni;
      };

      for (let i = 0; i < verts.length; i += 3) {
        newIndices.push(
          ensureVert(verts[i]!),
          ensureVert(verts[i + 1]!),
          ensureVert(verts[i + 2]!),
        );
      }

      const outGeom = new THREE.BufferGeometry();
      outGeom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(newPositions, 3),
      );
      if (newNormals.length) {
        outGeom.setAttribute(
          'normal',
          new THREE.Float32BufferAttribute(newNormals, 3),
        );
      } else {
        outGeom.computeVertexNormals();
      }
      if (newUvs.length) {
        outGeom.setAttribute('uv', new THREE.Float32BufferAttribute(newUvs, 2));
      }
      outGeom.setIndex(newIndices);
      outGeom.computeBoundingSphere();

      const mesh = new THREE.Mesh(outGeom, prep.material);
      mesh.name = `WheelHub_${h}_mat${mi}`;
      mesh.castShadow = prep.castShadow;
      mesh.receiveShadow = prep.receiveShadow;
      mesh.userData.isTire = prep.isTire;
      mesh.userData.isSpinSolid = prep.role === 'spin';
      mesh.userData.isBrake = prep.role === 'brake';

      if (prep.role === 'spin') {
        builds[h]!.spin.add(mesh);
      } else {
        builds[h]!.brakes.add(mesh);
      }
    }

    geom.dispose();
  }

  // Tire-bbox recenter on the whole anchor (spin + brakes stay co-located).
  for (const build of builds) {
    const tireBox = new THREE.Box3();
    let hasTire = false;
    build.spin.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.userData.isTire) return;
      obj.geometry.computeBoundingBox();
      const bb = obj.geometry.boundingBox;
      if (!bb) return;
      tireBox.union(bb);
      hasTire = true;
    });
    if (!hasTire) {
      build.spin.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry.computeBoundingBox();
        const bb = obj.geometry.boundingBox;
        if (bb) tireBox.union(bb);
      });
    }
    if (tireBox.isEmpty()) continue;
    const center = tireBox.getCenter(new THREE.Vector3());
    if (center.lengthSq() < 1e-8) continue;
    const shift = (root: THREE.Object3D) => {
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry.translate(-center.x, -center.y, -center.z);
        obj.geometry.computeBoundingSphere();
      });
    };
    shift(build.spin);
    shift(build.brakes);
    build.anchor.position.add(center);
  }

  const hubsOut: HubEntry[] = [];
  for (const build of builds) {
    if (!build.spin.children.length && !build.brakes.children.length) continue;

    const solids: THREE.Mesh[] = [];
    build.spin.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData.isSpinSolid) solids.push(obj);
    });

    const ghosts: GhostEntry[] = [];
    for (const solid of solids) {
      for (let g = 0; g < BLUR_GHOSTS; g++) {
        const mats = cloneGhostMaterials(solid.material);
        const ghost = new THREE.Mesh(
          solid.geometry,
          mats.length === 1 ? mats[0]! : mats,
        );
        ghost.name = `${solid.name}_blur${g}`;
        ghost.castShadow = false;
        ghost.receiveShadow = false;
        ghost.renderOrder = (solid.renderOrder || 0) - 1;
        ghost.userData.isSpinGhost = true;
        ghost.userData.blurIndex = g;
        ghost.visible = false;
        build.spin.add(ghost);
        ghosts.push({ mesh: ghost, materials: mats });
      }
    }

    hubsOut.push({ anchor: build.anchor, spin: build.spin, ghosts });
  }

  return hubsOut;
}

function syncBlur(hubs: HubEntry[], enabled: boolean, wheelSpeed: number) {
  const amount = enabled ? Math.max(0, Math.min(1, wheelSpeed)) : 0;
  const show = amount > 0.03;

  for (const { spin, ghosts } of hubs) {
    // Keep tire / rim solids fully opaque — fading them makes rubber see-through.
    spin.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.userData.isSpinSolid) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
        m.needsUpdate = true;
      }
    });

    for (const { mesh, materials } of ghosts) {
      if (!show) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const idx = (mesh.userData.blurIndex as number) ?? 0;
      // Evenly fan samples across ±half-angle for a continuous ring.
      const u = (idx + 0.5) / BLUR_GHOSTS;
      const angle = (u * 2 - 1) * BLUR_HALF_ANGLE * amount;
      mesh.rotation.x = angle;
      // Soft overlay only — solids stay opaque underneath.
      const falloff = 1 - Math.abs(u * 2 - 1) * 0.4;
      const opacity =
        0.22 *
        falloff *
        THREE.MathUtils.smoothstep(amount, 0.03, 0.45) *
        (0.5 + 0.5 * amount);
      for (const m of materials) {
        m.opacity = opacity;
        m.transparent = true;
        m.depthWrite = false;
        m.depthTest = true;
        m.needsUpdate = true;
      }
    }
  }
}

export function createCarMotion(): CarMotionHandle {
  const params: CarMotionParams = { ...DEFAULT_CAR_MOTION_PARAMS };
  let hubs: HubEntry[] = [];

  const unbind = () => {
    for (const { anchor, ghosts } of hubs) {
      for (const { materials } of ghosts) {
        for (const m of materials) m.dispose();
      }
      anchor.traverse((obj) => {
        if (
          obj instanceof THREE.Mesh &&
          (obj.userData.isSpinSolid || obj.userData.isBrake)
        ) {
          obj.geometry.dispose();
        }
      });
      anchor.parent?.remove(anchor);
    }
    hubs = [];
  };

  const bind = (modelRoot: THREE.Object3D) => {
    unbind();
    const wheelRoot = findWheelRoot(modelRoot);
    if (!wheelRoot) {
      console.warn('[carMotion] No wheel node found — spin disabled');
      return;
    }

    const meshes = collectMeshes(wheelRoot);
    if (!meshes.length) {
      console.warn('[carMotion] Wheel node has no meshes — spin disabled');
      return;
    }

    const parent = wheelRoot.parent ?? modelRoot;
    const hubEntries = splitWheelMeshes(meshes, wheelRoot, parent);
    if (hubEntries.length < 2) {
      console.warn('[carMotion] Wheel hub split failed — spin disabled');
      return;
    }

    for (const { anchor } of hubEntries) {
      parent.add(anchor);
    }
    wheelRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    parent.remove(wheelRoot);
    hubs = hubEntries;
    syncBlur(hubs, params.enabled, params.wheelSpeed);
    console.info(`[carMotion] Bound ${hubs.length} wheel hubs (brakes static)`);
  };

  const applyParams = () => {
    syncBlur(hubs, params.enabled, params.wheelSpeed);
  };

  return {
    params,
    bind,
    unbind,
    applyParams,
    effectiveShake: () => (params.enabled ? Math.max(0, params.shake) : 0),
    hubCount: () => hubs.length,
    update(dt) {
      if (!params.enabled || params.wheelSpeed <= 0 || !hubs.length) return;
      const omega = params.wheelSpeed * MAX_WHEEL_RAD_PER_SEC * dt;
      // Car nose +Z, Y up → forward roll is −X. Brakes stay on the anchor.
      for (const { spin } of hubs) {
        spin.rotation.x -= omega;
      }
    },
    dispose() {
      unbind();
    },
  };
}
