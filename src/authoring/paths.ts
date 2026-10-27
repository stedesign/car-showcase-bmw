import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  enableEditorOverlayPicking,
  markEditorOverlay,
} from '../viewer/editorOverlays';
import type { PathClip, Vec3 } from './project';
import { cloneVec3, nextAuthoringId, vec3 } from './project';

const CURVE_SAMPLES = 64;
const POINT_RADIUS = 0.11;
const MIN_POINTS = 2;

export type PathsHandle = {
  group: THREE.Group;
  entries: { id: string; params: PathClip }[];
  selectedId: string | null;
  selectedPointIndex: number;
  setFromProject: (paths: PathClip[]) => void;
  serialize: () => PathClip[];
  add: (partial?: Partial<PathClip>) => PathClip;
  remove: (id: string) => boolean;
  select: (id: string | null) => void;
  selectPoint: (index: number) => void;
  addPoint: (id: string) => number | null;
  removePoint: (id: string, index?: number) => boolean;
  apply: (id: string) => void;
  applyAll: () => void;
  getPointAt: (id: string, u: number) => Vec3 | null;
  getCurve: (id: string) => THREE.CatmullRomCurve3 | null;
  setHelpersVisible: (visible: boolean) => void;
  setPlaybackLocked: (locked: boolean) => void;
  setTransformEnabled: (enabled: boolean) => void;
  update: () => void;
  setOnTransformCommit: (fn: (() => void) | null) => void;
  /** Fired when control points change (drag, add/remove, apply). */
  setOnPointsChange: (fn: ((pathId: string) => void) | null) => void;
  dispose: () => void;
};

type Entry = {
  id: string;
  params: PathClip;
  curve: THREE.CatmullRomCurve3;
  line: THREE.Line;
  points: THREE.Mesh[];
};

function defaultPath(index: number, id: string): PathClip {
  return {
    id,
    name: `Path ${index}`,
    points: [
      vec3(-4.2, 1.35, 4.5),
      vec3(-1.2, 0.95, 5.8),
      vec3(2.0, 0.85, 5.2),
      vec3(5.2, 1.1, 2.2),
    ],
  };
}

function unlit(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
}

function unlitLine(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });
}

function toVectors(points: Vec3[]): THREE.Vector3[] {
  return points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
}

function buildCurve(points: Vec3[]): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(toVectors(points), false, 'centripetal', 0.5);
}

function sampleLinePositions(curve: THREE.CatmullRomCurve3): Float32Array {
  const arr = new Float32Array((CURVE_SAMPLES + 1) * 3);
  for (let i = 0; i <= CURVE_SAMPLES; i += 1) {
    const p = curve.getPoint(i / CURVE_SAMPLES);
    arr[i * 3] = p.x;
    arr[i * 3 + 1] = p.y;
    arr[i * 3 + 2] = p.z;
  }
  return arr;
}

export function createPathsHandle(
  scene: THREE.Scene,
  camera: THREE.Camera,
  domElement: HTMLElement,
  orbit: OrbitControls,
): PathsHandle {
  const group = new THREE.Group();
  group.name = 'AuthoringPaths';
  scene.add(group);

  const entries: Entry[] = [];
  let selectedId: string | null = null;
  let selectedPointIndex = 0;
  let transformEnabled = true;
  let helpersVisible = true;
  let playbackLocked = false;
  let helpersVisibleBeforePlayback = true;

  const transform = new TransformControls(camera, domElement);
  transform.setMode('translate');
  transform.setSize(0.85);
  transform.enabled = false;
  enableEditorOverlayPicking(transform);
  const helper = transform.getHelper();
  helper.visible = false;
  scene.add(helper);
  markEditorOverlay(helper);

  let onTransformCommit: (() => void) | null = null;
  let onPointsChange: ((pathId: string) => void) | null = null;

  transform.addEventListener('dragging-changed', (event) => {
    const dragging = (event as { value: boolean }).value;
    orbit.enabled = !dragging;
    if (!dragging) {
      const entry = entries.find((e) => e.id === selectedId);
      if (entry) {
        syncParamsFromMeshes(entry);
        rebuildCurveVisual(entry);
        onPointsChange?.(entry.id);
      }
      onTransformCommit?.();
    }
  });

  transform.addEventListener('objectChange', () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry) return;
    syncParamsFromMeshes(entry);
    rebuildCurveVisual(entry);
  });

  const syncParamsFromMeshes = (entry: Entry) => {
    entry.params.points = entry.points.map((mesh) =>
      vec3(mesh.position.x, mesh.position.y, mesh.position.z),
    );
  };

  const disposePoint = (mesh: THREE.Mesh) => {
    group.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  };

  const disposeEntry = (entry: Entry) => {
    group.remove(entry.line);
    entry.line.geometry.dispose();
    (entry.line.material as THREE.Material).dispose();
    for (const p of entry.points) disposePoint(p);
    entry.points.length = 0;
  };

  const rebuildPointMeshes = (entry: Entry) => {
    for (const p of entry.points) disposePoint(p);
    entry.points = entry.params.points.map((pt, i) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(POINT_RADIUS, 14, 10),
        unlit(0xf0c674),
      );
      mesh.position.set(pt.x, pt.y, pt.z);
      mesh.renderOrder = 24;
      mesh.name = `${entry.params.name}-pt-${i}`;
      group.add(mesh);
      markEditorOverlay(mesh);
      return mesh;
    });
  };

  const rebuildCurveVisual = (entry: Entry) => {
    entry.curve = buildCurve(entry.params.points);
    const positions = sampleLinePositions(entry.curve);
    entry.line.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    entry.line.geometry = geo;
  };

  const tintPoints = (entry: Entry) => {
    const selected = entry.id === selectedId;
    for (let i = 0; i < entry.points.length; i += 1) {
      const mesh = entry.points[i];
      const mat = mesh.material as THREE.MeshBasicMaterial;
      const isActive = selected && i === selectedPointIndex;
      mat.color.setHex(isActive ? 0xff8c42 : selected ? 0xf0c674 : 0xc8b87a);
      mesh.scale.setScalar(isActive ? 1.25 : 1);
    }
    (entry.line.material as THREE.LineBasicMaterial).color.setHex(
      selected ? 0x7aa8ff : 0xb8c0d0,
    );
  };

  const syncVisibility = () => {
    const visible = helpersVisible && !playbackLocked;
    group.visible = visible;
    helper.visible = visible && transform.enabled;
  };

  const attach = () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (
      !entry ||
      !transformEnabled ||
      playbackLocked ||
      !helpersVisible ||
      entry.points.length === 0
    ) {
      transform.detach();
      transform.enabled = false;
      helper.visible = false;
      return;
    }
    selectedPointIndex = Math.min(
      Math.max(0, selectedPointIndex),
      entry.points.length - 1,
    );
    transform.attach(entry.points[selectedPointIndex]);
    transform.enabled = true;
    helper.visible = true;
    tintPoints(entry);
    syncVisibility();
  };

  const applyEntry = (entry: Entry) => {
    rebuildPointMeshes(entry);
    rebuildCurveVisual(entry);
    tintPoints(entry);
    if (entry.id === selectedId) attach();
  };

  const add = (partial?: Partial<PathClip>): PathClip => {
    const id = partial?.id ?? nextAuthoringId('path');
    const base = defaultPath(entries.length + 1, id);
    const params: PathClip = {
      ...base,
      ...partial,
      id,
      points:
        partial?.points && partial.points.length >= MIN_POINTS
          ? partial.points.map(cloneVec3)
          : base.points.map(cloneVec3),
    };

    const curve = buildCurve(params.points);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(sampleLinePositions(curve), 3),
    );
    const line = new THREE.Line(geo, unlitLine(0xb8c0d0));
    line.renderOrder = 19;
    line.name = params.name;
    group.add(line);
    markEditorOverlay(line);

    const entry: Entry = {
      id: params.id,
      params,
      curve,
      line,
      points: [],
    };
    entries.push(entry);
    rebuildPointMeshes(entry);
    selectedId = params.id;
    selectedPointIndex = 0;
    tintPoints(entry);
    attach();
    return params;
  };

  return {
    group,
    get entries() {
      return entries.map((e) => ({ id: e.id, params: e.params }));
    },
    get selectedId() {
      return selectedId;
    },
    get selectedPointIndex() {
      return selectedPointIndex;
    },
    setFromProject(paths) {
      transform.detach();
      for (const e of entries) disposeEntry(e);
      entries.length = 0;
      for (const p of paths) add({ ...structuredClone(p) });
      selectedId = null;
      selectedPointIndex = 0;
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
        selectedPointIndex = 0;
      }
      disposeEntry(entry);
      attach();
      return true;
    },
    select(id) {
      selectedId = id;
      selectedPointIndex = 0;
      for (const e of entries) tintPoints(e);
      attach();
    },
    selectPoint(index) {
      const entry = entries.find((e) => e.id === selectedId);
      if (!entry) return;
      selectedPointIndex = Math.min(
        Math.max(0, index),
        Math.max(0, entry.points.length - 1),
      );
      tintPoints(entry);
      attach();
    },
    addPoint(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return null;
      const pts = entry.params.points;
      const i = Math.min(selectedPointIndex, pts.length - 1);
      const a = pts[i];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      const mid =
        i === pts.length - 1
          ? vec3(a.x + 0.8, a.y, a.z - 0.4)
          : vec3((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      pts.splice(i + 1, 0, mid);
      selectedPointIndex = i + 1;
      applyEntry(entry);
      onPointsChange?.(entry.id);
      return selectedPointIndex;
    },
    removePoint(id, index) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return false;
      if (entry.params.points.length <= MIN_POINTS) return false;
      const i = index ?? selectedPointIndex;
      if (i < 0 || i >= entry.params.points.length) return false;
      entry.params.points.splice(i, 1);
      selectedPointIndex = Math.min(i, entry.params.points.length - 1);
      applyEntry(entry);
      onPointsChange?.(entry.id);
      return true;
    },
    apply(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      applyEntry(entry);
      onPointsChange?.(entry.id);
    },
    applyAll() {
      for (const e of entries) applyEntry(e);
    },
    getPointAt(id, u) {
      const entry = entries.find((e) => e.id === id);
      if (!entry || entry.params.points.length < MIN_POINTS) return null;
      const t = Math.min(1, Math.max(0, u));
      const p = entry.curve.getPointAt(t);
      return vec3(p.x, p.y, p.z);
    },
    getCurve(id) {
      return entries.find((e) => e.id === id)?.curve ?? null;
    },
    setHelpersVisible(visible) {
      helpersVisible = visible;
      syncVisibility();
      attach();
    },
    setPlaybackLocked(locked) {
      if (locked && !playbackLocked) {
        helpersVisibleBeforePlayback = helpersVisible;
        helpersVisible = false;
      } else if (!locked && playbackLocked) {
        helpersVisible = helpersVisibleBeforePlayback;
      }
      playbackLocked = locked;
      syncVisibility();
      attach();
    },
    setTransformEnabled(enabled) {
      transformEnabled = enabled;
      attach();
    },
    update() {
      if (transformEnabled && selectedId && transform.dragging) {
        const entry = entries.find((e) => e.id === selectedId);
        if (entry) {
          syncParamsFromMeshes(entry);
          rebuildCurveVisual(entry);
        }
      }
    },
    setOnTransformCommit(fn) {
      onTransformCommit = fn;
    },
    setOnPointsChange(fn) {
      onPointsChange = fn;
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
