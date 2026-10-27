import * as THREE from 'three';
import { rasterizeBrandLine, rasterizeLogo, type LogoRaster } from './logoImage';
import { logoMarkIndex } from './wrtLogo';

export type DotGridPreset = 'idle' | 'pulse' | 'shockwave';

/** Numeric modes — timeline-keyable via `dotGrid.effectMode`. */
export const DOT_GRID_EFFECT_MODES = [
  { id: 0, name: 'Idle' },
  { id: 1, name: 'Wave' },
  { id: 2, name: 'Scan' },
  { id: 3, name: 'Rain' },
  { id: 4, name: 'Sparkle' },
  { id: 5, name: 'Breathe' },
  { id: 6, name: 'Shock loop' },
  { id: 7, name: 'Reveal loop' },
] as const;

export type DotGridEffectModeId = (typeof DOT_GRID_EFFECT_MODES)[number]['id'];

export type DotGridParams = {
  enabled: boolean;
  opacity: number;
  reveal: number;
  pulse: number;
  pulseHz: number;
  wave: number;
  waveSpeed: number;
  flash: number;
  flashDecay: number;
  /** Soft halo + bloom push on logo / active dots (0–2). */
  glow: number;
  /**
   * Active motion pattern (0–7). See `DOT_GRID_EFFECT_MODES`.
   * Key on timeline as `dotGrid.effectMode`.
   */
  effectMode: number;
  /** Overall strength of the active effect pattern (0–2). */
  effectStrength: number;
  /** Dot diameter as a fraction of cell size (0–1). */
  dotSize: number;
  /** Approximate cell count across the screen width (density). */
  density: number;
  baseColor: string;
  activeColor: string;
  panelColor: string;
  distance: number;
  height: number;
  scale: number;
  /** World-space plane width before scale. */
  width: number;
  /** World-space plane height before scale. */
  heightWorld: number;
  reflectionEnabled: boolean;
  reflectionOpacity: number;
  reflectionFade: number;
  /** How far the floor wash stretches toward the camera (world units). */
  reflectionLength: number;
  /** Which logo mask is painted. 0 = WRT, 1 = stacked team, 2 = sliding line. Synced with `logo.mark`. */
  mark: number;
  /** Marquee travel in screen-widths per second (mark 2 only). */
  marqueeSpeed: number;
};

export const DEFAULT_DOT_GRID_PARAMS: DotGridParams = {
  enabled: true,
  opacity: 1,
  reveal: 1,
  pulse: 0.7,
  pulseHz: 0.9,
  wave: 0.55,
  waveSpeed: 1.4,
  flash: 0,
  flashDecay: 2.4,
  glow: 1.15,
  effectMode: 1,
  effectStrength: 1,
  dotSize: 0.48,
  density: 88,
  baseColor: '#8b849c',
  activeColor: '#ffffff',
  panelColor: '#1a1624',
  distance: 7.2,
  height: 1.65,
  scale: 1.15,
  width: 18,
  heightWorld: 6.5,
  reflectionEnabled: true,
  reflectionOpacity: 0.55,
  reflectionFade: 0.78,
  reflectionLength: 3.4,
  mark: 0,
  marqueeSpeed: 0.12,
};

function hash21(x: number, y: number, t: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 41.17) * 43758.5453;
  return n - Math.floor(n);
}

export type DottedWrtScreenHandle = {
  group: THREE.Group;
  params: DotGridParams;
  applyParams: () => void;
  applyPreset: (preset: DotGridPreset) => void;
  update: (dt: number, elapsed: number) => void;
  triggerFlash: (peak?: number) => void;
  setVisible: (visible: boolean) => void;
  getWorldCenter: (out?: THREE.Vector3) => THREE.Vector3;
};

function parseRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
  ];
}

function createFloorFadeAlphaMap(fade: number): THREE.CanvasTexture {
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(4, h);
  const t = THREE.MathUtils.clamp(fade, 0, 1);

  for (let y = 0; y < h; y++) {
    const uvY = 1 - y / (h - 1);
    const along = 1 - uvY;
    const a = Math.round(255 * (1 - t * along * along * (3 - 2 * along)));
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = a;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

type MaskSource = {
  raster: LogoRaster;
  /** `contain` fits the whole mark; `marquee` height-fits a strip that can be wider than the wall. */
  layout: 'contain' | 'marquee';
  /** Fraction of the limiting axis (contain) or of wall height (marquee). */
  contain: number;
};

type MaskGrid = {
  data: Float32Array;
  /** Horizontal period in cells. Equals cellsX for contain marks; may be wider for marquee. */
  periodX: number;
  cellsY: number;
};

function sampleLogoAlpha(
  logoData: Uint8ClampedArray,
  logoW: number,
  logoH: number,
  lu: number,
  lv: number,
): number {
  if (lu < 0 || lu > 1 || lv < 0 || lv > 1) return 0;
  const px = Math.min(logoW - 1, Math.max(0, Math.floor(lu * logoW)));
  const py = Math.min(logoH - 1, Math.max(0, Math.floor((1 - lv) * logoH)));
  const i = (py * logoW + px) * 4;
  const a = Math.max(logoData[i + 3], logoData[i], logoData[i + 1], logoData[i + 2]) / 255;
  return a > 0.2 ? Math.min(1, (a - 0.2) / 0.45) : 0;
}

/**
 * Precompute logo mask at cell centers for fast per-frame paints.
 * `contain` is how much of the limiting screen axis the mark may use (1 = edge to edge).
 */
function buildContainMaskGrid(
  logoData: Uint8ClampedArray,
  logoW: number,
  logoH: number,
  cellsX: number,
  cellsY: number,
  planeAspect: number,
  logoAspect: number,
  contain = 1,
): MaskGrid {
  const inset = Math.min(1, Math.max(0.05, contain));
  const mask = new Float32Array(cellsX * cellsY);
  for (let y = 0; y < cellsY; y++) {
    for (let x = 0; x < cellsX; x++) {
      const u = (x + 0.5) / cellsX;
      const v = (y + 0.5) / cellsY;
      let lu = u;
      let lv = v;
      if (planeAspect > logoAspect) {
        lu = (u - 0.5) * (planeAspect / logoAspect) / inset + 0.5;
        lv = (v - 0.5) / inset + 0.5;
      } else {
        lu = (u - 0.5) / inset + 0.5;
        lv = (v - 0.5) * (logoAspect / planeAspect) / inset + 0.5;
      }
      mask[y * cellsX + x] = sampleLogoAlpha(logoData, logoW, logoH, lu, lv);
    }
  }
  return { data: mask, periodX: cellsX, cellsY };
}

/**
 * Height-fit a wide strip; horizontal period can exceed the wall so only part shows at once.
 * Trailing empty cells come from transparent padding in the SVG (loop gap).
 */
function buildMarqueeMaskGrid(
  logoData: Uint8ClampedArray,
  logoW: number,
  logoH: number,
  cellsX: number,
  cellsY: number,
  planeAspect: number,
  logoAspect: number,
  heightFill = 0.62,
): MaskGrid {
  const fill = Math.min(1, Math.max(0.2, heightFill));
  // Logo height in plane-UV terms → width in UV → cells for one period.
  const logoHeightUv = fill;
  const logoWidthUv = logoHeightUv * (logoAspect / planeAspect);
  const periodX = Math.max(cellsX + 1, Math.round(logoWidthUv * cellsX));
  const mask = new Float32Array(periodX * cellsY);

  for (let y = 0; y < cellsY; y++) {
    const v = (y + 0.5) / cellsY;
    const lv = (v - 0.5) / fill + 0.5;
    for (let x = 0; x < periodX; x++) {
      const uStrip = (x + 0.5) / periodX;
      mask[y * periodX + x] = sampleLogoAlpha(logoData, logoW, logoH, uStrip, lv);
    }
  }
  return { data: mask, periodX, cellsY };
}

function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

export async function createDottedWrtScreen(
  textureUrl = '/brand/wrt-logo.png',
  altTextureUrl = '/brand/we-are-a-team.svg',
): Promise<DottedWrtScreenHandle> {
  const params: DotGridParams = { ...DEFAULT_DOT_GRID_PARAMS };
  const group = new THREE.Group();
  group.name = 'DottedWrtScreen';

  // Outlined letters are ~2px on a 394-wide SVG. Cell centers are ~9px apart
  // on this wall, so the mask raster uses a heavier stroke or the outlines vanish.
  // The stacked lockup is much taller than the WRT wordmark; keep it inside the wall.
  // The marquee line is height-fitted and free to be wider than the screen.
  const TEAM_DOT_CONTAIN = 0.72;
  // Near full wall height so LED cells resolve counters / stroke weight cleanly.
  const TEAM_LINE_HEIGHT = 0.94;
  const [wrtRaster, teamRaster] = await Promise.all([
    rasterizeLogo(textureUrl, { maxEdge: 1024 }),
    rasterizeLogo(altTextureUrl, { maxEdge: 1600, minStrokeWidth: 9 }),
  ]);
  const lineRaster = rasterizeBrandLine('WE ARE A TEAM', { height: 512 });
  const sources: MaskSource[] = [
    { raster: wrtRaster, layout: 'contain', contain: 1 },
    { raster: teamRaster, layout: 'contain', contain: TEAM_DOT_CONTAIN },
    { raster: lineRaster, layout: 'marquee', contain: TEAM_LINE_HEIGHT },
  ];

  const paint = document.createElement('canvas');
  const paintW = 1280;
  let paintH = Math.max(256, Math.round(paintW * (params.heightWorld / params.width)));
  paint.width = paintW;
  paint.height = paintH;
  const ctx = paint.getContext('2d')!;

  const map = new THREE.CanvasTexture(paint);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = false;

  const floorMap = map.clone();
  floorMap.colorSpace = THREE.SRGBColorSpace;
  floorMap.wrapS = THREE.ClampToEdgeWrapping;
  floorMap.wrapT = THREE.ClampToEdgeWrapping;
  floorMap.repeat.y = -1;
  floorMap.offset.y = 1;
  floorMap.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    opacity: 1,
    depthWrite: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(params.width, params.heightWorld),
    material,
  );
  mesh.name = 'DottedWrtScreenMesh';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  group.add(mesh);

  // Additive twin — pushes logo whites into bloom.
  const glowMaterial = new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(1.35, 1.35, 1.45),
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const glowMesh = new THREE.Mesh(mesh.geometry, glowMaterial);
  glowMesh.name = 'DottedWrtScreenGlow';
  glowMesh.position.z = 0.015;
  glowMesh.frustumCulled = false;
  glowMesh.renderOrder = 3;
  group.add(glowMesh);

  let fadeAlphaMap = createFloorFadeAlphaMap(params.reflectionFade);
  const floorReflectionMaterial = new THREE.MeshBasicMaterial({
    map: floorMap,
    alphaMap: fadeAlphaMap,
    color: new THREE.Color(1.15, 1.15, 1.25),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const floorReflection = new THREE.Mesh(
    new THREE.PlaneGeometry(params.width, 1),
    floorReflectionMaterial,
  );
  floorReflection.name = 'DottedWrtScreenFloorReflection';
  floorReflection.rotation.x = -Math.PI / 2;
  floorReflection.renderOrder = 3;
  floorReflection.frustumCulled = false;
  group.add(floorReflection);

  let flashEnergy = 0;
  let flashRadius = 0;
  let lastWidth = params.width;
  let lastHeightWorld = params.heightWorld;
  let lastFade = params.reflectionFade;
  let cellsX = 0;
  let cellsY = 0;
  let maskGrids: MaskGrid[] = [];
  let maskDirty = true;
  let elapsed = 0;

  const rebuildMask = () => {
    const aspect = params.width / Math.max(0.001, params.heightWorld);
    cellsX = Math.max(8, Math.round(params.density));
    cellsY = Math.max(8, Math.round(params.density / aspect));
    maskGrids = sources.map((src) =>
      src.layout === 'marquee'
        ? buildMarqueeMaskGrid(
            src.raster.data,
            src.raster.width,
            src.raster.height,
            cellsX,
            cellsY,
            aspect,
            src.raster.aspect,
            src.contain,
          )
        : buildContainMaskGrid(
            src.raster.data,
            src.raster.width,
            src.raster.height,
            cellsX,
            cellsY,
            aspect,
            src.raster.aspect,
            src.contain,
          ),
    );
    maskDirty = false;
  };

  const activeMask = () => maskGrids[logoMarkIndex(params.mark)] ?? maskGrids[0];

  const sampleMask = (grid: MaskGrid, cellX: number, cellY: number, scrollCells: number) => {
    const mx = wrapIndex(cellX + Math.floor(scrollCells), grid.periodX);
    const my = Math.min(grid.cellsY - 1, Math.max(0, cellY));
    return grid.data[my * grid.periodX + mx] ?? 0;
  };

  const syncFloorReflection = () => {
    const length = Math.max(0.2, params.reflectionLength);
    floorReflection.scale.set(1, length, 1);
    floorReflection.position.set(0, -params.height + 0.01, length * 0.5);
    floorReflection.visible = params.enabled && params.reflectionEnabled;
    floorReflectionMaterial.opacity =
      THREE.MathUtils.clamp(params.opacity, 0, 1) *
      THREE.MathUtils.clamp(params.reflectionOpacity, 0, 1);
  };

  const syncReflectionFadeMap = () => {
    if (Math.abs(params.reflectionFade - lastFade) < 0.001) return;
    lastFade = params.reflectionFade;
    fadeAlphaMap.dispose();
    fadeAlphaMap = createFloorFadeAlphaMap(params.reflectionFade);
    floorReflectionMaterial.alphaMap = fadeAlphaMap;
    floorReflectionMaterial.needsUpdate = true;
  };

  /** Per-dot motion from the active effect mode. */
  const sampleEffect = (
    mode: number,
    u: number,
    v: number,
    cellX: number,
    cellY: number,
    logo: number,
    strength: number,
    pulseWave: number,
    wavePhase: number,
  ) => {
    const s = strength;
    let sizeMod = 0;
    let brightMod = 0;

    switch (mode) {
      case 0: {
        // Idle — soft logo breathe only.
        sizeMod = logo * params.pulse * pulseWave * 0.35 * s;
        brightMod = logo * params.pulse * pulseWave * 0.2 * s;
        break;
      }
      case 2: {
        // Scan — horizontal band sweeping vertically.
        const band = ((elapsed * params.waveSpeed * 0.35) % 1.4) - 0.2;
        const dist = Math.abs(v - band);
        const scan = Math.max(0, 1 - dist / 0.09) * s;
        sizeMod = scan * (0.55 + 0.45 * logo) * (0.4 + params.wave);
        brightMod = scan * (0.7 + 0.5 * logo);
        break;
      }
      case 3: {
        // Rain — staggered columns falling top→bottom.
        const colPhase = hash21(cellX, 0.37, 0) * 0.85;
        const fall = (1 - v + elapsed * params.waveSpeed * 0.55 + colPhase) % 1;
        const drop = Math.max(0, 1 - Math.abs(fall - 0.12) / 0.1) * s;
        sizeMod = drop * (0.35 + 0.65 * logo) * (0.5 + params.wave * 0.5);
        brightMod = drop * (0.55 + 0.6 * logo);
        break;
      }
      case 4: {
        // Sparkle — twinkling cells (logo-biased).
        const tw = hash21(cellX, cellY, Math.floor(elapsed * (3 + params.waveSpeed * 2)));
        const spark = tw > 0.82 - logo * 0.25 ? (tw - 0.7) * 3.2 * s : 0;
        sizeMod = spark * (0.4 + 0.8 * logo);
        brightMod = spark * (0.8 + 0.6 * logo);
        break;
      }
      case 5: {
        // Breathe — whole field swells together.
        const breath = pulseWave * s;
        sizeMod = breath * (0.25 + 0.55 * logo) * (0.5 + params.pulse * 0.5);
        brightMod = breath * (0.15 + 0.45 * logo);
        break;
      }
      case 6: {
        // Shock loop — radial wave under auto flashes (flash handled in update).
        const dCenter = Math.hypot(u - 0.5, v - 0.5);
        sizeMod =
          Math.sin(dCenter * 18 - wavePhase) * params.wave * 0.35 * s;
        brightMod = logo * params.pulse * pulseWave * 0.25 * s;
        break;
      }
      case 7: {
        // Reveal loop — wipe driven by animated reveal (see effectiveReveal).
        sizeMod = logo * params.pulse * pulseWave * 0.4 * s;
        brightMod = logo * 0.2 * s;
        break;
      }
      case 1:
      default: {
        // Wave — classic radial ripple.
        const dCenter = Math.hypot(u - 0.5, v - 0.5);
        sizeMod =
          Math.sin(dCenter * 22 - wavePhase) * params.wave * 0.55 * s;
        brightMod = logo * params.pulse * pulseWave * 0.15 * s;
        break;
      }
    }

    return { sizeMod, brightMod };
  };

  const effectiveReveal = () => {
    const mode = Math.round(params.effectMode);
    if (mode === 7) {
      // Ping-pong wipe 0→1→0.
      const cycle = (elapsed * Math.max(0.15, params.waveSpeed * 0.22)) % 2;
      const t = cycle < 1 ? cycle : 2 - cycle;
      return THREE.MathUtils.clamp(t, 0, 1) * THREE.MathUtils.clamp(params.reveal, 0, 1);
    }
    return THREE.MathUtils.clamp(params.reveal, 0, 1);
  };

  const paintFrame = () => {
    if (maskDirty) rebuildMask();

    const aspect = params.width / Math.max(0.001, params.heightWorld);
    const nextH = Math.max(256, Math.round(paintW * (1 / aspect)));
    if (paint.height !== nextH) {
      paint.height = nextH;
      paintH = nextH;
      maskDirty = true;
      rebuildMask();
    }

    const [pr, pg, pb] = parseRgb(params.panelColor);
    const [br, bg, bb] = parseRgb(params.baseColor);
    const [ar, ag, ab] = parseRgb(params.activeColor);
    const glowAmt = THREE.MathUtils.clamp(params.glow, 0, 2);
    const mode = Math.round(THREE.MathUtils.clamp(params.effectMode, 0, 7));
    const strength = THREE.MathUtils.clamp(params.effectStrength, 0, 2);

    ctx.fillStyle = `rgb(${pr},${pg},${pb})`;
    ctx.fillRect(0, 0, paint.width, paint.height);

    const cellW = paint.width / cellsX;
    const cellH = paint.height / cellsY;
    const baseR =
      Math.min(cellW, cellH) * 0.5 * THREE.MathUtils.clamp(params.dotSize, 0.1, 0.9);
    const pulseWave = 0.5 + 0.5 * Math.sin(elapsed * params.pulseHz * Math.PI * 2);
    const wavePhase = elapsed * params.waveSpeed * Math.PI * 2;
    const reveal = effectiveReveal();
    const maskGrid = activeMask();
    const markId = logoMarkIndex(params.mark);
    const scrollCells =
      markId === 2
        ? elapsed * Math.max(0, params.marqueeSpeed) * cellsX
        : 0;

    // Pass 1 — soft halos under logo / hot dots (feeds bloom + additive layer).
    if (glowAmt > 0.01) {
      for (let y = 0; y < cellsY; y++) {
        for (let x = 0; x < cellsX; x++) {
          const u = (x + 0.5) / cellsX;
          const v = (y + 0.5) / cellsY;
          const mask = sampleMask(maskGrid, x, y, scrollCells);
          const wipe = THREE.MathUtils.smoothstep(reveal, u - 0.12, u + 0.04);
          const logo = mask * wipe;
          if (logo < 0.08 && mode !== 2 && mode !== 3 && mode !== 4) continue;

          const dCenter = Math.hypot(u - 0.5, v - 0.5);
          const shock =
            flashEnergy * Math.exp(-Math.abs(dCenter - flashRadius) * 14);
          const { sizeMod, brightMod } = sampleEffect(
            mode,
            u,
            v,
            x,
            y,
            logo,
            strength,
            pulseWave,
            wavePhase,
          );
          const pulseBoost = logo * params.pulse * pulseWave;
          const hot = Math.min(
            1,
            logo + shock * 0.5 + pulseBoost * 0.25 + brightMod,
          );
          if (hot < 0.08) continue;

          const cx = (x + 0.5) * cellW;
          const cy = (1 - v) * paint.height;
          const haloR =
            baseR * (2.8 + glowAmt * 2.2 + pulseBoost * 1.4 + Math.max(0, sizeMod) * 1.2);

          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
          const a0 = 0.55 * glowAmt * hot;
          const a1 = 0.18 * glowAmt * hot;
          g.addColorStop(0, `rgba(${ar},${ag},${ab},${a0})`);
          g.addColorStop(0.35, `rgba(${ar},${ag},${ab},${a1})`);
          g.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Pass 2 — hard dots.
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const u = (x + 0.5) / cellsX;
        const v = (y + 0.5) / cellsY;
        const mask = sampleMask(maskGrid, x, y, scrollCells);
        const wipe = THREE.MathUtils.smoothstep(reveal, u - 0.12, u + 0.04);
        const logo = mask * wipe;

        const dCenter = Math.hypot(u - 0.5, v - 0.5);
        const shock =
          flashEnergy * Math.exp(-Math.abs(dCenter - flashRadius) * 14);
        const { sizeMod, brightMod } = sampleEffect(
          mode,
          u,
          v,
          x,
          y,
          logo,
          strength,
          pulseWave,
          wavePhase,
        );
        const pulseBoost = logo * params.pulse * pulseWave;

        const radius =
          baseR * (1 + sizeMod + shock * 0.95 + pulseBoost * 0.55);

        const t = Math.min(
          1,
          logo * 0.95 + shock * 0.85 + pulseBoost * 0.35 + brightMod,
        );
        let cr = br + (ar - br) * t;
        let cg = bg + (ag - bg) * t;
        let cb = bb + (ab - bb) * t;
        const field =
          0.65 + 1.25 * logo + shock * 0.6 + glowAmt * logo * 0.35 + brightMod * 0.8;
        cr = Math.min(255, cr * field + ar * logo * (0.45 + glowAmt * 0.35));
        cg = Math.min(255, cg * field + ag * logo * (0.45 + glowAmt * 0.35));
        cb = Math.min(255, cb * field + ab * logo * (0.45 + glowAmt * 0.35));

        const cx = (x + 0.5) * cellW;
        const cy = (1 - v) * paint.height;

        ctx.beginPath();
        ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
        ctx.arc(cx, cy, Math.max(0.6, radius), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    map.needsUpdate = true;
    floorMap.needsUpdate = true;
  };

  const applyParams = () => {
    const scale = Number.isFinite(params.scale) ? Math.max(0.05, params.scale) : 1;
    group.visible = params.enabled;
    group.scale.setScalar(scale);
    group.position.set(0, params.height, -params.distance);
    material.opacity = THREE.MathUtils.clamp(params.opacity, 0, 1);
    material.visible = params.enabled;

    const glowAmt = THREE.MathUtils.clamp(params.glow, 0, 2);
    glowMesh.visible = params.enabled && glowAmt > 0.02;
    glowMaterial.opacity = THREE.MathUtils.clamp(0.25 + glowAmt * 0.45, 0, 0.95) *
      THREE.MathUtils.clamp(params.opacity, 0, 1);
    glowMaterial.color.setRGB(1.2 + glowAmt * 0.25, 1.2 + glowAmt * 0.25, 1.3 + glowAmt * 0.2);

    if (params.width !== lastWidth || params.heightWorld !== lastHeightWorld) {
      lastWidth = params.width;
      lastHeightWorld = params.heightWorld;
      mesh.geometry.dispose();
      mesh.geometry = new THREE.PlaneGeometry(params.width, params.heightWorld);
      glowMesh.geometry = mesh.geometry;
      floorReflection.geometry.dispose();
      floorReflection.geometry = new THREE.PlaneGeometry(params.width, 1);
      maskDirty = true;
    }

    const aspect = params.width / Math.max(0.001, params.heightWorld);
    const nextX = Math.max(8, Math.round(params.density));
    const nextY = Math.max(8, Math.round(params.density / aspect));
    if (nextX !== cellsX || nextY !== cellsY) maskDirty = true;

    syncReflectionFadeMap();
    syncFloorReflection();
    paintFrame();
  };

  const applyPreset = (preset: DotGridPreset) => {
    if (preset === 'idle') {
      Object.assign(params, {
        enabled: true,
        opacity: 1,
        reveal: 1,
        effectMode: 0,
        effectStrength: 1,
        pulse: 0.45,
        pulseHz: 0.45,
        wave: 0.1,
        waveSpeed: 0.7,
        glow: 0.75,
        flash: 0,
      });
    } else if (preset === 'pulse') {
      Object.assign(params, {
        enabled: true,
        opacity: 1,
        reveal: 1,
        effectMode: 5,
        effectStrength: 1.15,
        pulse: 1.05,
        pulseHz: 1.1,
        wave: 0.25,
        waveSpeed: 1.2,
        glow: 1.35,
        flash: 0,
      });
    } else {
      Object.assign(params, {
        enabled: true,
        opacity: 1,
        reveal: 1,
        effectMode: 6,
        effectStrength: 1.2,
        pulse: 0.7,
        pulseHz: 0.9,
        wave: 0.65,
        waveSpeed: 1.8,
        glow: 1.5,
      });
      flashEnergy = 1.35;
      flashRadius = 0;
      params.flash = flashEnergy;
    }
    applyParams();
  };

  const triggerFlash = (peak = 1.25) => {
    flashEnergy = Math.max(flashEnergy, peak);
    flashRadius = 0;
    params.flash = flashEnergy;
  };

  let accum = 0;
  let shockTimer = 0;
  const update = (dt: number, t: number) => {
    if (!params.enabled) return;
    elapsed = t;

    const mode = Math.round(params.effectMode);
    if (mode === 6) {
      // Auto shockwave on a tempo tied to waveSpeed.
      const interval = Math.max(0.45, 2.2 / Math.max(0.2, params.waveSpeed));
      shockTimer += dt;
      if (shockTimer >= interval) {
        shockTimer = 0;
        triggerFlash(0.9 + 0.45 * THREE.MathUtils.clamp(params.effectStrength, 0, 2));
      }
    } else {
      shockTimer = 0;
    }

    if (flashEnergy > 0.001) {
      flashEnergy = Math.max(0, flashEnergy - dt * params.flashDecay);
      flashRadius = Math.min(1.4, flashRadius + dt * 1.55);
    } else {
      flashEnergy = 0;
    }
    params.flash = flashEnergy;

    accum += dt;
    const marquee = logoMarkIndex(params.mark) === 2 && params.marqueeSpeed > 0.001;
    if (accum >= 1 / 30 || flashEnergy > 0.01 || mode === 7 || marquee) {
      accum = 0;
      paintFrame();
    }
  };

  const getWorldCenter = (out = new THREE.Vector3()) => {
    out.set(0, params.height, -params.distance);
    return out;
  };

  applyParams();

  return {
    group,
    params,
    applyParams,
    applyPreset,
    update,
    triggerFlash,
    getWorldCenter,
    setVisible: (visible: boolean) => {
      params.enabled = visible;
      applyParams();
    },
  };
}
