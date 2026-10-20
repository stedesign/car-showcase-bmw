import {
  captureSettings,
  type SavedSettings,
} from '../viewer/settings';
import type { Viewer } from '../viewer/Viewer';
import { createStoryboardProject } from './storyboard';

export const PROJECT_STORAGE_KEY = 'wrt-paddock-project';
export const PROJECT_VERSION = 3 as const;
export const LEGACY_PROJECT_VERSION = 2 as const;

export type Vec3 = { x: number; y: number; z: number };

export type CameraClip = {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
};

export type PlaneClip = {
  id: string;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  opacity: number;
  castShadow: boolean;
  color: string;
  /** When true, render as a box (scale.z = depth); otherwise a flat plane. */
  extrude: boolean;
};

export type TextAlign = 'left' | 'center' | 'right';

export type TextClip = {
  id: string;
  name: string;
  content: string;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  opacity: number;
  align: TextAlign;
  color: string;
  /** Face the active camera each frame. */
  billboard: boolean;
};

export type EasingName = 'linear' | 'easeInOut';

/** CSS-style cubic-bezier control points (into this keyframe). */
export type CubicBezier = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type KeyframeValue =
  | number
  | string
  | boolean
  | Vec3
  | CameraPoseValue;

export type CameraPoseValue = {
  position: Vec3;
  target: Vec3;
  fov: number;
};

export type Keyframe = {
  t: number;
  value: KeyframeValue;
  easing?: EasingName;
  /** When set, overrides `easing` for interpolation into this key. */
  bezier?: CubicBezier;
};

export type TimelineTrack = {
  id: string;
  /** e.g. camera.active | camera.<id>.pose | plane.<id>.position | light.<id>.intensity */
  target: string;
  keyframes: Keyframe[];
};

/** Per-scene authoring document (look, cameras, timeline). */
export type Scene = {
  id: string;
  name: string;
  duration: number;
  playCameraId: string;
  /** When false, the car mesh (and attached car-light FX) are hidden. */
  carVisible: boolean;
  look: SavedSettings;
  cameras: CameraClip[];
  planes: PlaneClip[];
  texts: TextClip[];
  timeline: { tracks: TimelineTrack[] };
};

export type MasterClip = {
  id: string;
  sceneId: string;
  /** Local in-point on the scene timeline (seconds). */
  in: number;
  /** Local out-point on the scene timeline (seconds). */
  out: number;
};

export type EditorMode = 'scene' | 'master';

export type Project = {
  version: typeof PROJECT_VERSION;
  name: string;
  fps: number;
  activeSceneId: string;
  editorMode: EditorMode;
  scenes: Scene[];
  master: { clips: MasterClip[] };
};

/** Flat v2 project shape (pre-scenes). */
type LegacyProjectV2 = {
  version: 2;
  name: string;
  duration: number;
  fps: number;
  playCameraId: string;
  carVisible?: boolean;
  look: SavedSettings;
  cameras: CameraClip[];
  planes?: PlaneClip[];
  texts?: TextClip[];
  timeline: { tracks: TimelineTrack[] };
};

export type SelectionKind =
  | 'freeCamera'
  | 'camera'
  | 'light'
  | 'car'
  | 'carLights'
  | 'roofStrobe'
  | 'lighting'
  | 'dotGrid'
  | 'plane'
  | 'text'
  | null;

/** Fixed selection id for the vehicle light rig (timeline: carLights.*). */
export const CAR_LIGHTS_ID = 'car-lights';

/** Fixed selection id for the roof softbox strobe (timeline: roofStrobe.*). */
export const ROOF_STROBE_ID = 'roof-strobe';

/** Fixed selection id for Look → Lighting (timeline: lighting.*). */
export const LIGHTING_ID = 'lighting';

/** Fixed selection id for the dotted WRT screen (timeline: dotGrid.*). */
export const DOT_GRID_ID = 'dot-grid';

/** Fixed selection id for the car model (timeline: car.visible). */
export const CAR_ID = 'car';

/** Fixed selection id for the orbit / free viewport camera. */
export const FREE_CAMERA_ID = 'free-camera';

export type Selection = {
  kind: SelectionKind;
  id: string | null;
};

let idCounter = 1;

export function nextAuthoringId(prefix: string): string {
  const id = `${prefix}-${idCounter}`;
  idCounter += 1;
  return id;
}

export function resetAuthoringIdCounter(min = 1) {
  idCounter = Math.max(min, 1);
}

function considerId(id: string, max: { n: number }) {
  const m = id.match(/(\d+)$/);
  if (m) max.n = Math.max(max.n, parseInt(m[1], 10));
}

export function syncIdCounterFromScene(scene: Scene) {
  const max = { n: 0 };
  considerId(scene.id, max);
  scene.cameras.forEach((c) => considerId(c.id, max));
  scene.planes.forEach((p) => considerId(p.id, max));
  scene.texts.forEach((t) => considerId(t.id, max));
  scene.timeline.tracks.forEach((t) => considerId(t.id, max));
  resetAuthoringIdCounter(max.n + 1);
}

export function syncIdCounterFromProject(project: Project) {
  const max = { n: 0 };
  considerId(project.activeSceneId, max);
  for (const scene of project.scenes) {
    considerId(scene.id, max);
    scene.cameras.forEach((c) => considerId(c.id, max));
    scene.planes.forEach((p) => considerId(p.id, max));
    scene.texts.forEach((t) => considerId(t.id, max));
    scene.timeline.tracks.forEach((t) => considerId(t.id, max));
  }
  for (const clip of project.master.clips) {
    considerId(clip.id, max);
    considerId(clip.sceneId, max);
  }
  resetAuthoringIdCounter(max.n + 1);
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function createDefaultCameras(viewer?: Viewer): CameraClip[] {
  const pos = viewer
    ? vec3(viewer.camera.position.x, viewer.camera.position.y, viewer.camera.position.z)
    : vec3(0.15, 0.55, 6.8);
  const target = viewer
    ? vec3(viewer.controls.target.x, viewer.controls.target.y, viewer.controls.target.z)
    : vec3(0, 0.45, 0);
  const fov = viewer?.camera.fov ?? 32;

  return [
    {
      id: nextAuthoringId('camera'),
      name: 'Hero',
      position: cloneVec3(pos),
      target: cloneVec3(target),
      fov,
    },
    {
      id: nextAuthoringId('camera'),
      name: 'Front 3/4',
      position: vec3(pos.x + 2.2, pos.y + 0.15, pos.z - 1.5),
      target: cloneVec3(target),
      fov,
    },
    {
      id: nextAuthoringId('camera'),
      name: 'Side',
      position: vec3(target.x + 6.5, target.y + 0.4, target.z),
      target: cloneVec3(target),
      fov,
    },
  ];
}

export function getActiveScene(project: Project): Scene {
  const scene =
    project.scenes.find((s) => s.id === project.activeSceneId) ?? project.scenes[0];
  if (!scene) throw new Error('Project has no scenes');
  if (project.activeSceneId !== scene.id) project.activeSceneId = scene.id;
  return scene;
}

export function getSceneById(project: Project, sceneId: string): Scene | null {
  return project.scenes.find((s) => s.id === sceneId) ?? null;
}

export function clipDuration(clip: MasterClip): number {
  return Math.max(0.05, clip.out - clip.in);
}

export function masterDuration(project: Project): number {
  return project.master.clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Build a blank scene cloned from an existing look. */
export function createBlankScene(name: string, look: SavedSettings, viewer?: Viewer): Scene {
  const cameras = createDefaultCameras(viewer);
  return {
    id: nextAuthoringId('scene'),
    name,
    duration: 8,
    playCameraId: cameras[0].id,
    carVisible: true,
    look: structuredClone(look),
    cameras,
    planes: [],
    texts: [],
    timeline: { tracks: [] },
  };
}

export function wrapSceneAsProject(
  scene: Scene,
  name: string,
  fps = 30,
): Project {
  const clip: MasterClip = {
    id: nextAuthoringId('mclip'),
    sceneId: scene.id,
    in: 0,
    out: scene.duration,
  };
  return {
    version: PROJECT_VERSION,
    name,
    fps,
    activeSceneId: scene.id,
    editorMode: 'scene',
    scenes: [scene],
    master: { clips: [clip] },
  };
}

export function migrateLegacyV2(legacy: LegacyProjectV2): Project {
  const scene: Scene = {
    id: nextAuthoringId('scene'),
    name: 'Scene 1',
    duration: legacy.duration,
    playCameraId: legacy.playCameraId,
    carVisible: legacy.carVisible !== false,
    look: structuredClone(legacy.look),
    cameras: structuredClone(legacy.cameras),
    planes: structuredClone(legacy.planes ?? []),
    texts: structuredClone(legacy.texts ?? []),
    timeline: { tracks: structuredClone(legacy.timeline.tracks) },
  };
  for (const plane of scene.planes) {
    if (typeof plane.extrude !== 'boolean') plane.extrude = false;
  }
  return wrapSceneAsProject(scene, legacy.name, legacy.fps);
}

export function addSceneToProject(project: Project, scene: Scene): Scene {
  project.scenes.push(scene);
  project.activeSceneId = scene.id;
  return scene;
}

export function duplicateScene(project: Project, sceneId: string): Scene | null {
  const source = getSceneById(project, sceneId);
  if (!source) return null;
  const copy = structuredClone(source);
  copy.id = nextAuthoringId('scene');
  copy.name = `${source.name} Copy`;
  // Remap camera / plane / text / track ids so scenes stay independent.
  const idMap = new Map<string, string>();
  for (const cam of copy.cameras) {
    const nid = nextAuthoringId('camera');
    idMap.set(cam.id, nid);
    cam.id = nid;
  }
  for (const plane of copy.planes) {
    const nid = nextAuthoringId('plane');
    idMap.set(plane.id, nid);
    plane.id = nid;
  }
  for (const text of copy.texts) {
    const nid = nextAuthoringId('text');
    idMap.set(text.id, nid);
    text.id = nid;
  }
  for (const track of copy.timeline.tracks) {
    track.id = nextAuthoringId('track');
    // Remap target ids embedded in track targets.
    const parts = track.target.split('.');
    if (parts.length >= 2 && idMap.has(parts[1])) {
      parts[1] = idMap.get(parts[1])!;
      track.target = parts.join('.');
    }
    // Remap camera.active keyframe values
    if (track.target === 'camera.active') {
      for (const kf of track.keyframes) {
        if (typeof kf.value === 'string' && idMap.has(kf.value)) {
          kf.value = idMap.get(kf.value)!;
        }
      }
    }
  }
  if (idMap.has(copy.playCameraId)) {
    copy.playCameraId = idMap.get(copy.playCameraId)!;
  }
  project.scenes.push(copy);
  project.activeSceneId = copy.id;
  return copy;
}

export function deleteScene(project: Project, sceneId: string): boolean {
  if (project.scenes.length <= 1) return false;
  const idx = project.scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) return false;
  project.scenes.splice(idx, 1);
  project.master.clips = project.master.clips.filter((c) => c.sceneId !== sceneId);
  if (project.activeSceneId === sceneId) {
    project.activeSceneId = project.scenes[Math.min(idx, project.scenes.length - 1)].id;
  }
  // Ensure master still has at least one clip if scenes remain.
  if (!project.master.clips.length && project.scenes.length) {
    const s = project.scenes[0];
    project.master.clips.push({
      id: nextAuthoringId('mclip'),
      sceneId: s.id,
      in: 0,
      out: s.duration,
    });
  }
  return true;
}

export function addMasterClip(
  project: Project,
  sceneId: string,
  inT?: number,
  outT?: number,
): MasterClip | null {
  const scene = getSceneById(project, sceneId);
  if (!scene) return null;
  const clip: MasterClip = {
    id: nextAuthoringId('mclip'),
    sceneId,
    in: inT ?? 0,
    out: outT ?? scene.duration,
  };
  project.master.clips.push(clip);
  return clip;
}

export function normalizeMasterClip(clip: MasterClip, scene: Scene): void {
  const dur = Math.max(0.5, scene.duration);
  clip.in = Math.max(0, Math.min(clip.in, dur - 0.05));
  clip.out = Math.max(clip.in + 0.05, Math.min(clip.out, dur));
}

/** Default project is the M Hybrid V8 storyboard commercial. */
export function createDefaultProject(viewer?: Viewer): Project {
  return createStoryboardProject(viewer);
}

export function captureProjectLook(viewer: Viewer): SavedSettings {
  return captureSettings(viewer);
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

function normalizeScenePlanes(scene: Scene) {
  for (const plane of scene.planes) {
    if (typeof plane.extrude !== 'boolean') plane.extrude = false;
  }
  if (typeof scene.carVisible !== 'boolean') scene.carVisible = true;
}

export function parseProject(raw: string): Project | null {
  try {
    const parsed = JSON.parse(raw) as Project | LegacyProjectV2;
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.version === LEGACY_PROJECT_VERSION) {
      const migrated = migrateLegacyV2(parsed as LegacyProjectV2);
      syncIdCounterFromProject(migrated);
      return migrated;
    }

    if (parsed.version !== PROJECT_VERSION) return null;
    const project = parsed as Project;
    if (!Array.isArray(project.scenes) || !project.scenes.length) return null;
    if (!project.master || !Array.isArray(project.master.clips)) {
      project.master = { clips: [] };
    }
    if (project.editorMode !== 'scene' && project.editorMode !== 'master') {
      project.editorMode = 'scene';
    }
    for (const scene of project.scenes) {
      if (!scene.timeline || !Array.isArray(scene.cameras)) return null;
      normalizeScenePlanes(scene);
    }
    if (!project.master.clips.length) {
      const s = project.scenes[0];
      project.master.clips.push({
        id: nextAuthoringId('mclip'),
        sceneId: s.id,
        in: 0,
        out: s.duration,
      });
    }
    if (!project.scenes.some((s) => s.id === project.activeSceneId)) {
      project.activeSceneId = project.scenes[0].id;
    }
    syncIdCounterFromProject(project);
    return project;
  } catch {
    return null;
  }
}

export function saveProjectToStorage(project: Project): void {
  localStorage.setItem(PROJECT_STORAGE_KEY, serializeProject(project));
}

export function loadProjectFromStorage(): Project | null {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return null;
    return parseProject(raw);
  } catch {
    return null;
  }
}

export function clearProjectStorage(): void {
  localStorage.removeItem(PROJECT_STORAGE_KEY);
}

/** Migrate legacy settings-only storage into a fresh project shell. */
export function projectFromLegacySettings(look: SavedSettings, viewer?: Viewer): Project {
  const project = createDefaultProject(viewer);
  const scene = getActiveScene(project);
  scene.look = structuredClone(look);
  return project;
}
