export type LogoRaster = {
  canvas: HTMLCanvasElement;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  aspect: number;
};

/**
 * Per non-space glyph in "WE ARE A TEAM": true = solid fill, false = stroke only.
 * Brand lockup — only W, R, T are solid; everything else is outline.
 */
const BRAND_LINE_FILL: readonly boolean[] = [
  true, // W
  false, // E
  false, // A
  true, // R
  false, // E
  false, // A
  true, // T
  false, // E
  false, // A
  false, // M
];

/**
 * Mixed fill/stroke line lockup for the dotted-wall marquee.
 * Canvas text (not SVG-as-image) so letterforms stay reliable across browsers.
 * `gapRatio` adds trailing empty space so a U-scroll can loop cleanly.
 *
 * Every glyph is stroked with the same weight first so cap height matches;
 * W / R / T are then filled on top. Stroke stays moderate so hollow letters
 * still read as outlines on the LED grid.
 */
export function rasterizeBrandLine(
  text = 'WE ARE A TEAM',
  options: { height?: number; gapRatio?: number } = {},
): LogoRaster {
  const height = Math.max(64, Math.round(options.height ?? 256));
  const gapRatio = Math.min(1, Math.max(0.1, options.gapRatio ?? 0.38));
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d');
  if (!probeCtx) throw new Error('Failed to rasterize brand line');

  // Size the face so font bbox + stroke fits inside the canvas with even padding.
  let fontSize = Math.round(height * 0.82);
  const fontFor = (size: number) =>
    `900 ${size}px "Arial Black", Impact, "Helvetica Neue", Helvetica, Arial, sans-serif`;
  probeCtx.textBaseline = 'alphabetic';
  for (let i = 0; i < 4; i++) {
    probeCtx.font = fontFor(fontSize);
    const m = probeCtx.measureText('HG');
    const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? fontSize * 0.8;
    const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? fontSize * 0.2;
    const strokeW = Math.max(3, fontSize * 0.065);
    const need = ascent + descent + strokeW;
    if (need <= height * 0.92 || fontSize < 32) break;
    fontSize = Math.max(32, Math.floor(fontSize * ((height * 0.92) / need)));
  }

  const font = fontFor(fontSize);
  const strokeW = Math.max(3, fontSize * 0.065);
  probeCtx.font = font;
  const metrics = probeCtx.measureText('HG');
  const ascent =
    metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? fontSize * 0.8;
  const descent =
    metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? fontSize * 0.2;
  // Alphabetic baseline placed so the font bbox is vertically centered.
  const y = (height + ascent - descent) / 2;

  const textW = Math.max(1, Math.ceil(probeCtx.measureText(text).width));
  const padL = Math.round(height * 0.06 + strokeW);
  const gap = Math.ceil(textW * gapRatio);
  const width = padL + textW + Math.ceil(strokeW) + gap;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to rasterize brand line');
  ctx.clearRect(0, 0, width, height);
  ctx.font = font;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = strokeW;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // Pass 1 — identical stroke on every letter (shared outer height).
  let x = padL;
  for (const ch of text) {
    if (ch === ' ') {
      x += ctx.measureText(' ').width;
      continue;
    }
    ctx.strokeText(ch, x, y);
    x += ctx.measureText(ch).width;
  }

  // Pass 2 — solid W / R / T.
  x = padL;
  let letter = 0;
  for (const ch of text) {
    if (ch === ' ') {
      x += ctx.measureText(' ').width;
      continue;
    }
    if (BRAND_LINE_FILL[letter]) ctx.fillText(ch, x, y);
    letter += 1;
    x += ctx.measureText(ch).width;
  }

  const data = ctx.getImageData(0, 0, width, height).data;
  return { canvas, data, width, height, aspect: width / Math.max(1, height) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Draw a logo URL to a canvas. SVGs can thicken strokes first so a dot-grid
 * sample (one tap per cell) still catches outlined letters.
 */
export async function rasterizeLogo(
  url: string,
  options: { maxEdge?: number; minStrokeWidth?: number } = {},
): Promise<LogoRaster> {
  const maxEdge = options.maxEdge ?? 2048;
  let src = url;
  let revoke: string | null = null;

  if (options.minStrokeWidth !== undefined && /\.svg($|\?)/i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}`);
    const raw = await response.text();
    const min = options.minStrokeWidth;
    const thickened = raw.replace(/stroke-width="([\d.]+)"/g, (_match, n: string) => {
      const w = Number.parseFloat(n);
      const next = Number.isFinite(w) ? Math.max(w, min) : min;
      return `stroke-width="${next}"`;
    });
    revoke = URL.createObjectURL(new Blob([thickened], { type: 'image/svg+xml' }));
    src = revoke;
  }

  try {
    const img = await loadImage(src);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    const edge = Math.max(srcW, srcH, 1);
    const scale = edge >= maxEdge ? 1 : maxEdge / edge;
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(`Failed to rasterize ${url}`);
    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { canvas, data, width, height, aspect: width / Math.max(1, height) };
  } finally {
    if (revoke) URL.revokeObjectURL(revoke);
  }
}
