import {
  normalizeAllMasterClips,
  pruneMasterTextsToDuration,
  type CameraPoseValue,
  type CubicBezier,
  type Keyframe,
  type KeyframeValue,
  type Project,
  type Scene,
  type Selection,
  type TimelineTrack,
  type Vec3,
} from '../project';
import type { TimelineEngine } from '../timeline';
import { cubicBezierEase, resolveBezier } from '../bezier';

const PX_PER_SEC = 80;
const SNAP = 0.05;
const CURVE_PAD = { top: 28, right: 24, bottom: 20, left: 52 };
const BAR_COLORS = [
  '#5b8def',
  '#3dd6c6',
  '#f0c14b',
  '#c084fc',
  '#fb7185',
  '#34d399',
  '#f97316',
  '#a78bfa',
];

type CurveChannel = {
  id: string;
  label: string;
  read: (v: KeyframeValue) => number | null;
};

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

function channelsForTrack(track: TimelineTrack): CurveChannel[] {
  const sample = track.keyframes[0]?.value;
  if (sample == null) return [];
  if (typeof sample === 'number') {
    return [{ id: 'value', label: 'Value', read: (v) => (typeof v === 'number' ? v : null) }];
  }
  if (typeof sample === 'boolean' || typeof sample === 'string') return [];
  if (isVec3(sample)) {
    return [
      { id: 'x', label: 'X', read: (v) => (isVec3(v) ? v.x : null) },
      { id: 'y', label: 'Y', read: (v) => (isVec3(v) ? v.y : null) },
      { id: 'z', label: 'Z', read: (v) => (isVec3(v) ? v.z : null) },
    ];
  }
  if (isPose(sample)) {
    return [
      { id: 'px', label: 'Pos X', read: (v) => (isPose(v) ? v.position.x : null) },
      { id: 'py', label: 'Pos Y', read: (v) => (isPose(v) ? v.position.y : null) },
      { id: 'pz', label: 'Pos Z', read: (v) => (isPose(v) ? v.position.z : null) },
      { id: 'tx', label: 'Tgt X', read: (v) => (isPose(v) ? v.target.x : null) },
      { id: 'ty', label: 'Tgt Y', read: (v) => (isPose(v) ? v.target.y : null) },
      { id: 'tz', label: 'Tgt Z', read: (v) => (isPose(v) ? v.target.z : null) },
      { id: 'fov', label: 'FOV', read: (v) => (isPose(v) ? v.fov : null) },
    ];
  }
  return [];
}

function trackSupportsCurve(track: TimelineTrack): boolean {
  return channelsForTrack(track).length > 0 && track.keyframes.length >= 1;
}

function sampleCurve(
  a: Keyframe,
  b: Keyframe,
  channel: CurveChannel,
  steps = 48,
): { t: number; v: number }[] {
  const va = channel.read(a.value);
  const vb = channel.read(b.value);
  if (va == null || vb == null) return [];
  const bezier = resolveBezier(b.bezier ?? a.bezier, b.easing ?? a.easing);
  const pts: { t: number; v: number }[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps;
    const eased = cubicBezierEase(u, bezier);
    pts.push({ t: a.t + (b.t - a.t) * u, v: va + (vb - va) * eased });
  }
  return pts;
}

export type TimelineUiApi = {
  getProject: () => Project;
  getScene: () => Scene;
  getSelection: () => Selection;
  timeline: TimelineEngine;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  onCut: () => void;
  onAnimate: () => void;
  /** Delete every keyframe and every dedicated camera. Free camera stays. */
  onClearAll: () => void;
  onChange: () => void;
};

/** Keep master clip outs inside the scene after a duration edit. */
function syncMasterAfterSceneDuration(api: TimelineUiApi) {
  const project = api.getProject();
  if (!normalizeAllMasterClips(project)) return;
  pruneMasterTextsToDuration(project);
}

export type TimelineUiHandle = {
  refresh: () => void;
  updatePlayhead: () => void;
};

type HoldSegment = {
  cameraId: string;
  start: number;
  end: number;
  /** Keyframe time that owns this hold (null = extrapolated before first key). */
  keyT: number | null;
  /** Next cut key time, if any. */
  nextKeyT: number | null;
};

/** Selected keyframe identity (track + time). */
type KeyRef = { trackId: string; t: number };

function sameKeyRef(a: KeyRef, b: KeyRef): boolean {
  return a.trackId === b.trackId && Math.abs(a.t - b.t) < 1e-3;
}

type Row =
  | {
      kind: 'header';
      label: string;
      groupId: string;
      parentId: string | null;
      depth: number;
    }
  | { kind: 'active'; label: string; track: TimelineTrack | null; groupId: string }
  | { kind: 'keys'; label: string; nested: boolean; track: TimelineTrack; groupId: string | null };

type TimelineTree = {
  rows: Row[];
  /** groupId → parent groupId (null = top-level). */
  parents: Map<string, string | null>;
};

const COLLAPSE_KEY = 'wrt-director-timeline-collapsed';
const TWIST_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">' +
  '<path d="M2.2 3.5 L5 6.5 L7.8 3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(ids: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota or private mode */
  }
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function snapTime(t: number, duration: number): number {
  const snapped = Math.round(t / SNAP) * SNAP;
  return Math.max(0, Math.min(duration, Math.round(snapped * 1000) / 1000));
}

function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BAR_COLORS[h % BAR_COLORS.length];
}

function holdSegments(track: TimelineTrack | null, duration: number): HoldSegment[] {
  if (!track?.keyframes.length) return [];
  const keys = [...track.keyframes].sort((a, b) => a.t - b.t);
  const segs: HoldSegment[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key.value !== 'string') continue;
    const start = i === 0 ? 0 : key.t;
    const next = keys[i + 1];
    const end = next ? next.t : duration;
    if (end - start < 1e-4) continue;
    segs.push({
      cameraId: key.value,
      start,
      end,
      keyT: key.t,
      nextKeyT: next ? next.t : null,
    });
  }
  return segs;
}

function buildRows(project: Scene, tracks: TimelineTrack[]): TimelineTree {
  const byTarget = new Map(tracks.map((t) => [t.target, t]));
  const rows: Row[] = [];
  const parents = new Map<string, string | null>();
  const used = new Set<string>();

  const active = byTarget.get('camera.active') ?? null;
  if (active) used.add(active.target);

  const cameraIds = new Set<string>();
  for (const c of project.cameras) cameraIds.add(c.id);
  for (const t of tracks) {
    const m = /^camera\.([^.]+)\.(pose|pathProgress)$/.exec(t.target);
    if (m) cameraIds.add(m[1]);
  }

  if (active || cameraIds.size) {
    parents.set('cameras', null);
    rows.push({
      kind: 'header',
      label: 'Cameras',
      groupId: 'cameras',
      parentId: null,
      depth: 0,
    });
    rows.push({ kind: 'active', label: 'Active', track: active, groupId: 'cameras' });
    for (const cam of project.cameras) {
      if (!cameraIds.has(cam.id)) continue;
      const pose = byTarget.get(`camera.${cam.id}.pose`);
      const progress = byTarget.get(`camera.${cam.id}.pathProgress`);
      if (!pose && !progress) continue;
      if (pose) used.add(pose.target);
      if (progress) used.add(progress.target);
      const groupId = `camera:${cam.id}`;
      parents.set(groupId, 'cameras');
      rows.push({
        kind: 'header',
        label: cam.name,
        groupId,
        parentId: 'cameras',
        depth: 1,
      });
      if (pose) {
        rows.push({ kind: 'keys', label: 'Pose', nested: true, track: pose, groupId });
      }
      if (progress) {
        rows.push({
          kind: 'keys',
          label: 'Path Progress',
          nested: true,
          track: progress,
          groupId,
        });
      }
    }
    // Orphan pose / pathProgress tracks (camera deleted from list but keys remain)
    const orphanCamIds = new Set<string>();
    for (const t of tracks) {
      if (used.has(t.target)) continue;
      const m = /^camera\.([^.]+)\.(pose|pathProgress)$/.exec(t.target);
      if (!m) continue;
      orphanCamIds.add(m[1]);
    }
    for (const camId of orphanCamIds) {
      const pose = byTarget.get(`camera.${camId}.pose`);
      const progress = byTarget.get(`camera.${camId}.pathProgress`);
      const groupId = `camera:${camId}`;
      parents.set(groupId, 'cameras');
      rows.push({
        kind: 'header',
        label: camId,
        groupId,
        parentId: 'cameras',
        depth: 1,
      });
      if (pose && !used.has(pose.target)) {
        used.add(pose.target);
        rows.push({ kind: 'keys', label: 'Pose', nested: true, track: pose, groupId });
      }
      if (progress && !used.has(progress.target)) {
        used.add(progress.target);
        rows.push({
          kind: 'keys',
          label: 'Path Progress',
          nested: true,
          track: progress,
          groupId,
        });
      }
    }
  }

  type Group = { title: string; items: { label: string; track: TimelineTrack }[] };
  const groups = new Map<string, Group>();

  const ensureGroup = (key: string, title: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { title, items: [] };
      groups.set(key, g);
    }
    return g;
  };

  for (const t of tracks) {
    if (used.has(t.target)) continue;
    const parts = t.target.split('.');
    if (parts[0] === 'plane' && parts[1]) {
      const plane = project.planes.find((p) => p.id === parts[1]);
      const g = ensureGroup(`plane:${parts[1]}`, plane?.name ?? parts[1]);
      g.items.push({ label: parts.slice(2).join('.') || t.target, track: t });
      used.add(t.target);
    } else if (parts[0] === 'light' && parts[1]) {
      const g = ensureGroup(`light:${parts[1]}`, `Light ${parts[1].slice(-4)}`);
      g.items.push({ label: parts.slice(2).join('.') || t.target, track: t });
      used.add(t.target);
    } else if (parts[0] === 'carLights') {
      const g = ensureGroup('carLights', 'Car Lights');
      g.items.push({ label: parts.slice(1).join('.') || t.target, track: t });
      used.add(t.target);
    } else if (parts[0] === 'roofStrobe') {
      const g = ensureGroup('roofStrobe', 'Roof Strobe');
      g.items.push({ label: parts.slice(1).join('.') || t.target, track: t });
      used.add(t.target);
    } else if (parts[0] === 'airflow') {
      const g = ensureGroup('airflow', 'Airflow');
      const prop = parts[1] ?? t.target;
      const label =
        prop === 'enabled'
          ? 'On'
          : prop === 'flowColor'
            ? 'Flow color'
            : prop === 'accentColor'
              ? 'Accent color'
              : prop === 'speed'
                ? 'Speed'
                : prop === 'brightness'
                  ? 'Brightness'
                  : prop === 'opacity'
                    ? 'Opacity'
                    : prop === 'width'
                      ? 'Width'
                      : prop;
      g.items.push({ label, track: t });
      used.add(t.target);
    } else if (parts[0] === 'motion') {
      const g = ensureGroup('motion', 'Speed');
      const prop = parts[1] ?? t.target;
      const label =
        prop === 'enabled'
          ? 'On'
          : prop === 'wheelSpeed'
            ? 'Wheel speed'
            : prop === 'shake'
              ? 'Camera shake'
              : prop;
      g.items.push({ label, track: t });
      used.add(t.target);
    } else if (parts[0] === 'lighting') {
      const g = ensureGroup('lighting', 'Lighting');
      const prop = parts[1] ?? t.target;
      const label =
        prop === 'environmentIntensity'
          ? 'Env intensity'
          : prop === 'directIntensity'
            ? 'Key intensity'
            : prop === 'environment'
              ? 'Environment'
              : prop === 'exposure'
                ? 'Exposure'
                : prop;
      g.items.push({ label, track: t });
      used.add(t.target);
    } else if (parts[0] === 'logo') {
      const g = ensureGroup('logo', 'Logo');
      const prop = parts[1] ?? t.target;
      g.items.push({ label: prop === 'mark' ? 'Mark' : prop, track: t });
      used.add(t.target);
    } else if (parts[0] === 'dotGrid') {
      const g = ensureGroup('dotGrid', 'Dot Grid WRT');
      g.items.push({ label: parts.slice(1).join('.') || t.target, track: t });
      used.add(t.target);
    } else if (parts[0] === 'car') {
      const g = ensureGroup('car', 'Car');
      g.items.push({ label: parts.slice(1).join('.') || t.target, track: t });
      used.add(t.target);
    }
  }

  for (const [key, g] of groups) {
    parents.set(key, null);
    rows.push({
      kind: 'header',
      label: g.title,
      groupId: key,
      parentId: null,
      depth: 0,
    });
    for (const item of g.items) {
      rows.push({
        kind: 'keys',
        label: item.label,
        nested: true,
        track: item.track,
        groupId: key,
      });
    }
  }

  for (const t of tracks) {
    if (used.has(t.target)) continue;
    rows.push({ kind: 'keys', label: t.target, nested: false, track: t, groupId: null });
  }

  return { rows, parents };
}

function groupDepth(groupId: string | null, parents: Map<string, string | null>): number {
  let depth = 0;
  let id = groupId;
  while (id) {
    const parent = parents.get(id);
    if (!parent) break;
    depth += 1;
    id = parent;
  }
  return depth;
}

/** True when `groupId` is `ancestor` or nested inside it. */
function groupWithin(
  groupId: string | null,
  ancestor: string,
  parents: Map<string, string | null>,
): boolean {
  let id = groupId;
  while (id) {
    if (id === ancestor) return true;
    id = parents.get(id) ?? null;
  }
  return false;
}

export function mountTimelineUi(
  host: HTMLElement,
  api: TimelineUiApi,
): TimelineUiHandle {
  host.replaceChildren();
  host.style.setProperty('--px-per-sec', `${PX_PER_SEC}px`);

  const toolbar = document.createElement('div');
  toolbar.className = 'ed-tl-toolbar';

  const playBtn = document.createElement('button');
  playBtn.className = 'ed-btn primary';
  playBtn.type = 'button';
  playBtn.textContent = 'Play';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'ed-btn';
  stopBtn.type = 'button';
  stopBtn.textContent = 'Stop';

  const cutBtn = document.createElement('button');
  cutBtn.className = 'ed-btn';
  cutBtn.type = 'button';
  cutBtn.textContent = 'Cut';
  cutBtn.title = 'Switch to the selected camera at the playhead';

  const animateBtn = document.createElement('button');
  animateBtn.className = 'ed-btn';
  animateBtn.type = 'button';
  animateBtn.textContent = 'Animate';
  animateBtn.title = 'Keyframe the selected object at the playhead (no camera cut)';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ed-btn';
  deleteBtn.type = 'button';
  deleteBtn.textContent = 'Delete';
  deleteBtn.title = 'Delete selected keyframes (Delete / Backspace)';
  deleteBtn.disabled = true;

  const clearAllBtn = document.createElement('button');
  clearAllBtn.className = 'ed-btn';
  clearAllBtn.type = 'button';
  clearAllBtn.textContent = 'Clear all';
  clearAllBtn.title =
    'Delete all timeline keyframes and cameras. Free camera stays.';
  clearAllBtn.addEventListener('click', () => api.onClearAll());

  const timeLabel = document.createElement('span');
  timeLabel.className = 'ed-tl-time';

  const durLabel = document.createElement('label');
  durLabel.className = 'ed-tl-dur';
  durLabel.textContent = 'Duration';
  const durInput = document.createElement('input');
  durInput.type = 'number';
  durInput.min = '1';
  durInput.max = '120';
  durInput.step = '0.5';
  durInput.style.width = '64px';
  durInput.addEventListener('change', () => {
    const v = parseFloat(durInput.value) || 8;
    api.timeline.setDuration(v);
    api.getScene().duration = v;
    syncMasterAfterSceneDuration(api);
    refresh();
    api.onChange();
  });
  durLabel.append(durInput);

  const foldBtn = document.createElement('button');
  foldBtn.className = 'ed-btn ed-tl-fold-btn';
  foldBtn.type = 'button';
  foldBtn.title = 'Collapse all tracks';
  foldBtn.textContent = 'Collapse';

  const curveBtn = document.createElement('button');
  curveBtn.className = 'ed-btn ed-tl-curve-btn';
  curveBtn.type = 'button';
  curveBtn.title = 'Toggle curve view — edit animation speed / easing';
  curveBtn.setAttribute('aria-pressed', 'false');
  curveBtn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M2 12C2 12 4 4 8 4s6 8 6 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="2" cy="12" r="1.5" fill="currentColor"/>' +
    '<circle cx="14" cy="12" r="1.5" fill="currentColor"/>' +
    '</svg>';

  const channelSelect = document.createElement('select');
  channelSelect.className = 'ed-tl-channel';
  channelSelect.title = 'Curve channel';
  channelSelect.hidden = true;

  const hint = document.createElement('span');
  hint.className = 'ed-tl-hint';
  hint.textContent =
    'Playhead / ruler = scrub · Drag empty = select · Drag keys = move · Delete';

  toolbar.append(
    playBtn,
    stopBtn,
    cutBtn,
    animateBtn,
    deleteBtn,
    clearAllBtn,
    foldBtn,
    curveBtn,
    channelSelect,
    timeLabel,
    durLabel,
    hint,
  );
  host.append(toolbar);

  const body = document.createElement('div');
  body.className = 'ed-tl-body';
  const labels = document.createElement('div');
  labels.className = 'ed-tl-labels';
  const tracksEl = document.createElement('div');
  tracksEl.className = 'ed-tl-tracks';
  body.append(labels, tracksEl);
  host.append(body);

  let playheadEl: HTMLDivElement | null = null;
  let dragging = false;
  let curveMode = false;
  let selectedTrackId: string | null = null;
  /** Group ids the user has folded. Survives timeline refreshes and reloads. */
  const collapsedGroups = loadCollapsedGroups();
  let groupIds: string[] = [];
  let selectedChannelId = 'value';
  /** Selected keyframes for multi-move / delete. */
  let selectedKeys: KeyRef[] = [];
  /** When set, playhead X is mapped through the curve graph (includes left pad). */
  let curveTimeToX: ((t: number) => number) | null = null;

  const syncPlayButton = () => {
    playBtn.textContent = api.timeline.state === 'playing' ? 'Pause' : 'Play';
  };

  const allGroupsCollapsed = () =>
    groupIds.length > 0 && groupIds.every((id) => collapsedGroups.has(id));

  const syncFoldButton = () => {
    const folded = allGroupsCollapsed();
    foldBtn.disabled = groupIds.length === 0;
    foldBtn.textContent = folded ? 'Expand' : 'Collapse';
    foldBtn.title = folded ? 'Expand all tracks' : 'Collapse all tracks';
    foldBtn.setAttribute('aria-pressed', folded ? 'true' : 'false');
    foldBtn.classList.toggle('active', folded);
  };

  const setGroupCollapsed = (groupId: string, fold: boolean) => {
    if (fold) collapsedGroups.add(groupId);
    else collapsedGroups.delete(groupId);
    saveCollapsedGroups(collapsedGroups);
    refresh();
  };

  foldBtn.addEventListener('click', () => {
    if (!groupIds.length) return;
    const fold = !allGroupsCollapsed();
    collapsedGroups.clear();
    if (fold) {
      for (const id of groupIds) collapsedGroups.add(id);
    }
    saveCollapsedGroups(collapsedGroups);
    refresh();
  });

  const isKeySelected = (ref: KeyRef) => selectedKeys.some((k) => sameKeyRef(k, ref));

  const setSelectedKeys = (next: KeyRef[]) => {
    selectedKeys = next;
    deleteBtn.disabled = selectedKeys.length === 0;
    deleteBtn.textContent =
      selectedKeys.length > 1 ? `Delete (${selectedKeys.length})` : 'Delete';
    for (const el of tracksEl.querySelectorAll<HTMLElement>('.ed-tl-key')) {
      const trackId = el.dataset.trackId;
      const t = parseFloat(el.dataset.t ?? '');
      if (!trackId || Number.isNaN(t)) continue;
      el.classList.toggle('selected', isKeySelected({ trackId, t }));
    }
  };

  const clearKeySelection = () => {
    if (selectedKeys.length) setSelectedKeys([]);
  };

  const pruneSelectedKeys = () => {
    const tracks = api.timeline.getTracks();
    const next = selectedKeys.filter((ref) => {
      const track = tracks.find((t) => t.id === ref.trackId);
      return !!track?.keyframes.some((k) => Math.abs(k.t - ref.t) < 1e-3);
    });
    if (next.length !== selectedKeys.length) setSelectedKeys(next);
    else deleteBtn.disabled = selectedKeys.length === 0;
  };

  const deleteSelectedKeys = () => {
    if (!selectedKeys.length) return;
    const toDelete = [...selectedKeys];
    setSelectedKeys([]);
    for (const ref of toDelete) {
      api.timeline.removeKeyframe(ref.trackId, ref.t);
    }
    api.onChange();
  };

  const syncActionButtons = () => {
    const sel = api.getSelection();
    cutBtn.disabled = sel.kind !== 'camera';
    animateBtn.disabled = !sel.kind || !sel.id;
    deleteBtn.disabled = selectedKeys.length === 0;
    const track = selectedTrackId
      ? api.timeline.getTracks().find((t) => t.id === selectedTrackId)
      : null;
    const canCurve = !!(track && trackSupportsCurve(track));
    curveBtn.disabled = !canCurve && !curveMode;
    curveBtn.classList.toggle('active', curveMode);
    curveBtn.setAttribute('aria-pressed', curveMode ? 'true' : 'false');
    channelSelect.hidden = !(curveMode && track && channelsForTrack(track).length > 1);
  };

  const selectTrack = (trackId: string | null, opts?: { refresh?: boolean }) => {
    const changed = selectedTrackId !== trackId;
    selectedTrackId = trackId;
    const track = trackId
      ? api.timeline.getTracks().find((t) => t.id === trackId)
      : null;
    const channels = track ? channelsForTrack(track) : [];
    if (channels.length && !channels.some((c) => c.id === selectedChannelId)) {
      selectedChannelId = channels[0].id;
    }
    syncChannelSelect();
    if (opts?.refresh === false) return;
    if (curveMode || changed) refresh();
  };

  const syncChannelSelect = () => {
    const track = selectedTrackId
      ? api.timeline.getTracks().find((t) => t.id === selectedTrackId)
      : null;
    const channels = track ? channelsForTrack(track) : [];
    channelSelect.replaceChildren();
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.label;
      if (ch.id === selectedChannelId) opt.selected = true;
      channelSelect.append(opt);
    }
    syncActionButtons();
  };

  curveBtn.addEventListener('click', () => {
    if (!selectedTrackId) {
      const first = api.timeline.getTracks().find(trackSupportsCurve);
      if (first) selectTrack(first.id);
    }
    const track = selectedTrackId
      ? api.timeline.getTracks().find((t) => t.id === selectedTrackId)
      : null;
    if (!track || !trackSupportsCurve(track)) return;
    curveMode = !curveMode;
    body.classList.toggle('ed-tl-curve-mode', curveMode);
    refresh();
  });

  channelSelect.addEventListener('change', () => {
    selectedChannelId = channelSelect.value;
    if (curveMode) refresh();
  });

  playBtn.addEventListener('click', () => {
    if (api.timeline.state === 'playing') api.onPause();
    else api.onPlay();
    syncPlayButton();
  });
  stopBtn.addEventListener('click', () => {
    api.onStop();
    syncPlayButton();
    updatePlayhead();
  });
  cutBtn.addEventListener('click', () => api.onCut());
  animateBtn.addEventListener('click', () => api.onAnimate());
  deleteBtn.addEventListener('click', () => deleteSelectedKeys());

  host.tabIndex = 0;
  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!selectedKeys.length) return;
    event.preventDefault();
    deleteSelectedKeys();
  });

  labels.addEventListener('scroll', () => {
    tracksEl.scrollTop = labels.scrollTop;
  });
  tracksEl.addEventListener('scroll', () => {
    labels.scrollTop = tracksEl.scrollTop;
  });

  const seekFromClientX = (clientX: number) => {
    const rect = tracksEl.getBoundingClientRect();
    const x = clientX - rect.left + tracksEl.scrollLeft;
    const t = snapTime(x / PX_PER_SEC, api.timeline.duration);
    api.onSeek(t);
    updatePlayhead();
  };

  const localPoint = (event: PointerEvent) => {
    const rect = tracksEl.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + tracksEl.scrollLeft,
      y: event.clientY - rect.top + tracksEl.scrollTop,
    };
  };

  const keysInMarquee = (box: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }): KeyRef[] => {
    const hits: KeyRef[] = [];
    const tracksRect = tracksEl.getBoundingClientRect();
    for (const el of tracksEl.querySelectorAll<HTMLElement>('.ed-tl-key')) {
      const trackId = el.dataset.trackId;
      const t = parseFloat(el.dataset.t ?? '');
      if (!trackId || Number.isNaN(t)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 - tracksRect.left + tracksEl.scrollLeft;
      const cy = r.top + r.height / 2 - tracksRect.top + tracksEl.scrollTop;
      if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
        hits.push({ trackId, t });
      }
    }
    return hits;
  };

  const bindScrubDrag = (event: PointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    dragging = true;
    seekFromClientX(event.clientX);
    playheadEl?.classList.add('dragging');
    const move = (e: PointerEvent) => seekFromClientX(e.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      playheadEl?.classList.remove('dragging');
      dragging = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const bindPlayheadScrub = (el: HTMLElement) => {
    el.addEventListener('pointerdown', bindScrubDrag);
  };

  tracksEl.addEventListener('pointerdown', (event) => {
    if (dragging || curveMode) return;
    const el = event.target as HTMLElement;
    if (
      el.closest('.ed-tl-key') ||
      el.closest('.ed-tl-bar') ||
      el.closest('.ed-tl-bar-handle') ||
      el.closest('.ed-tl-playhead') ||
      el.closest('.ed-tl-ruler')
    ) {
      return;
    }

    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const origin = localPoint(event);
    let moved = false;
    let marquee: HTMLDivElement | null = null;

    const ensureMarquee = () => {
      if (marquee) return marquee;
      marquee = document.createElement('div');
      marquee.className = 'ed-tl-marquee';
      tracksEl.append(marquee);
      return marquee;
    };

    const move = (e: PointerEvent) => {
      const cur = localPoint(e);
      const dx = Math.abs(cur.x - origin.x);
      const dy = Math.abs(cur.y - origin.y);
      if (!moved && dx < 4 && dy < 4) return;
      moved = true;
      const box = {
        left: Math.min(origin.x, cur.x),
        top: Math.min(origin.y, cur.y),
        right: Math.max(origin.x, cur.x),
        bottom: Math.max(origin.y, cur.y),
      };
      const m = ensureMarquee();
      m.style.left = `${box.left}px`;
      m.style.top = `${box.top}px`;
      m.style.width = `${box.right - box.left}px`;
      m.style.height = `${box.bottom - box.top}px`;
    };

    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      marquee?.remove();
      if (!moved) {
        if (!additive) clearKeySelection();
        seekFromClientX(e.clientX);
        return;
      }
      const cur = localPoint(e);
      const box = {
        left: Math.min(origin.x, cur.x),
        top: Math.min(origin.y, cur.y),
        right: Math.max(origin.x, cur.x),
        bottom: Math.max(origin.y, cur.y),
      };
      const hits = keysInMarquee(box);
      if (additive) {
        const merged = [...selectedKeys];
        for (const hit of hits) {
          if (!merged.some((k) => sameKeyRef(k, hit))) merged.push(hit);
        }
        setSelectedKeys(merged);
      } else {
        setSelectedKeys(hits);
      }
      host.focus({ preventScroll: true });
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const updatePlayhead = () => {
    const t = api.timeline.time;
    timeLabel.textContent = `${formatTime(t)} / ${formatTime(api.timeline.duration)}`;
    if (playheadEl) {
      const x = curveTimeToX ? curveTimeToX(t) : t * PX_PER_SEC;
      playheadEl.style.left = `${x}px`;
      const badge = playheadEl.querySelector('.ed-tl-playhead-badge');
      if (badge) badge.textContent = t.toFixed(2);
    }
    syncPlayButton();
    syncActionButtons();
  };

  const appendLabel = (text: string, className: string) => {
    const lab = document.createElement('div');
    lab.className = className;
    lab.textContent = text;
    lab.title = text;
    labels.append(lab);
  };

  const makeTrackRow = (duration: number) => {
    const row = document.createElement('div');
    row.className = 'ed-tl-track';
    row.style.width = `${duration * PX_PER_SEC + 40}px`;
    return row;
  };

  const bindKeyDrag = (
    diamond: HTMLElement,
    track: TimelineTrack,
    fromT: number,
  ) => {
    diamond.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      host.focus({ preventScroll: true });

      const ref: KeyRef = { trackId: track.id, t: fromT };
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      let group = selectedKeys.filter((k) => isKeySelected(k));

      if (additive) {
        if (isKeySelected(ref)) {
          setSelectedKeys(selectedKeys.filter((k) => !sameKeyRef(k, ref)));
          return;
        }
        setSelectedKeys([...selectedKeys, ref]);
        group = [...selectedKeys];
      } else if (!isKeySelected(ref)) {
        setSelectedKeys([ref]);
        group = [ref];
      } else {
        group = [...selectedKeys];
      }

      selectTrack(track.id, { refresh: false });
      dragging = true;
      diamond.classList.add('dragging');
      const startX = e.clientX;
      const origins = group.map((k) => ({ ...k }));
      let appliedDt = 0;
      let didMove = false;

      const diamondEls = () =>
        Array.from(tracksEl.querySelectorAll<HTMLElement>('.ed-tl-key')).filter(
          (el) => {
            const tid = el.dataset.trackId;
            const t = parseFloat(el.dataset.t ?? '');
            return origins.some(
              (o) => o.trackId === tid && Math.abs(o.t - t) < 1e-3,
            );
          },
        );

      const clampDt = (rawDt: number) => {
        let lo = -Infinity;
        let hi = Infinity;
        for (const o of origins) {
          lo = Math.max(lo, -o.t);
          hi = Math.min(hi, api.timeline.duration - o.t);
        }
        const clamped = Math.max(lo, Math.min(hi, rawDt));
        return snapTime(fromT + clamped, api.timeline.duration) - fromT;
      };

      const move = (ev: PointerEvent) => {
        const rawDt = (ev.clientX - startX) / PX_PER_SEC;
        appliedDt = clampDt(rawDt);
        if (Math.abs(appliedDt) > 1e-4) didMove = true;
        for (const el of diamondEls()) {
          const t = parseFloat(el.dataset.t ?? '0');
          el.style.left = `${(t + appliedDt) * PX_PER_SEC}px`;
          el.classList.add('dragging');
        }
        const lead = snapTime(fromT + appliedDt, api.timeline.duration);
        api.onSeek(lead);
        updatePlayhead();
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        for (const el of tracksEl.querySelectorAll('.ed-tl-key.dragging')) {
          el.classList.remove('dragging');
        }
        dragging = false;

        if (!didMove || Math.abs(appliedDt) <= 1e-4) {
          if (!additive) {
            setSelectedKeys([ref]);
            selectTrack(track.id);
          }
          api.onSeek(fromT);
          updatePlayhead();
          return;
        }

        // Move right-to-left when shifting later, else left-to-right — avoids collisions.
        const ordered =
          appliedDt >= 0
            ? [...origins].sort((a, b) => b.t - a.t)
            : [...origins].sort((a, b) => a.t - b.t);

        const nextSelection: KeyRef[] = [];
        for (const o of ordered) {
          const toT = snapTime(o.t + appliedDt, api.timeline.duration);
          api.timeline.moveKeyframe(o.trackId, o.t, toT);
          nextSelection.push({ trackId: o.trackId, t: toT });
        }
        setSelectedKeys(nextSelection);
        api.onChange();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  };

  const renderKeysRow = (row: HTMLElement, track: TimelineTrack) => {
    if (selectedTrackId === track.id) row.classList.add('ed-tl-track-selected');
    for (const key of track.keyframes) {
      const diamond = document.createElement('button');
      diamond.type = 'button';
      diamond.className = 'ed-tl-key';
      diamond.dataset.trackId = track.id;
      diamond.dataset.t = String(key.t);
      diamond.style.left = `${key.t * PX_PER_SEC}px`;
      if (isKeySelected({ trackId: track.id, t: key.t })) {
        diamond.classList.add('selected');
      }
      diamond.title = `${track.target} @ ${key.t.toFixed(2)}s — drag select/move, Delete to remove`;
      diamond.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTrack(track.id);
        api.onSeek(key.t);
        updatePlayhead();
      });
      diamond.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ref: KeyRef = { trackId: track.id, t: key.t };
        if (isKeySelected(ref) && selectedKeys.length > 1) {
          deleteSelectedKeys();
        } else {
          setSelectedKeys([]);
          api.timeline.removeKeyframe(track.id, key.t);
          api.onChange();
        }
      });
      bindKeyDrag(diamond, track, key.t);
      row.append(diamond);
    }
  };

  const renderCurveGraph = (
    container: HTMLElement,
    track: TimelineTrack,
    duration: number,
  ) => {
    const channels = channelsForTrack(track);
    const channel =
      channels.find((c) => c.id === selectedChannelId) ?? channels[0] ?? null;
    if (!channel) {
      const empty = document.createElement('div');
      empty.className = 'ed-tl-empty';
      empty.textContent = 'This track has no animatable curve (step / hold only).';
      container.append(empty);
      return;
    }

    const keys = [...track.keyframes].sort((a, b) => a.t - b.t);
    const values = keys
      .map((k) => channel.read(k.value))
      .filter((v): v is number => v != null);
    if (!values.length) {
      const empty = document.createElement('div');
      empty.className = 'ed-tl-empty';
      empty.textContent = 'No values for this channel.';
      container.append(empty);
      return;
    }

    let vMin = Math.min(...values);
    let vMax = Math.max(...values);
    if (Math.abs(vMax - vMin) < 1e-6) {
      vMin -= 1;
      vMax += 1;
    }
    const vPad = (vMax - vMin) * 0.12;
    vMin -= vPad;
    vMax += vPad;

    const graph = document.createElement('div');
    graph.className = 'ed-tl-curve-graph';
    const width = Math.max(duration * PX_PER_SEC + 40, 320);
    const height = Math.max(container.clientHeight || 160, 160);
    graph.style.width = `${width}px`;
    graph.style.height = `${height}px`;

    const plotW = width - CURVE_PAD.left - CURVE_PAD.right;
    const plotH = height - CURVE_PAD.top - CURVE_PAD.bottom;

    const xOf = (t: number) => CURVE_PAD.left + (t / Math.max(duration, 0.001)) * plotW;
    const yOf = (v: number) =>
      CURVE_PAD.top + ((vMax - v) / Math.max(vMax - vMin, 1e-6)) * plotH;
    const tOf = (x: number) =>
      ((x - CURVE_PAD.left) / plotW) * Math.max(duration, 0.001);
    const vOf = (y: number) =>
      vMax - ((y - CURVE_PAD.top) / plotH) * (vMax - vMin);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'ed-tl-curve-svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // Y-axis labels
    for (let i = 0; i <= 4; i += 1) {
      const v = vMax - ((vMax - vMin) * i) / 4;
      const y = yOf(v);
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(CURVE_PAD.left));
      line.setAttribute('x2', String(width - CURVE_PAD.right));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      line.setAttribute('class', 'ed-tl-curve-grid');
      svg.append(line);
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(CURVE_PAD.left - 8));
      label.setAttribute('y', String(y + 3));
      label.setAttribute('class', 'ed-tl-curve-ylabel');
      label.setAttribute('text-anchor', 'end');
      label.textContent = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
      svg.append(label);
    }

    // Time ticks (reuse duration)
    const majorSteps = Math.ceil(duration);
    for (let i = 0; i <= majorSteps; i += 1) {
      const t = Math.min(i, duration);
      const x = xOf(t);
      const tick = document.createElementNS(svgNS, 'line');
      tick.setAttribute('x1', String(x));
      tick.setAttribute('x2', String(x));
      tick.setAttribute('y1', String(CURVE_PAD.top));
      tick.setAttribute('y2', String(height - CURVE_PAD.bottom));
      tick.setAttribute('class', 'ed-tl-curve-grid-v');
      svg.append(tick);
    }

    // Curve paths per segment
    for (let i = 0; i < keys.length - 1; i += 1) {
      const a = keys[i];
      const b = keys[i + 1];
      const pts = sampleCurve(a, b, channel);
      if (pts.length < 2) continue;
      const d = pts
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xOf(p.t).toFixed(2)} ${yOf(p.v).toFixed(2)}`)
        .join(' ');
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'ed-tl-curve-path');
      svg.append(path);

      // Bezier handles for this segment (into destination key b)
      const va = channel.read(a.value);
      const vb = channel.read(b.value);
      if (va == null || vb == null) continue;
      const bezier = resolveBezier(b.bezier ?? a.bezier, b.easing ?? a.easing);
      const spanT = b.t - a.t;
      const spanV = vb - va;

      const h1 = {
        x: xOf(a.t + bezier.x1 * spanT),
        y: yOf(va + bezier.y1 * spanV),
      };
      const h2 = {
        x: xOf(a.t + bezier.x2 * spanT),
        y: yOf(va + bezier.y2 * spanV),
      };
      const p0 = { x: xOf(a.t), y: yOf(va) };
      const p1 = { x: xOf(b.t), y: yOf(vb) };

      const mkHandleLine = (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('class', 'ed-tl-curve-handle-line');
        return line;
      };
      const bindHandle = (
        cx: number,
        cy: number,
        which: 'out' | 'in',
        destKeyT: number,
        baseBezier: CubicBezier,
        handleLine: SVGLineElement,
      ) => {
        const handle = document.createElementNS(svgNS, 'circle');
        handle.setAttribute('cx', String(cx));
        handle.setAttribute('cy', String(cy));
        handle.setAttribute('r', '5');
        handle.setAttribute('class', 'ed-tl-curve-handle');
        handle.style.cursor = 'grab';

        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          dragging = true;
          handle.classList.add('dragging');
          const svgRect = svg.getBoundingClientRect();

          const move = (ev: PointerEvent) => {
            const mx = ev.clientX - svgRect.left;
            const my = ev.clientY - svgRect.top;
            let nx = (tOf(mx) - a.t) / Math.max(spanT, 1e-6);
            let ny =
              Math.abs(spanV) < 1e-8
                ? which === 'out'
                  ? baseBezier.y1
                  : baseBezier.y2
                : (vOf(my) - va) / spanV;
            nx = Math.min(0.98, Math.max(0.02, nx));
            // Allow mild overshoot on Y for punchier easing
            ny = Math.min(2, Math.max(-1, ny));

            const next: CubicBezier =
              which === 'out'
                ? { x1: nx, y1: ny, x2: baseBezier.x2, y2: baseBezier.y2 }
                : { x1: baseBezier.x1, y1: baseBezier.y1, x2: nx, y2: ny };

            api.timeline.setKeyframeBezier(track.id, destKeyT, next);
            baseBezier.x1 = next.x1;
            baseBezier.y1 = next.y1;
            baseBezier.x2 = next.x2;
            baseBezier.y2 = next.y2;
            const hx = xOf(a.t + nx * spanT);
            const hy = yOf(va + ny * (Math.abs(spanV) < 1e-8 ? 0 : spanV));
            handle.setAttribute('cx', String(hx));
            handle.setAttribute('cy', String(hy));
            handleLine.setAttribute('x2', String(hx));
            handleLine.setAttribute('y2', String(hy));
            const live = sampleCurve(a, { ...b, bezier: next }, channel);
            path.setAttribute(
              'd',
              live
                .map(
                  (p, idx) =>
                    `${idx === 0 ? 'M' : 'L'} ${xOf(p.t).toFixed(2)} ${yOf(p.v).toFixed(2)}`,
                )
                .join(' '),
            );
            api.timeline.evaluateAt(api.timeline.time);
            updatePlayhead();
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            handle.classList.remove('dragging');
            dragging = false;
            api.onChange();
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });

        svg.append(handle);
      };

      const liveBezier = { ...bezier };
      const outLine = mkHandleLine(p0, h1);
      const inLine = mkHandleLine(p1, h2);
      svg.append(outLine, inLine);
      bindHandle(h1.x, h1.y, 'out', b.t, liveBezier, outLine);
      bindHandle(h2.x, h2.y, 'in', b.t, liveBezier, inLine);
    }

    for (const key of keys) {
      const v = channel.read(key.value);
      if (v == null) continue;
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', String(xOf(key.t)));
      dot.setAttribute('cy', String(yOf(v)));
      dot.setAttribute('r', '6');
      dot.setAttribute('class', 'ed-tl-curve-key');
      dot.style.cursor = 'pointer';
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        api.onSeek(key.t);
        updatePlayhead();
      });
      dot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        api.timeline.removeKeyframe(track.id, key.t);
        api.onChange();
      });
      svg.append(dot);
    }

    playheadEl = document.createElement('div');
    playheadEl.className = 'ed-tl-playhead ed-tl-playhead-curve';
    const playheadBadge = document.createElement('span');
    playheadBadge.className = 'ed-tl-playhead-badge';
    playheadBadge.textContent = '0.00';
    playheadEl.append(playheadBadge);
    curveTimeToX = xOf;

    graph.append(svg, playheadEl);
    container.append(graph);

    graph.addEventListener('pointerdown', (event) => {
      if (dragging) return;
      const el = event.target as Element;
      if (el.closest?.('.ed-tl-curve-handle') || el.closest?.('.ed-tl-curve-key')) return;
      const rect = svg.getBoundingClientRect();
      const t = snapTime(tOf(event.clientX - rect.left), duration);
      api.onSeek(t);
      updatePlayhead();
      const move = (e: PointerEvent) => {
        api.onSeek(snapTime(tOf(e.clientX - rect.left), duration));
        updatePlayhead();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  };

  const applyBarGeometry = (
    bar: HTMLElement,
    start: number,
    end: number,
  ) => {
    bar.style.left = `${start * PX_PER_SEC}px`;
    bar.style.width = `${Math.max(4, (end - start) * PX_PER_SEC)}px`;
  };

  const renderActiveRow = (
    row: HTMLElement,
    track: TimelineTrack | null,
    project: Scene,
  ) => {
    if (!track) {
      const empty = document.createElement('div');
      empty.className = 'ed-tl-bar-empty';
      empty.textContent = 'Select a camera → Cut';
      row.append(empty);
      return;
    }

    const segs = holdSegments(track, project.duration);
    const nameOf = (id: string) =>
      project.cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8);

    for (const seg of segs) {
      const bar = document.createElement('div');
      bar.className = 'ed-tl-bar';
      applyBarGeometry(bar, seg.start, seg.end);
      bar.style.background = colorForId(seg.cameraId);
      bar.title = `${nameOf(seg.cameraId)}  ${seg.start.toFixed(2)}s → ${seg.end.toFixed(2)}s`;

      const label = document.createElement('span');
      label.className = 'ed-tl-bar-label';
      label.textContent = nameOf(seg.cameraId);
      bar.append(label);

      const leftHandle = document.createElement('div');
      leftHandle.className = 'ed-tl-bar-handle left';
      const rightHandle = document.createElement('div');
      rightHandle.className = 'ed-tl-bar-handle right';
      // First hold is glued to t=0 — retiming uses the cut diamond / right edge.
      if (seg.start > 1e-4) bar.append(leftHandle);
      bar.append(rightHandle);

      const beginDrag = (e: PointerEvent, mode: 'body' | 'left' | 'right') => {
        e.stopPropagation();
        e.preventDefault();
        if (seg.keyT == null) return;

        dragging = true;
        bar.classList.add('dragging');
        const startX = e.clientX;
        const originKey = seg.keyT;
        const originNext = seg.nextKeyT;
        const span =
          originNext != null ? originNext - originKey : seg.end - originKey;
        let draftKey = originKey;
        let draftNext = originNext;
        let draftDur = project.duration;

        const move = (ev: PointerEvent) => {
          const dt = (ev.clientX - startX) / PX_PER_SEC;

          if (mode === 'body') {
            // Opening shot is glued to 0 — body drag slides the outgoing cut only.
            if (seg.start < 1e-4 && originKey < 1e-4 && originNext != null) {
              draftKey = originKey;
              draftNext = Math.max(
                SNAP,
                Math.min(project.duration, snapTime(originNext + dt, project.duration)),
              );
            } else {
              draftKey = snapTime(originKey + dt, project.duration);
              if (originNext != null) {
                draftKey = Math.max(
                  0,
                  Math.min(project.duration - span, draftKey),
                );
                draftNext = snapTime(draftKey + span, project.duration);
              } else {
                draftKey = Math.max(
                  0,
                  Math.min(project.duration - 0.25, draftKey),
                );
                draftNext = null;
              }
            }
          } else if (mode === 'left') {
            const maxT =
              originNext != null ? originNext - SNAP : project.duration - SNAP;
            draftKey = Math.max(0, Math.min(maxT, snapTime(originKey + dt, project.duration)));
            draftNext = originNext;
          } else {
            // right
            draftKey = originKey;
            if (originNext != null) {
              draftNext = Math.max(
                originKey + SNAP,
                Math.min(project.duration, snapTime(originNext + dt, project.duration)),
              );
            } else {
              draftNext = null;
              draftDur = Math.max(
                originKey + 0.5,
                Math.min(120, snapTime(seg.end + dt, 120)),
              );
            }
          }

          const left =
            seg.start < 1e-4
              ? 0
              : mode === 'left' || mode === 'body'
                ? draftKey
                : seg.start;

          const right =
            draftNext != null
              ? draftNext
              : mode === 'right' && originNext == null
                ? draftDur
                : seg.end;
          applyBarGeometry(bar, left, right);
          api.onSeek(mode === 'right' && draftNext != null ? draftNext : draftKey);
          updatePlayhead();
        };

        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          bar.classList.remove('dragging');
          dragging = false;

          if (mode === 'right' && originNext == null) {
            if (Math.abs(draftDur - project.duration) > 1e-4) {
              api.timeline.setDuration(draftDur);
              project.duration = draftDur;
              syncMasterAfterSceneDuration(api);
              api.onChange();
            } else {
              refresh();
            }
            return;
          }

          if (mode === 'body' && originNext != null && draftNext != null) {
            // Opening shot: only the outgoing cut moved.
            if (seg.start < 1e-4 && originKey < 1e-4) {
              if (Math.abs(draftNext - originNext) > 1e-4) {
                api.timeline.moveKeyframe(track.id, originNext, draftNext);
                api.onChange();
              } else {
                refresh();
              }
              return;
            }
            if (draftKey >= originKey) {
              api.timeline.moveKeyframe(track.id, originNext, draftNext);
              api.timeline.moveKeyframe(track.id, originKey, draftKey);
            } else {
              api.timeline.moveKeyframe(track.id, originKey, draftKey);
              api.timeline.moveKeyframe(track.id, originNext, draftNext);
            }
            api.onChange();
            return;
          }

          if (mode === 'body' && originNext == null) {
            if (Math.abs(draftKey - originKey) > 1e-4) {
              api.timeline.moveKeyframe(track.id, originKey, draftKey);
              api.onChange();
            } else {
              refresh();
            }
            return;
          }

          if (mode === 'left' && Math.abs(draftKey - originKey) > 1e-4) {
            api.timeline.moveKeyframe(track.id, originKey, draftKey);
            api.onChange();
            return;
          }

          if (
            mode === 'right' &&
            originNext != null &&
            draftNext != null &&
            Math.abs(draftNext - originNext) > 1e-4
          ) {
            api.timeline.moveKeyframe(track.id, originNext, draftNext);
            api.onChange();
            return;
          }

          refresh();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      leftHandle.addEventListener('pointerdown', (e) => beginDrag(e, 'left'));
      rightHandle.addEventListener('pointerdown', (e) => beginDrag(e, 'right'));
      bar.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).classList.contains('ed-tl-bar-handle')) return;
        beginDrag(e, 'body');
      });

      row.append(bar);
    }

    for (const key of track.keyframes) {
      const diamond = document.createElement('button');
      diamond.type = 'button';
      diamond.className = 'ed-tl-key ed-tl-key-cut';
      diamond.dataset.trackId = track.id;
      diamond.dataset.t = String(key.t);
      diamond.style.left = `${key.t * PX_PER_SEC}px`;
      if (isKeySelected({ trackId: track.id, t: key.t })) {
        diamond.classList.add('selected');
      }
      diamond.title = `Cut @ ${key.t.toFixed(2)}s — drag select/move, Delete to remove`;
      diamond.addEventListener('click', (e) => {
        e.stopPropagation();
        api.onSeek(key.t);
        updatePlayhead();
      });
      diamond.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ref: KeyRef = { trackId: track.id, t: key.t };
        if (isKeySelected(ref) && selectedKeys.length > 1) {
          deleteSelectedKeys();
        } else {
          setSelectedKeys([]);
          api.timeline.removeKeyframe(track.id, key.t);
          api.onChange();
        }
      });
      bindKeyDrag(diamond, track, key.t);
      row.append(diamond);
    }
  };

  const appendTrackLabel = (
    text: string,
    className: string,
    track: TimelineTrack | null,
  ) => {
    const lab = document.createElement('div');
    lab.className = className;
    lab.textContent = text;
    lab.title = track
      ? `${text} — click to select, then toggle Curve`
      : text;
    if (track && trackSupportsCurve(track)) {
      lab.dataset.trackId = track.id;
      lab.classList.add('ed-tl-label-selectable');
      if (selectedTrackId === track.id) lab.classList.add('ed-tl-label-selected');
      lab.addEventListener('click', () => selectTrack(track.id));
    }
    labels.append(lab);
  };

  const refresh = () => {
    const project = api.getScene();
    durInput.value = String(project.duration);
    labels.replaceChildren();
    tracksEl.replaceChildren();
    curveTimeToX = null;
    body.classList.toggle('ed-tl-curve-mode', curveMode);

    const tracks = api.timeline.getTracks();
    // Drop selection if track vanished
    if (
      selectedTrackId &&
      !tracks.some((t) => t.id === selectedTrackId)
    ) {
      selectedTrackId = null;
      if (curveMode) curveMode = false;
    }
    pruneSelectedKeys();

    syncChannelSelect();

    const tree = buildRows(project, tracks);
    groupIds = [...tree.parents.keys()];
    syncFoldButton();

    const rowHidden = (row: Row) => {
      let id = row.kind === 'header' ? row.parentId : row.groupId;
      while (id) {
        if (collapsedGroups.has(id)) return true;
        id = tree.parents.get(id) ?? null;
      }
      return false;
    };

    const directChildCount = (groupId: string) => {
      let count = 0;
      for (const row of tree.rows) {
        if (row.kind === 'header') {
          if (row.parentId === groupId) count += 1;
        } else if (row.groupId === groupId) count += 1;
      }
      return count;
    };

    if (curveMode && selectedTrackId) {
      const track = tracks.find((t) => t.id === selectedTrackId);
      if (track && trackSupportsCurve(track)) {
        appendLabel('Curve', 'ed-tl-label ed-tl-label-head');
        appendTrackLabel(track.target, 'ed-tl-label ed-tl-label-selected', track);
        for (const t of tracks) {
          if (t.id === track.id || !trackSupportsCurve(t)) continue;
          appendTrackLabel(
            t.target.split('.').slice(-1)[0] ?? t.target,
            'ed-tl-label ed-tl-label-nested ed-tl-label-selectable',
            t,
          );
        }
        renderCurveGraph(tracksEl, track, project.duration);
        updatePlayhead();
        return;
      }
      curveMode = false;
      body.classList.remove('ed-tl-curve-mode');
    }

    const ruler = document.createElement('div');
    ruler.className = 'ed-tl-ruler';
    ruler.style.width = `${project.duration * PX_PER_SEC + 40}px`;
    const minorSteps = Math.ceil(project.duration * 10);
    for (let i = 0; i <= minorSteps; i += 1) {
      const t = i / 10;
      if (t > project.duration + 1e-6) break;
      const tick = document.createElement('span');
      const major = i % 10 === 0;
      tick.className = major ? 'ed-tl-tick ed-tl-tick-major' : 'ed-tl-tick ed-tl-tick-minor';
      tick.style.left = `${t * PX_PER_SEC}px`;
      if (major) tick.textContent = `${Math.round(t)}s`;
      ruler.append(tick);
    }

    appendLabel('Tracks', 'ed-tl-label ed-tl-label-head');

    playheadEl = document.createElement('div');
    playheadEl.className = 'ed-tl-playhead';
    const playheadBadge = document.createElement('span');
    playheadBadge.className = 'ed-tl-playhead-badge';
    playheadBadge.textContent = '0.00';
    const playheadHit = document.createElement('div');
    playheadHit.className = 'ed-tl-playhead-hit';
    playheadHit.title = 'Drag to scrub';
    playheadEl.append(playheadBadge, playheadHit);
    bindPlayheadScrub(playheadBadge);
    bindPlayheadScrub(playheadHit);
    ruler.addEventListener('pointerdown', bindScrubDrag);
    tracksEl.append(ruler, playheadEl);

    const appendGroupLabel = (row: Extract<Row, { kind: 'header' }>) => {
      const folded = collapsedGroups.has(row.groupId);
      const lab = document.createElement('div');
      lab.className = 'ed-tl-label ed-tl-label-group';
      if (row.depth > 0) lab.classList.add('ed-tl-label-group-nested');
      lab.title = folded ? `Expand ${row.label}` : `Collapse ${row.label}`;

      const twist = document.createElement('button');
      twist.type = 'button';
      twist.className = 'ed-twist';
      if (folded) twist.classList.add('collapsed');
      twist.setAttribute('aria-expanded', folded ? 'false' : 'true');
      twist.setAttribute('aria-label', lab.title);
      twist.innerHTML = TWIST_ICON;

      const text = document.createElement('span');
      text.className = 'ed-tl-label-text';
      text.textContent = row.label;

      const toggle = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        setGroupCollapsed(row.groupId, !folded);
      };
      twist.addEventListener('click', toggle);
      lab.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('.ed-twist')) return;
        toggle(event);
      });

      lab.append(twist, text);
      if (folded) {
        const count = document.createElement('span');
        count.className = 'ed-tl-fold-count';
        count.textContent = String(directChildCount(row.groupId));
        lab.append(count);
      }
      labels.append(lab);
    };

    const renderCollapsedSummary = (lane: HTMLElement, groupId: string) => {
      const seen = new Set<string>();
      for (const row of tree.rows) {
        if (row.kind === 'header' || !row.track) continue;
        if (!groupWithin(row.groupId, groupId, tree.parents)) continue;
        if (seen.has(row.track.id)) continue;
        seen.add(row.track.id);
        if (row.kind === 'active') {
          for (const seg of holdSegments(row.track, project.duration)) {
            const bar = document.createElement('div');
            bar.className = 'ed-tl-mini-bar';
            bar.style.left = `${seg.start * PX_PER_SEC}px`;
            bar.style.width = `${Math.max(4, (seg.end - seg.start) * PX_PER_SEC)}px`;
            bar.style.background = colorForId(seg.cameraId);
            lane.append(bar);
          }
          continue;
        }
        for (const key of row.track.keyframes) {
          const dot = document.createElement('span');
          dot.className = 'ed-tl-mini';
          dot.style.left = `${key.t * PX_PER_SEC}px`;
          lane.append(dot);
        }
      }
    };

    if (!tree.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'ed-tl-empty';
      empty.textContent =
        'Select a camera, scrub the playhead, then Cut (switch shot) or Animate (move within shot).';
      tracksEl.append(empty);
      updatePlayhead();
      return;
    }

    for (const r of tree.rows) {
      if (rowHidden(r)) continue;
      if (r.kind === 'header') {
        appendGroupLabel(r);
        const spacer = makeTrackRow(project.duration);
        spacer.classList.add('ed-tl-track-group');
        if (collapsedGroups.has(r.groupId)) renderCollapsedSummary(spacer, r.groupId);
        tracksEl.append(spacer);
        continue;
      }
      if (r.kind === 'active') {
        const depth = groupDepth(r.groupId, tree.parents);
        appendLabel(
          r.label,
          depth > 0
            ? 'ed-tl-label ed-tl-label-nested ed-tl-label-deep'
            : 'ed-tl-label ed-tl-label-nested',
        );
        const row = makeTrackRow(project.duration);
        row.classList.add('ed-tl-track-active');
        renderActiveRow(row, r.track, project);
        tracksEl.append(row);
        continue;
      }
      const depth = groupDepth(r.groupId, tree.parents);
      const nestedClass = r.nested
        ? depth > 0
          ? 'ed-tl-label ed-tl-label-nested ed-tl-label-deep'
          : 'ed-tl-label ed-tl-label-nested'
        : 'ed-tl-label';
      appendTrackLabel(r.label, nestedClass, r.track);
      const row = makeTrackRow(project.duration);
      renderKeysRow(row, r.track);
      tracksEl.append(row);
    }

    updatePlayhead();
  };

  refresh();
  return { refresh, updatePlayhead };
}
