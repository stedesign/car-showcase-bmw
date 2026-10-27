/**
 * Title fonts for master text.
 * Built-ins are system / already-loaded faces. Uploaded team fonts are
 * registered with the FontFace API and stored on the project so export,
 * import, and autosave keep them.
 */

export type ProjectFont = {
  id: string;
  /** Label shown in the font menu. */
  name: string;
  /** CSS font-family registered for this file. Unique per upload. */
  family: string;
  /**
   * data: URL of the font file.
   * Empty while the project sits in undo history — bytes live in `sources`.
   */
  source: string;
};

export const DEFAULT_FONT_ID = 'helvetica';

export const BUILTIN_FONTS = [
  {
    id: 'helvetica',
    label: 'Helvetica Neue',
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    id: 'ibm-plex',
    label: 'IBM Plex Sans',
    stack: '"IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  { id: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  {
    id: 'arial-black',
    label: 'Arial Black',
    stack: '"Arial Black", Impact, Arial, sans-serif',
  },
  { id: 'impact', label: 'Impact', stack: 'Impact, "Arial Narrow", sans-serif' },
  { id: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'courier', label: 'Courier New', stack: '"Courier New", Courier, monospace' },
] as const;

const FONT_EXT = ['woff2', 'woff', 'ttf', 'otf'] as const;
/** Keep a team cut in localStorage without crowding out the rest of the project. */
const MAX_FONT_BYTES = 1.5 * 1024 * 1024;

const stacks = new Map<string, string>();
const sources = new Map<string, string>();
const faces = new Map<string, FontFace>();
const installed = new Set<string>();

let loadKey = '';
let loadChain: Promise<void> = Promise.resolve();

export function isBuiltinFontId(id: string): boolean {
  return BUILTIN_FONTS.some((font) => font.id === id);
}

export function syncFontRegistry(fonts: readonly ProjectFont[] | undefined): void {
  stacks.clear();
  for (const font of fonts ?? []) {
    if (!font.id || !font.family) continue;
    stacks.set(font.id, font.family);
    if (font.source) sources.set(font.id, font.source);
  }
}

export function resolveFontStack(fontId: string | undefined): string {
  if (fontId) {
    const family = stacks.get(fontId);
    if (family) return `"${family}", "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const builtin = BUILTIN_FONTS.find((font) => font.id === fontId);
    if (builtin) return builtin.stack;
  }
  return BUILTIN_FONTS[0].stack;
}

export function isCustomFont(fontId: string | undefined): boolean {
  return !!fontId && stacks.has(fontId);
}

export function rememberFontSource(id: string, source: string): void {
  if (id && source) sources.set(id, source);
}

export function storedFontSource(id: string): string {
  return sources.get(id) ?? '';
}

/** Load any uploaded faces, and warm Google faces so canvas metrics match the menu. */
export function kickProjectFonts(fonts: readonly ProjectFont[] | undefined): void {
  const list = fonts ?? [];
  syncFontRegistry(list);
  const key = list.map((font) => font.id).join('|');
  if (key === loadKey) return;
  loadKey = key;
  const pending = list.map((font) => ({
    ...font,
    source: font.source || sources.get(font.id) || '',
  }));
  loadChain = loadChain.then(async () => {
    await Promise.all(pending.map((font) => installFont(font).catch(() => undefined)));
    await Promise.all([
      document.fonts.load('700 64px "IBM Plex Sans"').catch(() => undefined),
      document.fonts.load('700 64px Inter').catch(() => undefined),
    ]);
  });
}

export function forgetFont(id: string): void {
  const face = faces.get(id);
  if (face) document.fonts.delete(face);
  faces.delete(id);
  installed.delete(id);
  sources.delete(id);
  stacks.delete(id);
  loadKey = '';
}

export async function installFont(font: ProjectFont): Promise<void> {
  const source = font.source || sources.get(font.id) || '';
  if (!source) return;
  rememberFontSource(font.id, source);
  stacks.set(font.id, font.family);
  if (installed.has(font.id)) return;
  const face = new FontFace(font.family, `url(${source})`, {
    style: 'normal',
    weight: '400',
  });
  const loaded = await face.load();
  document.fonts.add(loaded);
  faces.set(font.id, loaded);
  installed.add(font.id);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read that font file'));
    };
    reader.onerror = () => reject(new Error('Could not read that font file'));
    reader.readAsDataURL(file);
  });
}

function labelFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || 'Custom';
}

/** Read a .woff2 / .woff / .ttf / .otf and register it. Does not attach it to a project. */
export async function fontFromFile(file: File): Promise<ProjectFont> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!FONT_EXT.includes(ext as (typeof FONT_EXT)[number])) {
    throw new Error('Use a .woff2, .woff, .ttf, or .otf font');
  }
  if (file.size <= 0) throw new Error('That font file is empty');
  if (file.size > MAX_FONT_BYTES) {
    throw new Error('Font must be under 1.5 MB — a .woff2 cut is usually enough');
  }
  const source = await readDataUrl(file);
  const id = `font-${crypto.randomUUID()}`;
  const font: ProjectFont = {
    id,
    name: labelFromFilename(file.name),
    family: id,
    source,
  };
  try {
    await installFont(font);
  } catch {
    forgetFont(id);
    throw new Error('That file is not a usable font');
  }
  return font;
}
