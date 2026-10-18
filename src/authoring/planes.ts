import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PlaneClip, Vec3 } from './project';
import { cloneVec3, nextAuthoringId, vec3 } from './project';

export type PlaneTransformMode = 'translate' | 'rotate' | 'scale';

export type PlanesHandle = {
  group: THREE.Group;
  entries: { id: string; params: PlaneClip; mesh: THREE.Mesh }[];
  selectedId: string | null;
  setFromProject: (planes: PlaneClip[]) => void;
  serialize: () => PlaneClip[];
  add: (partial?: Partial<PlaneClip>) => PlaneClip;
  remove: (id: string) => boolean;
  select: (id: string | null) => void;
  apply: (id: string) => void;
  applyAll: () => void;
  setTransformEnabled: (enabled: boolean) => void;
  setTransformMode: (mode: PlaneTransformMode) => void;
  update: () => void;
  getObject3D: (id: string) => THREE.Object3D | null;
  dispose: () => void;
};

type Entry = {
  id: string;
  params: PlaneClip;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
};

function defaultPlane(index: number, id: string): PlaneClip {
  return {
    id,
    name: `Plane ${index}`,
    position: vec3(-1.5, 1.2, 2.5),
    rotation: vec3(0, 25, 0),
    scale: vec3(2.4, 1.6, 1),
    opacity: 1,
    castShadow: true,
    color: '#0a0a0a',
  };
}

export function createPlanesHandle(
  scene: THREE.Scene,
  camera: THREE.Camera,
  domElement: HTMLElement,
  orbit: OrbitControls,
): PlanesHandle {
  const group = new THREE.Group();
  group.name = 'AuthoringPlanes';
  scene.add(group);

  const entries: Entry[] = [];
  let selectedId: string | null = null;
  let transformEnabled = true;
  let transformMode: PlaneTransformMode = 'translate';

  const transform = new TransformControls(camera, domElement);
  transform.setMode('translate');
  transform.setSize(0.8);
  transform.enabled = false;
  const helper = transform.getHelper();
  helper.visible = false;
  scene.add(helper);

  transform.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !(event as { value: boolean }).value;
  });

  const syncFromMesh = (entry: Entry) => {
    const { mesh, params } = entry;
    params.position = vec3(mesh.position.x, mesh.position.y, mesh.position.z);
    params.rotation = vec3(
      THREE.MathUtils.radToDeg(mesh.rotation.x),
      THREE.MathUtils.radToDeg(mesh.rotation.y),
      THREE.MathUtils.radToDeg(mesh.rotation.z),
    );
    params.scale = vec3(mesh.scale.x, mesh.scale.y, mesh.scale.z);
  };

  transform.addEventListener('objectChange', () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (entry) syncFromMesh(entry);
  });

  const applyEntry = (entry: Entry) => {
    const { mesh, material, params } = entry;
    mesh.position.set(params.position.x, params.position.y, params.position.z);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(params.rotation.x),
      THREE.MathUtils.degToRad(params.rotation.y),
      THREE.MathUtils.degToRad(params.rotation.z),
    );
    mesh.scale.set(params.scale.x, params.scale.y, params.scale.z);
    material.color.set(params.color);
    material.opacity = params.opacity;
    material.transparent = params.opacity < 0.999;
    material.depthWrite = params.opacity >= 0.999;
    mesh.castShadow = params.castShadow;
    mesh.visible = params.opacity > 0.001;
    mesh.name = params.name;
  };

  const attach = () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry || !transformEnabled) {
      transform.detach();
      transform.enabled = false;
      helper.visible = false;
      return;
    }
    transform.setMode(transformMode);
    transform.attach(entry.mesh);
    transform.enabled = true;
    helper.visible = true;
  };

  const add = (partial?: Partial<PlaneClip>): PlaneClip => {
    const id = partial?.id ?? nextAuthoringId('plane');
    const base = defaultPlane(entries.length + 1, id);
    const params: PlaneClip = {
      ...base,
      ...partial,
      id,
      position: partial?.position ? cloneVec3(partial.position) : base.position,
      rotation: partial?.rotation ? cloneVec3(partial.rotation) : base.rotation,
      scale: partial?.scale ? cloneVec3(partial.scale) : base.scale,
    };

    const material = new THREE.MeshStandardMaterial({
      color: params.color,
      roughness: 1,
      metalness: 0,
      transparent: params.opacity < 0.999,
      opacity: params.opacity,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.castShadow = params.castShadow;
    mesh.receiveShadow = false;

    const entry: Entry = { id: params.id, params, mesh, material };
    entries.push(entry);
    group.add(mesh);
    applyEntry(entry);
    selectedId = params.id;
    attach();
    return params;
  };

  const disposeEntry = (entry: Entry) => {
    group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.material.dispose();
  };

  return {
    group,
    get entries() {
      return entries.map((e) => ({ id: e.id, params: e.params, mesh: e.mesh }));
    },
    get selectedId() {
      return selectedId;
    },
    setFromProject(planes) {
      transform.detach();
      for (const e of entries) disposeEntry(e);
      entries.length = 0;
      for (const p of planes) add({ ...structuredClone(p) });
      selectedId = null;
      attach();
    },
    serialize() {
      return entries.map((e) => structuredClone(e.params));
    },
    add,
    remove(id) {
      const index = entries.findIndex((e) => e.id === id);
      if (index < 0) return false;
      const [entry] = entries.splice(index, 1);
      if (selectedId === id) {
        transform.detach();
        selectedId = null;
      }
      disposeEntry(entry);
      attach();
      return true;
    },
    select(id) {
      selectedId = id;
      attach();
    },
    apply(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      applyEntry(entry);
      if (id === selectedId) attach();
    },
    applyAll() {
      for (const e of entries) applyEntry(e);
    },
    setTransformEnabled(enabled) {
      transformEnabled = enabled;
      attach();
    },
    setTransformMode(mode) {
      transformMode = mode;
      attach();
    },
    update() {
      if (transformEnabled && selectedId && transform.dragging) {
        const entry = entries.find((e) => e.id === selectedId);
        if (entry) syncFromMesh(entry);
      }
    },
    getObject3D(id) {
      return entries.find((e) => e.id === id)?.mesh ?? null;
    },
    dispose() {
      transform.detach();
      transform.dispose();
      scene.remove(helper);
      for (const e of entries) disposeEntry(e);
      entries.length = 0;
      scene.remove(group);
    },
  };
}

export function setPlaneVec3(params: PlaneClip, key: 'position' | 'rotation' | 'scale', v: Vec3) {
  params[key] = cloneVec3(v);
}
