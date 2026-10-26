import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import type { EditorMode, Project, Scene, Selection } from '../project';
import type { TimelineEngine } from '../timeline';
import { renderHierarchy } from './hierarchy';
import { renderInspector } from './inspector';
import { mountTimelineUi, type TimelineUiHandle } from './timelineUi';
import { mountMasterUi, type MasterUiHandle } from './masterUi';
import {
  mountCameraPreview,
  type CameraPreviewHandle,
} from './cameraPreview';
import { mountViewGizmo, type ViewGizmoHandle } from './viewGizmo';
import '../editor.css';

export type EditorShellOptions = {
  viewer: Viewer;
  getProject: () => Project;
  getScene: () => Scene;
  getSelection: () => Selection;
  select: (kind: Selection['kind'], id: string | null) => void;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  timeline: TimelineEngine;
  getMasterTime: () => number;
  getMasterDuration: () => number;
  isMasterPlaying: () => boolean;
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
  /** Restore storyboard scenes, cameras, and lights from the left sidebar. */
  onResetSetup: () => void | Promise<void>;
  /** Delete scene timeline keyframes and dedicated cameras. Free camera stays. */
  onClearTimeline: () => void;
  onRecord: () => void;
  onStopRecord: () => void | Promise<void>;
  onTogglePreview: () => void;
  /** Called after project-mutating UI edits (feeds undo history). */
  onEdit: () => void;
  onSetEditorMode: (mode: EditorMode) => void;
  onSelectScene: (sceneId: string) => void;
  onAddScene: () => void;
  onDuplicateScene: () => void;
  onDeleteScene: (sceneId: string) => void;
  onDeleteAllScenes: () => void;
  onRenameScene: (sceneId: string, name: string) => void;
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

  const modeSceneBtn = mkBtn('Scene', 'ed-mode-btn', () => {
    opts.onSetEditorMode('scene');
  });
  const modeMasterBtn = mkBtn('Master', 'ed-mode-btn', () => {
    opts.onSetEditorMode('master');
  });
  const modeGroup = document.createElement('div');
  modeGroup.className = 'ed-mode-toggle';
  modeGroup.append(modeSceneBtn, modeMasterBtn);

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

  const INSPECTOR_OPEN_KEY = 'wrt-director-inspector-open';
  const inspectorBtn = document.createElement('button');
  inspectorBtn.type = 'button';
  inspectorBtn.className = 'ed-sb-toggle';
  inspectorBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <defs>
      <clipPath id="ed-inspector-toggle-clip">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.6"></rect>
      </clipPath>
    </defs>
    <g clip-path="url(#ed-inspector-toggle-clip)">
      <rect class="ed-sb-pane" x="10.15" y="2.5" width="4.35" height="11"></rect>
    </g>
    <rect class="ed-sb-frame" x="1.5" y="2.5" width="13" height="11" rx="1.6"></rect>
    <path class="ed-sb-split" d="M10.15 2.5v11"></path>
  </svg>`;

  const inspectorIsOpen = () => !root.classList.contains('inspector-collapsed');

  const applyInspectorOpen = (open: boolean, persist = false) => {
    root.classList.toggle('inspector-collapsed', !open);
    inspectorBtn.classList.toggle('active', open);
    const label = open ? 'Hide inspector' : 'Show inspector';
    inspectorBtn.title = label;
    inspectorBtn.setAttribute('aria-label', label);
    inspectorBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (persist) localStorage.setItem(INSPECTOR_OPEN_KEY, open ? '1' : '0');
  };

  applyInspectorOpen(localStorage.getItem(INSPECTOR_OPEN_KEY) !== '0');
  inspectorBtn.addEventListener('click', () => {
    applyInspectorOpen(!inspectorIsOpen(), true);
    opts.viewer.notifyResize();
  });

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  top.append(
    brand,
    modeGroup,
    mkBtn('Save', '', opts.onSave),
    mkBtn('Export JSON', '', opts.onExport),
    mkBtn('Import JSON', '', () => importInput.click()),
    mkBtn('New', 'danger', () => void opts.onReset()),
    spacer,
    previewBtn,
    recordBtn,
    inspectorBtn,
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

  const isPlaying = () =>
    opts.getProject().editorMode === 'master'
      ? opts.isMasterPlaying()
      : opts.timeline.state === 'playing';

  const previewPlayBtn = mkBtn('Play', 'ed-preview-hud-btn', () => {
    if (isPlaying()) opts.onPause();
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
  const leftScroll = document.createElement('div');
  leftScroll.className = 'ed-left-scroll';
  const sidebarActions = document.createElement('div');
  sidebarActions.className = 'ed-sidebar-actions';
  const clearTimelineBtn = mkBtn('Clear timeline & cameras', 'ed-sidebar-reset', () => {
    opts.onClearTimeline();
  });
  clearTimelineBtn.title =
    'Delete every timeline keyframe and every camera in this scene. Free camera stays.';
  const resetSetupBtn = mkBtn('Reset cameras, lights, scenes', 'ed-sidebar-reset', () => {
    void opts.onResetSetup();
  });
  resetSetupBtn.title =
    'Restore scenes, cameras, and lights to the 60s loop. Master titles stay.';
  sidebarActions.append(clearTimelineBtn, resetSetupBtn);
  left.append(leftScroll, sidebarActions);
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
  const timelineContent = document.createElement('div');
  timelineContent.className = 'ed-timeline-content';
  timelineHost.append(timelineContent);

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
    getScene: opts.getScene,
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

  let timelineUi: TimelineUiHandle | null = null;
  let masterUi: MasterUiHandle | null = null;
  let bottomMode: EditorMode | null = null;

  const onEdit = () => {
    opts.onEdit();
    refresh();
  };

  const ensureBottomUi = () => {
    const mode = opts.getProject().editorMode;
    if (mode === bottomMode && (timelineUi || masterUi)) return;

    masterUi?.dispose();
    timelineUi = null;
    masterUi = null;
    bottomMode = mode;

    if (mode === 'master') {
      masterUi = mountMasterUi(timelineContent, {
        getProject: opts.getProject,
        getTime: opts.getMasterTime,
        getPlaying: opts.isMasterPlaying,
        onPlay: opts.onPlay,
        onPause: opts.onPause,
        onStop: opts.onStop,
        onSeek: opts.onSeek,
        onChange: onEdit,
        setStatus: opts.setStatus,
        viewport,
        getCanvas: () => opts.viewer.canvas,
        isPlacementHidden: () => opts.isPreviewing() || opts.isRecording(),
      });
    } else {
      timelineUi = mountTimelineUi(timelineContent, {
        getScene: opts.getScene,
        getSelection: opts.getSelection,
        timeline: opts.timeline,
        onPlay: opts.onPlay,
        onPause: opts.onPause,
        onStop: opts.onStop,
        onSeek: opts.onSeek,
        onCut: opts.onCut,
        onAnimate: opts.onAnimate,
        onClearAll: opts.onClearTimeline,
        onChange: onEdit,
      });
    }
  };

  const refresh = () => {
    ensureBottomUi();
    renderHierarchy(leftScroll, {
      viewer: opts.viewer,
      getProject: opts.getProject,
      getScene: opts.getScene,
      getSelection: opts.getSelection,
      select: opts.select,
      cameras: opts.cameras,
      planes: opts.planes,
      onChange: onEdit,
      onSelectScene: opts.onSelectScene,
      onAddScene: opts.onAddScene,
      onDuplicateScene: opts.onDuplicateScene,
      onDeleteScene: opts.onDeleteScene,
      onDeleteAllScenes: opts.onDeleteAllScenes,
      onRenameScene: opts.onRenameScene,
      onClearScene: opts.onClearTimeline,
    });
    renderInspector(right, {
      viewer: opts.viewer,
      getProject: opts.getProject,
      getScene: opts.getScene,
      getSelection: opts.getSelection,
      cameras: opts.cameras,
      planes: opts.planes,
      onChange: onEdit,
      onLookEdit: opts.onEdit,
      setStatus: opts.setStatus,
    });
    timelineUi?.refresh();
    masterUi?.refresh();
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
    const master = opts.getProject().editorMode === 'master';
    const playing = isPlaying();
    previewPlayBtn.textContent = playing ? 'Pause' : 'Play';
    const t = master ? opts.getMasterTime() : opts.timeline.time;
    const d = master ? opts.getMasterDuration() : opts.timeline.duration;
    previewTime.textContent = `${formatPreviewTime(t)} / ${formatPreviewTime(d)}`;
    previewLabel.textContent = master ? 'Master preview' : 'Preview';
  };

  const refreshTop = () => {
    const mode = opts.getProject().editorMode;
    modeSceneBtn.classList.toggle('active', mode === 'scene');
    modeMasterBtn.classList.toggle('active', mode === 'master');
    recordBtn.textContent = opts.isRecording() ? '■ Stop & export' : '● Record';
    recordBtn.title =
      mode === 'master'
        ? 'Record the master sequence'
        : 'Record the active scene only';
    const previewing = opts.isPreviewing();
    previewBtn.classList.toggle('active', previewing);
    previewBtn.textContent = previewing ? 'Exit preview' : 'Preview';
    previewBtn.disabled = opts.isRecording();
    recordBtn.disabled = previewing;
    refreshPreviewHud();
  };

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

  ensureBottomUi();
  refresh();

  return {
    refresh,
    updatePlayhead() {
      if (opts.getProject().editorMode === 'master') masterUi?.updatePlayhead();
      else timelineUi?.updatePlayhead();
      syncCameraChrome();
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
      masterUi?.dispose();
      viewGizmo.dispose();
      cameraPreview.dispose();
      document.body.append(app);
      root.remove();
    },
  };
}
