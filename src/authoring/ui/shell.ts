import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import type { TextsHandle } from '../texts';
import type { Project, Selection } from '../project';
import type { TimelineEngine } from '../timeline';
import { renderHierarchy } from './hierarchy';
import { renderInspector } from './inspector';
import { mountTimelineUi, type TimelineUiHandle } from './timelineUi';
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
  onKeyframe: () => void;
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
  setStatus: (msg: string) => void;
  isRecording: () => boolean;
};

export type EditorShell = {
  refresh: () => void;
  updatePlayhead: () => void;
  setChromeVisible: (visible: boolean) => void;
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

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  top.append(
    brand,
    mkBtn('Save', '', opts.onSave),
    mkBtn('Export JSON', '', opts.onExport),
    mkBtn('Import JSON', '', () => importInput.click()),
    mkBtn('New', 'danger', () => void opts.onReset()),
    spacer,
    recordBtn,
    importInput,
  );

  const left = document.createElement('div');
  left.className = 'ed-left';
  const right = document.createElement('div');
  right.className = 'ed-right';
  const viewport = document.createElement('div');
  viewport.className = 'ed-viewport';
  const timelineHost = document.createElement('div');
  timelineHost.className = 'ed-timeline';

  // Re-parent #app into viewport
  app.parentElement?.insertBefore(root, app);
  viewport.append(app);
  root.append(top, left, viewport, right, timelineHost);

  let timelineUi: TimelineUiHandle;

  const refresh = () => {
    renderHierarchy(left, {
      viewer: opts.viewer,
      getProject: opts.getProject,
      getSelection: opts.getSelection,
      select: opts.select,
      cameras: opts.cameras,
      planes: opts.planes,
      texts: opts.texts,
      onChange: () => refresh(),
    });
    renderInspector(right, {
      viewer: opts.viewer,
      getProject: opts.getProject,
      getSelection: opts.getSelection,
      cameras: opts.cameras,
      planes: opts.planes,
      texts: opts.texts,
      onChange: () => refresh(),
      setStatus: opts.setStatus,
    });
    timelineUi.refresh();
    refreshTop();
    opts.viewer.notifyResize();
  };

  const refreshTop = () => {
    recordBtn.textContent = opts.isRecording() ? '■ Stop & export' : '● Record';
  };

  timelineUi = mountTimelineUi(timelineHost, {
    getProject: opts.getProject,
    timeline: opts.timeline,
    onPlay: opts.onPlay,
    onPause: opts.onPause,
    onStop: opts.onStop,
    onSeek: opts.onSeek,
    onKeyframe: opts.onKeyframe,
    onChange: () => refresh(),
  });

  refresh();

  return {
    refresh,
    updatePlayhead: () => timelineUi.updatePlayhead(),
    setChromeVisible(visible) {
      root.classList.toggle('chrome-hidden', !visible);
      opts.viewer.notifyResize();
    },
    dispose() {
      // Move app back and remove shell
      document.body.append(app);
      root.remove();
    },
  };
}
