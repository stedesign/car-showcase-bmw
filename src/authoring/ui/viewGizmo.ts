import * as THREE from 'three';
import type { PerspectiveCamera } from 'three';
import {
  AXIS_LABELS,
  type CameraAxis,
  type CamerasHandle,
} from '../cameras';

const SIZE = 88;
const RADIUS = 26;
const HIT_R = 12;

type AxisHandle = {
  axis: CameraAxis;
  color: string;
  dim: boolean;
  x: number;
  y: number;
  /** Camera-space depth; larger = closer to viewer. */
  depth: number;
};

const HANDLES: Omit<AxisHandle, 'x' | 'y' | 'depth'>[] = [
  { axis: '+x', color: '#ff4d4d', dim: false },
  { axis: '-x', color: '#ff4d4d', dim: true },
  { axis: '+y', color: '#3ddc84', dim: false },
  { axis: '-y', color: '#3ddc84', dim: true },
  { axis: '+z', color: '#4d8dff', dim: false },
  { axis: '-z', color: '#4d8dff', dim: true },
];

const AXIS_VEC: Record<CameraAxis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

export type ViewGizmoHandle = {
  render: () => void;
  dispose: () => void;
};

export type ViewGizmoApi = {
  camera: PerspectiveCamera;
  cameras: CamerasHandle;
  setStatus: (msg: string) => void;
  onSnap?: () => void;
};

/**
 * Spline-style viewport orientation gizmo: colored axis dots that snap
 * the free / general camera onto the corresponding world axis.
 */
export function mountViewGizmo(
  host: HTMLElement,
  api: ViewGizmoApi,
): ViewGizmoHandle {
  const root = document.createElement('div');
  root.className = 'ed-view-gizmo';
  root.title = 'Snap free camera to axis';

  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round(SIZE * dpr);
  canvas.className = 'ed-view-gizmo-canvas';
  root.append(canvas);
  host.append(root);

  const ctx = canvas.getContext('2d')!;
  const _dir = new THREE.Vector3();
  const _invQ = new THREE.Quaternion();
  let hover: CameraAxis | null = null;
  let disposed = false;

  const project = (): AxisHandle[] => {
    const cam = api.camera;
    cam.updateMatrixWorld();
    // World → camera rotation only (no translation).
    _invQ.copy(cam.quaternion).invert();
    const cx = SIZE * 0.5;
    const cy = SIZE * 0.5;

    return HANDLES.map((h) => {
      _dir.copy(AXIS_VEC[h.axis]).applyQuaternion(_invQ);
      return {
        ...h,
        x: cx + _dir.x * RADIUS,
        // Canvas Y is down; camera Y is up.
        y: cy - _dir.y * RADIUS,
        // In Three view space, −Z is forward; invert so front axes draw last.
        depth: -_dir.z,
      };
    });
  };

  const hitTest = (px: number, py: number, handles: AxisHandle[]) => {
    let best: AxisHandle | null = null;
    let bestD = HIT_R * HIT_R;
    for (const h of handles) {
      const dx = px - h.x;
      const dy = py - h.y;
      const d = dx * dx + dy * dy;
      if (d > bestD) continue;
      if (!best || d < bestD - 0.5 || h.depth > best.depth) {
        best = h;
        bestD = d;
      }
    }
    return best;
  };

  const draw = () => {
    if (disposed) return;
    const handles = project().sort((a, b) => a.depth - b.depth);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const cx = SIZE * 0.5;
    const cy = SIZE * 0.5;

    // Soft plate (matches Spline corner widget)
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, SIZE - 1, SIZE - 1, 14);
    ctx.fillStyle = 'rgba(22, 24, 30, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Axis stems — back to front
    for (const h of handles) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(h.x, h.y);
      ctx.strokeStyle = h.dim
        ? 'rgba(160, 168, 184, 0.35)'
        : 'rgba(200, 208, 224, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Hub
    ctx.beginPath();
    ctx.arc(cx, cy, 3.25, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(210, 216, 230, 0.95)';
    ctx.fill();

    // Dots — back to front
    for (const h of handles) {
      const hot = hover === h.axis;
      const r = h.dim ? (hot ? 6 : 5) : hot ? 7.5 : 6.5;

      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);

      if (h.dim) {
        // Negative axis: hollow / muted ring (Spline style)
        ctx.fillStyle = hot ? h.color : 'rgba(70, 76, 92, 0.95)';
        ctx.fill();
        ctx.strokeStyle = hot ? 'rgba(255,255,255,0.7)' : h.color;
        ctx.globalAlpha = hot ? 1 : 0.75;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = h.color;
        ctx.fill();
        if (hot) {
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  };

  const localPoint = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  };

  const onMove = (e: PointerEvent) => {
    const p = localPoint(e);
    const next = hitTest(p.x, p.y, project())?.axis ?? null;
    if (next !== hover) {
      hover = next;
      root.style.cursor = next ? 'pointer' : 'default';
      draw();
    }
  };

  const onLeave = () => {
    if (hover) {
      hover = null;
      root.style.cursor = 'default';
      draw();
    }
  };

  const onClick = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const p = localPoint(e);
    const hit = hitTest(p.x, p.y, project());
    if (!hit) return;
    api.cameras.snapToAxis(hit.axis);
    api.setStatus(`Free camera · ${AXIS_LABELS[hit.axis]}`);
    api.onSnap?.();
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onClick);

  draw();

  return {
    render: draw,
    dispose() {
      disposed = true;
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onClick);
      root.remove();
    },
  };
}
