import * as THREE from 'three';
import { isCustomFont, resolveFontStack } from './fonts';
import type { MasterTextAlign, MasterTextClip, MasterTextEffect } from './project';

/**
 * Screen-space titles composited onto the WebGL canvas after the beauty pass,
 * so master preview and canvas.captureStream both include them.
 *
 * Masked heading follows the React Bits look (word blur reveal, drifting
 * red/white duotone through the glyphs). It is painted here — the React
 * component is not used.
 */

/** React Bits Masked Heading defaults from the preview URL. */
const MASKED = {
  reveal: 1.4,
  wordDur: 0.5,
  drift: 30,
  tracking: -0.02,
  lineHeight: 0.97,
};

const BLUR = {
  reveal: 1.4,
  wordDur: 0.5,
  tracking: -0.02,
  lineHeight: 1.15,
};

const FADE_IN = 0.4;
const FADE_OUT = 0.4;

/** Tight tracking on the giant sliding line, in ems. Pixel tracking only. */
export const MARQUEE_TRACKING_EM = -0.025;

export type MasterTextOverlay = {
  /** Active master titles. `visible` is false in Scene mode. */
  setFrame: (clips: MasterTextClip[], time: number, visible: boolean) => void;
  render: (renderer: THREE.WebGLRenderer) => void;
  dispose: () => void;
};

type PlacedWord = {
  text: string;
  x: number;
  y: number;
  index: number;
};

/** Laid-out title in canvas pixels. `origin` is the block's top-left. */
export type MasterTextBlock = {
  words: PlacedWord[];
  fontPx: number;
  originX: number;
  originY: number;
  blockW: number;
  blockH: number;
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function smooth(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function setType(
  ctx: CanvasRenderingContext2D,
  px: number,
  weight: number,
  family: string,
  trackingPx = 0,
) {
  ctx.font = `${weight} ${px}px ${family}`;
  // Pixel tracking only. `em` letter-spacing makes measureText disagree with
  // fillText, which is what pushed titles off the right edge.
  ctx.letterSpacing = `${trackingPx}px`;
}

function textWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontPx: number,
  weight: number,
  family: string,
) {
  setType(ctx, fontPx, weight, family);
  return ctx.measureText(text).width;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontPx: number,
  weight: number,
  family: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const parts = para.split(/\s+/).filter(Boolean);
    if (!parts.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const part of parts) {
      const next = line ? `${line} ${part}` : part;
      if (line && textWidth(ctx, next, fontPx, weight, family) > maxWidth) {
        lines.push(line);
        line = part;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function wordProgress(local: number, index: number, count: number, reveal: number, wordDur: number) {
  // Long titles need more than `reveal` or every word lands in the same beat
  // and realtime preview looks like the line just pops on.
  const span = Math.max(reveal - wordDur, Math.max(0, count - 1) * 0.16);
  const delay = count <= 1 ? 0 : (index / (count - 1)) * span;
  return smooth((local - delay) / wordDur);
}

/**
 * Soften one word with extra fillText taps.
 * A shared blur canvas was uploaded once and preview kept that frame.
 */
function paintGlyph(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  blur: number,
) {
  if (blur < 0.8) {
    ctx.fillText(text, x, y);
    return;
  }
  const steps = 8;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev / steps;
  for (let i = 0; i < steps; i += 1) {
    const ang = (i / steps) * Math.PI * 2;
    ctx.fillText(text, x + Math.cos(ang) * blur, y + Math.sin(ang) * blur * 0.65);
  }
  ctx.globalAlpha = prev;
}

function marqueeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

type MarqueeMetrics = {
  line: string;
  fontPx: number;
  originY: number;
  blockH: number;
  copyW: number;
  period: number;
  weight: number;
  family: string;
  tracking: number;
};

/** One copy of the sliding line, at the requested size — it may be wider than the frame. */
function measureMarquee(
  ctx: CanvasRenderingContext2D,
  clip: MasterTextClip,
  text: string,
  frameW: number,
  frameH: number,
  lineHeight: number,
  weight: number,
  family: string,
): MarqueeMetrics | null {
  const line = marqueeLine(text);
  if (!line || frameW < 2 || frameH < 2) return null;
  const fontPx = Math.min(frameH * 1.25, Math.max(12, clip.size * frameH));
  const tracking = fontPx * MARQUEE_TRACKING_EM;
  setType(ctx, fontPx, weight, family, tracking);
  const copyW = ctx.measureText(line).width;
  const gap = fontPx * 0.85;
  const period = Math.max(copyW + gap, 1);
  const blockH = fontPx * lineHeight;
  const marginY = Math.round(frameH * 0.1);
  let originY: number;
  if (Number.isFinite(clip.y)) originY = (clip.y as number) * frameH;
  else if (clip.anchor === 'center') originY = (frameH - blockH) / 2;
  else if (clip.anchor === 'bottom') originY = frameH - marginY - blockH;
  else originY = marginY;
  originY = Math.min(Math.max(originY, -blockH + 8), Math.max(8, frameH) - 8);
  return { line, fontPx, originY, blockH, copyW, period, weight, family, tracking };
}

/** Left edge of the first copy before travel is applied. Center crops both sides, like the WRT line. */
function marqueeStart(align: MasterTextAlign, frameW: number, copyW: number): number {
  if (align === 'left') return 0;
  if (align === 'right') return frameW - copyW;
  return (frameW - copyW) / 2;
}

/** Wrap so a copy always starts in (-period, 0]. */
function marqueeOffset(start: number, travel: number, period: number): number {
  let x = (start - travel) % period;
  if (x > 0) x -= period;
  return x;
}

function layoutWords(
  ctx: CanvasRenderingContext2D,
  clip: MasterTextClip,
  text: string,
  frameW: number,
  frameH: number,
  lineHeight: number,
  weight: number,
  family: string,
  requestedPx: number,
): MasterTextBlock {
  if (clip.effect === 'marquee') {
    const band = measureMarquee(
      ctx,
      clip,
      text,
      frameW,
      frameH,
      lineHeight,
      weight,
      family,
    );
    if (!band) {
      return { words: [], fontPx: requestedPx, originX: 0, originY: 0, blockW: 0, blockH: 0 };
    }
    return {
      words: [{ text: band.line, x: 0, y: band.originY, index: 0 }],
      fontPx: band.fontPx,
      originX: 0,
      originY: band.originY,
      blockW: frameW,
      blockH: band.blockH,
    };
  }

  const marginX = Math.round(frameW * 0.07);
  const marginY = Math.round(frameH * 0.1);
  const maxWidth = Math.max(32, frameW - marginX * 2);
  const maxHeight = Math.max(32, frameH - marginY * 2);

  const paragraphs = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const unwrapped = (fontPx: number) => {
    const widths = paragraphs.map((line) => textWidth(ctx, line, fontPx, weight, family));
    const width = Math.max(0, ...widths);
    const height = Math.max(paragraphs.length, 1) * fontPx * lineHeight;
    return { width, height };
  };

  const wrappedFits = (fontPx: number) => {
    const lines = wrapLines(ctx, text, fontPx, weight, family, maxWidth);
    const width = Math.max(
      ...lines.map((line) => (line ? textWidth(ctx, line, fontPx, weight, family) : 0)),
      0,
    );
    const height = Math.max(lines.length, 1) * fontPx * lineHeight;
    return width <= maxWidth + 0.5 && height <= maxHeight + 0.5;
  };

  // Keep each paragraph on one line and shrink until it fits. Wrap only when
  // even the smallest size is still wider than the frame.
  let lo = 12;
  let hi = Math.max(12, requestedPx);
  let fontPx = lo;
  let lines: string[];
  if (unwrapped(hi).width <= maxWidth + 0.5 && unwrapped(hi).height <= maxHeight + 0.5) {
    fontPx = hi;
    lines = paragraphs;
  } else {
    let fitUnwrapped = false;
    for (let i = 0; i < 14; i += 1) {
      const mid = (lo + hi) / 2;
      const box = unwrapped(mid);
      if (box.width <= maxWidth + 0.5 && box.height <= maxHeight + 0.5) {
        fontPx = mid;
        fitUnwrapped = true;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    if (fitUnwrapped) {
      lines = paragraphs;
    } else if (wrappedFits(Math.max(12, requestedPx))) {
      fontPx = Math.max(12, requestedPx);
      lines = wrapLines(ctx, text, fontPx, weight, family, maxWidth);
    } else {
      lo = 12;
      hi = Math.max(12, requestedPx);
      fontPx = lo;
      for (let i = 0; i < 14; i += 1) {
        const mid = (lo + hi) / 2;
        if (wrappedFits(mid)) {
          fontPx = mid;
          lo = mid;
        } else {
          hi = mid;
        }
      }
      lines = wrapLines(ctx, text, fontPx, weight, family, maxWidth);
    }
  }
  const lineH = fontPx * lineHeight;
  const space = textWidth(ctx, ' ', fontPx, weight, family);
  const lineMetrics = lines.map((line) => {
    const parts = line.split(/\s+/).filter(Boolean);
    const widths = parts.map((part) => textWidth(ctx, part, fontPx, weight, family));
    const lineW = widths.reduce((sum, w, i) => sum + w + (i ? space : 0), 0);
    return { parts, widths, lineW };
  });
  const blockW = Math.max(0, ...lineMetrics.map((line) => line.lineW));
  const blockH = Math.max(lines.length, 1) * lineH;

  let originX: number;
  if (Number.isFinite(clip.x)) {
    originX = (clip.x as number) * frameW;
    originX = Math.min(Math.max(originX, -blockW + 8), Math.max(8, frameW) - 8);
  } else if (clip.align === 'center') {
    originX = (frameW - blockW) / 2;
  } else if (clip.align === 'right') {
    originX = frameW - marginX - blockW;
  } else {
    originX = marginX;
  }
  if (!Number.isFinite(clip.x)) {
    originX = Math.min(Math.max(marginX, originX), Math.max(marginX, frameW - marginX - blockW));
  }

  let originY: number;
  if (Number.isFinite(clip.y)) {
    originY = (clip.y as number) * frameH;
    originY = Math.min(Math.max(originY, -blockH + 8), Math.max(8, frameH) - 8);
  } else if (clip.anchor === 'center') {
    originY = (frameH - blockH) / 2;
  } else if (clip.anchor === 'bottom') {
    originY = frameH - marginY - blockH;
  } else {
    originY = marginY;
  }
  if (!Number.isFinite(clip.y)) {
    originY = Math.min(Math.max(marginY, originY), Math.max(marginY, frameH - marginY - blockH));
  }

  const words: PlacedWord[] = [];
  let index = 0;
  lineMetrics.forEach((line, li) => {
    let x = originX;
    if (clip.align === 'center') x = originX + (blockW - line.lineW) / 2;
    else if (clip.align === 'right') x = originX + blockW - line.lineW;
    const y = originY + li * lineH;
    line.parts.forEach((part, i) => {
      words.push({ text: part, x, y, index });
      index += 1;
      x += line.widths[i] + space;
    });
  });

  return { words, fontPx, originX, originY, blockW, blockH };
}

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');

function effectType(effect: MasterTextEffect): { lineHeight: number; weight: number } {
  if (effect === 'maskedHeading') return { lineHeight: 1.15, weight: 700 };
  if (effect === 'blurReveal') return { lineHeight: BLUR.lineHeight, weight: 700 };
  if (effect === 'marquee') return { lineHeight: 1, weight: 800 };
  return { lineHeight: 1.2, weight: 600 };
}

function clipType(clip: MasterTextClip): { lineHeight: number; weight: number; family: string } {
  const base = effectType(clip.effect);
  return {
    lineHeight: base.lineHeight,
    // Uploaded faces are a single cut. Requesting 700 faux-bolds them.
    weight: isCustomFont(clip.font) ? 400 : base.weight,
    family: resolveFontStack(clip.font),
  };
}

/** Type used to paint `clip`, so an on-canvas editor can match it. */
export function masterTextType(clip: MasterTextClip): {
  lineHeight: number;
  weight: number;
  family: string;
} {
  return clipType(clip);
}

let editingClipId: string | null = null;

/** Hide one title while its on-canvas editor is showing the same glyphs. */
export function setMasterTextEditing(id: string | null): void {
  editingClipId = id;
}

/** Same block the canvas paints, in drawing-buffer pixels. */
export function measureMasterTextBlock(
  clip: MasterTextClip,
  frameW: number,
  frameH: number,
): MasterTextBlock | null {
  if (!measureCtx || frameW < 2 || frameH < 2) return null;
  const text = clip.text.trim();
  if (!text) return null;
  const { lineHeight, weight, family } = clipType(clip);
  return layoutWords(
    measureCtx,
    clip,
    text,
    frameW,
    frameH,
    lineHeight,
    weight,
    family,
    Math.max(18, clip.size * frameH),
  );
}

/**
 * Write one axis from the anchor or align preset.
 * The other axis stays where a free drag left it.
 */
export function snapMasterTextAxis(
  clip: MasterTextClip,
  axis: 'x' | 'y',
  frameW: number,
  frameH: number,
): void {
  const probe: MasterTextClip = { ...clip };
  if (axis === 'x') delete probe.x;
  else delete probe.y;
  const block = measureMasterTextBlock(probe, frameW, frameH);
  if (!block) return;
  if (axis === 'x') clip.x = block.originX / frameW;
  else clip.y = block.originY / frameH;
}

function hexChannel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function mixHex(hex: string, toward: number, amount: number, alpha: number): string {
  const mix = (index: number) =>
    Math.round(hexChannel(hex, index) * (1 - amount) + toward * amount);
  return `rgba(${mix(0)},${mix(1)},${mix(2)},${alpha})`;
}

function inkOf(clip: MasterTextClip): string {
  return /^#[0-9a-f]{6}$/.test(clip.color)
    ? clip.color
    : clip.effect === 'maskedHeading'
      ? '#ff0000'
      : '#ffffff';
}

function paintDuotone(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: number,
  tint: string,
) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  // Red keeps the original palette. Any other pick shifts the same blobs.
  const base = tint === '#ff0000' ? '#140206' : mixHex(tint, 0, 0.92, 1);
  const hot = tint === '#ff0000' ? 'rgba(255,70,80,0.9)' : mixHex(tint, 255, 0.28, 0.9);
  const deep = tint === '#ff0000' ? 'rgba(120,0,16,0.95)' : mixHex(tint, 0, 0.53, 0.95);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const blobs: { color: string; rx: number; phase: number }[] = [
    { color: 'rgba(255,255,255,0.95)', rx: 0.42, phase: 0.4 },
    { color: 'rgba(255,255,255,0.75)', rx: 0.22, phase: 2.1 },
    { color: tint, rx: 0.55, phase: 1.2 },
    { color: hot, rx: 0.28, phase: 2.8 },
    { color: deep, rx: 0.48, phase: 0.2 },
  ];
  const drift = time * MASKED.drift;
  for (const blob of blobs) {
    const x = w * (0.5 + 0.32 * Math.sin(time * 0.35 + blob.phase)) + Math.sin(time * 0.9 + blob.phase) * drift;
    const y = h * (0.5 + 0.32 * Math.cos(time * 0.28 + blob.phase)) + Math.cos(time * 0.7 + blob.phase) * drift;
    const r = Math.max(w, h) * blob.rx;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, blob.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

function fadeEdge(local: number, duration: number, outSec: number): number {
  if (outSec <= 0) return 1;
  return clamp01((duration - local) / outSec);
}

function layerOpacity(clip: MasterTextClip): number {
  return clamp01(typeof clip.opacity === 'number' ? clip.opacity : 1);
}

function paintMarquee(
  main: CanvasRenderingContext2D,
  clip: MasterTextClip,
  frameW: number,
  frameH: number,
  local: number,
) {
  const { lineHeight, weight, family } = clipType(clip);
  const band = measureMarquee(
    main,
    clip,
    clip.text,
    frameW,
    frameH,
    lineHeight,
    weight,
    family,
  );
  if (!band || band.copyW < 1) return;
  // Stay fully up at the in-point so a paused playhead still shows the line.
  const alpha =
    fadeEdge(local, clip.duration, Math.min(0.35, clip.duration * 0.25)) * layerOpacity(clip);
  if (alpha <= 0.001) return;
  const speed = typeof clip.speed === 'number' && Number.isFinite(clip.speed) ? clip.speed : 0.15;
  const x0 = marqueeOffset(marqueeStart(clip.align, frameW, band.copyW), local * speed * frameW, band.period);
  main.save();
  main.globalAlpha = alpha;
  main.fillStyle = inkOf(clip);
  main.textBaseline = 'top';
  main.shadowColor = 'transparent';
  main.shadowBlur = 0;
  setType(main, band.fontPx, band.weight, band.family, band.tracking);
  for (let x = x0; x < frameW; x += band.period) {
    main.fillText(band.line, x, band.originY);
  }
  main.restore();
}

export function createMasterTextOverlay(): MasterTextOverlay {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
  const mask = document.createElement('canvas');
  const maskCtx = mask.getContext('2d', { alpha: true, willReadFrequently: true });
  const color = document.createElement('canvas');
  const colorCtx = color.getContext('2d', { alpha: true, willReadFrequently: true });

  // Pixel copy, not a CanvasTexture. Chrome keeps the first canvas snapshot
  // for texImage2D(canvas), so preview playback never advances the title.
  const makeTexture = (data: Uint8Array, w: number, h: number) => {
    const tex = new THREE.DataTexture(data as unknown as BufferSource, w, h, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.flipY = true;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  };
  let texture = makeTexture(new Uint8Array(4), 1, 1);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  let clips: MasterTextClip[] = [];
  let time = 0;
  let visible = false;
  const prevViewport = new THREE.Vector4();
  let scratchW = 2;
  let scratchH = 2;
  mask.width = scratchW;
  mask.height = scratchH;
  color.width = scratchW;
  color.height = scratchH;

  const ensureScratch = (w: number, h: number) => {
    const W = Math.max(2, Math.ceil(w));
    const H = Math.max(2, Math.ceil(h));
    if (W <= scratchW && H <= scratchH) return;
    scratchW = Math.max(scratchW, W);
    scratchH = Math.max(scratchH, H);
    mask.width = scratchW;
    mask.height = scratchH;
    color.width = scratchW;
    color.height = scratchH;
  };

  const paintClip = (
    main: CanvasRenderingContext2D,
    clip: MasterTextClip,
    frameW: number,
    frameH: number,
  ) => {
    if (clip.id === editingClipId) return;
    const local = time - clip.start;
    if (local < 0 || local >= clip.duration) return;
    const text = clip.text.trim();
    if (!text) return;

    const effect: MasterTextEffect = clip.effect;
    const { weight, family } = clipType(clip);
    const ink = inkOf(clip);
    const cover = layerOpacity(clip);
    if (cover <= 0.001) return;

    if (effect === 'marquee') {
      paintMarquee(main, clip, frameW, frameH, local);
      return;
    }

    const measure = measureMasterTextBlock(clip, frameW, frameH);
    if (!measure || !measure.words.length) return;
    const fontPx = measure.fontPx;

    if (effect === 'fade') {
      const fadeIn = Math.min(FADE_IN, clip.duration * 0.45);
      const fadeOut = Math.min(FADE_OUT, clip.duration * 0.45);
      const alpha =
        (0.2 + 0.8 * smooth(local / fadeIn)) *
        smooth((clip.duration - local) / fadeOut) *
        cover;
      if (alpha <= 0.001) return;
      main.save();
      main.globalAlpha = alpha;
      main.fillStyle = ink;
      main.textBaseline = 'top';
      main.shadowColor = 'rgba(0,0,0,0.55)';
      main.shadowBlur = fontPx * 0.18;
      setType(main, fontPx, weight, family);
      for (const word of measure.words) {
        main.fillText(word.text, word.x, word.y);
      }
      main.restore();
      return;
    }

    const count = Math.max(1, measure.words.length);
    const reveal = effect === 'maskedHeading' ? MASKED.reveal : BLUR.reveal;
    const wordDur = effect === 'maskedHeading' ? MASKED.wordDur : BLUR.wordDur;

    // Blur reveal is painted straight onto the frame canvas. Blitting a
    // second canvas (and then uploading that canvas to WebGL) is what left
    // preview playback stuck on a single title frame.
    if (effect === 'blurReveal') {
      main.save();
      main.globalAlpha = fadeEdge(local, clip.duration, Math.min(0.35, clip.duration * 0.3)) * cover;
      main.textBaseline = 'top';
      setType(main, fontPx, weight, family);
      main.fillStyle = ink;
      for (const word of measure.words) {
        const p = wordProgress(local, word.index, count, reveal, wordDur);
        if (p <= 0.001) continue;
        const blur = (1 - p) * fontPx * 0.34;
        const rise = (1 - p) * fontPx * 0.28;
        main.save();
        main.globalAlpha *= p;
        paintGlyph(main, word.text, word.x, word.y + rise, blur);
        main.restore();
      }
      main.restore();
      return;
    }

    if (!maskCtx || !colorCtx) return;
    ensureScratch(frameW, frameH);
    maskCtx.clearRect(0, 0, frameW, frameH);
    maskCtx.textBaseline = 'top';
    setType(maskCtx, fontPx, weight, family);
    maskCtx.fillStyle = '#ffffff';
    maskCtx.shadowColor = 'transparent';
    maskCtx.shadowBlur = 0;

    for (const word of measure.words) {
      const p = wordProgress(local, word.index, count, reveal, wordDur);
      if (p <= 0.001) continue;
      maskCtx.save();
      maskCtx.globalAlpha = p;
      paintGlyph(maskCtx, word.text, word.x, word.y, (1 - p) * fontPx * 0.34);
      maskCtx.restore();
    }
    maskCtx.shadowBlur = 0;
    maskCtx.filter = 'none';

    if (effect === 'maskedHeading') {
      paintDuotone(colorCtx, frameW, frameH, time, ink);
      colorCtx.globalCompositeOperation = 'destination-in';
      colorCtx.drawImage(mask, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
      colorCtx.globalCompositeOperation = 'source-over';
      main.save();
      main.globalAlpha = fadeEdge(local, clip.duration, Math.min(0.35, clip.duration * 0.3)) * cover;
      main.drawImage(color, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
      main.restore();
      return;
    }

    main.save();
    main.globalAlpha = fadeEdge(local, clip.duration, Math.min(0.35, clip.duration * 0.3)) * cover;
    main.drawImage(mask, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
    main.restore();
  };

  const upload = (frameW: number, frameH: number) => {
    if (!ctx) return;
    const image = ctx.getImageData(0, 0, frameW, frameH);
    if (texture.image.width !== frameW || texture.image.height !== frameH) {
      texture.dispose();
      texture = makeTexture(new Uint8Array(image.data), frameW, frameH);
      material.map = texture;
      material.needsUpdate = true;
      return;
    }
    (texture.image.data as Uint8Array).set(image.data);
    texture.needsUpdate = true;
  };

  const paint = (frameW: number, frameH: number) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, frameW, frameH);
    if (!visible) return;
    // Lower rows paint later, so a marquee on the top row sits behind titles under it.
    const ordered = [...clips].sort((a, b) => a.lane - b.lane);
    for (const clip of ordered) paintClip(ctx, clip, frameW, frameH);
    upload(frameW, frameH);
  };

  return {
    setFrame(next, t, show) {
      clips = next;
      time = t;
      visible = show;
    },
    render(renderer) {
      if (!ctx) return;
      const frameW = renderer.domElement.width;
      const frameH = renderer.domElement.height;
      if (frameW < 2 || frameH < 2) return;

      const sizeChanged = canvas.width !== frameW || canvas.height !== frameH;
      if (sizeChanged) {
        canvas.width = frameW;
        canvas.height = frameH;
      }

      const inWindow = (c: MasterTextClip) =>
        time >= c.start && time < c.start + c.duration;
      // Still paint while editing so the previous frame is cleared off the title.
      const active =
        visible &&
        clips.some(
          (c) => inWindow(c) && (c.id === editingClipId || c.text.trim().length > 0),
        );
      if (!active) {
        if (sizeChanged) texture.needsUpdate = true;
        return;
      }

      paint(frameW, frameH);

      const prevTone = renderer.toneMapping;
      const prevExposure = renderer.toneMappingExposure;
      const prevAutoClear = renderer.autoClear;
      renderer.getViewport(prevViewport);

      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.autoClear = false;
      // setViewport is in CSS pixels and the renderer multiplies by pixel
      // ratio. Passing the drawing-buffer size paints the title into a
      // viewport twice as big as the canvas, so the glyphs land off the box.
      const pixelRatio = renderer.getPixelRatio() || 1;
      renderer.setViewport(0, 0, frameW / pixelRatio, frameH / pixelRatio);
      renderer.clearDepth();
      renderer.render(scene, camera);

      renderer.setViewport(prevViewport);
      renderer.toneMapping = prevTone;
      renderer.toneMappingExposure = prevExposure;
      renderer.autoClear = prevAutoClear;
    },
    dispose() {
      material.dispose();
      mesh.geometry.dispose();
      texture.dispose();
    },
  };
}
