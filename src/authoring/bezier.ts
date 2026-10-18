import type { CubicBezier, EasingName } from './project';

export const EASING_BEZIERS: Record<EasingName, CubicBezier> = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  easeInOut: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
};

export function defaultBezier(easing: EasingName = 'easeInOut'): CubicBezier {
  const p = EASING_BEZIERS[easing] ?? EASING_BEZIERS.easeInOut;
  return { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 };
}

export function cloneBezier(b: CubicBezier): CubicBezier {
  return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** Cubic Bezier basis (P0=0, P3=1). */
function bezier1d(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezier1dDeriv(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * CSS-style cubic-bezier easing: map progress u∈[0,1] → eased progress.
 * Control points are (x1,y1) and (x2,y2) with endpoints (0,0)/(1,1).
 */
export function cubicBezierEase(u: number, bezier: CubicBezier): number {
  const x = clamp01(u);
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const { x1, y1, x2, y2 } = bezier;

  // Linear shortcut
  if (
    Math.abs(x1 - y1) < 1e-6 &&
    Math.abs(x2 - y2) < 1e-6 &&
    Math.abs(x1) < 1e-6 &&
    Math.abs(x2 - 1) < 1e-6
  ) {
    return x;
  }

  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const xEst = bezier1d(t, x1, x2) - x;
    const d = bezier1dDeriv(t, x1, x2);
    if (Math.abs(xEst) < 1e-6 || Math.abs(d) < 1e-6) break;
    t = clamp01(t - xEst / d);
  }

  // Fallback binary search if Newton drifts
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i += 1) {
    const xEst = bezier1d(t, x1, x2);
    if (Math.abs(xEst - x) < 1e-6) break;
    if (xEst < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }

  return bezier1d(t, y1, y2);
}

export function resolveBezier(
  bezier: CubicBezier | undefined,
  easing: EasingName | undefined,
): CubicBezier {
  if (bezier) return cloneBezier(bezier);
  return defaultBezier(easing ?? 'easeInOut');
}
