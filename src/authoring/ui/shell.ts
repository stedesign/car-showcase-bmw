import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import type { TextsHandle } from '../texts';
import type { Project, Selection } from '../project';
import type { TimelineEngine } from '../timeline';
import { renderHierarchy } from './hierarchy';
import { renderInspector } from './inspector';
import { mountTimelineUi, type TimelineUiHandle } from './timelineUi';
import {
  mountCameraPreview,
  type CameraPreviewHandle,
} from './cameraPreview';
import { mountViewGizmo, type ViewGizmoHandle } from './viewGizmo';
import '../editor.css';

export type EditorShellOptions = {
  viewer: Viewer;
  getProject: () => Project;
  getSelection: () => Selection;
  select: (kind: Selection['kind'], id: string | null) => void;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  texts: TextsHandle;
  timeline: TimelineEngine;
  onCut: () => void;
  onAnimate: () => void;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  onSave: () => void;
  onExport: () => void;
  onImport: (file: File) => void | Promise<void>;
  onReset: () => void | Promise<void>;
  onRecord: () => void;
  onStopRecord: () => void | Promise<void>;
  onTogglePreview: () => void;
  /** Called after project-mutating UI edits (feeds undo history). */
  onEdit: () => void;
  setStatus: (msg: string) => void;
  isRecording: () => boolean;
  isPreviewing: () => boolean;
};

export type EditorShell = {
  refresh: () => void;
  updatePlayhead: () => void;
  setChromeVisible: (visible: boolean) => void;
  setPreviewHudVisible: (visible: boolean) => void;
  dispose: () => void;
};

export function mountEditorShell(opts: EditorShellOptions): EditorShell {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) throw new Error('#app missing');

  const root = document.createElement('div');
  root.id = 'editor-root';

  const top = document.createElement('div');
  top.className = 'ed-top';
  const brand = document.createElement('div');
  brand.className = 'ed-brand';
  brand.textContent = 'WRT Director';

  const mkBtn = (label: string, cls: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ed-btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.hidden = true;
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file) void opts.onImport(file);
    importInput.value = '';
  });

  const recordBtn = mkBtn('● Record', 'record', () => {
    if (opts.isRecording()) void opts.onStopRecord();
    else opts.onRecord();
    refreshTop();
  });

  const previewBtn = mkBtn('Preview', '', () => {
    opts.onTogglePreview();
    refreshTop();
  });
  previewBtn.title = 'Toggle clean preview (how the timeline looks before export)';

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  top.append(
    brand,
    mkBtn('Save', '', opts.onSave),
    mkBtn('Export JSON', '', opts.onExport),
    mkBtn('Import JSON', '', () => importInput.click()),
    mkBtn('New', 'danger', () => void opts.onReset()),
    spacer,
    previewBtn,
    recordBtn,
    importInput,
  );

  // Floating HUD while previewing (chrome is hidden).
  const previewHud = document.createElement('div');
  previewHud.className = 'ed-preview-hud';
  previewHud.hidden = true;

  const previewLabel = document.createElement('span');
  previewLabel.className = 'ed-preview-hud-label';
  previewLabel.textContent = 'Preview';

  const previewTime = document.createElement('span');
  previewTime.className = 'ed-preview-hud-time';
  previewTime.textContent = '0:00.00';

  const previewPlayBtn = mkBtn('Play', 'ed-preview-hud-btn', () => {
    if (opts.timeline.state === 'playing') opts.onPause();
    else opts.onPlay();
    refreshPreviewHud();
  });
  const previewRestartBtn = mkBtn('Restart', 'ed-preview-hud-btn', () => {
    opts.onSeek(0);
    opts.onPlay();
    refreshPreviewHud();
  });
  const previewExitBtn = mkBtn('Exit', 'ed-preview-hud-btn primary', () => {
    opts.onTogglePreview();
  });
  previewExitBtn.title = 'Exit preview (Esc)';

  previewHud.append(
    previewLabel,
    previewTime,
    previewPlayBtn,
    previewRestartBtn,
    previewExitBtn,
  );

  const left = document.createElement('div');
  left.className = 'ed-left';
  const right = document.createElement('div');
  right.className = 'ed-right';
  const viewport = document.createElement('div');
  viewport.className = 'ed-viewport';
  const camBadge = document.createElement('div');
  camBadge.className = 'ed-cam-badge free';
  camBadge.textContent = 'Free Camera';
  const camFrame = document.createElement('div');
  camFrame.className = 'ed-cam-frame';
  camFrame.hidden = true;
  const timelineHost = document.createElement('div');
  timelineHost.className = 'ed-timeline';

  const TL_HEIGHT_KEY = 'wrt-director-timeline-h';
  const TL_MIN = 120;
  const TL_DEFAULT = 260;

  const clampTlHeight = (px: number) => {
    const max = Math.floor(window.innerHeight * 0.75);
    return Math.max(TL_MIN, Math.min(max, Math.round(px)));
  };

  const applyTlHeight = (px: number, notify = true) => {
    const h = clampTlHeight(px);
    root.style.setProperty('--ed-bottom', `${h}px`);
    if (notify) opts.viewer.notifyResize();
    return h;
  };

  const savedTl = Number.parseInt(localStorage.getItem(TL_HEIGHT_KEY) ?? '', 10);
  applyTlHeight(Number.isFinite(savedTl) ? savedTl : TL_DEFAULT, false);

  // Re-parent #app into viewport
  app.parentElement?.insertBefore(root, app);
  viewport.append(app, camFrame, camBadge, previewHud);
  root.append(top, left, viewport, right, timelineHost);

  const cameraPreview: CameraPreviewHandle = mountCameraPreview(viewport, {
    viewer: opts.viewer,
    cameras: opts.cameras,
    getProject: opts.getProject,
    getSelection: opts.getSelection,
    select: opts.select,
    onChange: () => onEdit(),
    setStatus: opts.setStatus,
  });

  const viewGizmo: ViewGizmoHandle = mountViewGizmo(viewport, {
    camera: opts.viewer.camera,
    cameras: opts.cameras,
    setStatus: opts.setStatus,
    onSnap: () => {
      // Leaving a through-camera via axis snap updates chrome / hierarchy.
      refresh();
    },
  });

  opts.viewer.setPostRender(() => {
    cameraPreview.render();
    viewGizmo.render();
  });

  const syncCameraChrome = () => {
    const cams = opts.cameras;
    if (cams.viewMode === 'through' && cams.throughCameraId) {
      const clip = cams.get(cams.throughCameraId);
      camBadge.className = 'ed-cam-badge';
      camBadge.textContent = `Camera · ${clip?.name ?? 'Shot'}`;
      camFrame.hidden = false;
    } else {
      camBadge.className = 'ed-cam-badge free';
      camBadge.textContent = 'Free Camera';
      camFrame.hidden = true;
    }
  };

  let timelineUi: TimelineUiHandle;

  const onEdit = () => {
    opts.onEdit();
    refresh();
  };

  const refresh = () => {
    renderHierarchy(left, {
      viewer: opts.viewer,
      getProject: opts.getProject,
      getSelection: opts.getSelection,
      select: opts.select,
      cameras: opts.cameras,
      planes: opts.planes,
      texts: opts.texts,
      onChange: onEdit,
    });
    renderInspector(right, {
      viewer: opts.viewer,
      getProject: opts.getProject,
      getSelection: opts.getSelection,
      cameras: opts.cameras,
      planes: opts.planes,
      texts: opts.texts,
      onChange: onEdit,
      onLookEdit: opts.onEdit,
      setStatus: opts.setStatus,
    });
    timelineUi.refresh();
    cameraPreview.refresh();
    refreshTop();
    syncCameraChrome();
    opts.viewer.notifyResize();
  };

  const formatPreviewTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };

  const refreshPreviewHud = () => {
    const playing = opts.timeline.state === 'playing';
    previewPlayBtn.textContent = playing ? 'Pause' : 'Play';
    previewTime.textContent = `${formatPreviewTime(opts.timeline.time)} / ${formatPreviewTime(opts.timeline.duration)}`;
  };

  const refreshTop = () => {
    recordBtn.textContent = opts.isRecording() ? '■ Stop & export' : '● Record';
    const previewing = opts.isPreviewing();
    previewBtn.classList.toggle('active', previewing);
    previewBtn.textContent = previewing ? 'Exit preview' : 'Preview';
    previewBtn.disabled = opts.isRecording();
    recordBtn.disabled = previewing;
    refreshPreviewHud();
  };

  timelineUi = mountTimelineUi(timelineHost, {
    getProject: opts.getProject,
    getSelection: opts.getSelection,
    timeline: opts.timeline,
    onPlay: opts.onPlay,
    onPause: opts.onPause,
    onStop: opts.onStop,
    onSeek: opts.onSeek,
    onCut: opts.onCut,
    onAnimate: opts.onAnimate,
    onChange: onEdit,
  });

  // After timeline UI mounts (it replaceChildren the host).
  const tlResize = document.createElement('div');
  tlResize.className = 'ed-tl-resize';
  tlResize.title = 'Drag to resize timeline';
  tlResize.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH =
      Number.parseFloat(getComputedStyle(root).getPropertyValue('--ed-bottom')) ||
      TL_DEFAULT;
    tlResize.classList.add('dragging');
    document.body.classList.add('ed-tl-resizing');
    tlResize.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      // Drag up → taller timeline; drag down → shorter.
      applyTlHeight(startH + (startY - ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      tlResize.releasePointerCapture(ev.pointerId);
      tlResize.removeEventListener('pointermove', onMove);
      tlResize.removeEventListener('pointerup', onUp);
      tlResize.removeEventListener('pointercancel', onUp);
      tlResize.classList.remove('dragging');
      document.body.classList.remove('ed-tl-resizing');
      const h =
        Number.parseFloat(getComputedStyle(root).getPropertyValue('--ed-bottom')) ||
        TL_DEFAULT;
      localStorage.setItem(TL_HEIGHT_KEY, String(Math.round(h)));
      opts.viewer.notifyResize();
    };
    tlResize.addEventListener('pointermove', onMove);
    tlResize.addEventListener('pointerup', onUp);
    tlResize.addEventListener('pointercancel', onUp);
  });
  timelineHost.prepend(tlResize);

  refresh();

  return {
    refresh,
    updatePlayhead() {
      timelineUi.updatePlayhead();
      refreshPreviewHud();
    },
    setChromeVisible(visible) {
      root.classList.toggle('chrome-hidden', !visible);
      opts.viewer.notifyResize();
    },
    setPreviewHudVisible(visible) {
      previewHud.hidden = !visible;
      refreshPreviewHud();
    },
    dispose() {
      opts.viewer.setPostRender(null);
      viewGizmo.dispose();
      cameraPreview.dispose();
      // Move app back and remove shell
      document.body.append(app);
      root.remove();
    },
  };
}
