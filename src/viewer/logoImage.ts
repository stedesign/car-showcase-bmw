export type LogoRaster = {
  canvas: HTMLCanvasElement;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  aspect: number;
};

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
