import * as THREE from 'three';
import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { Project, Selection } from '../project';

const PREVIEW_W = 320;
const PREVIEW_H = 180;

export type CameraPreviewApi = {
  viewer: Viewer;
  cameras: CamerasHandle;
  getProject: () => Project;
  getSelection: () => Selection;
  select: (kind: Selection['kind'], id: string | null) => void;
  onChange: () => void;
  setStatus: (msg: string) => void;
};

export type CameraPreviewHandle = {
  /** Sync visibility / labels from selection (and pin state). */
  refresh: () => void;
  /** Draw the live preview (call after the main frame). */
  render: () => void;
  dispose: () => void;
};

export function mountCameraPreview(
  host: HTMLElement,
  api: CameraPreviewApi,
): CameraPreviewHandle {
  const panel = document.createElement('div');
  panel.className = 'ed-cam-preview';
  panel.hidden = true;

  const header = document.createElement('div');
  header.className = 'ed-cam-preview-head';

  const title = document.createElement('span');
  title.className = 'ed-cam-preview-title';
  title.textContent = 'Camera';

  const actions = document.createElement('div');
  actions.className = 'ed-cam-preview-actions';

  const snapBtn = document.createElement('button');
  snapBtn.type = 'button';
  snapBtn.className = 'ed-cam-preview-btn';
  snapBtn.textContent = 'Snap to camera';

  const useBtn = document.createElement('button');
  useBtn.type = 'button';
  useBtn.className = 'ed-cam-preview-btn primary';
  useBtn.textContent = 'Use this camera';

  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'ed-cam-preview-pin';
  pinBtn.title = 'Keep preview open';
  pinBtn.setAttribute('aria-label', 'Pin preview');
  pinBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.2 1.6 9 2.8l.7 2.1-2.4 2.4-1.5-.5L4.4 8.2l2.2 2.2-3.8 3.8.8.8 3.8-3.8 2.2 2.2 1.4-1.4-.5-1.5 2.4-2.4 2.1.7 1.2-1.2-3-3z"/></svg>';

  actions.append(snapBtn, useBtn, pinBtn);
  header.append(title, actions);

  const frame = document.createElement('div');
  frame.className = 'ed-cam-preview-frame';

  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  canvas.className = 'ed-cam-preview-canvas';

  const lookingBadge = document.createElement('div');
  lookingBadge.className = 'ed-cam-preview-looking';
  lookingBadge.textContent = 'Looking through';
  lookingBadge.hidden = true;

  frame.append(canvas, lookingBadge);
  panel.append(header, frame);
  host.append(panel);

  const previewRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'low-power',
  });
  previewRenderer.setPixelRatio(1);
  previewRenderer.setSize(PREVIEW_W, PREVIEW_H, false);
  previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
  previewRenderer.shadowMap.enabled = true;
  previewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const previewCam = new THREE.PerspectiveCamera(
    32,
    PREVIEW_W / PREVIEW_H,
    0.05,
    200,
  );

  let cameraId: string | null = null;
  let pinned = false;
  let disposed = false;

  // Drag panel by header
  let drag: { ox: number; oy: number; left: number; top: number } | null = null;
  header.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    drag = {
      ox: e.clientX,
      oy: e.clientY,
      left: rect.left - hostRect.left,
      top: rect.top - hostRect.top,
    };
    header.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
  });
  header.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const hostRect = host.getBoundingClientRect();
    const left = drag.left + (e.clientX - drag.ox);
    const top = drag.top + (e.clientY - drag.oy);
    const maxL = Math.max(8, hostRect.width - panel.offsetWidth - 8);
    const maxT = Math.max(8, hostRect.height - panel.offsetHeight - 8);
    panel.style.left = `${Math.max(8, Math.min(maxL, left))}px`;
    panel.style.top = `${Math.max(8, Math.min(maxT, top))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  header.addEventListener('pointerup', () => {
    drag = null;
    panel.classList.remove('dragging');
  });

  const syncPinChrome = () => {
    pinBtn.classList.toggle('active', pinned);
    pinBtn.title = pinned ? 'Unpin preview' : 'Keep preview open';
  };

  pinBtn.addEventListener('click', () => {
    pinned = !pinned;
    syncPinChrome();
    refresh();
  });

  snapBtn.addEventListener('click', () => {
    if (!cameraId) return;
    api.cameras.lookThrough(cameraId);
    api.select('camera', cameraId);
    api.setStatus(`Snapped to ${api.cameras.get(cameraId)?.name ?? 'camera'}`);
    api.onChange();
  });

  useBtn.addEventListener('click', () => {
    if (!cameraId) return;
    const clip = api.cameras.get(cameraId);
    if (!clip) return;
    api.cameras.setPlayCameraId(cameraId);
    api.getProject().playCameraId = cameraId;
    api.cameras.lookThrough(cameraId);
    api.select('camera', cameraId);
    api.setStatus(`Using ${clip.name} as play camera`);
    api.onChange();
  });

  const resolveCameraId = (): string | null => {
    const sel = api.getSelection();
    if (sel.kind === 'camera' && sel.id) return sel.id;
    if (pinned && cameraId && api.cameras.get(cameraId)) return cameraId;
    return null;
  };

  const refresh = () => {
    if (disposed) return;
    const next = resolveCameraId();
    cameraId = next;
    if (!cameraId) {
      panel.hidden = true;
      return;
    }
    const clip = api.cameras.get(cameraId);
    if (!clip) {
      panel.hidden = true;
      cameraId = null;
      return;
    }
    panel.hidden = false;
    title.textContent = clip.name;
    const looking =
      api.cameras.viewMode === 'through' &&
      api.cameras.throughCameraId === cameraId;
    lookingBadge.hidden = !looking;
    snapBtn.disabled = looking;
    useBtn.textContent =
      api.cameras.playCameraId === cameraId
        ? 'Using this camera'
        : 'Use this camera';
    useBtn.classList.toggle('primary', api.cameras.playCameraId !== cameraId);
    syncPinChrome();
  };

  const render = () => {
    if (disposed || panel.hidden || !cameraId) return;
    const clip = api.cameras.get(cameraId);
    if (!clip) return;

    previewCam.position.set(clip.position.x, clip.position.y, clip.position.z);
    previewCam.lookAt(clip.target.x, clip.target.y, clip.target.z);
    previewCam.fov = clip.fov;
    previewCam.near = api.viewer.camera.near;
    previewCam.far = api.viewer.camera.far;
    previewCam.updateProjectionMatrix();

    const main = api.viewer.renderer;
    previewRenderer.outputColorSpace = main.outputColorSpace;
    previewRenderer.toneMapping = main.toneMapping;
    previewRenderer.toneMappingExposure = main.toneMappingExposure;

    api.cameras.withOverlaysHidden(() => {
      previewRenderer.render(api.viewer.scene, previewCam);
    });
  };

  syncPinChrome();
  refresh();

  return {
    refresh,
    render,
    dispose() {
      disposed = true;
      previewRenderer.dispose();
      panel.remove();
    },
  };
}
