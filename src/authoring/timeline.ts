import type {
  CameraPoseValue,
  EasingName,
  Keyframe,
  KeyframeValue,
  Project,
  TimelineTrack,
  Vec3,
} from './project';
import { cloneVec3, nextAuthoringId } from './project';

export type TimelineState = 'idle' | 'playing';

export type TimelineApplyFn = (target: string, value: KeyframeValue) => void;

export type TimelineEngine = {
  get time(): number;
  get state(): TimelineState;
  get duration(): number;
  setDuration: (seconds: number) => void;
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  update: (dt: number) => void;
  evaluateAt: (t: number) => void;
  setApply: (fn: TimelineApplyFn) => void;
  setOnEnded: (fn: (() => void) | null) => void;
  setOnTime: (fn: ((t: number) => void) | null) => void;
  bindProject: (project: Project) => void;
  ensureTrack: (target: string) => TimelineTrack;
  setKeyframe: (target: string, t: number, value: KeyframeValue, easing?: EasingName) => void;
  removeKeyframe: (trackId: string, t: number) => void;
  getTracks: () => TimelineTrack[];
};

function ease(u: number, name: EasingName = 'linear'): number {
  const t = Math.min(1, Math.max(0, u));
  if (name === 'easeInOut') {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
  return t;
}

function isVec3(v: KeyframeValue): v is Vec3 {
  return (
    typeof v === 'object' &&
    v !== null &&
    'x' in v &&
    'y' in v &&
    'z' in v &&
    !('position' in v)
  );
}

function isPose(v: KeyframeValue): v is CameraPoseValue {
  return typeof v === 'object' && v !== null && 'position' in v && 'target' in v;
}

function lerpNumber(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function lerpVec3(a: Vec3, b: Vec3, u: number): Vec3 {
  return {
    x: lerpNumber(a.x, b.x, u),
    y: lerpNumber(a.y, b.y, u),
    z: lerpNumber(a.z, b.z, u),
  };
}

function lerpPose(a: CameraPoseValue, b: CameraPoseValue, u: number): CameraPoseValue {
  return {
    position: lerpVec3(a.position, b.position, u),
    target: lerpVec3(a.target, b.target, u),
    fov: lerpNumber(a.fov, b.fov, u),
  };
}

function interpolate(
  a: Keyframe,
  b: Keyframe | undefined,
  t: number,
): KeyframeValue {
  if (!b || t <= a.t) return structuredClone(a.value) as KeyframeValue;
  if (t >= b.t) return structuredClone(b.value) as KeyframeValue;

  const span = b.t - a.t;
  if (span <= 1e-6) return structuredClone(b.value) as KeyframeValue;
  const u = ease((t - a.t) / span, b.easing ?? a.easing ?? 'linear');

  const va = a.value;
  const vb = b.value;

  if (typeof va === 'number' && typeof vb === 'number') {
    return lerpNumber(va, vb, u);
  }
  if (typeof va === 'boolean' || typeof vb === 'boolean') {
    return u < 1 ? va : vb;
  }
  if (typeof va === 'string' || typeof vb === 'string') {
    return u < 1 ? va : vb;
  }
  if (isPose(va) && isPose(vb)) {
    return lerpPose(va, vb, u);
  }
  if (isVec3(va) && isVec3(vb)) {
    return lerpVec3(va, vb, u);
  }
  return u < 1 ? structuredClone(va) as KeyframeValue : structuredClone(vb) as KeyframeValue;
}

function sortKeys(track: TimelineTrack) {
  track.keyframes.sort((a, b) => a.t - b.t);
}

export function createTimelineEngine(initialDuration = 8): TimelineEngine {
  let project: Project | null = null;
  let time = 0;
  let duration = initialDuration;
  let state: TimelineState = 'idle';
  let applyFn: TimelineApplyFn = () => {};
  let onEnded: (() => void) | null = null;
  let onTime: ((t: number) => void) | null = null;

  const tracks = (): TimelineTrack[] => project?.timeline.tracks ?? [];

  const evaluateAt = (t: number) => {
    time = Math.min(duration, Math.max(0, t));
    for (const track of tracks()) {
      if (!track.keyframes.length) continue;
      sortKeys(track);
      const keys = track.keyframes;
      if (time <= keys[0].t) {
        applyFn(track.target, structuredClone(keys[0].value) as KeyframeValue);
        continue;
      }
      if (time >= keys[keys.length - 1].t) {
        applyFn(
          track.target,
          structuredClone(keys[keys.length - 1].value) as KeyframeValue,
        );
        continue;
      }
      let i = 0;
      while (i < keys.length - 1 && keys[i + 1].t < time) i += 1;
      const value = interpolate(keys[i], keys[i + 1], time);
      applyFn(track.target, value);
    }
    onTime?.(time);
  };

  return {
    get time() {
      return time;
    },
    get state() {
      return state;
    },
    get duration() {
      return duration;
    },
    setDuration(seconds: number) {
      duration = Math.max(0.5, seconds);
      if (project) project.duration = duration;
      if (time > duration) evaluateAt(duration);
    },
    seek(t: number) {
      evaluateAt(t);
    },
    play() {
      if (time >= duration - 1e-4) evaluateAt(0);
      state = 'playing';
    },
    pause() {
      state = 'idle';
    },
    stop() {
      state = 'idle';
      evaluateAt(0);
    },
    update(dt: number) {
      if (state !== 'playing') return;
      const next = time + dt;
      if (next >= duration) {
        evaluateAt(duration);
        state = 'idle';
        onEnded?.();
        return;
      }
      evaluateAt(next);
    },
    evaluateAt,
    setApply(fn) {
      applyFn = fn;
    },
    setOnEnded(fn) {
      onEnded = fn;
    },
    setOnTime(fn) {
      onTime = fn;
    },
    bindProject(p) {
      project = p;
      duration = p.duration;
      time = Math.min(time, duration);
    },
    ensureTrack(target: string) {
      if (!project) throw new Error('No project bound');
      let track = project.timeline.tracks.find((tr) => tr.target === target);
      if (!track) {
        track = { id: nextAuthoringId('track'), target, keyframes: [] };
        project.timeline.tracks.push(track);
      }
      return track;
    },
    setKeyframe(target, t, value, easing = 'easeInOut') {
      const track = this.ensureTrack(target);
      const snapped = Math.round(t * 1000) / 1000;
      const existing = track.keyframes.find((k) => Math.abs(k.t - snapped) < 1e-3);
      const cloned =
        typeof value === 'object' && value !== null
          ? (structuredClone(value) as KeyframeValue)
          : value;
      if (existing) {
        existing.value = cloned;
        existing.easing = easing;
      } else {
        track.keyframes.push({ t: snapped, value: cloned, easing });
      }
      sortKeys(track);
    },
    removeKeyframe(trackId, t) {
      if (!project) return;
      const track = project.timeline.tracks.find((tr) => tr.id === trackId);
      if (!track) return;
      track.keyframes = track.keyframes.filter((k) => Math.abs(k.t - t) > 1e-3);
    },
    getTracks() {
      return tracks();
    },
  };
}

export function poseFromCameraClip(clip: {
  position: Vec3;
  target: Vec3;
  fov: number;
}): CameraPoseValue {
  return {
    position: cloneVec3(clip.position),
    target: cloneVec3(clip.target),
    fov: clip.fov,
  };
}
