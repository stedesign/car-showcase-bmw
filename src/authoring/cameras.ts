import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PerspectiveCamera } from 'three';
import type { CameraClip, CameraPoseValue, Vec3 } from './project';
import { cloneVec3, nextAuthoringId, vec3 } from './project';
import { poseFromCameraClip } from './timeline';

export type CamerasHandle = {
  clips: CameraClip[];
  playCameraId: string;
  setClips: (clips: CameraClip[], playCameraId?: string) => void;
  add: (partial?: Partial<CameraClip>) => CameraClip;
  remove: (id: string) => boolean;
  get: (id: string) => CameraClip | undefined;
  captureFromView: (id: string) => void;
  applyClip: (id: string) => void;
  applyPose: (pose: CameraPoseValue) => void;
  setPlayCameraId: (id: string) => void;
  applyPlayCamera: () => void;
  setPlaybackLocked: (locked: boolean) => void;
  syncClipFromView: (id: string) => CameraClip | null;
};

export function createCamerasHandle(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  initial: CameraClip[],
  playCameraId: string,
): CamerasHandle {
  let clips = initial.map((c) => structuredClone(c));
  let activePlayId = playCameraId;
  let playbackLocked = false;
  let savedOrbitEnabled = controls.enabled;

  const find = (id: string) => clips.find((c) => c.id === id);

  const applyPose = (pose: CameraPoseValue) => {
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    controls.update();
  };

  const applyClip = (id: string) => {
    const clip = find(id);
    if (!clip) return;
    applyPose(poseFromCameraClip(clip));
  };

  return {
    get clips() {
      return clips;
    },
    get playCameraId() {
      return activePlayId;
    },
    setClips(next, playId) {
      clips = next.map((c) => structuredClone(c));
      if (playId && find(playId)) activePlayId = playId;
      else if (!find(activePlayId)) activePlayId = clips[0]?.id ?? '';
    },
    add(partial) {
      const pos = vec3(camera.position.x, camera.position.y, camera.position.z);
      const target = vec3(controls.target.x, controls.target.y, controls.target.z);
      const clip: CameraClip = {
        id: nextAuthoringId('camera'),
        name: partial?.name ?? `Camera ${clips.length + 1}`,
        position: partial?.position ? cloneVec3(partial.position) : pos,
        target: partial?.target ? cloneVec3(partial.target) : target,
        fov: partial?.fov ?? camera.fov,
      };
      clips.push(clip);
      return clip;
    },
    remove(id) {
      const index = clips.findIndex((c) => c.id === id);
      if (index < 0 || clips.length <= 1) return false;
      clips.splice(index, 1);
      if (activePlayId === id) activePlayId = clips[0].id;
      return true;
    },
    get: find,
    captureFromView(id) {
      const clip = find(id);
      if (!clip) return;
      clip.position = vec3(camera.position.x, camera.position.y, camera.position.z);
      clip.target = vec3(controls.target.x, controls.target.y, controls.target.z);
      clip.fov = camera.fov;
    },
    applyClip,
    applyPose,
    setPlayCameraId(id) {
      if (!find(id)) return;
      activePlayId = id;
    },
    applyPlayCamera() {
      if (activePlayId) applyClip(activePlayId);
    },
    setPlaybackLocked(locked) {
      if (locked && !playbackLocked) {
        savedOrbitEnabled = controls.enabled;
        controls.enabled = false;
        controls.autoRotate = false;
      } else if (!locked && playbackLocked) {
        controls.enabled = savedOrbitEnabled;
      }
      playbackLocked = locked;
    },
    syncClipFromView(id) {
      const clip = find(id);
      if (!clip) return null;
      this.captureFromView(id);
      return clip;
    },
  };
}

export function vec3ToThree(v: Vec3): [number, number, number] {
  return [v.x, v.y, v.z];
}
