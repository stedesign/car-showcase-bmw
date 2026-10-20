import {
  clipDuration,
  getSceneById,
  type MasterClip,
  type Project,
  type Scene,
} from './project';

export type MasterResolve = {
  clipIndex: number;
  clip: MasterClip;
  scene: Scene;
  /** Time within the scene timeline. */
  localT: number;
  /** Start of this clip on the master timeline. */
  clipStart: number;
  /** End of this clip on the master timeline. */
  clipEnd: number;
};

/** Map a global master time to the active clip + local scene time. */
export function resolveMasterTime(
  project: Project,
  globalT: number,
): MasterResolve | null {
  const clips = project.master.clips;
  if (!clips.length) return null;

  const total = clips.reduce((sum, c) => sum + clipDuration(c), 0);
  let t = Math.max(0, Math.min(globalT, Math.max(0, total)));

  let cursor = 0;
  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const dur = clipDuration(clip);
    const clipEnd = cursor + dur;
    const isLast = i === clips.length - 1;
    if (t < clipEnd || isLast) {
      const scene = getSceneById(project, clip.sceneId);
      if (!scene) return null;
      const localOffset = Math.min(dur, Math.max(0, t - cursor));
      return {
        clipIndex: i,
        clip,
        scene,
        localT: clip.in + localOffset,
        clipStart: cursor,
        clipEnd,
      };
    }
    cursor = clipEnd;
  }
  return null;
}

export type MasterClock = {
  get time(): number;
  get duration(): number;
  get state(): 'idle' | 'playing';
  get clipIndex(): number;
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  update: (dt: number) => void;
  /** Called when the active scene clip changes (or on seek). */
  setOnResolve: (fn: ((r: MasterResolve) => void) | null) => void;
  setOnTime: (fn: ((t: number) => void) | null) => void;
  setOnEnded: (fn: (() => void) | null) => void;
  bindProject: (project: Project) => void;
};

/**
 * Lightweight master playhead that drives scene loads via resolve callbacks.
 * Scene timeline evaluation is left to the caller (Editor).
 */
export function createMasterClock(): MasterClock {
  let project: Project | null = null;
  let time = 0;
  let state: 'idle' | 'playing' = 'idle';
  let clipIndex = -1;
  let onResolve: ((r: MasterResolve) => void) | null = null;
  let onTime: ((t: number) => void) | null = null;
  let onEnded: (() => void) | null = null;

  const durationOf = () => {
    if (!project) return 0;
    return project.master.clips.reduce((sum, c) => sum + clipDuration(c), 0);
  };

  const emit = (t: number, forceClip = false) => {
    if (!project) return;
    const dur = durationOf();
    time = Math.min(dur, Math.max(0, t));
    const resolved = resolveMasterTime(project, time);
    if (resolved && (forceClip || resolved.clipIndex !== clipIndex)) {
      clipIndex = resolved.clipIndex;
      onResolve?.(resolved);
    }
    onTime?.(time);
  };

  return {
    get time() {
      return time;
    },
    get duration() {
      return durationOf();
    },
    get state() {
      return state;
    },
    get clipIndex() {
      return clipIndex;
    },
    seek(t) {
      emit(t, true);
    },
    play() {
      const dur = durationOf();
      if (time >= dur - 1e-4) emit(0, true);
      state = 'playing';
    },
    pause() {
      state = 'idle';
    },
    stop() {
      state = 'idle';
      emit(0, true);
    },
    update(dt) {
      if (state !== 'playing') return;
      const dur = durationOf();
      const next = time + dt;
      if (next >= dur) {
        emit(dur, true);
        state = 'idle';
        onEnded?.();
        return;
      }
      emit(next, false);
    },
    setOnResolve(fn) {
      onResolve = fn;
    },
    setOnTime(fn) {
      onTime = fn;
    },
    setOnEnded(fn) {
      onEnded = fn;
    },
    bindProject(p) {
      project = p;
      clipIndex = -1;
      time = Math.min(time, durationOf());
    },
  };
}
