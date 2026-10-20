import type { Viewer } from '../viewer/Viewer';
import { ENVIRONMENT_PRESETS, type EnvironmentPreset } from '../viewer/Viewer';
import type { Recorder } from '../recorder/Recorder';
import { applySettings, loadSettingsFromStorage } from '../viewer/settings';
import {
  addSceneToProject,
  captureProjectLook,
  clearProjectStorage,
  createBlankScene,
  createDefaultProject,
  deleteScene,
  duplicateScene,
  getActiveScene,
  getSceneById,
  loadProjectFromStorage,
  masterDuration,
  parseProject,
  projectFromLegacySettings,
  saveProjectToStorage,
  serializeProject,
  type CameraPoseValue,
  type KeyframeValue,
  type Project,
  type Scene,
  type Selection,
  type Vec3,
} from './project';
import { STORYBOARD_LEGACY_NAMES, STORYBOARD_NAME } from './storyboard';
import type { CarLightsParams } from '../viewer/carLights';
import { createCamerasHandle, type CamerasHandle } from './cameras';
import { createPlanesHandle, type PlanesHandle } from './planes';
import { createTextsHandle, type TextsHandle } from './texts';
import { createTimelineEngine, poseFromCameraClip, type TimelineEngine } from './timeline';
import { createProjectHistory } from './history';
import { createMasterClock, resolveMasterTime } from './masterPlayback';
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

  // Seed / upgrade blank shells and prior storyboard defaults to the current spot.
  const isLegacyStoryboard = (STORYBOARD_LEGACY_NAMES as readonly string[]).includes(
    project.name,
  );
  const activeForCheck = getActiveScene(project);
  if (
    project.name !== STORYBOARD_NAME &&
    (!activeForCheck.timeline.tracks.length || isLegacyStoryboard)
  ) {
    project = createDefaultProject(viewer);
    saveProjectToStorage(project);
  }

  let scene = getActiveScene(project);

  // Sync look into viewer first
  await applySettings(viewer, scene.look);

  const cameras = createCamerasHandle(
    viewer.scene,
    viewer.camera,
    viewer.controls,
    viewer.canvas,
    scene.cameras,
    scene.playCameraId,
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

  planes.setFromProject(scene.planes);
  texts.setFromProject(scene.texts);
  viewer.setCarVisible(scene.carVisible !== false);
  viewer.setShadowExcludes([planes.group, texts.group, cameras.group]);
  cameras.excludeFromReflector(viewer.ground.reflector);
  // Start in free camera — don't jump into a dedicated cam on boot
  cameras.enterFree();

  const timeline = createTimelineEngine(scene.duration);
  timeline.bindScene(scene);

  const master = createMasterClock();
  master.bindProject(project);

  let selection: Selection = { kind: null, id: null };
  let shell: EditorShell;
  let recordingFromTimeline = false;
  let previewing = false;
  let lightHelpersBeforePresentation: boolean | null = null;
  let historyTimer: number | null = null;
  let applyingHistory = false;
  /** Scene id currently loaded into runtime (cameras / look / timeline). */
  let loadedSceneId = scene.id;
  /** When true, master clock drives playback instead of scene timeline. */
  let masterDriving = false;

  const history = createProjectHistory(project);

  const syncSceneFromRuntime = () => {
    const s = getActiveScene(project);
    s.cameras = cameras.clips.map((c) => structuredClone(c));
    s.playCameraId = cameras.playCameraId;
    s.carVisible = viewer.carVisible;
    s.planes = planes.serialize();
    s.texts = texts.serialize();
    s.look = captureProjectLook(viewer);
    s.duration = timeline.duration;
    scene = s;
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
    syncSceneFromRuntime();
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
    getActiveScene(project).carVisible = visible;
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
      getActiveScene(project).playCameraId = id;
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
    } else if (
      kind === 'car' ||
      kind === 'carLights' ||
      kind === 'roofStrobe' ||
      kind === 'lighting' ||
      kind === 'dotGrid'
    ) {
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
      kind === 'roofStrobe' ||
      kind === 'lighting' ||
      kind === 'dotGrid' ||
      kind === 'freeCamera';
    if (stillExists) select(kind, id);
    else select(null, null);
  };

  const loadSceneRuntime = async (next: Scene, seekT?: number) => {
    scene = next;
    project.activeSceneId = next.id;
    loadedSceneId = next.id;
    await applySettings(viewer, next.look);
    applyCarVisible(next.carVisible !== false);
    cameras.setClips(next.cameras, next.playCameraId);
    planes.setFromProject(next.planes);
    texts.setFromProject(next.texts);
    timeline.bindScene(next);
    timeline.seek(seekT ?? 0);
    cameras.enterFree();
  };

  const switchToScene = async (sceneId: string) => {
    if (sceneId === loadedSceneId && project.activeSceneId === sceneId) {
      shell?.refresh();
      return;
    }
    syncSceneFromRuntime();
    const next = getSceneById(project, sceneId);
    if (!next) {
      setStatus('Scene not found');
      return;
    }
    await loadSceneRuntime(next);
    select(null, null);
    commitHistory();
    setStatus(`Scene: ${next.name}`);
    shell?.refresh();
  };

  const applyProjectSnapshot = async (snapshot: Project) => {
    applyingHistory = true;
    try {
      project = snapshot;
      master.bindProject(project);
      scene = getActiveScene(project);
      await loadSceneRuntime(scene, timeline.time);
      saveProjectToStorage(project);
      restoreSelectionAfterHistory();
      shell?.refresh();
    } finally {
      applyingHistory = false;
    }
  };

  const undo = () => {
    clearHistoryTimer();
    syncSceneFromRuntime();
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
        getActiveScene(project).playCameraId = value;
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
      } else if (prop === 'rotation' && isVec3(value)) {
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

    if (root === 'lighting' && parts[1]) {
      const key = parts[1];
      const lighting = viewer.state.lighting;
      if (key === 'environment' && typeof value === 'string') {
        if ((ENVIRONMENT_PRESETS as readonly string[]).includes(value)) {
          lighting.environment = value as EnvironmentPreset;
          void viewer.applyEnvironment();
        }
        return;
      }
      if (key === 'environmentIntensity' && typeof value === 'number') {
        lighting.environmentIntensity = value;
        viewer.applyEnvironmentTuning();
        return;
      }
      if (key === 'exposure' && typeof value === 'number') {
        lighting.exposure = value;
        viewer.applyLighting();
        return;
      }
      if (key === 'directIntensity' && typeof value === 'number') {
        lighting.directIntensity = value;
        viewer.applyLighting();
        return;
      }
      return;
    }

    if (root === 'roofStrobe' && parts[1]) {
      const key = parts[1] as keyof typeof viewer.roofStrobe.params;
      if (!(key in viewer.roofStrobe.params)) return;
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        (viewer.roofStrobe.params as unknown as Record<string, number | boolean | string>)[
          key
        ] = value;
        viewer.roofStrobe.applyParams();
      }
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
      return;
    }

    if (root === 'dotGrid' && parts[1]) {
      const key = parts[1] as keyof typeof viewer.dotGrid.params;
      if (!(key in viewer.dotGrid.params)) return;
      if (typeof value === 'number' || typeof value === 'boolean') {
        let next: number | boolean = value;
        if (key === 'effectMode' && typeof value === 'number') {
          next = Math.round(value);
        }
        (viewer.dotGrid.params as unknown as Record<string, number | boolean>)[key] =
          next;
        viewer.dotGrid.applyParams();
      }
    }
  };

  timeline.setApply(applyTimelineValue);

  const setPlaybackUi = (playing: boolean) => {
    const lockHelpers = playing || previewing || recordingFromTimeline;
    cameras.setPlaybackLocked(lockHelpers);
    if (lockHelpers) {
      clearGizmos();
      viewer.customLights.setTransformEnabled(false);
      planes.setTransformEnabled(false);
      texts.setTransformEnabled(false);
    }
  };

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

  const isMasterMode = () => project.editorMode === 'master';

  const applyMasterResolve = async (forceLoad: boolean) => {
    const resolved = resolveMasterTime(project, master.time);
    if (!resolved) return;
    if (forceLoad || resolved.scene.id !== loadedSceneId) {
      // Don't sync runtime back when jumping clips during master play —
      // active scene was already synced when entering master / last scene edit.
      await loadSceneRuntime(resolved.scene, resolved.localT);
    } else {
      timeline.seek(resolved.localT);
    }
  };

  master.setOnResolve((r) => {
    if (!masterDriving && !isMasterMode()) return;
    if (r.scene.id !== loadedSceneId) {
      void loadSceneRuntime(r.scene, r.localT).then(() => shell?.refresh());
    } else {
      timeline.seek(r.localT);
    }
  });

  master.setOnTime(() => {
    if (masterDriving || isMasterMode()) {
      const resolved = resolveMasterTime(project, master.time);
      if (resolved && resolved.scene.id === loadedSceneId) {
        timeline.seek(resolved.localT);
      }
      shell?.updatePlayhead();
    }
  });

  const exitPreview = () => {
    if (!previewing) return;
    previewing = false;
    masterDriving = false;
    timeline.pause();
    master.pause();
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
    syncSceneFromRuntime();
    previewing = true;
    setPresentationMode(true);
    shell?.setPreviewHudVisible(true);
    setPlaybackUi(true);

    if (isMasterMode()) {
      masterDriving = true;
      master.bindProject(project);
      master.seek(0);
      void applyMasterResolve(true).then(() => {
        master.play();
        setStatus('Master preview — Esc to exit');
        shell?.refresh();
      });
    } else {
      masterDriving = false;
      timeline.bindScene(getActiveScene(project));
      timeline.seek(0);
      timeline.play();
      setStatus('Preview — Esc to exit');
      shell?.refresh();
    }
  };

  const togglePreview = () => {
    if (previewing) exitPreview();
    else enterPreview();
  };

  timeline.setOnTime(() => {
    if (!masterDriving && !isMasterMode()) shell?.updatePlayhead();
  });

  const onPlaybackEnded = async () => {
    setPlaybackUi(false);
    masterDriving = false;
    if (recordingFromTimeline) {
      recordingFromTimeline = false;
      setPresentationMode(false);
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      setStatus('Exported commercial MP4');
      shell?.refresh();
    } else if (previewing) {
      shell?.refresh();
    } else {
      shell?.refresh();
    }
  };

  timeline.setOnEnded(() => {
    if (masterDriving) return;
    void onPlaybackEnded();
  });

  master.setOnEnded(() => {
    void onPlaybackEnded();
  });

  const snapshotCameraPose = (id: string) => {
    const clip = cameras.get(id);
    if (!clip) return null;
    if (cameras.throughCameraId === id) {
      cameras.captureFromView(id);
    }
    return poseFromCameraClip(clip);
  };

  const cutCamera = () => {
    if (isMasterMode()) {
      setStatus('Switch to Scene mode to Cut');
      return;
    }
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
    getActiveScene(project).playCameraId = selection.id;
    autosave();
    setStatus(`Cut to ${cameras.get(selection.id)?.name ?? 'camera'} at ${t.toFixed(2)}s`);
    shell?.refresh();
  };

  const animateSelection = () => {
    if (isMasterMode()) {
      setStatus('Switch to Scene mode to Animate');
      return;
    }
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
    } else if (selection.kind === 'roofStrobe') {
      const rs = viewer.roofStrobe.params;
      timeline.setKeyframe('roofStrobe.enabled', t, rs.enabled, 'linear');
      timeline.setKeyframe('roofStrobe.intensity', t, rs.intensity);
      timeline.setKeyframe('roofStrobe.color', t, rs.color, 'linear');
      timeline.setKeyframe('roofStrobe.strobing', t, rs.strobing, 'linear');
      timeline.setKeyframe('roofStrobe.flashDuration', t, rs.flashDuration);
      timeline.setKeyframe('roofStrobe.strobeHz', t, rs.strobeHz);
      timeline.setKeyframe('roofStrobe.strobeDuty', t, rs.strobeDuty);
      timeline.setKeyframe('roofStrobe.width', t, rs.width);
      timeline.setKeyframe('roofStrobe.length', t, rs.length);
      timeline.setKeyframe('roofStrobe.thickness', t, rs.thickness);
      timeline.setKeyframe('roofStrobe.yOffset', t, rs.yOffset);
      timeline.setKeyframe('roofStrobe.zOffset', t, rs.zOffset);
    } else if (selection.kind === 'lighting') {
      const L = viewer.state.lighting;
      timeline.setKeyframe('lighting.environment', t, L.environment, 'linear');
      timeline.setKeyframe('lighting.environmentIntensity', t, L.environmentIntensity);
      timeline.setKeyframe('lighting.exposure', t, L.exposure);
      timeline.setKeyframe('lighting.directIntensity', t, L.directIntensity);
    } else if (selection.kind === 'dotGrid') {
      const dg = viewer.dotGrid.params;
      timeline.setKeyframe('dotGrid.enabled', t, dg.enabled, 'linear');
      timeline.setKeyframe('dotGrid.effectMode', t, Math.round(dg.effectMode), 'linear');
      timeline.setKeyframe('dotGrid.effectStrength', t, dg.effectStrength);
      timeline.setKeyframe('dotGrid.opacity', t, dg.opacity);
      timeline.setKeyframe('dotGrid.reveal', t, dg.reveal);
      timeline.setKeyframe('dotGrid.pulse', t, dg.pulse);
      timeline.setKeyframe('dotGrid.pulseHz', t, dg.pulseHz);
      timeline.setKeyframe('dotGrid.wave', t, dg.wave);
      timeline.setKeyframe('dotGrid.waveSpeed', t, dg.waveSpeed);
      timeline.setKeyframe('dotGrid.glow', t, dg.glow);
      timeline.setKeyframe('dotGrid.reflectionEnabled', t, dg.reflectionEnabled, 'linear');
      timeline.setKeyframe('dotGrid.reflectionOpacity', t, dg.reflectionOpacity);
    } else {
      setStatus('Select a camera, light, plane, text, car, Lighting, Roof Strobe, or Dot Grid');
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
    syncSceneFromRuntime();
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
    master.bindProject(project);
    scene = getActiveScene(project);
    await loadSceneRuntime(scene);
    history.reset(project);
    saveProjectToStorage(project);
    select(null, null);
    setStatus(`Loaded ${project.name}`);
    shell?.refresh();
  };

  const resetProject = async () => {
    clearHistoryTimer();
    project = createDefaultProject(viewer);
    master.bindProject(project);
    scene = getActiveScene(project);
    await loadSceneRuntime(scene);
    history.reset(project);
    clearProjectStorage();
    select(null, null);
    setStatus('Loaded 25s storyboard');
    shell?.refresh();
  };

  const play = () => {
    autosave();
    setPlaybackUi(true);
    if (isMasterMode()) {
      masterDriving = true;
      master.bindProject(project);
      void applyMasterResolve(true).then(() => {
        master.play();
        shell?.refresh();
      });
    } else {
      masterDriving = false;
      timeline.bindScene(getActiveScene(project));
      timeline.play();
      shell?.refresh();
    }
  };

  const pause = () => {
    timeline.pause();
    master.pause();
    masterDriving = false;
    setPlaybackUi(false);
    shell?.refresh();
  };

  const stopPlayback = () => {
    masterDriving = false;
    if (isMasterMode()) {
      master.stop();
      void applyMasterResolve(true);
    } else {
      timeline.stop();
    }
    setPlaybackUi(false);
    shell?.refresh();
  };

  const seekPlayback = (t: number) => {
    if (isMasterMode()) {
      master.bindProject(project);
      master.seek(t);
      void applyMasterResolve(true).then(() => shell?.updatePlayhead());
    } else {
      timeline.seek(t);
      shell?.updatePlayhead();
    }
  };

  const startRecord = () => {
    if (recorder.isRecording) return;
    if (previewing) exitPreview();
    syncSceneFromRuntime();
    recordingFromTimeline = true;
    setPresentationMode(true);
    shell?.setPreviewHudVisible(false);
    setPlaybackUi(true);
    recorder.configure({ fps: project.fps, videoBitsPerSecond: 12_000_000 });
    recorder.start();

    if (isMasterMode()) {
      masterDriving = true;
      master.bindProject(project);
      master.seek(0);
      void applyMasterResolve(true).then(() => {
        master.play();
        setStatus('Recording master…');
        shell?.refresh();
      });
    } else {
      masterDriving = false;
      timeline.bindScene(getActiveScene(project));
      timeline.seek(0);
      timeline.play();
      setStatus('Recording scene…');
      shell?.refresh();
    }
  };

  const stopRecord = async () => {
    timeline.pause();
    master.pause();
    masterDriving = false;
    setPlaybackUi(false);
    setPresentationMode(false);
    if (recorder.isRecording) {
      recordingFromTimeline = false;
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      setStatus('Exported MP4');
    }
    shell?.refresh();
  };

  const setEditorMode = (mode: 'scene' | 'master') => {
    if (project.editorMode === mode) return;
    syncSceneFromRuntime();
    timeline.pause();
    master.pause();
    masterDriving = false;
    setPlaybackUi(false);
    project.editorMode = mode;
    if (mode === 'master') {
      master.bindProject(project);
      master.seek(0);
      void applyMasterResolve(true).then(() => {
        commitHistory();
        setStatus(`Master · ${masterDuration(project).toFixed(1)}s`);
        shell?.refresh();
      });
    } else {
      void loadSceneRuntime(getActiveScene(project)).then(() => {
        commitHistory();
        setStatus(`Scene · ${getActiveScene(project).name}`);
        shell?.refresh();
      });
    }
  };

  const handleAddScene = () => {
    syncSceneFromRuntime();
    const look = getActiveScene(project).look;
    const n = project.scenes.length + 1;
    const created = createBlankScene(`Scene ${n}`, look, viewer);
    addSceneToProject(project, created);
    void loadSceneRuntime(created).then(() => {
      commitHistory();
      setStatus(`Added ${created.name}`);
      shell?.refresh();
    });
  };

  const handleDuplicateScene = () => {
    syncSceneFromRuntime();
    const copy = duplicateScene(project, project.activeSceneId);
    if (!copy) return;
    void loadSceneRuntime(copy).then(() => {
      commitHistory();
      setStatus(`Duplicated → ${copy.name}`);
      shell?.refresh();
    });
  };

  const handleDeleteScene = (sceneId: string) => {
    syncSceneFromRuntime();
    if (!deleteScene(project, sceneId)) {
      setStatus('Cannot delete the last scene');
      return;
    }
    const next = getActiveScene(project);
    void loadSceneRuntime(next).then(() => {
      master.bindProject(project);
      commitHistory();
      setStatus(`Deleted scene · now ${next.name}`);
      shell?.refresh();
    });
  };

  const handleRenameScene = (sceneId: string, name: string) => {
    const s = getSceneById(project, sceneId);
    if (!s) return;
    s.name = name;
    commitHistory();
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
    getScene: () => getActiveScene(project),
    getSelection: () => selection,
    select,
    cameras,
    planes,
    texts,
    timeline,
    getMasterTime: () => master.time,
    getMasterDuration: () => masterDuration(project),
    isMasterPlaying: () => master.state === 'playing',
    onCut: cutCamera,
    onAnimate: animateSelection,
    onPlay: play,
    onPause: pause,
    onStop: stopPlayback,
    onSeek: seekPlayback,
    onSave: persist,
    onExport: exportJson,
    onImport: importJson,
    onReset: resetProject,
    onRecord: startRecord,
    onStopRecord: stopRecord,
    onTogglePreview: togglePreview,
    onEdit: scheduleHistoryCommit,
    onSetEditorMode: setEditorMode,
    onSelectScene: (id) => void switchToScene(id),
    onAddScene: handleAddScene,
    onDuplicateScene: handleDuplicateScene,
    onDeleteScene: handleDeleteScene,
    onRenameScene: handleRenameScene,
    setStatus,
    isRecording: () => recorder.isRecording || recordingFromTimeline,
    isPreviewing: () => previewing,
  });

  viewer.setExternalTick((dt) => {
    if (masterDriving || (isMasterMode() && master.state === 'playing')) {
      master.update(dt);
    } else {
      timeline.update(dt);
    }
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
