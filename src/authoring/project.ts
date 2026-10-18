import {
  captureSettings,
  defaultSettings,
  type SavedSettings,
} from '../viewer/settings';
import type { Viewer } from '../viewer/Viewer';
import { carSpecs } from '../data/carSpecs';

export const PROJECT_STORAGE_KEY = 'wrt-paddock-project';
export const PROJECT_VERSION = 2 as const;

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
};

export type TimelineTrack = {
  id: string;
  /** e.g. camera.active | camera.<id>.pose | plane.<id>.position | light.<id>.intensity */
  target: string;
  keyframes: Keyframe[];
};

export type Project = {
  version: typeof PROJECT_VERSION;
  name: string;
  duration: number;
  fps: number;
  playCameraId: string;
  look: SavedSettings;
  cameras: CameraClip[];
  planes: PlaneClip[];
  texts: TextClip[];
  timeline: { tracks: TimelineTrack[] };
};

export type SelectionKind = 'camera' | 'light' | 'plane' | 'text' | null;

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

export function syncIdCounterFromProject(project: Project) {
  let max = 0;
  const consider = (id: string) => {
    const m = id.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  };
  project.cameras.forEach((c) => consider(c.id));
  project.planes.forEach((p) => consider(p.id));
  project.texts.forEach((t) => consider(t.id));
  project.timeline.tracks.forEach((t) => consider(t.id));
  resetAuthoringIdCounter(max + 1);
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

export function createDefaultProject(viewer?: Viewer): Project {
  resetAuthoringIdCounter(1);
  const cameras = createDefaultCameras(viewer);
  const texts: TextClip[] = [
    {
      id: nextAuthoringId('text'),
      name: 'Title',
      content: carSpecs.name,
      position: vec3(-2.4, 1.6, 2.2),
      rotation: vec3(0, 20, 0),
      scale: 1,
      opacity: 1,
      align: 'left',
      color: '#ffffff',
      billboard: false,
    },
  ];

  return {
    version: PROJECT_VERSION,
    name: 'WRT Commercial',
    duration: 8,
    fps: 30,
    playCameraId: cameras[0].id,
    look: viewer ? captureSettings(viewer) : defaultSettings(),
    cameras,
    planes: [],
    texts,
    timeline: { tracks: [] },
  };
}

export function captureProjectLook(viewer: Viewer): SavedSettings {
  return captureSettings(viewer);
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(raw: string): Project | null {
  try {
    const parsed = JSON.parse(raw) as Project;
    if (parsed?.version !== PROJECT_VERSION) return null;
    if (!Array.isArray(parsed.cameras) || !parsed.timeline) return null;
    syncIdCounterFromProject(parsed);
    return parsed;
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
  project.look = structuredClone(look);
  return project;
}
