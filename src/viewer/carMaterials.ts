import * as THREE from 'three';

/** Body livery / decals that should read as clearcoated automotive paint. */
const PAINT_NAMES = new Set([
  '#15 WRT ',
  'EXT_DECALS',
  '#15 Numberplate',
  'Number 88',
]);

const CARBON_NAMES = new Set(['main carbon']);

const TIRE_NAMES = new Set(['Tire']);

/** Leave emissive / glass alone — carLights and glass clearcoat already own these. */
const SKIP_NAMES = new Set([
  'White light glow',
  'Red light glow',
  'EXT_LIGHTS',
  'Ext Glass',
  'Int Glass',
  'Pannel Glass',
  'STEER_DISPLAY',
  'STEER_DECALS',
]);

export type CarMaterialKind = 'paint' | 'carbon' | 'tire' | 'other' | 'skip';

export type CarMaterialsParams = {
  /** Master toggle for clearcoat + selective env overrides. */
  enabled: boolean;
  clearcoat: number;
  clearcoatRoughness: number;
  /** Env map intensity for paint / livery. */
  paintEnv: number;
  /** Env map intensity for carbon weave. */
  carbonEnv: number;
  /** Env map intensity for rubber. */
  tireEnv: number;
  /** Env map intensity for remaining body materials. */
  otherEnv: number;
};

export const DEFAULT_CAR_MATERIALS_PARAMS: CarMaterialsParams = {
  enabled: true,
  clearcoat: 1,
  clearcoatRoughness: 0.045,
  paintEnv: 1.05,
  carbonEnv: 0.38,
  tireEnv: 0.1,
  otherEnv: 0.32,
};

export type CarMaterialsHandle = {
  params: CarMaterialsParams;
  /** Convert / tag materials on a freshly loaded model. */
  enhance: (root: THREE.Object3D) => void;
  /** Re-apply clearcoat + selective env from params. */
  applyParams: () => void;
  /** Sync fallback "other" env from the lighting GUI. */
  setOtherEnv: (value: number) => void;
};

function classify(name: string): CarMaterialKind {
  if (SKIP_NAMES.has(name)) return 'skip';
  if (PAINT_NAMES.has(name)) return 'paint';
  if (CARBON_NAMES.has(name)) return 'carbon';
  if (TIRE_NAMES.has(name)) return 'tire';
  return 'other';
}

function isPbr(
  mat: THREE.Material,
): mat is THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
  return (
    mat instanceof THREE.MeshStandardMaterial ||
    mat instanceof THREE.MeshPhysicalMaterial
  );
}

function toPhysical(source: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  if (source instanceof THREE.MeshPhysicalMaterial) return source;
  // MeshPhysicalMaterial.copy() reads clearcoatNormalScale / sheenColor / etc.
  // from the source — those fields don't exist on MeshStandardMaterial and
  // throw "Cannot read properties of undefined (reading 'x')".
  const physical = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(physical, source);
  physical.name = source.name;
  physical.userData = { ...source.userData };
  physical.defines = { STANDARD: '', PHYSICAL: '' };
  return physical;
}

export function createCarMaterials(): CarMaterialsHandle {
  const params: CarMaterialsParams = { ...DEFAULT_CAR_MATERIALS_PARAMS };
  let root: THREE.Object3D | null = null;

  const enhance = (modelRoot: THREE.Object3D) => {
    root = modelRoot;

    // GLTF materials are often shared — convert each unique Standard once.
    const upgrades = new Map<THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial>();

    modelRoot.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      const nextList = list.map((mat) => {
        if (!isPbr(mat)) return mat;
        const kind = classify(mat.name);
        mat.userData.carMaterialKind = kind;
        if (kind !== 'paint' && kind !== 'carbon') return mat;
        if (mat instanceof THREE.MeshPhysicalMaterial) return mat;

        let upgraded = upgrades.get(mat);
        if (!upgraded) {
          upgraded = toPhysical(mat);
          upgraded.userData.carMaterialKind = kind;
          upgrades.set(mat, upgraded);
        }
        return upgraded;
      });

      obj.material = Array.isArray(obj.material) ? nextList : nextList[0]!;
    });

    // Dispose originals that were fully replaced
    for (const [original, upgraded] of upgrades) {
      if (original !== upgraded) original.dispose();
    }

    applyParams();
  };

  const envForKind = (kind: CarMaterialKind): number => {
    switch (kind) {
      case 'paint':
        return params.paintEnv;
      case 'carbon':
        return params.carbonEnv;
      case 'tire':
        return params.tireEnv;
      case 'other':
        return params.otherEnv;
      default:
        return params.otherEnv;
    }
  };

  const applyParams = () => {
    if (!root) return;

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!isPbr(mat)) continue;
        const kind =
          (mat.userData.carMaterialKind as CarMaterialKind) ?? classify(mat.name);
        if (kind === 'skip') continue;

        if (!params.enabled) {
          mat.envMapIntensity = params.otherEnv;
          continue;
        }

        mat.envMapIntensity = envForKind(kind);

        if (
          (kind === 'paint' || kind === 'carbon') &&
          mat instanceof THREE.MeshPhysicalMaterial
        ) {
          if (kind === 'paint') {
            mat.clearcoat = params.clearcoat;
            mat.clearcoatRoughness = params.clearcoatRoughness;
          } else {
            mat.clearcoat = Math.min(params.clearcoat, 0.85);
            mat.clearcoatRoughness = Math.max(params.clearcoatRoughness, 0.22);
          }
        }

        if (kind === 'tire') {
          mat.metalness = 0;
          mat.roughness = Math.max(mat.roughness, 0.82);
        }
      }
    });
  };

  const setOtherEnv = (value: number) => {
    params.otherEnv = value;
    applyParams();
  };

  return { params, enhance, applyParams, setOtherEnv };
}
