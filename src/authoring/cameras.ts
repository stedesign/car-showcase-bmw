import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { CameraClip, CameraPoseValue, Vec3 } from './project';
import { cloneVec3, nextAuthoringId, vec3 } from './project';
import { poseFromCameraClip } from './timeline';

export type CameraViewMode = 'free' | 'through';
export type CameraTransformMode = 'translate' | 'rotate';
export type CameraGizmoTarget = 'body' | 'aim';
/** Main-axis snap directions for the viewport orientation gizmo. */
export type CameraAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export type CamerasHandle = {
  group: THREE.Group;
  clips: CameraClip[];
  playCameraId: string;
  viewMode: CameraViewMode;
  throughCameraId: string | null;
  selectedId: string | null;
  setClips: (clips: CameraClip[], playCameraId?: string) => void;
  add: (partial?: Partial<CameraClip>) => CameraClip;
  remove: (id: string) => boolean;
  get: (id: string) => CameraClip | undefined;
  select: (id: string | null) => void;
  captureFromView: (id: string) => void;
  /** Jump viewport into a dedicated camera (does not change free-cam bookmark). */
  lookThrough: (id: string) => void;
  /** Return viewport to free / orbit camera. */
  enterFree: () => void;
  /** Bookmark current free view (call before leaving free mode). */
  saveFreeView: () => void;
  applyClip: (id: string) => void;
  applyPose: (pose: CameraPoseValue) => void;
  /**
   * Orbit the viewport (free / general camera) onto a world axis while
   * keeping the current look-at target and distance. Smoothly animated.
   */
  snapToAxis: (axis: CameraAxis) => void;
  setPlayCameraId: (id: string) => void;
  applyPlayCamera: () => void;
  setPlaybackLocked: (locked: boolean) => void;
  setTransformMode: (mode: CameraTransformMode) => void;
  setGizmoTarget: (target: CameraGizmoTarget) => void;
  helpersVisible: boolean;
  setHelpersVisible: (visible: boolean) => void;
  syncClipFromView: (id: string) => CameraClip | null;
  /** Refresh helper meshes from clip data (e.g. after timeline). */
  refreshHelpers: () => void;
  /** Hide camera gizmos during the floor mirror pass. */
  excludeFromReflector: (reflector: Reflector) => void;
  /** Hide camera helpers + transform gizmo for a callback (e.g. preview render). */
  withOverlaysHidden: (fn: () => void) => void;
  /** Fired when a transform-gizmo drag ends (for undo history). */
  setOnTransformCommit: (fn: (() => void) | null) => void;
  update: () => void;
  dispose: () => void;
};

const AXIS_DIRS: Record<CameraAxis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

const AXIS_LABELS: Record<CameraAxis, string> = {
  '+x': 'Right',
  '-x': 'Left',
  '+y': 'Top',
  '-y': 'Bottom',
  '+z': 'Front',
  '-z': 'Back',
};

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

type Entry = {
  id: string;
  params: CameraClip;
  body: THREE.Object3D;
  frustum: THREE.LineSegments;
  label: THREE.Sprite;
  aim: THREE.Mesh;
  line: THREE.Line;
};

function camColor(selected: boolean) {
  return selected ? 0x5b8def : 0x3dd6c6;
}

function aimColor(selected: boolean) {
  return selected ? 0x5b8def : 0xf0c14b;
}

function unlit(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function unlitLine(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
    opacity: 0.95,
  });
}

/** Wire frustum + up-triangle in local camera space (looks down -Z). */
function buildFrustumGeometry(fov: number, aspect: number, far: number) {
  const halfH = Math.tan(THREE.MathUtils.degToRad(fov) * 0.5) * far;
  const halfW = halfH * aspect;
  const z = -far;
  const corners = [
    new THREE.Vector3(-halfW, halfH, z),
    new THREE.Vector3(halfW, halfH, z),
    new THREE.Vector3(halfW, -halfH, z),
    new THREE.Vector3(-halfW, -halfH, z),
  ];
  const origin = new THREE.Vector3(0, 0, 0);
  const positions: number[] = [];
  for (const c of corners) {
    positions.push(origin.x, origin.y, origin.z, c.x, c.y, c.z);
  }
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  // Orientation triangle on the far-plane top edge (apex = camera up).
  const triHalf = halfW * 0.22;
  const triH = halfH * 0.35;
  const triL = new THREE.Vector3(-triHalf, halfH, z);
  const triR = new THREE.Vector3(triHalf, halfH, z);
  const triApex = new THREE.Vector3(0, halfH + triH, z);
  positions.push(
    triL.x, triL.y, triL.z, triR.x, triR.y, triR.z,
    triR.x, triR.y, triR.z, triApex.x, triApex.y, triApex.z,
    triApex.x, triApex.y, triApex.z, triL.x, triL.y, triL.z,
  );
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(12,14,20,0.75)';
  ctx.roundRect(8, 12, 240, 40, 8);
  ctx.fill();
  ctx.font = '600 22px "IBM Plex Sans", Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.1, 0.28, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 30;
  return sprite;
}

function redrawLabel(sprite: THREE.Sprite, text: string) {
  const mat = sprite.material as THREE.SpriteMaterial;
  const map = mat.map;
  if (!map?.image) return;
  const canvas = map.image as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(12,14,20,0.75)';
  ctx.roundRect(8, 12, 240, 40, 8);
  ctx.fill();
  ctx.font = '600 22px "IBM Plex Sans", Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  map.needsUpdate = true;
}

const _aimEye = new THREE.Vector3();
const _aimTarget = new THREE.Vector3();
const _aimUp = new THREE.Vector3(0, 1, 0);
const _aimMatrix = new THREE.Matrix4();

/**
 * Orient an Object3D like a Three.js Camera: local -Z points at the target.
 * (Object3D.lookAt faces +Z at the target, which flips our frustum / lens.)
 */
function aimBodyLikeCamera(
  body: THREE.Object3D,
  position: Vec3,
  target: Vec3,
) {
  _aimEye.set(position.x, position.y, position.z);
  _aimTarget.set(target.x, target.y, target.z);
  body.position.copy(_aimEye);
  _aimMatrix.lookAt(_aimEye, _aimTarget, _aimUp);
  body.quaternion.setFromRotationMatrix(_aimMatrix);
}

export function createCamerasHandle(
  scene: THREE.Scene,
  viewportCamera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  domElement: HTMLElement,
  initial: CameraClip[],
  playCameraId: string,
): CamerasHandle {
  const group = new THREE.Group();
  group.name = 'AuthoringCameras';
  scene.add(group);

  let clips = initial.map((c) => structuredClone(c));
  let activePlayId = playCameraId;
  let selectedId: string | null = null;
  let viewMode: CameraViewMode = 'free';
  let throughCameraId: string | null = null;
  let playbackLocked = false;
  let helpersVisible = true;
  let helpersVisibleBeforePlayback = true;
  let transformMode: CameraTransformMode = 'translate';
  let gizmoTarget: CameraGizmoTarget = 'body';
  let savedOrbitEnabled = controls.enabled;

  let freePose: CameraPoseValue = {
    position: vec3(
      viewportCamera.position.x,
      viewportCamera.position.y,
      viewportCamera.position.z,
    ),
    target: vec3(controls.target.x, controls.target.y, controls.target.z),
    fov: viewportCamera.fov,
  };

  let axisSnapRaf = 0;
  const _snapStart = new THREE.Spherical();
  const _snapEnd = new THREE.Spherical();
  const _snapOffset = new THREE.Vector3();
  const _snapTarget = new THREE.Vector3();

  const entries: Entry[] = [];

  const transform = new TransformControls(viewportCamera, domElement);
  transform.setMode('translate');
  transform.setSize(0.75);
  transform.enabled = false;
  const transformHelper = transform.getHelper();
  transformHelper.visible = false;
  scene.add(transformHelper);

  let onTransformCommit: (() => void) | null = null;

  transform.addEventListener('dragging-changed', (event) => {
    const dragging = (event as { value: boolean }).value;
    if (viewMode === 'free' && !playbackLocked) {
      controls.enabled = !dragging;
    }
    if (!dragging) onTransformCommit?.();
  });

  const find = (id: string) => clips.find((c) => c.id === id);
  const findEntry = (id: string) => entries.find((e) => e.id === id);

  const applyPoseToViewport = (pose: CameraPoseValue) => {
    viewportCamera.position.set(pose.position.x, pose.position.y, pose.position.z);
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    viewportCamera.fov = pose.fov;
    viewportCamera.updateProjectionMatrix();
    controls.update();
  };

  const readViewportPose = (): CameraPoseValue => ({
    position: vec3(
      viewportCamera.position.x,
      viewportCamera.position.y,
      viewportCamera.position.z,
    ),
    target: vec3(controls.target.x, controls.target.y, controls.target.z),
    fov: viewportCamera.fov,
  });

  const syncHelperFromParams = (entry: Entry) => {
    const { params, body, aim, line, frustum, label } = entry;
    aimBodyLikeCamera(body, params.position, params.target);
    aim.position.set(params.target.x, params.target.y, params.target.z);

    const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, params.position.x, params.position.y, params.position.z);
    positions.setXYZ(1, params.target.x, params.target.y, params.target.z);
    positions.needsUpdate = true;

    const nextGeo = buildFrustumGeometry(params.fov, 16 / 9, 2.8);
    frustum.geometry.dispose();
    frustum.geometry = nextGeo;

    const selected = entry.id === selectedId;
    const color = camColor(selected);
    (frustum.material as THREE.LineBasicMaterial).color.setHex(color);
    (line.material as THREE.LineBasicMaterial).color.setHex(
      selected ? 0x5b8def : 0xa8b0c2,
    );
    (aim.material as THREE.MeshBasicMaterial).color.setHex(aimColor(selected));
    redrawLabel(label, params.name);

    // Visible in free view (and while looking through any other camera).
    // Hidden only for the camera you're currently looking through / during record.
    const throughSelf =
      viewMode === 'through' && throughCameraId === entry.id;
    const visibleInViewport = helpersVisible && !playbackLocked && !throughSelf;
    body.visible = visibleInViewport;
    aim.visible = visibleInViewport;
    line.visible = visibleInViewport;
  };

  const syncParamsFromBody = (entry: Entry) => {
    const { body, params } = entry;
    params.position = vec3(body.position.x, body.position.y, body.position.z);
    // Keep aim distance; recompute target from forward
    const dist = Math.max(
      0.35,
      body.position.distanceTo(
        new THREE.Vector3(params.target.x, params.target.y, params.target.z),
      ),
    );
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(body.quaternion);
    const target = body.position.clone().add(forward.multiplyScalar(dist));
    params.target = vec3(target.x, target.y, target.z);
    syncHelperFromParams(entry);
  };

  const syncParamsFromAim = (entry: Entry) => {
    const { aim, params } = entry;
    params.target = vec3(aim.position.x, aim.position.y, aim.position.z);
    syncHelperFromParams(entry);
  };

  transform.addEventListener('objectChange', () => {
    const entry = selectedId ? findEntry(selectedId) : null;
    if (!entry) return;
    if (gizmoTarget === 'aim') syncParamsFromAim(entry);
    else syncParamsFromBody(entry);

    // Live update viewport when looking through this camera
    if (viewMode === 'through' && throughCameraId === entry.id) {
      applyPoseToViewport(poseFromCameraClip(entry.params));
    }
  });

  const attachTransform = () => {
    const entry = selectedId ? findEntry(selectedId) : null;
    if (!entry || playbackLocked || !helpersVisible) {
      transform.detach();
      transform.enabled = false;
      transformHelper.visible = false;
      return;
    }
    transform.setMode(gizmoTarget === 'aim' ? 'translate' : transformMode);
    transform.attach(gizmoTarget === 'aim' ? entry.aim : entry.body);
    transform.enabled = true;
    transformHelper.visible = true;
  };

  /** Orbit / pan / zoom while looking through writes back into the shot (Blender lock-to-view). */
  const onControlsChange = () => {
    if (playbackLocked || transform.dragging) return;
    if (viewMode !== 'through' || !throughCameraId) return;
    const entry = findEntry(throughCameraId);
    if (!entry) return;
    const pose = readViewportPose();
    entry.params.position = cloneVec3(pose.position);
    entry.params.target = cloneVec3(pose.target);
    entry.params.fov = pose.fov;
    syncHelperFromParams(entry);
  };
  controls.addEventListener('change', onControlsChange);

  const disposeEntry = (entry: Entry) => {
    group.remove(entry.body);
    group.remove(entry.aim);
    group.remove(entry.line);
    entry.line.geometry.dispose();
    (entry.line.material as THREE.Material).dispose();
    entry.aim.geometry.dispose();
    (entry.aim.material as THREE.Material).dispose();
    entry.frustum.geometry.dispose();
    (entry.frustum.material as THREE.Material).dispose();
    const labelMat = entry.label.material as THREE.SpriteMaterial;
    labelMat.map?.dispose();
    labelMat.dispose();
  };

  const buildEntry = (params: CameraClip): Entry => {
    const body = new THREE.Object3D();
    body.name = params.name;

    const frustum = new THREE.LineSegments(
      buildFrustumGeometry(params.fov, 16 / 9, 2.8),
      unlitLine(camColor(false)),
    );
    frustum.renderOrder = 21;

    const label = makeLabelSprite(params.name);
    label.position.set(0, 0.35, 0.1);

    body.add(frustum, label);

    const aim = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 16, 12),
      unlit(aimColor(false)),
    );
    aim.renderOrder = 23;
    aim.name = `${params.name}Aim`;

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(6), 3),
    );
    const line = new THREE.Line(lineGeo, unlitLine(0xa8b0c2));
    line.renderOrder = 20;

    group.add(body);
    group.add(aim);
    group.add(line);

    const entry: Entry = {
      id: params.id,
      params,
      body,
      frustum,
      label,
      aim,
      line,
    };
    syncHelperFromParams(entry);
    return entry;
  };

  const rebuildEntries = () => {
    transform.detach();
    for (const e of entries) disposeEntry(e);
    entries.length = 0;
    for (const clip of clips) {
      entries.push(buildEntry(clip));
    }
    attachTransform();
  };

  rebuildEntries();

  const applyClip = (id: string) => {
    const clip = find(id);
    if (!clip) return;
    applyPoseToViewport(poseFromCameraClip(clip));
  };

  const saveFreeView = () => {
    if (viewMode === 'free') {
      freePose = readViewportPose();
    }
  };

  const cancelAxisSnap = () => {
    if (!axisSnapRaf) return;
    cancelAnimationFrame(axisSnapRaf);
    axisSnapRaf = 0;
    if (!playbackLocked) controls.enabled = true;
  };

  const enterFree = () => {
    cancelAxisSnap();
    viewMode = 'free';
    throughCameraId = null;
    applyPoseToViewport(freePose);
    if (!playbackLocked) {
      controls.enabled = savedOrbitEnabled;
    }
    for (const e of entries) syncHelperFromParams(e);
    attachTransform();
  };

  const lookThrough = (id: string) => {
    const clip = find(id);
    if (!clip) return;
    cancelAxisSnap();
    if (viewMode === 'free') saveFreeView();
    viewMode = 'through';
    throughCameraId = id;
    selectedId = id;
    activePlayId = id;
    applyClip(id);
    // Keep orbit on so framing in the middle view edits this shot live
    if (!playbackLocked) {
      controls.enabled = true;
      controls.autoRotate = false;
    }
    for (const e of entries) syncHelperFromParams(e);
    attachTransform();
  };

  const snapToAxis = (axis: CameraAxis) => {
    if (playbackLocked) return;

    // Axis snaps always operate the free / general camera, keeping the
    // current framing (don't jump back to the free-view bookmark).
    if (viewMode === 'through') {
      viewMode = 'free';
      throughCameraId = null;
      freePose = readViewportPose();
      for (const e of entries) syncHelperFromParams(e);
      attachTransform();
    }

    cancelAxisSnap();

    const dir = AXIS_DIRS[axis];
    _snapTarget.copy(controls.target);
    _snapOffset.copy(viewportCamera.position).sub(_snapTarget);
    const distance = Math.max(
      controls.minDistance,
      Math.min(controls.maxDistance, _snapOffset.length() || 6),
    );

    _snapStart.setFromVector3(_snapOffset);
    // Nudge off poles so OrbitControls doesn't hitch at phi = 0 / π.
    _snapEnd.setFromVector3(dir.clone().multiplyScalar(distance));
    _snapEnd.phi = THREE.MathUtils.clamp(_snapEnd.phi, 0.02, Math.PI - 0.02);

    // Shortest yaw path
    let dTheta = _snapEnd.theta - _snapStart.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    // Authoring: allow full orbit including bottom views.
    controls.maxPolarAngle = Math.PI;
    controls.autoRotate = false;

    const duration = 320;
    const t0 = performance.now();
    controls.enabled = false;

    const tick = (now: number) => {
      const u = easeInOutCubic(Math.min(1, (now - t0) / duration));
      const phi = THREE.MathUtils.lerp(_snapStart.phi, _snapEnd.phi, u);
      const theta = _snapStart.theta + dTheta * u;
      const radius = THREE.MathUtils.lerp(_snapStart.radius, _snapEnd.radius, u);
      _snapOffset.setFromSphericalCoords(radius, phi, theta);
      viewportCamera.position.copy(_snapTarget).add(_snapOffset);
      controls.update();

      if (u < 1) {
        axisSnapRaf = requestAnimationFrame(tick);
        return;
      }

      axisSnapRaf = 0;
      if (!playbackLocked) controls.enabled = true;
      freePose = readViewportPose();
    };

    axisSnapRaf = requestAnimationFrame(tick);
  };

  return {
    group,
    get clips() {
      return clips;
    },
    get playCameraId() {
      return activePlayId;
    },
    get viewMode() {
      return viewMode;
    },
    get throughCameraId() {
      return throughCameraId;
    },
    get selectedId() {
      return selectedId;
    },
    get helpersVisible() {
      return helpersVisible;
    },
    setClips(next, playId) {
      clips = next.map((c) => structuredClone(c));
      if (playId && find(playId)) activePlayId = playId;
      else if (!find(activePlayId)) activePlayId = clips[0]?.id ?? '';
      rebuildEntries();
    },
    add(partial) {
      const pose = viewMode === 'free' ? readViewportPose() : freePose;
      const clip: CameraClip = {
        id: nextAuthoringId('camera'),
        name: partial?.name ?? `Camera ${clips.length + 1}`,
        position: partial?.position ? cloneVec3(partial.position) : cloneVec3(pose.position),
        target: partial?.target ? cloneVec3(partial.target) : cloneVec3(pose.target),
        fov: partial?.fov ?? pose.fov,
      };
      // Offset new camera slightly so it isn't stacked on free view
      if (!partial?.position) {
        clip.position.x += 0.6;
        clip.position.y += 0.15;
      }
      clips.push(clip);
      const entry = buildEntry(clip);
      entries.push(entry);
      selectedId = clip.id;
      attachTransform();
      return clip;
    },
    remove(id) {
      const index = clips.findIndex((c) => c.id === id);
      if (index < 0 || clips.length <= 1) return false;
      clips.splice(index, 1);
      const entryIndex = entries.findIndex((e) => e.id === id);
      if (entryIndex >= 0) {
        disposeEntry(entries[entryIndex]);
        entries.splice(entryIndex, 1);
      }
      if (activePlayId === id) activePlayId = clips[0].id;
      if (throughCameraId === id) enterFree();
      if (selectedId === id) {
        selectedId = null;
        attachTransform();
      }
      return true;
    },
    get: find,
    select(id) {
      selectedId = id;
      for (const e of entries) syncHelperFromParams(e);
      attachTransform();
    },
    captureFromView(id) {
      const clip = find(id);
      if (!clip) return;
      const pose = readViewportPose();
      clip.position = cloneVec3(pose.position);
      clip.target = cloneVec3(pose.target);
      clip.fov = pose.fov;
      const entry = findEntry(id);
      if (entry) {
        entry.params = clip;
        syncHelperFromParams(entry);
      }
    },
    lookThrough,
    enterFree,
    saveFreeView,
    applyClip,
    applyPose(pose) {
      cancelAxisSnap();
      applyPoseToViewport(pose);
    },
    snapToAxis,
    setPlayCameraId(id) {
      if (!find(id)) return;
      activePlayId = id;
    },
    applyPlayCamera() {
      if (activePlayId) lookThrough(activePlayId);
    },
    setPlaybackLocked(locked) {
      if (locked && !playbackLocked) {
        savedOrbitEnabled = controls.enabled;
        helpersVisibleBeforePlayback = helpersVisible;
        if (viewMode === 'free') saveFreeView();
        controls.enabled = false;
        controls.autoRotate = false;
        transform.detach();
        transform.enabled = false;
        transformHelper.visible = false;
        helpersVisible = false;
      } else if (!locked && playbackLocked) {
        helpersVisible = helpersVisibleBeforePlayback;
        enterFree();
        controls.enabled = savedOrbitEnabled;
      }
      playbackLocked = locked;
      for (const e of entries) syncHelperFromParams(e);
      if (!locked) attachTransform();
    },
    setTransformMode(mode) {
      transformMode = mode;
      attachTransform();
    },
    setGizmoTarget(target) {
      gizmoTarget = target;
      attachTransform();
    },
    setHelpersVisible(visible) {
      helpersVisible = visible;
      for (const e of entries) syncHelperFromParams(e);
      attachTransform();
    },
    syncClipFromView(id) {
      const clip = find(id);
      if (!clip) return null;
      this.captureFromView(id);
      return clip;
    },
    refreshHelpers() {
      // Re-bind params refs from clips array (timeline may mutate clip objects)
      for (const entry of entries) {
        const clip = find(entry.id);
        if (clip) entry.params = clip;
        syncHelperFromParams(entry);
      }
    },
    excludeFromReflector(reflector) {
      const previous = reflector.onBeforeRender;
      reflector.onBeforeRender = (
        renderer,
        sceneArg,
        cameraArg,
        geometryArg,
        materialArg,
        groupArg,
      ) => {
        const wasVisible = group.visible;
        const wasHelper = transformHelper.visible;
        group.visible = false;
        transformHelper.visible = false;
        previous.call(
          reflector,
          renderer,
          sceneArg,
          cameraArg,
          geometryArg,
          materialArg,
          groupArg,
        );
        group.visible = wasVisible;
        transformHelper.visible = wasHelper;
      };
    },
    withOverlaysHidden(fn) {
      const wasVisible = group.visible;
      const wasHelper = transformHelper.visible;
      group.visible = false;
      transformHelper.visible = false;
      try {
        fn();
      } finally {
        group.visible = wasVisible;
        transformHelper.visible = wasHelper;
      }
    },
    setOnTransformCommit(fn) {
      onTransformCommit = fn;
    },
    update() {
      if (transform.enabled && transform.dragging && selectedId) {
        const entry = findEntry(selectedId);
        if (!entry) return;
        if (gizmoTarget === 'aim') syncParamsFromAim(entry);
        else syncParamsFromBody(entry);
        if (viewMode === 'through' && throughCameraId === entry.id) {
          applyPoseToViewport(poseFromCameraClip(entry.params));
        }
      }
      // Keep free pose bookmarked while orbiting in free mode
      if (viewMode === 'free' && !playbackLocked && !transform.dragging) {
        freePose = readViewportPose();
      }
    },
    dispose() {
      cancelAxisSnap();
      controls.removeEventListener('change', onControlsChange);
      transform.detach();
      transform.dispose();
      scene.remove(transformHelper);
      for (const e of entries) disposeEntry(e);
      entries.length = 0;
      scene.remove(group);
    },
  };
}

export { AXIS_LABELS };

export function vec3ToThree(v: Vec3): [number, number, number] {
  return [v.x, v.y, v.z];
}
