import type { Viewer } from '../viewer/Viewer';
import type { Recorder } from '../recorder/Recorder';
import { applySettings, loadSettingsFromStorage } from '../viewer/settings';
import {
  captureProjectLook,
  clearProjectStorage,
  createDefaultProject,
  loadProjectFromStorage,
  parseProject,
  projectFromLegacySettings,
  saveProjectToStorage,
  serializeProject,
  type CameraPoseValue,
  type KeyframeValue,
  type Project,
  type Selection,
  type Vec3,
} from './project';
import type { CarLightsParams } from '../viewer/carLights';
import { createCamerasHandle, type CamerasHandle } from './cameras';
import { createPlanesHandle, type PlanesHandle } from './planes';
import { createTextsHandle, type TextsHandle } from './texts';
import { createTimelineEngine, poseFromCameraClip, type TimelineEngine } from './timeline';
import { createProjectHistory } from './history';
import { mountEditorShell, type EditorShell } from './ui/shell';

export type EditorHandle = {
  project: Project;
  timeline: TimelineEngine;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  texts: TextsHandle;
  selection: Selection;
  select: (kind: Selection['kind'], id: string | null) => void;
  refreshUi: () => void;
  dispose: () => void;
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

export async function createEditor(
  viewer: Viewer,
  recorder: Recorder,
  setStatus: (msg: string) => void,
): Promise<EditorHandle> {
  let project =
    loadProjectFromStorage() ??
    (() => {
      const legacy = loadSettingsFromStorage();
      return legacy
        ? projectFromLegacySettings(legacy, viewer)
        : createDefaultProject(viewer);
    })();

  // Sync look into viewer first
  await applySettings(viewer, project.look);

  const cameras = createCamerasHandle(
    viewer.scene,
    viewer.camera,
    viewer.controls,
    viewer.canvas,
    project.cameras,
    project.playCameraId,
  );
  const planes = createPlanesHandle(
    viewer.scene,
    viewer.camera,
    viewer.canvas,
    viewer.controls,
  );
  const texts = createTextsHandle(
    viewer.scene,
    viewer.camera,
    viewer.canvas,
    viewer.controls,
  );

  planes.setFromProject(project.planes);
  texts.setFromProject(project.texts);
  viewer.setCarVisible(project.carVisible !== false);
  viewer.setShadowExcludes([planes.group, texts.group, cameras.group]);
  cameras.excludeFromReflector(viewer.ground.reflector);
  // Start in free camera — don't jump into a dedicated cam on boot
  cameras.enterFree();

  const timeline = createTimelineEngine(project.duration);
  timeline.bindProject(project);

  let selection: Selection = { kind: null, id: null };
  let shell: EditorShell;
  let recordingFromTimeline = false;
  let previewing = false;
  let lightHelpersBeforePresentation: boolean | null = null;
  let historyTimer: number | null = null;
  let applyingHistory = false;

  const history = createProjectHistory(project);

  const syncProjectFromRuntime = () => {
    project.cameras = cameras.clips.map((c) => structuredClone(c));
    project.playCameraId = cameras.playCameraId;
    project.carVisible = viewer.carVisible;
    project.planes = planes.serialize();
    project.texts = texts.serialize();
    project.look = captureProjectLook(viewer);
    project.duration = timeline.duration;
  };

  const clearHistoryTimer = () => {
    if (historyTimer !== null) {
      window.clearTimeout(historyTimer);
      historyTimer = null;
    }
  };

  /** Snapshot current runtime into undo history (no-op if unchanged). */
  const commitHistory = () => {
    if (applyingHistory) return;
    clearHistoryTimer();
    syncProjectFromRuntime();
    history.push(project);
    saveProjectToStorage(project);
  };

  /** Coalesce rapid UI edits (sliders, continuous input) into one undo step. */
  const scheduleHistoryCommit = () => {
    if (applyingHistory) return;
    if (historyTimer !== null) window.clearTimeout(historyTimer);
    historyTimer = window.setTimeout(() => {
      historyTimer = null;
      commitHistory();
    }, 400);
  };

  const applyCarVisible = (visible: boolean) => {
    viewer.setCarVisible(visible);
    project.carVisible = visible;
  };

  const clearGizmos = () => {
    viewer.customLights.select(null);
    viewer.customLights.setTransformEnabled(false);
    planes.select(null);
    planes.setTransformEnabled(false);
    texts.select(null);
    texts.setTransformEnabled(false);
  };

  const select = (kind: Selection['kind'], id: string | null) => {
    selection = { kind, id };
    clearGizmos();
    if (!kind || !id) {
      cameras.select(null);
      shell?.refresh();
      return;
    }
    if (kind === 'freeCamera') {
      cameras.enterFree();
      cameras.select(null);
    } else if (kind === 'camera') {
      // Stay in free view so you can drag move/rotate gizmos on the camera
      cameras.enterFree();
      cameras.select(id);
      cameras.setPlayCameraId(id);
      project.playCameraId = id;
    } else if (kind === 'light') {
      cameras.select(null);
      if (cameras.viewMode === 'through') cameras.enterFree();
      viewer.customLights.setTransformEnabled(true);
      viewer.customLights.select(id);
    } else if (kind === 'plane') {
      cameras.select(null);
      if (cameras.viewMode === 'through') cameras.enterFree();
      planes.setTransformEnabled(true);
      planes.select(id);
    } else if (kind === 'text') {
      cameras.select(null);
      if (cameras.viewMode === 'through') cameras.enterFree();
      texts.setTransformEnabled(true);
      texts.select(id);
    } else if (kind === 'car' || kind === 'carLights') {
      cameras.select(null);
      if (cameras.viewMode === 'through') cameras.enterFree();
    }
    shell?.refresh();
  };

  const restoreSelectionAfterHistory = () => {
    const { kind, id } = selection;
    if (!kind || !id) {
      select(null, null);
      return;
    }
    const stillExists =
      (kind === 'camera' && !!cameras.get(id)) ||
      (kind === 'plane' && planes.entries.some((e) => e.id === id)) ||
      (kind === 'text' && texts.entries.some((e) => e.id === id)) ||
      (kind === 'light' && viewer.customLights.entries.some((e) => e.id === id)) ||
      kind === 'car' ||
      kind === 'carLights' ||
      kind === 'freeCamera';
    if (stillExists) select(kind, id);
    else select(null, null);
  };

  const applyProjectSnapshot = async (snapshot: Project) => {
    applyingHistory = true;
    try {
      project = snapshot;
      await applySettings(viewer, project.look);
      applyCarVisible(project.carVisible !== false);
      cameras.setClips(project.cameras, project.playCameraId);
      planes.setFromProject(project.planes);
      texts.setFromProject(project.texts);
      timeline.bindProject(project);
      timeline.seek(timeline.time);
      saveProjectToStorage(project);
      restoreSelectionAfterHistory();
      shell?.refresh();
    } finally {
      applyingHistory = false;
    }
  };

  const undo = () => {
    clearHistoryTimer();
    // Capture any in-flight edit before stepping back.
    syncProjectFromRuntime();
    history.push(project);
    const prev = history.undo();
    if (!prev) {
      setStatus('Nothing to undo');
      return;
    }
    void applyProjectSnapshot(prev).then(() => setStatus('Undo'));
  };

  const redo = () => {
    clearHistoryTimer();
    const next = history.redo();
    if (!next) {
      setStatus('Nothing to redo');
      return;
    }
    void applyProjectSnapshot(next).then(() => setStatus('Redo'));
  };

  const applyTimelineValue = (target: string, value: KeyframeValue) => {
    const parts = target.split('.');
    const root = parts[0];

    if (root === 'camera') {
      if (parts[1] === 'active' && typeof value === 'string') {
        cameras.setPlayCameraId(value);
        project.playCameraId = value;
        cameras.applyClip(value);
        return;
      }
      if (parts[2] === 'pose' && isPose(value)) {
        const clip = cameras.get(parts[1]);
        if (clip) {
          clip.position = { ...value.position };
          clip.target = { ...value.target };
          clip.fov = value.fov;
        }
        cameras.refreshHelpers();
        // Only drive the viewport for the active camera (avoids track fighting).
        if (parts[1] === cameras.playCameraId) {
          cameras.applyPose(value);
        }
        return;
      }
    }

    if (root === 'plane' && parts.length >= 3) {
      const id = parts[1];
      const prop = parts[2];
      const entry = planes.entries.find((e) => e.id === id);
      if (!entry) return;
      if (prop === 'position' && isVec3(value)) entry.params.position = { ...value };
      else if (prop === 'rotation' && isVec3(value)) entry.params.rotation = { ...value };
      else if (prop === 'scale' && isVec3(value)) entry.params.scale = { ...value };
      else if (prop === 'opacity' && typeof value === 'number') entry.params.opacity = value;
      planes.apply(id);
      return;
    }

    if (root === 'text' && parts.length >= 3) {
      const id = parts[1];
      const prop = parts[2];
      const entry = texts.entries.find((e) => e.id === id);
      if (!entry) return;
      if (prop === 'position' && isVec3(value)) entry.params.position = { ...value };
      else if (prop === 'opacity' && typeof value === 'number') entry.params.opacity = value;
      else if (prop === 'scale' && typeof value === 'number') entry.params.scale = value;
      texts.apply(id);
      return;
    }

    if (root === 'light' && parts.length >= 3) {
      const id = parts[1];
      const prop = parts[2];
      const entry = viewer.customLights.entries.find((e) => e.id === id);
      if (!entry) return;
      if (prop === 'intensity' && typeof value === 'number') entry.params.intensity = value;
      else if (prop === 'color' && typeof value === 'string') entry.params.color = value;
      else if (prop === 'position' && isVec3(value)) {
        entry.params.x = value.x;
        entry.params.y = value.y;
        entry.params.z = value.z;
      }
      else if (prop === 'rotation' && isVec3(value)) {
        entry.params.rotX = value.x;
        entry.params.rotY = value.y;
        entry.params.rotZ = value.z;
      }
      viewer.customLights.apply(id);
      return;
    }

    if (root === 'car' && parts[1] === 'visible' && typeof value === 'boolean') {
      applyCarVisible(value);
      return;
    }

    if (root === 'softboxes' && parts[1] === 'intensity' && typeof value === 'number') {
      viewer.softboxes.params.intensity = value;
      viewer.softboxes.applyParams();
      return;
    }

    if (root === 'carLights' && parts[1]) {
      const key = parts[1] as keyof CarLightsParams;
      if (!(key in viewer.carLights.params)) return;
      if (typeof value === 'number' || typeof value === 'boolean') {
        (viewer.carLights.params as unknown as Record<string, number | boolean>)[key] =
          value;
        viewer.carLights.applyParams();
      }
      return;
    }

    if (root === 'effects' && parts[1]) {
      const key = parts[1] as keyof typeof viewer.effects.params;
      if (key in viewer.effects.params && typeof value === 'number') {
        (viewer.effects.params as unknown as Record<string, number>)[key] = value;
        viewer.effects.applyParams();
      }
      return;
    }

    if (root === 'logo' && parts[1]) {
      const key = parts[1] as keyof typeof viewer.logo.params;
      if (key in viewer.logo.params && typeof value === 'number') {
        (viewer.logo.params as unknown as Record<string, number>)[key] = value;
        viewer.logo.applyParams();
      }
    }
  };

  timeline.setApply(applyTimelineValue);

  const setPlaybackUi = (playing: boolean) => {
    // Keep helpers hidden while previewing/recording even if paused.
    const lockHelpers = playing || previewing || recordingFromTimeline;
    cameras.setPlaybackLocked(lockHelpers);
    if (lockHelpers) {
      clearGizmos();
      viewer.customLights.setTransformEnabled(false);
      planes.setTransformEnabled(false);
      texts.setTransformEnabled(false);
    }
  };

  /** Hide editor overlays so the viewport matches the exported commercial. */
  const setPresentationMode = (on: boolean) => {
    if (on) {
      if (lightHelpersBeforePresentation === null) {
        lightHelpersBeforePresentation = viewer.customLights.showHelpers;
      }
      viewer.customLights.setShowHelpers(false);
      shell?.setChromeVisible(false);
    } else {
      shell?.setChromeVisible(true);
      if (lightHelpersBeforePresentation !== null) {
        viewer.customLights.setShowHelpers(lightHelpersBeforePresentation);
        lightHelpersBeforePresentation = null;
      }
    }
  };

  const exitPreview = () => {
    if (!previewing) return;
    previewing = false;
    timeline.pause();
    setPlaybackUi(false);
    setPresentationMode(false);
    shell?.setPreviewHudVisible(false);
    setStatus('Preview ended');
    shell?.refresh();
  };

  const enterPreview = () => {
    if (recorder.isRecording || recordingFromTimeline) {
      setStatus('Stop recording before preview');
      return;
    }
    syncProjectFromRuntime();
    timeline.bindProject(project);
    previewing = true;
    setPresentationMode(true);
    shell?.setPreviewHudVisible(true);
    timeline.seek(0);
    setPlaybackUi(true);
    timeline.play();
    setStatus('Preview — Esc to exit');
    shell?.refresh();
  };

  const togglePreview = () => {
    if (previewing) exitPreview();
    else enterPreview();
  };

  timeline.setOnTime(() => {
    shell?.updatePlayhead();
  });

  timeline.setOnEnded(async () => {
    setPlaybackUi(false);
    if (recordingFromTimeline) {
      recordingFromTimeline = false;
      setPresentationMode(false);
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      setStatus('Exported commercial MP4');
      shell?.refresh();
    } else if (previewing) {
      // Stay in clean preview so you can Restart without leaving.
      shell?.refresh();
    } else {
      shell?.refresh();
    }
  });

  const snapshotCameraPose = (id: string) => {
    const clip = cameras.get(id);
    if (!clip) return null;
    if (cameras.throughCameraId === id) {
      cameras.captureFromView(id);
    }
    return poseFromCameraClip(clip);
  };

  /** Hard cut: switch live camera (and lock its pose at this time). */
  const cutCamera = () => {
    if (selection.kind !== 'camera' || !selection.id) {
      setStatus('Select a camera to Cut');
      return;
    }
    const t = timeline.time;
    const pose = snapshotCameraPose(selection.id);
    if (!pose) return;
    timeline.setKeyframe(`camera.${selection.id}.pose`, t, pose, 'linear');
    timeline.setKeyframe('camera.active', t, selection.id, 'linear');
    cameras.setPlayCameraId(selection.id);
    project.playCameraId = selection.id;
    autosave();
    setStatus(`Cut to ${cameras.get(selection.id)?.name ?? 'camera'} at ${t.toFixed(2)}s`);
    shell?.refresh();
  };

  /** Animate selected object at playhead (pose / props only — no camera switch). */
  const animateSelection = () => {
    if (!selection.kind || !selection.id) {
      setStatus('Select an object to Animate');
      return;
    }
    const t = timeline.time;
    if (selection.kind === 'camera') {
      const pose = snapshotCameraPose(selection.id);
      if (!pose) return;
      timeline.setKeyframe(`camera.${selection.id}.pose`, t, pose);
    } else if (selection.kind === 'plane') {
      const entry = planes.entries.find((e) => e.id === selection.id);
      if (!entry) return;
      timeline.setKeyframe(`plane.${selection.id}.position`, t, entry.params.position);
      timeline.setKeyframe(`plane.${selection.id}.rotation`, t, entry.params.rotation);
      timeline.setKeyframe(`plane.${selection.id}.opacity`, t, entry.params.opacity);
    } else if (selection.kind === 'text') {
      const entry = texts.entries.find((e) => e.id === selection.id);
      if (!entry) return;
      timeline.setKeyframe(`text.${selection.id}.position`, t, entry.params.position);
      timeline.setKeyframe(`text.${selection.id}.opacity`, t, entry.params.opacity);
      timeline.setKeyframe(`text.${selection.id}.scale`, t, entry.params.scale);
    } else if (selection.kind === 'light') {
      const entry = viewer.customLights.entries.find((e) => e.id === selection.id);
      if (!entry) return;
      timeline.setKeyframe(`light.${selection.id}.intensity`, t, entry.params.intensity);
      timeline.setKeyframe(`light.${selection.id}.color`, t, entry.params.color, 'linear');
      timeline.setKeyframe(
        `light.${selection.id}.position`,
        t,
        { x: entry.params.x, y: entry.params.y, z: entry.params.z },
      );
    } else if (selection.kind === 'car') {
      timeline.setKeyframe('car.visible', t, viewer.carVisible, 'linear');
    } else if (selection.kind === 'carLights') {
      const cl = viewer.carLights.params;
      timeline.setKeyframe('carLights.enabled', t, cl.enabled, 'linear');
      timeline.setKeyframe('carLights.grilleEnabled', t, cl.grilleEnabled, 'linear');
      timeline.setKeyframe('carLights.grilleStrength', t, cl.grilleStrength);
      timeline.setKeyframe('carLights.edgeEnabled', t, cl.edgeEnabled, 'linear');
      timeline.setKeyframe('carLights.edgeStrength', t, cl.edgeStrength);
      timeline.setKeyframe('carLights.redEnabled', t, cl.redEnabled, 'linear');
      timeline.setKeyframe('carLights.redStrength', t, cl.redStrength);
      timeline.setKeyframe('carLights.groundGlow', t, cl.groundGlow, 'linear');
      timeline.setKeyframe('carLights.groundGlowStrength', t, cl.groundGlowStrength);
      timeline.setKeyframe('carLights.beamsEnabled', t, cl.beamsEnabled, 'linear');
      timeline.setKeyframe('carLights.beamStrength', t, cl.beamStrength);
    } else {
      setStatus('Select a camera, light, plane, text, or car');
      return;
    }
    autosave();
    setStatus(`Animated at ${t.toFixed(2)}s`);
    shell?.refresh();
  };

  const autosave = () => {
    commitHistory();
  };

  const persist = () => {
    autosave();
    setStatus('Project saved');
  };

  const exportJson = () => {
    syncProjectFromRuntime();
    const blob = new Blob([serializeProject(project)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Project exported');
  };

  const importJson = async (file: File) => {
    const raw = await file.text();
    const parsed = parseProject(raw);
    if (!parsed) {
      setStatus('Invalid project file');
      return;
    }
    clearHistoryTimer();
    project = parsed;
    await applySettings(viewer, project.look);
    applyCarVisible(project.carVisible !== false);
    cameras.setClips(project.cameras, project.playCameraId);
    planes.setFromProject(project.planes);
    texts.setFromProject(project.texts);
    timeline.bindProject(project);
    timeline.seek(0);
    history.reset(project);
    saveProjectToStorage(project);
    select(null, null);
    setStatus(`Loaded ${project.name}`);
    shell?.refresh();
  };

  const resetProject = async () => {
    clearHistoryTimer();
    project = createDefaultProject(viewer);
    await applySettings(viewer, project.look);
    applyCarVisible(true);
    cameras.setClips(project.cameras, project.playCameraId);
    planes.setFromProject(project.planes);
    texts.setFromProject(project.texts);
    timeline.bindProject(project);
    timeline.seek(0);
    history.reset(project);
    clearProjectStorage();
    select(null, null);
    setStatus('New project');
    shell?.refresh();
  };

  const play = () => {
    autosave();
    timeline.bindProject(project);
    setPlaybackUi(true);
    timeline.play();
    shell?.refresh();
  };

  const pause = () => {
    timeline.pause();
    setPlaybackUi(false);
    shell?.refresh();
  };

  const startRecord = () => {
    if (recorder.isRecording) return;
    if (previewing) exitPreview();
    syncProjectFromRuntime();
    timeline.bindProject(project);
    recordingFromTimeline = true;
    setPresentationMode(true);
    shell?.setPreviewHudVisible(false);
    timeline.seek(0);
    setPlaybackUi(true);
    recorder.configure({ fps: project.fps, videoBitsPerSecond: 12_000_000 });
    recorder.start();
    timeline.play();
    setStatus('Recording commercial…');
    shell?.refresh();
  };

  const stopRecord = async () => {
    timeline.pause();
    setPlaybackUi(false);
    setPresentationMode(false);
    if (recorder.isRecording) {
      recordingFromTimeline = false;
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      setStatus('Exported MP4');
    }
    shell?.refresh();
  };

  const isTypingTarget = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      el.isContentEditable
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && previewing) {
      e.preventDefault();
      exitPreview();
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod || isTypingTarget(e.target)) return;

    const key = e.key.toLowerCase();
    if (key === 'z' && e.shiftKey) {
      e.preventDefault();
      redo();
      return;
    }
    if (key === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (key === 'y') {
      e.preventDefault();
      redo();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const onTransformCommit = () => {
    commitHistory();
    shell?.refresh();
  };
  cameras.setOnTransformCommit(onTransformCommit);
  planes.setOnTransformCommit(onTransformCommit);
  texts.setOnTransformCommit(onTransformCommit);
  viewer.customLights.setOnTransformCommit(onTransformCommit);

  shell = mountEditorShell({
    viewer,
    getProject: () => project,
    getSelection: () => selection,
    select,
    cameras,
    planes,
    texts,
    timeline,
    onCut: cutCamera,
    onAnimate: animateSelection,
    onPlay: play,
    onPause: pause,
    onStop: () => {
      timeline.stop();
      setPlaybackUi(false);
      shell.refresh();
    },
    onSeek: (t) => {
      timeline.seek(t);
      shell.updatePlayhead();
    },
    onSave: persist,
    onExport: exportJson,
    onImport: importJson,
    onReset: resetProject,
    onRecord: startRecord,
    onStopRecord: stopRecord,
    onTogglePreview: togglePreview,
    onEdit: scheduleHistoryCommit,
    setStatus,
    isRecording: () => recorder.isRecording || recordingFromTimeline,
    isPreviewing: () => previewing,
  });

  viewer.setExternalTick((dt) => {
    timeline.update(dt);
    cameras.update();
    planes.update();
    texts.update(viewer.camera);
  });

  requestAnimationFrame(() => viewer.notifyResize());

  return {
    get project() {
      return project;
    },
    timeline,
    cameras,
    planes,
    texts,
    get selection() {
      return selection;
    },
    select,
    refreshUi: () => shell.refresh(),
    dispose() {
      clearHistoryTimer();
      window.removeEventListener('keydown', onKeyDown);
      cameras.setOnTransformCommit(null);
      planes.setOnTransformCommit(null);
      texts.setOnTransformCommit(null);
      viewer.customLights.setOnTransformCommit(null);
      viewer.setExternalTick(null);
      cameras.dispose();
      planes.dispose();
      texts.dispose();
      shell.dispose();
    },
  };
}
