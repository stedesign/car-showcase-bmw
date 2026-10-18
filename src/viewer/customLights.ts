import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CustomLightType = 'point' | 'spot';

export type CustomLightParams = {
  /** Stable id for authoring / timeline (optional for legacy saves). */
  id?: string;
  name: string;
  type: CustomLightType;
  enabled: boolean;
  color: string;
  intensity: number;
  distance: number;
  decay: number;
  /** Spot cone half-angle in degrees (0–90). */
  angle: number;
  /** Spot soft edge 0–1. */
  penumbra: number;
  x: number;
  y: number;
  z: number;
  /** Euler rotation in degrees (aims the cone; ignored by point lights). */
  rotX: number;
  rotY: number;
  rotZ: number;
};

export type CustomLightEntry = {
  id: string;
  params: CustomLightParams;
  pivot: THREE.Object3D;
  light: THREE.PointLight | THREE.SpotLight;
  helper: THREE.PointLightHelper | THREE.SpotLightHelper;
};

export type TransformMode = 'translate' | 'rotate';

export type CustomLightsHandle = {
  entries: CustomLightEntry[];
  selectedId: string | null;
  showHelpers: boolean;
  transformEnabled: boolean;
  transformMode: TransformMode;
  add: (partial?: Partial<CustomLightParams>) => CustomLightEntry;
  addPoint: () => CustomLightEntry;
  addSpot: () => CustomLightEntry;
  removeSelected: () => boolean;
  /** Remove every custom light. */
  clearAll: () => void;
  /** Replace lights from a serializable params list. */
  replaceAll: (list: CustomLightParams[]) => void;
  select: (id: string | null) => void;
  apply: (id: string) => void;
  applyAll: () => void;
  setShowHelpers: (visible: boolean) => void;
  setTransformEnabled: (enabled: boolean) => void;
  setTransformMode: (mode: TransformMode) => void;
  /** Sync transform gizmo → params (call each frame). */
  update: () => void;
  dispose: () => void;
};

let nextId = 1;

function defaultParams(
  index: number,
  type: CustomLightType = 'point',
): CustomLightParams {
  const yaw = (index * 0.7) % (Math.PI * 2);
  const radius = type === 'spot' ? 5 : 3.5;
  const x = Math.cos(yaw) * radius;
  const y = type === 'spot' ? 3.5 : 2;
  const z = Math.sin(yaw) * radius;

  // Aim spot toward car center-ish
  const look = new THREE.Object3D();
  look.position.set(x, y, z);
  look.lookAt(0, 0.55, 0);

  return {
    name: type === 'spot' ? `Cone ${index}` : `Light ${index}`,
    type,
    enabled: true,
    color: type === 'spot' ? '#ffe6c8' : '#ff0000',
    intensity: type === 'spot' ? 4 : 2,
    distance: type === 'spot' ? 18 : 10,
    decay: 2,
    angle: 35,
    penumbra: 0.35,
    x,
    y,
    z,
    rotX: THREE.MathUtils.radToDeg(look.rotation.x),
    rotY: THREE.MathUtils.radToDeg(look.rotation.y),
    rotZ: THREE.MathUtils.radToDeg(look.rotation.z),
  };
}

function createHelper(
  light: THREE.PointLight | THREE.SpotLight,
): THREE.PointLightHelper | THREE.SpotLightHelper {
  if (light instanceof THREE.SpotLight) {
    return new THREE.SpotLightHelper(light);
  }
  return new THREE.PointLightHelper(light, 0.25);
}

export function createCustomLights(
  scene: THREE.Scene,
  camera: THREE.Camera,
  domElement: HTMLElement,
  orbit: OrbitControls,
): CustomLightsHandle {
  const group = new THREE.Group();
  group.name = 'CustomLights';
  scene.add(group);

  const entries: CustomLightEntry[] = [];
  let selectedId: string | null = null;
  let showHelpers = true;
  let transformEnabled = true;
  let transformMode: TransformMode = 'translate';

  const transform = new TransformControls(camera, domElement);
  transform.setMode('translate');
  transform.setSize(0.85);
  transform.enabled = false;
  const transformHelper = transform.getHelper();
  transformHelper.visible = false;
  scene.add(transformHelper);

  transform.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !(event as { value: boolean }).value;
  });

  transform.addEventListener('objectChange', () => {
    syncSelectedFromPivot();
  });

  const syncSelectedFromPivot = () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry) return;
    const { pivot, params } = entry;
    params.x = pivot.position.x;
    params.y = pivot.position.y;
    params.z = pivot.position.z;
    params.rotX = THREE.MathUtils.radToDeg(pivot.rotation.x);
    params.rotY = THREE.MathUtils.radToDeg(pivot.rotation.y);
    params.rotZ = THREE.MathUtils.radToDeg(pivot.rotation.z);
    entry.helper.update();
  };

  const applyEntry = (entry: CustomLightEntry) => {
    const { light, helper, pivot, params } = entry;

    pivot.position.set(params.x, params.y, params.z);
    pivot.rotation.set(
      THREE.MathUtils.degToRad(params.rotX),
      THREE.MathUtils.degToRad(params.rotY),
      THREE.MathUtils.degToRad(params.rotZ),
    );

    light.color.set(params.color);
    light.intensity = params.enabled ? params.intensity : 0;
    light.distance = params.distance;
    light.decay = params.decay;
    light.visible = params.enabled;

    if (light instanceof THREE.SpotLight) {
      light.angle = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(params.angle, 1, 90));
      light.penumbra = THREE.MathUtils.clamp(params.penumbra, 0, 1);
    }

    helper.visible = showHelpers && params.enabled;
    helper.update();
  };

  const attachTransform = () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry || !transformEnabled || !entry.params.enabled) {
      transform.detach();
      transform.enabled = false;
      transformHelper.visible = false;
      return;
    }
    // Point lights: translate only. Spots: translate or rotate.
    const mode =
      entry.params.type === 'point' ? 'translate' : transformMode;
    transform.setMode(mode);
    transform.attach(entry.pivot);
    transform.enabled = true;
    transformHelper.visible = true;
  };

  const add = (partial?: Partial<CustomLightParams>): CustomLightEntry => {
    const type = partial?.type ?? 'point';
    const id = partial?.id ?? `custom-light-${nextId}`;
    const params: CustomLightParams = {
      ...defaultParams(nextId, type),
      ...partial,
      type,
      id,
    };
    nextId += 1;
    const num = parseInt(id.replace(/\D/g, ''), 10);
    if (!Number.isNaN(num)) nextId = Math.max(nextId, num + 1);

    const pivot = new THREE.Object3D();
    pivot.name = params.name;
    pivot.position.set(params.x, params.y, params.z);
    pivot.rotation.set(
      THREE.MathUtils.degToRad(params.rotX),
      THREE.MathUtils.degToRad(params.rotY),
      THREE.MathUtils.degToRad(params.rotZ),
    );

    let light: THREE.PointLight | THREE.SpotLight;
    if (type === 'spot') {
      const spot = new THREE.SpotLight(
        params.color,
        params.intensity,
        params.distance,
        THREE.MathUtils.degToRad(params.angle),
        params.penumbra,
        params.decay,
      );
      // Aim along local -Z via child target (SpotLight ignores object rotation)
      spot.target.position.set(0, 0, -1);
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.bias = -0.0002;
      spot.shadow.normalBias = 0.02;
      pivot.add(spot);
      pivot.add(spot.target);
      light = spot;
    } else {
      light = new THREE.PointLight(
        params.color,
        params.intensity,
        params.distance,
        params.decay,
      );
      light.castShadow = true;
      light.shadow.mapSize.set(512, 512);
      pivot.add(light);
    }
    light.name = params.name;

    const helper = createHelper(light);
    helper.visible = showHelpers;

    group.add(pivot);
    group.add(helper);

    const entry: CustomLightEntry = { id, params, pivot, light, helper };
    entries.push(entry);
    applyEntry(entry);
    selectedId = id;
    if (type === 'spot') transformMode = 'translate';
    attachTransform();
    return entry;
  };

  const addPoint = () => add({ type: 'point' });
  const addSpot = () => add({ type: 'spot' });

  const disposeEntry = (entry: CustomLightEntry) => {
    group.remove(entry.helper);
    group.remove(entry.pivot);
    entry.helper.dispose();
    entry.light.dispose();
  };

  const removeSelected = (): boolean => {
    if (!selectedId) return false;
    const index = entries.findIndex((e) => e.id === selectedId);
    if (index < 0) return false;

    const [entry] = entries.splice(index, 1);
    transform.detach();
    disposeEntry(entry);

    selectedId = entries[entries.length - 1]?.id ?? null;
    attachTransform();
    return true;
  };

  const clearAll = () => {
    transform.detach();
    for (const entry of entries) disposeEntry(entry);
    entries.length = 0;
    selectedId = null;
  };

  const replaceAll = (list: CustomLightParams[]) => {
    clearAll();
    for (const params of list) {
      add({ ...params, id: params.id });
    }
    selectedId = entries[0]?.id ?? null;
    attachTransform();
  };

  const select = (id: string | null) => {
    selectedId = id;
    attachTransform();
  };

  const apply = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.light.name = entry.params.name;
    entry.pivot.name = entry.params.name;
    applyEntry(entry);
    if (id === selectedId) attachTransform();
  };

  const applyAll = () => {
    for (const entry of entries) applyEntry(entry);
    attachTransform();
  };

  const setShowHelpers = (visible: boolean) => {
    showHelpers = visible;
    for (const entry of entries) {
      entry.helper.visible = visible && entry.params.enabled;
    }
  };

  const setTransformEnabled = (enabled: boolean) => {
    transformEnabled = enabled;
    attachTransform();
  };

  const setTransformMode = (mode: TransformMode) => {
    transformMode = mode;
    attachTransform();
  };

  const update = () => {
    if (transformEnabled && selectedId && transform.dragging) {
      syncSelectedFromPivot();
    }
    for (const entry of entries) {
      if (entry.helper.visible) entry.helper.update();
    }
  };

  const dispose = () => {
    transform.detach();
    transform.dispose();
    scene.remove(transformHelper);
    for (const entry of entries) {
      entry.helper.dispose();
      entry.light.dispose();
    }
    entries.length = 0;
    scene.remove(group);
  };

  return {
    get entries() {
      return entries;
    },
    get selectedId() {
      return selectedId;
    },
    get showHelpers() {
      return showHelpers;
    },
    get transformEnabled() {
      return transformEnabled;
    },
    get transformMode() {
      return transformMode;
    },
    add,
    addPoint,
    addSpot,
    removeSelected,
    clearAll,
    replaceAll,
    select,
    apply,
    applyAll,
    setShowHelpers,
    setTransformEnabled,
    setTransformMode,
    update,
    dispose,
  };
}
