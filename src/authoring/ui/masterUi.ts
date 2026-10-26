import {
  BUILTIN_FONTS,
  DEFAULT_FONT_ID,
  fontFromFile,
  forgetFont,
  isCustomFont,
  resolveFontStack,
  syncFontRegistry,
} from '../fonts';
import { snapMasterTextAxis } from '../masterTextOverlay';
import {
  addMasterClip,
  addMasterText,
  duplicateMasterText,
  clipDuration,
  compactMasterTextLanes,
  getSceneById,
  masterDuration,
  normalizeMasterClip,
  type MasterClip,
  TEXT_SIZE_MIN,
  clampMarqueeSpeed,
  clampTextOpacity,
  clampTextSize,
  textSizeMax,
  type MasterTextAlign,
  type MasterTextAnchor,
  type MasterTextClip,
  type MasterTextEffect,
  type Project,
} from '../project';
import { mountTextPlacement, type TextPlacementHandle } from './textPlacement';

const PX_PER_SEC = 48;
const MIN_CLIP_SEC = 0.05;
/** Matches `.ed-master-textrow` height. */
const TEXT_ROW_H = 36;

export type MasterUiApi = {
  getProject: () => Project;
  getTime: () => number;
  getPlaying: () => boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  onChange: () => void;
  setStatus: (msg: string) => void;
  viewport: HTMLElement;
  getCanvas: () => HTMLCanvasElement;
  isPlacementHidden: () => boolean;
};

export type MasterUiHandle = {
  refresh: () => void;
  updatePlayhead: () => void;
  dispose: () => void;
};

export function mountMasterUi(host: HTMLElement, api: MasterUiApi): MasterUiHandle {
  host.replaceChildren();

  const root = document.createElement('div');
  root.className = 'ed-master';

  const toolbar = document.createElement('div');
  toolbar.className = 'ed-tl-toolbar';

  const playBtn = document.createElement('button');
  playBtn.className = 'ed-btn primary';
  playBtn.type = 'button';
  playBtn.textContent = 'Play';
  playBtn.addEventListener('click', () => {
    if (api.getPlaying()) api.onPause();
    else api.onPlay();
    refresh();
  });

  const stopBtn = document.createElement('button');
  stopBtn.className = 'ed-btn';
  stopBtn.type = 'button';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => {
    api.onStop();
    refresh();
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'ed-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Clip';
  addBtn.title = 'Add a scene to the master sequence';
  addBtn.addEventListener('click', () => {
    const project = api.getProject();
    if (!project.scenes.length) return;
    const names = project.scenes.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    const pick = window.prompt(`Add scene to master:\n${names}\n\nEnter number:`, '1');
    if (!pick) return;
    const idx = Number.parseInt(pick, 10) - 1;
    const scene = project.scenes[idx];
    if (!scene) {
      api.setStatus('Invalid scene number');
      return;
    }
    addMasterClip(project, scene.id);
    api.onChange();
    api.setStatus(`Added “${scene.name}” to master`);
    refresh();
  });

  const durLabel = document.createElement('span');
  durLabel.className = 'ed-master-dur';

  const timeLabel = document.createElement('span');
  timeLabel.className = 'ed-master-time';

  const addTextBtn = document.createElement('button');
  addTextBtn.className = 'ed-btn';
  addTextBtn.type = 'button';
  addTextBtn.textContent = '+ Text';
  addTextBtn.title = 'Add a title on its own row at the playhead';
  addTextBtn.addEventListener('click', () => addTextClip('Title'));

  const duplicateTextBtn = document.createElement('button');
  duplicateTextBtn.className = 'ed-btn';
  duplicateTextBtn.type = 'button';
  duplicateTextBtn.textContent = 'Duplicate';
  duplicateTextBtn.title = 'Copy the selected title onto the row below (⌘D)';
  duplicateTextBtn.disabled = true;
  duplicateTextBtn.addEventListener('click', () => duplicateSelectedText());

  toolbar.append(playBtn, stopBtn, addBtn, addTextBtn, duplicateTextBtn, durLabel, timeLabel);

  const form = document.createElement('div');
  form.className = 'ed-master-text-form';
  form.hidden = true;

  const effectSelect = document.createElement('select');
  const effectOptions: { value: MasterTextEffect; label: string }[] = [
    { value: 'maskedHeading', label: 'Masked heading' },
    { value: 'blurReveal', label: 'Blur reveal' },
    { value: 'fade', label: 'Fade' },
    { value: 'marquee', label: 'Marquee' },
  ];
  for (const opt of effectOptions) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    effectSelect.append(el);
  }
  effectSelect.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.effect = effectSelect.value as MasterTextEffect;
    clip.size = clampTextSize(clip.effect, clip.size);
    sizeInput.max = String(textSizeMax(clip.effect));
    sizeInput.step = clip.effect === 'marquee' ? '0.01' : '0.005';
    sizeInput.value = String(clip.size);
    speedField.hidden = clip.effect !== 'marquee';
    api.onChange();
    if (clip.effect === 'marquee') {
      api.setStatus('Marquee slides across the frame. Raise Size for the giant line.');
    }
  });

  const anchorSelect = document.createElement('select');
  for (const value of ['top', 'center', 'bottom'] as MasterTextAnchor[]) {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = value;
    anchorSelect.append(el);
  }
  anchorSelect.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.anchor = anchorSelect.value as MasterTextAnchor;
    const canvas = api.getCanvas();
    snapMasterTextAxis(clip, 'y', canvas.width, canvas.height);
    api.onChange();
  });

  const alignSelect = document.createElement('select');
  for (const value of ['left', 'center', 'right'] as MasterTextAlign[]) {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = value;
    alignSelect.append(el);
  }
  alignSelect.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.align = alignSelect.value as MasterTextAlign;
    const canvas = api.getCanvas();
    snapMasterTextAxis(clip, 'x', canvas.width, canvas.height);
    api.onChange();
  });

  const fontSelect = document.createElement('select');
  fontSelect.title = 'Typeface for this title';
  fontSelect.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.font = fontSelect.value || DEFAULT_FONT_ID;
    fontSelect.style.fontFamily = resolveFontStack(clip.font);
    removeFontBtn.hidden = !isCustomFont(clip.font);
    api.onChange();
  });

  const fontFile = document.createElement('input');
  fontFile.type = 'file';
  fontFile.accept = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';
  fontFile.hidden = true;

  const uploadFontBtn = document.createElement('button');
  uploadFontBtn.type = 'button';
  uploadFontBtn.className = 'ed-btn';
  uploadFontBtn.textContent = 'Upload';
  uploadFontBtn.title = 'Upload a .woff2, .woff, .ttf, or .otf — including the WRT team font';
  uploadFontBtn.addEventListener('click', () => fontFile.click());

  const removeFontBtn = document.createElement('button');
  removeFontBtn.type = 'button';
  removeFontBtn.className = 'ed-btn';
  removeFontBtn.textContent = 'Remove';
  removeFontBtn.title = 'Remove this uploaded font from the project';
  removeFontBtn.hidden = true;
  removeFontBtn.addEventListener('click', () => {
    const clip = selectedText();
    if (!clip || !isCustomFont(clip.font)) return;
    const project = api.getProject();
    const fonts = project.fonts ?? [];
    const font = fonts.find((item) => item.id === clip.font);
    const id = clip.font;
    project.fonts = fonts.filter((item) => item.id !== id);
    for (const text of project.master.texts) {
      if (text.font === id) text.font = DEFAULT_FONT_ID;
    }
    forgetFont(id);
    syncFontRegistry(project.fonts);
    api.onChange();
    api.setStatus(font ? `Removed “${font.name}”` : 'Removed font');
    refresh();
  });

  fontFile.addEventListener('change', () => {
    const file = fontFile.files?.[0];
    fontFile.value = '';
    if (!file) return;
    const clip = selectedText();
    if (!clip) return;
    uploadFontBtn.disabled = true;
    api.setStatus(`Loading “${file.name}”…`);
    void fontFromFile(file)
      .then((font) => {
        const project = api.getProject();
        project.fonts = [...(project.fonts ?? []), font];
        syncFontRegistry(project.fonts);
        const current = selectedText();
        if (current) current.font = font.id;
        api.onChange();
        api.setStatus(`Using “${font.name}”`);
        refresh();
      })
      .catch((err: unknown) => {
        api.setStatus(err instanceof Error ? err.message : 'Could not load that font');
      })
      .finally(() => {
        uploadFontBtn.disabled = false;
      });
  });

  const fontRow = document.createElement('div');
  fontRow.className = 'ed-master-font-row';
  fontRow.append(fontSelect, uploadFontBtn, removeFontBtn, fontFile);

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.title = 'Title color. Fade and blur use it flat. Masked heading tints the moving fill.';
  colorInput.addEventListener('input', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.color = colorInput.value;
    api.onChange();
  });

  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '1';
  opacityInput.step = '0.01';
  opacityInput.title = 'How strongly this title sits on the picture';
  const opacityReadout = document.createElement('span');
  opacityReadout.className = 'ed-master-opacity-readout';
  const opacityRow = document.createElement('div');
  opacityRow.className = 'ed-master-opacity-row';
  opacityRow.append(opacityInput, opacityReadout);
  const showOpacity = (v: number) => {
    opacityReadout.textContent = `${Math.round(v * 100)}%`;
  };
  opacityInput.addEventListener('input', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.opacity = clampTextOpacity(Number.parseFloat(opacityInput.value));
    showOpacity(clip.opacity);
    api.onChange();
  });

  const speedInput = document.createElement('input');
  speedInput.type = 'number';
  speedInput.min = '-3';
  speedInput.max = '3';
  speedInput.step = '0.01';
  speedInput.title =
    'Frame widths per second. Positive slides left, negative slides right, 0 holds the line still.';
  speedInput.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    clip.speed = clampMarqueeSpeed(Number.parseFloat(speedInput.value));
    speedInput.value = clip.speed.toFixed(2);
    api.onChange();
  });

  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.min = String(TEXT_SIZE_MIN);
  sizeInput.max = '0.2';
  sizeInput.step = '0.005';
  sizeInput.title = 'Fraction of the frame height. Marquee can grow larger than the frame.';
  sizeInput.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    const v = Number.parseFloat(sizeInput.value);
    if (!Number.isFinite(v)) return;
    clip.size = clampTextSize(clip.effect, v);
    sizeInput.value = String(clip.size);
    api.onChange();
  });

  const startInput = document.createElement('input');
  startInput.type = 'number';
  startInput.min = '0';
  startInput.step = '0.05';
  startInput.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    const v = Number.parseFloat(startInput.value);
    if (!Number.isFinite(v)) return;
    placeText(clip, v, clip.duration);
    api.onChange();
    refresh();
  });

  const durInput = document.createElement('input');
  durInput.type = 'number';
  durInput.min = '0.25';
  durInput.step = '0.05';
  durInput.addEventListener('change', () => {
    const clip = selectedText();
    if (!clip) return;
    const v = Number.parseFloat(durInput.value);
    if (!Number.isFinite(v)) return;
    placeText(clip, clip.start, v);
    api.onChange();
    refresh();
  });

  const duplicateFormBtn = document.createElement('button');
  duplicateFormBtn.type = 'button';
  duplicateFormBtn.className = 'ed-btn';
  duplicateFormBtn.textContent = 'Duplicate';
  duplicateFormBtn.title = 'Copy this title onto the row below (⌘D)';
  duplicateFormBtn.addEventListener('click', () => duplicateSelectedText());

  const deleteTextBtn = document.createElement('button');
  deleteTextBtn.type = 'button';
  deleteTextBtn.className = 'ed-btn';
  deleteTextBtn.textContent = 'Delete';
  deleteTextBtn.addEventListener('click', () => {
    const clip = selectedText();
    if (!clip) return;
    const project = api.getProject();
    project.master.texts = project.master.texts.filter((t) => t.id !== clip.id);
    compactMasterTextLanes(project.master.texts);
    selectedTextId = null;
    api.onChange();
    api.setStatus('Removed title');
    refresh();
  });

  const field = (label: string, control: HTMLElement) => {
    const wrap = document.createElement('label');
    wrap.className = 'ed-master-text-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  };

  const speedField = field('Speed', speedInput);
  speedField.hidden = true;

  form.append(
    field('Font', fontRow),
    field('Color', colorInput),
    field('Effect', effectSelect),
    field('Opacity', opacityRow),
    speedField,
    field('Anchor', anchorSelect),
    field('Align', alignSelect),
    field('Size', sizeInput),
    field('Start', startInput),
    field('Duration', durInput),
    duplicateFormBtn,
    deleteTextBtn,
  );

  const scroll = document.createElement('div');
  scroll.className = 'ed-master-scroll';

  const lane = document.createElement('div');
  lane.className = 'ed-master-lane';

  const ruler = document.createElement('div');
  ruler.className = 'ed-tl-ruler';
  ruler.title = 'Drag to scrub';

  const textStack = document.createElement('div');
  textStack.className = 'ed-master-textstack';

  const track = document.createElement('div');
  track.className = 'ed-master-track';

  const playhead = document.createElement('div');
  playhead.className = 'ed-master-playhead';
  const playheadBadge = document.createElement('span');
  playheadBadge.className = 'ed-master-playhead-badge';
  playheadBadge.textContent = '0.00';
  playheadBadge.title = 'Drag to scrub';
  const playheadHit = document.createElement('div');
  playheadHit.className = 'ed-master-playhead-hit';
  playheadHit.title = 'Drag to scrub';
  playhead.append(playheadBadge, playheadHit);

  lane.append(ruler, textStack, track, playhead);
  scroll.append(lane);
  root.append(toolbar, form, scroll);
  host.append(root);

  let selectedClipId: string | null = null;
  let selectedTextId: string | null = null;
  let placement: TextPlacementHandle;
  let formClipId: string | null = null;
  let trimmingId: string | null = null;
  let trimmingEdge: 'in' | 'out' | null = null;
  /** Pixels before master t=0, so a trimmed head on the first clip stays visible. */
  let padPx = 0;

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };

  const moveClip = (clipId: string, dir: -1 | 1) => {
    const project = api.getProject();
    const clips = project.master.clips;
    const i = clips.findIndex((c) => c.id === clipId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= clips.length) return;
    const tmp = clips[i];
    clips[i] = clips[j];
    clips[j] = tmp;
    api.onChange();
    refresh();
  };

  const removeClip = (clipId: string) => {
    const project = api.getProject();
    if (project.master.clips.length <= 1) {
      api.setStatus('Master needs at least one clip');
      return;
    }
    project.master.clips = project.master.clips.filter((c) => c.id !== clipId);
    if (selectedClipId === clipId) selectedClipId = null;
    api.onChange();
    refresh();
  };

  const clipStartOf = (clipId: string) => {
    let cursor = 0;
    for (const clip of api.getProject().master.clips) {
      if (clip.id === clipId) return cursor;
      cursor += clipDuration(clip);
    }
    return 0;
  };

  const beginTrim = (e: PointerEvent, clip: MasterClip, which: 'in' | 'out') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const scene = getSceneById(api.getProject(), clip.sceneId);
    if (!scene) return;

    const startX = e.clientX;
    const origin = which === 'in' ? clip.in : clip.out;
    selectedClipId = clip.id;
    trimmingId = clip.id;
    trimmingEdge = which;
    // Pause rebuilds the clip row; the drag continues on window listeners.
    if (api.getPlaying()) api.onPause();

    let moved = false;
    const apply = (clientX: number) => {
      const dt = (clientX - startX) / PX_PER_SEC;
      if (which === 'in') clip.in = origin + dt;
      else clip.out = origin + dt;
      normalizeMasterClip(clip, scene);
      moved = Math.abs((which === 'in' ? clip.in : clip.out) - origin) > 1e-4;
      layoutTrack();
      const start = clipStartOf(clip.id);
      const dur = clipDuration(clip);
      // The out point is the first frame of the next clip, so step back onto this one.
      const t = which === 'in' ? start : Math.max(start, start + dur - MIN_CLIP_SEC);
      api.onSeek(t);
      api.setStatus(
        which === 'in'
          ? `In ${clip.in.toFixed(2)}s`
          : `Out ${clip.out.toFixed(2)}s`,
      );
    };

    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      trimmingId = null;
      trimmingEdge = null;
      if (!moved) {
        layoutTrack();
        return;
      }
      api.setStatus(`Trim ${clip.in.toFixed(2)}–${clip.out.toFixed(2)}s`);
      api.onChange();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const seekFromClientX = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    // track.getBoundingClientRect already moves with scroll — do not add scrollLeft
    const x = clientX - rect.left - padPx;
    const total = masterDuration(api.getProject());
    const t = Math.max(0, Math.min(total, x / PX_PER_SEC));
    api.onSeek(t);
    updatePlayhead();
  };

  const startScrub = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    playhead.classList.add('dragging');
    seekFromClientX(e.clientX);
    const move = (ev: PointerEvent) => seekFromClientX(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      playhead.classList.remove('dragging');
      refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  playheadBadge.addEventListener('pointerdown', startScrub);
  playheadHit.addEventListener('pointerdown', startScrub);
  ruler.addEventListener('pointerdown', startScrub);

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    // Buttons and trim handles own this gesture. Scrubbing stays on the ruler.
    if (el.closest('.ed-master-clip-actions, .ed-master-trim, .ed-master-qtrim')) return;

    const clipEl = el.closest('.ed-master-clip') as HTMLElement | null;
    if (clipEl?.dataset.clipId) {
      if (clipEl.dataset.clipId !== selectedClipId) {
        selectedClipId = clipEl.dataset.clipId;
        api.setStatus('Drag the yellow edges to trim this clip');
      }
    } else {
      selectedClipId = null;
    }
    layoutTrack();
  });

  const selectedText = (): MasterTextClip | null =>
    api.getProject().master.texts.find((t) => t.id === selectedTextId) ?? null;

  const duplicateSelectedText = () => {
    const source = selectedText();
    if (!source) return;
    const copy = duplicateMasterText(api.getProject(), source.id);
    if (!copy) return;
    selectedTextId = copy.id;
    api.onChange();
    api.setStatus(`Duplicated “${copy.name}” onto the row below`);
    refresh();
  };

  const placeText = (clip: MasterTextClip, start: number, duration: number) => {
    const total = masterDuration(api.getProject());
    const dur = Math.max(0.25, duration);
    const maxStart = Math.max(0, total - 0.25);
    clip.start = Math.min(Math.max(0, start), maxStart);
    clip.duration = Math.min(dur, Math.max(0.25, total - clip.start));
  };

  const addTextClip = (text: string, name?: string) => {
    const project = api.getProject();
    const total = masterDuration(project);
    if (total < 0.3) {
      api.setStatus('Add a scene clip before a title');
      return;
    }
    const start = Math.min(api.getTime(), Math.max(0, total - 0.25));
    const clip = addMasterText(project, { text, name, start, duration: 4 });
    selectedTextId = clip.id;
    const time = api.getTime();
    if (time < clip.start || time >= clip.start + clip.duration) {
      api.onSeek(clip.start);
    }
    api.onChange();
    api.setStatus('Type on the picture');
    refresh();
    placement.edit(clip.id);
  };

  const fillFontSelect = (selected: string | undefined) => {
    const project = api.getProject();
    const fonts = project.fonts ?? [];
    syncFontRegistry(fonts);
    fontSelect.replaceChildren();
    const addOption = (id: string, label: string) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      option.style.fontFamily = resolveFontStack(id);
      fontSelect.append(option);
    };
    for (const font of BUILTIN_FONTS) addOption(font.id, font.label);
    for (const font of fonts) addOption(font.id, font.name);
    const value = selected || DEFAULT_FONT_ID;
    fontSelect.value = value;
    if (fontSelect.value !== value) fontSelect.value = DEFAULT_FONT_ID;
    fontSelect.style.fontFamily = resolveFontStack(fontSelect.value);
    removeFontBtn.hidden = !isCustomFont(fontSelect.value);
  };

  const syncForm = () => {
    const clip = selectedText();
    form.hidden = !clip;
    if (!clip) {
      formClipId = null;
      return;
    }
    const changed = formClipId !== clip.id;
    formClipId = clip.id;
    fillFontSelect(clip.font);
    if (!changed && form.contains(document.activeElement)) return;
    colorInput.value = clip.color;
    effectSelect.value = clip.effect;
    anchorSelect.value = clip.anchor;
    alignSelect.value = clip.align;
    const opacity = clampTextOpacity(clip.opacity);
    clip.opacity = opacity;
    opacityInput.value = String(opacity);
    showOpacity(opacity);
    const speed = clampMarqueeSpeed(clip.speed);
    clip.speed = speed;
    speedInput.value = speed.toFixed(2);
    speedField.hidden = clip.effect !== 'marquee';
    sizeInput.max = String(textSizeMax(clip.effect));
    sizeInput.step = clip.effect === 'marquee' ? '0.01' : '0.005';
    sizeInput.value = String(clip.size);
    startInput.value = clip.start.toFixed(2);
    durInput.value = clip.duration.toFixed(2);
  };

  const beginTextDrag = (e: PointerEvent, clip: MasterTextClip, edge: 'move' | 'end') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const originStart = clip.start;
    const originDur = clip.duration;
    const originLane = clip.lane;
    const snapshot = api.getProject().master.texts.map((t) => ({ id: t.id, lane: t.lane }));
    selectedTextId = clip.id;
    syncForm();
    placement.sync();

    const rowFromY = (clientY: number) => {
      const rect = textStack.getBoundingClientRect();
      const count = Math.max(1, api.getProject().master.texts.length);
      return Math.max(0, Math.min(count - 1, Math.floor((clientY - rect.top) / TEXT_ROW_H)));
    };

    const reorderTo = (target: number) => {
      const texts = api.getProject().master.texts;
      for (const s of snapshot) {
        const t = texts.find((x) => x.id === s.id);
        if (t) t.lane = s.lane;
      }
      const order = [...texts].sort((a, b) => a.lane - b.lane);
      const from = order.findIndex((t) => t.id === clip.id);
      const to = Math.max(0, Math.min(order.length - 1, target));
      if (from < 0 || from === to) return;
      const [item] = order.splice(from, 1);
      order.splice(to, 0, item);
      order.forEach((t, i) => {
        t.lane = i;
      });
    };

    const apply = (clientX: number, clientY: number) => {
      const dt = (clientX - startX) / PX_PER_SEC;
      const timeMoved = Math.abs(dt) >= 0.02;
      if (timeMoved) {
        if (edge === 'move') placeText(clip, originStart + dt, originDur);
        else placeText(clip, originStart, originDur + dt);
      }
      if (edge === 'move') reorderTo(rowFromY(clientY));
      layoutTrack();
    };

    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const changed =
        clip.start !== originStart || clip.duration !== originDur || clip.lane !== originLane;
      if (!changed) {
        layoutTrack();
        return;
      }
      api.setStatus(`${clip.name}  ${clip.start.toFixed(2)}–${(clip.start + clip.duration).toFixed(2)}s`);
      api.onChange();
      syncForm();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  textStack.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest('.ed-master-text-pill')) return;
    selectedTextId = null;
    syncForm();
    layoutTrack();
  });

  const refresh = () => {
    const project = api.getProject();
    playBtn.textContent = api.getPlaying() ? 'Pause' : 'Play';

    track.replaceChildren();

    textStack.replaceChildren();
    if (!project.master.texts.some((t) => t.id === selectedTextId)) selectedTextId = null;

    const laneCount = Math.max(1, ...project.master.texts.map((t) => t.lane + 1));
    const rows: HTMLElement[] = [];
    for (let i = 0; i < laneCount; i += 1) {
      const row = document.createElement('div');
      row.className = 'ed-master-textrow';
      row.dataset.lane = String(i);
      const mark = document.createElement('div');
      mark.className = 'ed-master-textrow-mark';
      mark.textContent = 'T';
      mark.title = 'Text';
      row.append(mark);
      textStack.append(row);
      rows.push(row);
    }

    for (const clip of project.master.texts) {
      const pill = document.createElement('div');
      pill.className = 'ed-master-text-pill';
      pill.dataset.textId = clip.id;
      pill.title = 'Drag sideways to move in time, up or down to change row. Drag the right edge to change duration.';

      const label = document.createElement('div');
      label.className = 'ed-master-text-pill-label';
      label.textContent = clip.name || clip.text.split('\n')[0] || 'Title';

      const edge = document.createElement('div');
      edge.className = 'ed-master-text-pill-edge';
      edge.title = 'Drag to change duration';
      edge.addEventListener('pointerdown', (ev) => beginTextDrag(ev, clip, 'end'));

      pill.addEventListener('pointerdown', (ev) => {
        if ((ev.target as HTMLElement).closest('.ed-master-text-pill-edge')) return;
        beginTextDrag(ev, clip, 'move');
      });

      pill.append(label, edge);
      (rows[clip.lane] ?? rows[0]).append(pill);
    }

    for (const clip of project.master.clips) {
      const scene = getSceneById(project, clip.sceneId);
      const el = document.createElement('div');
      el.className = 'ed-master-clip';
      el.dataset.clipId = clip.id;

      const label = document.createElement('div');
      label.className = 'ed-master-clip-label';
      label.textContent = scene?.name ?? '?';

      const meta = document.createElement('div');
      meta.className = 'ed-master-clip-meta';

      const actions = document.createElement('div');
      actions.className = 'ed-master-clip-actions';

      const mk = (text: string, title: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ed-btn';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };

      actions.append(
        mk('◀', 'Move earlier', () => moveClip(clip.id, -1)),
        mk('▶', 'Move later', () => moveClip(clip.id, 1)),
        mk('×', 'Remove clip', () => removeClip(clip.id)),
      );

      el.append(label, meta, actions);
      el.title = 'Click to trim';
      track.append(el);
    }

    const qtrim = document.createElement('div');
    qtrim.className = 'ed-master-qtrim';
    qtrim.hidden = true;

    const shadeLeft = document.createElement('div');
    shadeLeft.className = 'ed-master-qtrim-shade left';
    const shadeRight = document.createElement('div');
    shadeRight.className = 'ed-master-qtrim-shade right';
    const frame = document.createElement('div');
    frame.className = 'ed-master-qtrim-frame';
    const qlabel = document.createElement('div');
    qlabel.className = 'ed-master-qtrim-label';

    const trimHandle = (which: 'in' | 'out') => {
      const h = document.createElement('div');
      h.className = `ed-master-trim ${which === 'in' ? 'left' : 'right'}`;
      h.title = which === 'in' ? 'Drag to trim the start' : 'Drag to trim the end';
      h.setAttribute('role', 'slider');
      h.setAttribute('aria-label', which === 'in' ? 'Trim start' : 'Trim end');
      h.setAttribute('aria-valuemin', '0');
      h.addEventListener('pointerdown', (ev) => {
        const current = api.getProject().master.clips.find((c) => c.id === selectedClipId);
        if (!current) return;
        beginTrim(ev, current, which);
      });
      return h;
    };

    frame.append(qlabel, trimHandle('in'), trimHandle('out'));
    qtrim.append(shadeLeft, shadeRight, frame);
    track.append(qtrim);

    layoutTrack();
  };

  const renderRuler = (total: number, width: number, pad: number) => {
    ruler.style.width = `${width}px`;
    const steps = Math.max(0, Math.ceil(total * 10));
    const key = `${steps}:${total.toFixed(2)}:${pad.toFixed(1)}`;
    if (ruler.dataset.steps === key && ruler.childElementCount > 0) return;
    ruler.dataset.steps = key;
    ruler.replaceChildren();
    for (let i = 0; i <= steps; i += 1) {
      const t = i / 10;
      if (t > total + 1e-6) break;
      const tick = document.createElement('span');
      const major = i % 10 === 0;
      tick.className = major ? 'ed-tl-tick ed-tl-tick-major' : 'ed-tl-tick ed-tl-tick-minor';
      tick.style.left = `${pad + t * PX_PER_SEC}px`;
      if (major) tick.textContent = `${Math.round(t)}s`;
      ruler.append(tick);
    }
  };

  const layoutTrack = () => {
    const project = api.getProject();
    const total = masterDuration(project);
    durLabel.textContent = `Master ${formatTime(total)}`;
    duplicateTextBtn.disabled = selectedText() == null;

    const selected = project.master.clips.find((c) => c.id === selectedClipId) ?? null;
    const selectedScene = selected ? getSceneById(project, selected.sceneId) : null;
    if (selected && !selectedScene) selectedClipId = null;

    let selectedStart = 0;
    if (selected) {
      for (const clip of project.master.clips) {
        if (clip.id === selected.id) break;
        selectedStart += clipDuration(clip);
      }
    }
    const mediaDur = selectedScene ? Math.max(0.5, selectedScene.duration) : 0;
    padPx =
      selected && selectedScene ? Math.max(0, selected.in - selectedStart) * PX_PER_SEC : 0;

    let filmRight = padPx + total * PX_PER_SEC;
    if (selected && mediaDur > 0) {
      const filmLeft = padPx + (selectedStart - selected.in) * PX_PER_SEC;
      filmRight = Math.max(filmRight, filmLeft + mediaDur * PX_PER_SEC);
    }
    const width = Math.max(filmRight + 40, scroll.clientWidth);
    lane.style.width = `${width}px`;
    track.style.width = `${width}px`;
    textStack.style.width = `${width}px`;
    textStack.querySelectorAll<HTMLElement>('.ed-master-textrow').forEach((row) => {
      row.style.width = `${width}px`;
    });
    track.classList.toggle('trimming-open', Boolean(selected && selectedScene));
    renderRuler(total, width, padPx);

    const pills = textStack.querySelectorAll<HTMLElement>('.ed-master-text-pill');
    pills.forEach((el) => {
      const clip = project.master.texts.find((t) => t.id === el.dataset.textId);
      if (!clip) return;
      const row = textStack.querySelector<HTMLElement>(`[data-lane="${clip.lane}"]`);
      if (row && el.parentElement !== row) row.append(el);
      const selectedHere = selectedTextId === clip.id;
      el.style.left = `${padPx + clip.start * PX_PER_SEC}px`;
      el.style.width = `${Math.max(clip.duration * PX_PER_SEC, 36)}px`;
      el.classList.toggle('selected', selectedHere);
      const label = el.querySelector('.ed-master-text-pill-label');
      if (label) label.textContent = clip.name || clip.text.split('\n')[0] || 'Title';
    });

    const nodes = track.querySelectorAll<HTMLElement>('.ed-master-clip');
    let cursor = 0;
    nodes.forEach((el, i) => {
      const clip = project.master.clips[i];
      if (!clip) return;
      const scene = getSceneById(project, clip.sceneId);
      const dur = clipDuration(clip);
      const trimming = trimmingId === clip.id;
      const selectedHere = selectedClipId === clip.id;
      el.style.left = `${padPx + cursor * PX_PER_SEC}px`;
      el.style.width = `${Math.max(dur * PX_PER_SEC, 4)}px`;
      el.classList.toggle('selected', selectedHere);
      el.classList.toggle('trimming', trimming);
      el.title = selectedHere
        ? `${scene?.name ?? 'Missing'}  ${clip.in.toFixed(2)}–${clip.out.toFixed(2)}s`
        : 'Click to trim';
      const meta = el.querySelector('.ed-master-clip-meta');
      if (meta) {
        meta.textContent =
          trimming && trimmingEdge
            ? `${trimmingEdge === 'in' ? 'In' : 'Out'} ${(trimmingEdge === 'in' ? clip.in : clip.out).toFixed(2)}s`
            : `${dur.toFixed(1)}s`;
      }
      cursor += dur;
    });

    const qtrim = track.querySelector<HTMLElement>('.ed-master-qtrim');
    if (qtrim && selected && selectedScene) {
      const filmLeft = padPx + (selectedStart - selected.in) * PX_PER_SEC;
      qtrim.hidden = false;
      qtrim.style.left = `${filmLeft}px`;
      qtrim.style.width = `${mediaDur * PX_PER_SEC}px`;
      const shadeLeft = qtrim.querySelector<HTMLElement>('.ed-master-qtrim-shade.left');
      const shadeRight = qtrim.querySelector<HTMLElement>('.ed-master-qtrim-shade.right');
      const frame = qtrim.querySelector<HTMLElement>('.ed-master-qtrim-frame');
      const qlabel = qtrim.querySelector('.ed-master-qtrim-label');
      if (shadeLeft) shadeLeft.style.width = `${selected.in * PX_PER_SEC}px`;
      if (shadeRight) {
        shadeRight.style.left = `${selected.out * PX_PER_SEC}px`;
        shadeRight.style.width = `${Math.max(0, mediaDur - selected.out) * PX_PER_SEC}px`;
      }
      if (frame) {
        frame.style.left = `${selected.in * PX_PER_SEC}px`;
        frame.style.width = `${Math.max(clipDuration(selected) * PX_PER_SEC, 4)}px`;
      }
      if (qlabel) {
        const range = `${selected.in.toFixed(1)}–${selected.out.toFixed(1)}s`;
        const wide = clipDuration(selected) * PX_PER_SEC > 200;
        qlabel.textContent =
          trimmingId === selected.id && trimmingEdge
            ? `${trimmingEdge === 'in' ? 'In' : 'Out'} ${(trimmingEdge === 'in' ? selected.in : selected.out).toFixed(2)}s`
            : wide
              ? `${selectedScene.name}  ${range}`
              : range;
      }
      const leftHandle = qtrim.querySelector('.ed-master-trim.left');
      const rightHandle = qtrim.querySelector('.ed-master-trim.right');
      leftHandle?.classList.toggle('active', trimmingId === selected.id && trimmingEdge === 'in');
      rightHandle?.classList.toggle('active', trimmingId === selected.id && trimmingEdge === 'out');
      leftHandle?.setAttribute('aria-valuenow', selected.in.toFixed(2));
      rightHandle?.setAttribute('aria-valuenow', selected.out.toFixed(2));
      leftHandle?.setAttribute('aria-valuemax', String(mediaDur));
      rightHandle?.setAttribute('aria-valuemax', String(mediaDur));
    } else if (qtrim) {
      qtrim.hidden = true;
    }

    updatePlayhead();
    syncForm();
    placement?.sync();
  };

  const updatePlayhead = () => {
    const t = api.getTime();
    const total = masterDuration(api.getProject());
    timeLabel.textContent = `${formatTime(t)} / ${formatTime(total)}`;
    const x = padPx + t * PX_PER_SEC;
    playhead.style.left = `${x}px`;
    playheadBadge.textContent = t.toFixed(2);
    // Don't chase the playhead while a trim handle is following the pointer.
    if (trimmingId) return;
    const viewL = scroll.scrollLeft;
    const viewR = viewL + scroll.clientWidth;
    if (x < viewL + 40) scroll.scrollLeft = Math.max(0, x - 40);
    else if (x > viewR - 40) scroll.scrollLeft = x - scroll.clientWidth + 40;
    placement?.sync();
  };

  scroll.addEventListener('scroll', () => updatePlayhead());

  const isTypingTarget = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'd') return;
    if (isTypingTarget(e.target) || !selectedText()) return;
    e.preventDefault();
    duplicateSelectedText();
  };
  window.addEventListener('keydown', onKeyDown);

  placement = mountTextPlacement(api.viewport, {
    getCanvas: api.getCanvas,
    getProject: api.getProject,
    getTime: api.getTime,
    getPlaying: api.getPlaying,
    getSelectedId: () => selectedTextId,
    select: (id) => {
      selectedTextId = id;
      syncForm();
      layoutTrack();
    },
    isHidden: api.isPlacementHidden,
    onLive: () => syncForm(),
    onCommit: () => api.onChange(),
    onPause: () => api.onPause(),
    setStatus: api.setStatus,
  });

  refresh();

  return {
    refresh,
    updatePlayhead,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      placement.dispose();
    },
  };
}
