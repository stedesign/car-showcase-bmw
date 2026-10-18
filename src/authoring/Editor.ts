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
import { createCamerasHandle, type CamerasHandle } from './cameras';
import { createPlanesHandle, type PlanesHandle } from './planes';
import { createTextsHandle, type TextsHandle } from './texts';
import { createTimelineEngine, poseFromCameraClip, type TimelineEngine } from './timeline';
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
    viewer.camera,
    viewer.controls,
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
  viewer.setShadowExcludes([planes.group, texts.group]);

  const timeline = createTimelineEngine(project.duration);
  timeline.bindProject(project);

  let selection: Selection = { kind: null, id: null };
  let shell: EditorShell;
  let recordingFromTimeline = false;

  const syncProjectFromRuntime = () => {
    project.cameras = cameras.clips.map((c) => structuredClone(c));
    project.playCameraId = cameras.playCameraId;
    project.planes = planes.serialize();
    project.texts = texts.serialize();
    project.look = captureProjectLook(viewer);
    project.duration = timeline.duration;
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
      shell?.refresh();
      return;
    }
    if (kind === 'camera') {
      cameras.applyClip(id);
      cameras.setPlayCameraId(id);
      project.playCameraId = id;
    } else if (kind === 'light') {
      viewer.customLights.setTransformEnabled(true);
      viewer.customLights.select(id);
    } else if (kind === 'plane') {
      planes.setTransformEnabled(true);
      planes.select(id);
    } else if (kind === 'text') {
      texts.setTransformEnabled(true);
      texts.select(id);
    }
    shell?.refresh();
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
        cameras.applyPose(value);
        const clip = cameras.get(parts[1]);
        if (clip) {
          clip.position = { ...value.position };
          clip.target = { ...value.target };
          clip.fov = value.fov;
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

    if (root === 'softboxes' && parts[1] === 'intensity' && typeof value === 'number') {
      viewer.softboxes.params.intensity = value;
      viewer.softboxes.applyParams();
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
    cameras.setPlaybackLocked(playing);
    if (playing) {
      clearGizmos();
      viewer.customLights.setTransformEnabled(false);
      planes.setTransformEnabled(false);
      texts.setTransformEnabled(false);
    }
  };

  timeline.setOnTime(() => {
    shell?.updatePlayhead();
  });

  timeline.setOnEnded(async () => {
    setPlaybackUi(false);
    if (recordingFromTimeline) {
      recordingFromTimeline = false;
      shell?.setChromeVisible(true);
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      setStatus('Exported commercial MP4');
      shell?.refresh();
    } else {
      shell?.refresh();
    }
  });

  const keyframeSelection = () => {
    if (!selection.kind || !selection.id) {
      setStatus('Select an object to keyframe');
      return;
    }
    const t = timeline.time;
    if (selection.kind === 'camera') {
      const clip = cameras.get(selection.id);
      if (!clip) return;
      cameras.captureFromView(selection.id);
      timeline.setKeyframe(
        `camera.${selection.id}.pose`,
        t,
        poseFromCameraClip(clip),
      );
      timeline.setKeyframe('camera.active', t, selection.id, 'linear');
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
    }
    autosave();
    setStatus(`Keyframed at ${t.toFixed(2)}s`);
    shell?.refresh();
  };

  const autosave = () => {
    syncProjectFromRuntime();
    saveProjectToStorage(project);
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
    project = parsed;
    await applySettings(viewer, project.look);
    cameras.setClips(project.cameras, project.playCameraId);
    planes.setFromProject(project.planes);
    texts.setFromProject(project.texts);
    timeline.bindProject(project);
    timeline.seek(0);
    select(null, null);
    setStatus(`Loaded ${project.name}`);
    shell?.refresh();
  };

  const resetProject = async () => {
    project = createDefaultProject(viewer);
    await applySettings(viewer, project.look);
    cameras.setClips(project.cameras, project.playCameraId);
    planes.setFromProject(project.planes);
    texts.setFromProject(project.texts);
    timeline.bindProject(project);
    timeline.seek(0);
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
    syncProjectFromRuntime();
    timeline.bindProject(project);
    recordingFromTimeline = true;
    shell?.setChromeVisible(false);
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
    shell?.setChromeVisible(true);
    if (recorder.isRecording) {
      recordingFromTimeline = false;
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      setStatus('Exported MP4');
    }
    shell?.refresh();
  };

  shell = mountEditorShell({
    viewer,
    getProject: () => project,
    getSelection: () => selection,
    select,
    cameras,
    planes,
    texts,
    timeline,
    onKeyframe: keyframeSelection,
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
    setStatus,
    isRecording: () => recorder.isRecording || recordingFromTimeline,
  });

  viewer.setExternalTick((dt) => {
    timeline.update(dt);
    planes.update();
    texts.update(viewer.camera);
  });

  // Apply play camera once at start
  cameras.applyPlayCamera();
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
      viewer.setExternalTick(null);
      planes.dispose();
      texts.dispose();
      shell.dispose();
    },
  };
}
