import type { Project } from '../project';
import type { TimelineEngine } from '../timeline';

const PX_PER_SEC = 80;

export type TimelineUiApi = {
  getProject: () => Project;
  timeline: TimelineEngine;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  onKeyframe: () => void;
  onChange: () => void;
};

export type TimelineUiHandle = {
  refresh: () => void;
  updatePlayhead: () => void;
};

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
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

  const keyBtn = document.createElement('button');
  keyBtn.className = 'ed-btn';
  keyBtn.type = 'button';
  keyBtn.textContent = '+ Keyframe';

  const timeLabel = document.createElement('span');
  timeLabel.className = 'ed-tl-time';

  const durLabel = document.createElement('label');
  durLabel.style.cssText = 'font-size:12px;color:var(--ed-muted);display:flex;gap:6px;align-items:center';
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
    api.getProject().duration = v;
    refresh();
  });
  durLabel.append(durInput);

  toolbar.append(playBtn, stopBtn, keyBtn, timeLabel, durLabel);
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

  const syncPlayButton = () => {
    playBtn.textContent = api.timeline.state === 'playing' ? 'Pause' : 'Play';
  };

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
  keyBtn.addEventListener('click', () => api.onKeyframe());

  const seekFromEvent = (event: MouseEvent) => {
    const rect = tracksEl.getBoundingClientRect();
    const x = event.clientX - rect.left + tracksEl.scrollLeft;
    const t = Math.max(0, Math.min(api.timeline.duration, x / PX_PER_SEC));
    api.onSeek(t);
    updatePlayhead();
  };

  tracksEl.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).classList.contains('ed-tl-key')) return;
    seekFromEvent(event);
    const move = (e: PointerEvent) => seekFromEvent(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const updatePlayhead = () => {
    const t = api.timeline.time;
    timeLabel.textContent = `${formatTime(t)} / ${formatTime(api.timeline.duration)}`;
    if (playheadEl) playheadEl.style.left = `${t * PX_PER_SEC}px`;
    syncPlayButton();
  };

  const refresh = () => {
    const project = api.getProject();
    durInput.value = String(project.duration);
    labels.replaceChildren();
    tracksEl.replaceChildren();

    const ruler = document.createElement('div');
    ruler.className = 'ed-tl-ruler';
    ruler.style.width = `${project.duration * PX_PER_SEC + 40}px`;
    const labelSpacer = document.createElement('div');
    labelSpacer.className = 'ed-tl-label';
    labelSpacer.textContent = 'Tracks';
    labels.append(labelSpacer);

    const tracks = api.timeline.getTracks();
    playheadEl = document.createElement('div');
    playheadEl.className = 'ed-tl-playhead';
    tracksEl.append(ruler, playheadEl);

    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'ed-tl-empty';
      empty.textContent = 'No keyframes yet — select an object and click + Keyframe.';
      tracksEl.append(empty);
      updatePlayhead();
      return;
    }

    for (const track of tracks) {
      const lab = document.createElement('div');
      lab.className = 'ed-tl-label';
      lab.textContent = track.target;
      lab.title = track.target;
      labels.append(lab);

      const row = document.createElement('div');
      row.className = 'ed-tl-track';
      row.style.width = `${project.duration * PX_PER_SEC + 40}px`;
      for (const key of track.keyframes) {
        const diamond = document.createElement('button');
        diamond.type = 'button';
        diamond.className = 'ed-tl-key';
        diamond.style.left = `${key.t * PX_PER_SEC}px`;
        diamond.title = `${track.target} @ ${key.t.toFixed(2)}s`;
        diamond.addEventListener('click', (e) => {
          e.stopPropagation();
          api.onSeek(key.t);
          updatePlayhead();
        });
        diamond.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          api.timeline.removeKeyframe(track.id, key.t);
          api.onChange();
        });
        row.append(diamond);
      }
      tracksEl.append(row);
    }
    updatePlayhead();
  };

  refresh();
  return { refresh, updatePlayhead };
}
