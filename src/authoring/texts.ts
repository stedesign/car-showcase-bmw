import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { carSpecs } from '../data/carSpecs';
import type { TextClip, Vec3 } from './project';
import { cloneVec3, nextAuthoringId, vec3 } from './project';

export type TextTransformMode = 'translate' | 'rotate' | 'scale';

export type TextsHandle = {
  group: THREE.Group;
  entries: { id: string; params: TextClip; mesh: THREE.Mesh }[];
  selectedId: string | null;
  setFromProject: (texts: TextClip[]) => void;
  serialize: () => TextClip[];
  add: (partial?: Partial<TextClip>) => TextClip;
  remove: (id: string) => boolean;
  select: (id: string | null) => void;
  apply: (id: string) => void;
  applyAll: () => void;
  redraw: (id: string) => void;
  setTransformEnabled: (enabled: boolean) => void;
  setTransformMode: (mode: TextTransformMode) => void;
  update: (camera: THREE.Camera) => void;
  getObject3D: (id: string) => THREE.Object3D | null;
  /** Fired when a transform-gizmo drag ends (for undo history). */
  setOnTransformCommit: (fn: (() => void) | null) => void;
  dispose: () => void;
};

export const TEXT_PRESETS: { label: string; content: string }[] = [
  { label: 'Car name', content: carSpecs.name },
  { label: 'Team', content: carSpecs.team },
  { label: 'Class', content: `${carSpecs.class} · #${carSpecs.number}` },
  { label: 'Championship', content: carSpecs.championship },
  {
    label: 'Power',
    content: `${carSpecs.engine.maxTorque} · ${carSpecs.engine.displacement}`,
  },
  { label: 'Drivers', content: carSpecs.drivers.join('  ·  ') },
  { label: 'Weight', content: carSpecs.body.weight },
  { label: 'Tagline', content: 'Precision. Endurance. WRT.' },
];

type Entry = {
  id: string;
  params: TextClip;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
};

function defaultText(index: number): TextClip {
  return {
    id: nextAuthoringId('text'),
    name: `Text ${index}`,
    content: carSpecs.name,
    position: vec3(-2.2, 1.4, 2),
    rotation: vec3(0, 15, 0),
    scale: 1,
    opacity: 1,
    align: 'left',
    color: '#ffffff',
    billboard: false,
  };
}

function drawText(entry: Entry) {
  const { canvas, params, texture, material, mesh } = entry;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const padX = 48;
  const padY = 36;
  const fontSize = 72;
  const lines = params.content.split('\n');
  ctx.font = `600 ${fontSize}px "Helvetica Neue", Helvetica, Arial, sans-serif`;

  let maxW = 0;
  for (const line of lines) {
    maxW = Math.max(maxW, ctx.measureText(line).width);
  }
  const lineH = fontSize * 1.2;
  const w = Math.ceil(maxW + padX * 2);
  const h = Math.ceil(lines.length * lineH + padY * 2);
  canvas.width = Math.max(64, w);
  canvas.height = Math.max(64, h);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `600 ${fontSize}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = params.color;
  ctx.textBaseline = 'top';
  ctx.textAlign =
    params.align === 'center' ? 'center' : params.align === 'right' ? 'right' : 'left';
  const x =
    params.align === 'center'
      ? canvas.width / 2
      : params.align === 'right'
        ? canvas.width - padX
        : padX;

  // Soft shadow for legibility on bright paint
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;

  lines.forEach((line, i) => {
    ctx.fillText(line, x, padY + i * lineH);
  });

  texture.needsUpdate = true;
  material.opacity = params.opacity;
  material.transparent = true;
  mesh.visible = params.opacity > 0.001;

  const worldW = 2.8 * params.scale;
  const aspect = canvas.width / canvas.height;
  mesh.scale.set(worldW, worldW / aspect, 1);
}

export function createTextsHandle(
  scene: THREE.Scene,
  camera: THREE.Camera,
  domElement: HTMLElement,
  orbit: OrbitControls,
): TextsHandle {
  const group = new THREE.Group();
  group.name = 'AuthoringTexts';
  scene.add(group);

  const entries: Entry[] = [];
  let selectedId: string | null = null;
  let transformEnabled = true;
  let transformMode: TextTransformMode = 'translate';

  const transform = new TransformControls(camera, domElement);
  transform.setMode('translate');
  transform.setSize(0.75);
  transform.enabled = false;
  const helper = transform.getHelper();
  helper.visible = false;
  scene.add(helper);

  let onTransformCommit: (() => void) | null = null;

  transform.addEventListener('dragging-changed', (event) => {
    const dragging = (event as { value: boolean }).value;
    orbit.enabled = !dragging;
    if (!dragging) onTransformCommit?.();
  });

  const syncFromMesh = (entry: Entry) => {
    const { mesh, params } = entry;
    params.position = vec3(mesh.position.x, mesh.position.y, mesh.position.z);
    if (!params.billboard) {
      params.rotation = vec3(
        THREE.MathUtils.radToDeg(mesh.rotation.x),
        THREE.MathUtils.radToDeg(mesh.rotation.y),
        THREE.MathUtils.radToDeg(mesh.rotation.z),
      );
    }
    // Uniform scale from X
    params.scale = Math.max(0.15, mesh.userData.baseScaleX
      ? mesh.scale.x / mesh.userData.baseScaleX
      : params.scale);
  };

  transform.addEventListener('objectChange', () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry) return;
    if (transformMode === 'scale') {
      const sx = entry.mesh.scale.x;
      const base = entry.mesh.userData.baseScaleX ?? sx;
      entry.params.scale = Math.max(0.15, sx / base);
      drawText(entry);
      entry.mesh.userData.baseScaleX = entry.mesh.scale.x / entry.params.scale;
    } else {
      syncFromMesh(entry);
    }
  });

  const applyEntry = (entry: Entry) => {
    const { mesh, params } = entry;
    mesh.position.set(params.position.x, params.position.y, params.position.z);
    if (!params.billboard) {
      mesh.rotation.set(
        THREE.MathUtils.degToRad(params.rotation.x),
        THREE.MathUtils.degToRad(params.rotation.y),
        THREE.MathUtils.degToRad(params.rotation.z),
      );
    }
    mesh.name = params.name;
    drawText(entry);
    entry.mesh.userData.baseScaleX = entry.mesh.scale.x / Math.max(0.15, params.scale);
  };

  const attach = () => {
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry || !transformEnabled) {
      transform.detach();
      transform.enabled = false;
      helper.visible = false;
      return;
    }
    transform.setMode(transformMode === 'scale' ? 'scale' : transformMode);
    transform.attach(entry.mesh);
    transform.enabled = true;
    helper.visible = true;
  };

  const add = (partial?: Partial<TextClip>): TextClip => {
    const params: TextClip = {
      ...defaultText(entries.length + 1),
      ...partial,
      id: partial?.id ?? nextAuthoringId('text'),
      position: partial?.position ? cloneVec3(partial.position) : vec3(-2.2, 1.4, 2),
      rotation: partial?.rotation ? cloneVec3(partial.rotation) : vec3(0, 15, 0),
    };

    const canvas = document.createElement('canvas');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.renderOrder = 10;

    const entry: Entry = { id: params.id, params, mesh, material, texture, canvas };
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
    entry.texture.dispose();
  };

  return {
    group,
    get entries() {
      return entries.map((e) => ({ id: e.id, params: e.params, mesh: e.mesh }));
    },
    get selectedId() {
      return selectedId;
    },
    setFromProject(texts) {
      transform.detach();
      for (const e of entries) disposeEntry(e);
      entries.length = 0;
      for (const t of texts) add({ ...structuredClone(t) });
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
    redraw(id) {
      const entry = entries.find((e) => e.id === id);
      if (entry) drawText(entry);
    },
    setTransformEnabled(enabled) {
      transformEnabled = enabled;
      attach();
    },
    setTransformMode(mode) {
      transformMode = mode;
      attach();
    },
    update(cam) {
      for (const entry of entries) {
        if (entry.params.billboard) {
          entry.mesh.quaternion.copy(cam.quaternion);
        }
      }
      if (transformEnabled && selectedId && transform.dragging) {
        const entry = entries.find((e) => e.id === selectedId);
        if (entry && transformMode !== 'scale') syncFromMesh(entry);
      }
    },
    getObject3D(id) {
      return entries.find((e) => e.id === id)?.mesh ?? null;
    },
    setOnTransformCommit(fn) {
      onTransformCommit = fn;
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

export function setTextPosition(params: TextClip, v: Vec3) {
  params.position = cloneVec3(v);
}
