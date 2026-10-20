import {
  addMasterClip,
  clipDuration,
  getSceneById,
  masterDuration,
  normalizeMasterClip,
  type MasterClip,
  type Project,
} from '../project';

const PX_PER_SEC = 48;

export type MasterUiApi = {
  getProject: () => Project;
  getTime: () => number;
  getPlaying: () => boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  onChange: () => void;
  setStatus: (msg: string) => void;
};

export type MasterUiHandle = {
  refresh: () => void;
  updatePlayhead: () => void;
};

export function mountMasterUi(host: HTMLElement, api: MasterUiApi): MasterUiHandle {
  host.replaceChildren();

  const root = document.createElement('div');
  root.className = 'ed-master';

  const toolbar = document.createElement('div');
  toolbar.className = 'ed-tl-toolbar';

  const playBtn = document.createElement('button');
  playBtn.className = 'ed-btn primary';
  playBtn.type = 'button';
  playBtn.textContent = 'Play';
  playBtn.addEventListener('click', () => {
    if (api.getPlaying()) api.onPause();
    else api.onPlay();
    refresh();
  });

  const stopBtn = document.createElement('button');
  stopBtn.className = 'ed-btn';
  stopBtn.type = 'button';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => {
    api.onStop();
    refresh();
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'ed-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Clip';
  addBtn.title = 'Add a scene to the master sequence';
  addBtn.addEventListener('click', () => {
    const project = api.getProject();
    if (!project.scenes.length) return;
    const names = project.scenes.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    const pick = window.prompt(`Add scene to master:\n${names}\n\nEnter number:`, '1');
    if (!pick) return;
    const idx = Number.parseInt(pick, 10) - 1;
    const scene = project.scenes[idx];
    if (!scene) {
      api.setStatus('Invalid scene number');
      return;
    }
    addMasterClip(project, scene.id);
    api.onChange();
    api.setStatus(`Added “${scene.name}” to master`);
    refresh();
  });

  const durLabel = document.createElement('span');
  durLabel.className = 'ed-master-dur';

  const timeLabel = document.createElement('span');
  timeLabel.className = 'ed-master-time';

  toolbar.append(playBtn, stopBtn, addBtn, durLabel, timeLabel);

  const scroll = document.createElement('div');
  scroll.className = 'ed-master-scroll';

  const track = document.createElement('div');
  track.className = 'ed-master-track';

  const playhead = document.createElement('div');
  playhead.className = 'ed-master-playhead';

  scroll.append(track);
  root.append(toolbar, scroll, playhead);
  host.append(root);

  let selectedClipId: string | null = null;

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };

  const moveClip = (clipId: string, dir: -1 | 1) => {
    const project = api.getProject();
    const clips = project.master.clips;
    const i = clips.findIndex((c) => c.id === clipId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= clips.length) return;
    const tmp = clips[i];
    clips[i] = clips[j];
    clips[j] = tmp;
    api.onChange();
    refresh();
  };

  const removeClip = (clipId: string) => {
    const project = api.getProject();
    if (project.master.clips.length <= 1) {
      api.setStatus('Master needs at least one clip');
      return;
    }
    project.master.clips = project.master.clips.filter((c) => c.id !== clipId);
    if (selectedClipId === clipId) selectedClipId = null;
    api.onChange();
    refresh();
  };

  const trimClip = (clip: MasterClip, which: 'in' | 'out') => {
    const project = api.getProject();
    const scene = getSceneById(project, clip.sceneId);
    if (!scene) return;
    const current = which === 'in' ? clip.in : clip.out;
    const next = window.prompt(
      which === 'in' ? 'In point (seconds)' : 'Out point (seconds)',
      String(current),
    );
    if (next == null) return;
    const v = Number.parseFloat(next);
    if (!Number.isFinite(v)) return;
    if (which === 'in') clip.in = v;
    else clip.out = v;
    normalizeMasterClip(clip, scene);
    api.onChange();
    refresh();
  };

  const seekFromClientX = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;
    const t = Math.max(0, x / PX_PER_SEC);
    api.onSeek(t);
    updatePlayhead();
  };

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.ed-master-clip')) return;
    seekFromClientX(e.clientX);
  });

  const refresh = () => {
    const project = api.getProject();
    const total = masterDuration(project);
    durLabel.textContent = `Master ${formatTime(total)}`;
    playBtn.textContent = api.getPlaying() ? 'Pause' : 'Play';

    track.replaceChildren();
    track.style.width = `${Math.max(total * PX_PER_SEC, 400)}px`;

    let cursor = 0;
    for (const clip of project.master.clips) {
      const scene = getSceneById(project, clip.sceneId);
      const dur = clipDuration(clip);
      const el = document.createElement('div');
      el.className = `ed-master-clip${selectedClipId === clip.id ? ' selected' : ''}`;
      el.style.left = `${cursor * PX_PER_SEC}px`;
      el.style.width = `${Math.max(dur * PX_PER_SEC, 40)}px`;
      el.title = `${scene?.name ?? 'Missing'}  ${clip.in.toFixed(2)}–${clip.out.toFixed(2)}s`;

      const label = document.createElement('div');
      label.className = 'ed-master-clip-label';
      label.textContent = scene?.name ?? '?';

      const meta = document.createElement('div');
      meta.className = 'ed-master-clip-meta';
      meta.textContent = `${dur.toFixed(1)}s`;

      const actions = document.createElement('div');
      actions.className = 'ed-master-clip-actions';

      const mk = (text: string, title: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ed-btn';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };

      actions.append(
        mk('◀', 'Move earlier', () => moveClip(clip.id, -1)),
        mk('▶', 'Move later', () => moveClip(clip.id, 1)),
        mk('In', 'Set in point', () => trimClip(clip, 'in')),
        mk('Out', 'Set out point', () => trimClip(clip, 'out')),
        mk('×', 'Remove clip', () => removeClip(clip.id)),
      );

      el.append(label, meta, actions);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedClipId = clip.id;
        api.onSeek(cursor + 0.001);
        refresh();
      });
      track.append(el);
      cursor += dur;
    }

    updatePlayhead();
  };

  const updatePlayhead = () => {
    const t = api.getTime();
    const total = masterDuration(api.getProject());
    timeLabel.textContent = `${formatTime(t)} / ${formatTime(total)}`;
    const x = t * PX_PER_SEC;
    playhead.style.transform = `translateX(${x - scroll.scrollLeft}px)`;
    // Keep playhead roughly in view
    const viewL = scroll.scrollLeft;
    const viewR = viewL + scroll.clientWidth;
    if (x < viewL + 40) scroll.scrollLeft = Math.max(0, x - 40);
    else if (x > viewR - 40) scroll.scrollLeft = x - scroll.clientWidth + 40;
  };

  scroll.addEventListener('scroll', () => updatePlayhead());

  refresh();

  return { refresh, updatePlayhead };
}
