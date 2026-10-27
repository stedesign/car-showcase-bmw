import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import {
  enableEditorOverlayPicking,
  markEditorOverlay,
} from '../viewer/editorOverlays';
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
  /** Remove every dedicated camera and return to the free camera. */
  clear: () => void;
  get: (id: string) => CameraClip | undefined;
  select: (id: string | null) => void;
  captureFromView: (id: string) => void;
  /** Jump viewport into a dedicated camera (does not change free-cam bookmark). */
  lookThrough: (id: string) => void;
  /** Return viewport to free / orbit camera. */
  enterFree: () => void;
  /**
   * Master view: look through a scene camera and keep orbit from editing it.
   * Does not overwrite the free-camera bookmark.
   */
  holdShot: (id: string) => void;
  /** Leave holdShot and restore the free camera. */
  releaseShot: () => void;
  readonly holdingShot: boolean;
  /** Bookmark current free view (call before leaving free mode). */
  saveFreeView: () => void;
  applyClip: (id: string) => void;
  applyPose: (pose: CameraPoseValue) => void;
  /**
   * Transient vibration on top of the last clean pose. Does not write clips.
   * Skipped in free-orbit edit so free-cam bookmarks stay clean.
   */
  applyShake: (amount: number, elapsed: number) => void;
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
  icon: THREE.Group;
  label: THREE.Sprite;
  aim: THREE.Mesh;
  line: THREE.Line;
};

function camColor(selected: boolean) {
  return selected ? 0x7aa8ff : 0x5cf0e0;
}

function aimColor(selected: boolean) {
  return selected ? 0x7aa8ff : 0xffd666;
}

function unlit(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}

function unlitLine(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    transparent: true,
    opacity: 1,
  });
}

/** Compact camera body + lens so shots stay findable in dark studios. */
function buildCameraIcon(color: number): THREE.Group {
  const icon = new THREE.Group();
  icon.name = 'CameraIcon';

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.18, 0.22),
    unlit(color, 0.92),
  );
  body.position.set(0, 0, 0.02);
  body.renderOrder = 22;

  const lens = new THREE.Mesh(
    new THREE.ConeGeometry(0.1, 0.16, 12, 1, true),
    unlit(color, 0.85),
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.16);
  lens.renderOrder = 22;

  const viewfinder = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.08, 0.08),
    unlit(0xffffff, 0.75),
  );
  viewfinder.position.set(0, 0.12, 0.02);
  viewfinder.renderOrder = 22;

  icon.add(body, lens, viewfinder);
  return icon;
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
    fog: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.35, 0.34, 1);
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
  /** Master timeline is showing a scene shot; don't fall back to the free camera. */
  let shotHold = false;
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
  transform.setSize(1.05);
  transform.enabled = false;
  enableEditorOverlayPicking(transform);
  const transformHelper = transform.getHelper();
  transformHelper.visible = false;
  scene.add(transformHelper);
  markEditorOverlay(transformHelper);

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

  let shakeWasActive = false;

  const readViewportPose = (): CameraPoseValue => ({
    position: vec3(
      viewportCamera.position.x,
      viewportCamera.position.y,
      viewportCamera.position.z,
    ),
    target: vec3(controls.target.x, controls.target.y, controls.target.z),
    fov: viewportCamera.fov,
  });

  let lastCleanPose: CameraPoseValue = readViewportPose();

  const applyPoseToViewport = (pose: CameraPoseValue) => {
    lastCleanPose = {
      position: cloneVec3(pose.position),
      target: cloneVec3(pose.target),
      fov: pose.fov,
    };
    viewportCamera.position.set(pose.position.x, pose.position.y, pose.position.z);
    controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    viewportCamera.fov = pose.fov;
    viewportCamera.updateProjectionMatrix();
    controls.update();
  };

  const tintIcon = (icon: THREE.Group, color: number) => {
    icon.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.name === 'viewfinder') return;
      const mat = obj.material as THREE.MeshBasicMaterial;
      if (mat?.color) mat.color.setHex(color);
    });
  };

  const syncHelperFromParams = (entry: Entry) => {
    const { params, body, aim, line, frustum, icon, label } = entry;
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
      selected ? 0x7aa8ff : 0xd0d6e4,
    );
    (aim.material as THREE.MeshBasicMaterial).color.setHex(aimColor(selected));
    tintIcon(icon, color);
    redrawLabel(label, params.name);

    // Visible in free view (and while looking through any other camera).
    // Hidden only for the camera you're currently looking through / during record.
    const throughSelf =
      viewMode === 'through' && throughCameraId === entry.id;
    const visibleInViewport =
      helpersVisible && !playbackLocked && !shotHold && !throughSelf;
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
    // Path-attached cameras keep eye on the curve — only aim is editable via gizmo.
    if (entry.params.pathId) {
      if (gizmoTarget === 'aim') syncParamsFromAim(entry);
      else syncHelperFromParams(entry);
    } else if (gizmoTarget === 'aim') {
      syncParamsFromAim(entry);
    } else {
      syncParamsFromBody(entry);
    }

    // Live update viewport when looking through this camera
    if (viewMode === 'through' && throughCameraId === entry.id) {
      applyPoseToViewport(poseFromCameraClip(entry.params));
    }
  });

  const attachTransform = () => {
    const entry = selectedId ? findEntry(selectedId) : null;
    if (!entry || playbackLocked || shotHold || !helpersVisible) {
      transform.detach();
      transform.enabled = false;
      transformHelper.visible = false;
      return;
    }
    // On a path, only the aim sphere is transformable.
    const useAim = gizmoTarget === 'aim' || !!entry.params.pathId;
    transform.setMode(useAim ? 'translate' : transformMode);
    transform.attach(useAim ? entry.aim : entry.body);
    transform.enabled = true;
    transformHelper.visible = true;
  };

  /** Orbit / pan / zoom while looking through writes back into the shot (Blender lock-to-view). */
  const onControlsChange = () => {
    if (playbackLocked || shotHold || transform.dragging) return;
    if (viewMode !== 'through' || !throughCameraId) return;
    const entry = findEntry(throughCameraId);
    if (!entry) return;
    const pose = readViewportPose();
    // Path rides keep eye position; orbit may still reframe the aim + fov.
    if (!entry.params.pathId) {
      entry.params.position = cloneVec3(pose.position);
    }
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
    entry.icon.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    });
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

    const icon = buildCameraIcon(camColor(false));
    const viewfinder = icon.children[2];
    if (viewfinder) viewfinder.name = 'viewfinder';

    const label = makeLabelSprite(params.name);
    label.position.set(0, 0.42, 0.1);

    body.add(icon, frustum, label);

    const aim = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 16, 12),
      unlit(aimColor(false)),
    );
    aim.renderOrder = 23;
    aim.name = `${params.name}Aim`;

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(6), 3),
    );
    const line = new THREE.Line(lineGeo, unlitLine(0xd0d6e4));
    line.renderOrder = 20;

    group.add(body);
    group.add(aim);
    group.add(line);
    markEditorOverlay(body);
    markEditorOverlay(aim);
    markEditorOverlay(line);

    const entry: Entry = {
      id: params.id,
      params,
      body,
      frustum,
      icon,
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
    shotHold = false;
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

  const holdShot = (id: string) => {
    const clip = find(id);
    if (!clip) return;
    cancelAxisSnap();
    const changed = !shotHold || viewMode !== 'through' || throughCameraId !== id;
    shotHold = true;
    viewMode = 'through';
    throughCameraId = id;
    controls.enabled = false;
    controls.autoRotate = false;
    if (changed) {
      transform.detach();
      transform.enabled = false;
      transformHelper.visible = false;
      for (const e of entries) syncHelperFromParams(e);
    }
    applyClip(id);
  };

  const releaseShot = () => {
    shotHold = false;
    enterFree();
  };

  const snapToAxis = (axis: CameraAxis) => {
    if (playbackLocked || shotHold) return;

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
      clips = next.map((c) => {
        const clip = structuredClone(c);
        if (typeof clip.pathId !== 'string') clip.pathId = null;
        if (typeof clip.pathProgress !== 'number' || !Number.isFinite(clip.pathProgress)) {
          clip.pathProgress = 0;
        } else {
          clip.pathProgress = Math.min(1, Math.max(0, clip.pathProgress));
        }
        return clip;
      });
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
        pathId: partial?.pathId ?? null,
        pathProgress:
          typeof partial?.pathProgress === 'number' ? partial.pathProgress : 0,
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
      if (index < 0) return false;
      clips.splice(index, 1);
      const entryIndex = entries.findIndex((e) => e.id === id);
      if (entryIndex >= 0) {
        disposeEntry(entries[entryIndex]);
        entries.splice(entryIndex, 1);
      }
      if (activePlayId === id) activePlayId = clips[0]?.id ?? '';
      if (throughCameraId === id) enterFree();
      if (selectedId === id) {
        selectedId = null;
        attachTransform();
      }
      return true;
    },
    clear() {
      for (const entry of entries) disposeEntry(entry);
      entries.length = 0;
      clips = [];
      activePlayId = '';
      selectedId = null;
      enterFree();
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
    holdShot,
    releaseShot,
    get holdingShot() {
      return shotHold;
    },
    saveFreeView,
    applyClip,
    applyPose(pose) {
      cancelAxisSnap();
      applyPoseToViewport(pose);
    },
    applyShake(amount, elapsed) {
      const allow = playbackLocked || viewMode === 'through' || shotHold;
      if (!allow) {
        shakeWasActive = false;
        return;
      }
      const amp = Math.max(0, amount);
      if (amp <= 1e-5) {
        if (shakeWasActive) {
          applyPoseToViewport(lastCleanPose);
          shakeWasActive = false;
        }
        return;
      }
      shakeWasActive = true;
      const posAmp = amp * 0.014;
      const tgtAmp = amp * 0.006;
      const t = elapsed;
      const ox =
        (Math.sin(t * 47.3) + Math.sin(t * 23.1) * 0.55 + Math.sin(t * 91.7) * 0.25) *
        posAmp;
      const oy =
        (Math.sin(t * 39.8 + 1.7) + Math.sin(t * 61.2) * 0.45) * posAmp * 0.7;
      const oz =
        (Math.sin(t * 53.4 + 0.9) + Math.sin(t * 29.6) * 0.5) * posAmp;
      const tx =
        (Math.sin(t * 41.2 + 2.1) + Math.sin(t * 17.8) * 0.4) * tgtAmp;
      const ty =
        (Math.sin(t * 33.7 + 0.4) + Math.sin(t * 55.1) * 0.35) * tgtAmp * 0.6;
      const p = lastCleanPose.position;
      const g = lastCleanPose.target;
      viewportCamera.position.set(p.x + ox, p.y + oy, p.z + oz);
      controls.target.set(g.x + tx, g.y + ty, g.z);
      viewportCamera.fov = lastCleanPose.fov;
      viewportCamera.updateProjectionMatrix();
      controls.update();
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
        if (shotHold) {
          controls.enabled = false;
          controls.autoRotate = false;
        } else {
          enterFree();
          controls.enabled = savedOrbitEnabled;
        }
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
        if (entry.params.pathId) {
          if (gizmoTarget === 'aim') syncParamsFromAim(entry);
          else syncHelperFromParams(entry);
        } else if (gizmoTarget === 'aim') {
          syncParamsFromAim(entry);
        } else {
          syncParamsFromBody(entry);
        }
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
