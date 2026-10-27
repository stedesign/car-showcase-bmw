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
  pruneMasterTextsToDuration,
  normalizeMasterClip,
  normalizeAllMasterClips,
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
/** Pixels of horizontal travel before a clip press becomes a reorder drag. */
const CLIP_DRAG_THRESHOLD_PX = 6;

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
  deleteTextBtn.title = 'Delete selected titles (Delete)';
  deleteTextBtn.addEventListener('click', () => deleteSelectedTexts());

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
  /** Primary title for the form / on-picture handles. */
  let selectedTextId: string | null = null;
  /** All selected title pills (includes primary). */
  let selectedTextIds: string[] = [];
  let placement: TextPlacementHandle;
  let formClipId: string | null = null;
  let trimmingId: string | null = null;
  let trimmingEdge: 'in' | 'out' | null = null;
  /** Pixels before master t=0, so a trimmed head on the first clip stays visible. */
  let padPx = 0;
  /** Live horizontal reorder of master scene clips. */
  let clipReorder: {
    clipId: string;
    from: number;
    /** Insert gap 0…n (before first … after last). */
    gap: number;
    active: boolean;
    /** Pointer X minus the clip’s left edge at press. */
    grabOffsetX: number;
    clientX: number;
  } | null = null;

  const isTextSelected = (id: string) => selectedTextIds.includes(id);

  const setSelectedTexts = (ids: string[], primaryId?: string | null) => {
    const unique: string[] = [];
    for (const id of ids) {
      if (id && !unique.includes(id)) unique.push(id);
    }
    selectedTextIds = unique;
    if (primaryId && unique.includes(primaryId)) selectedTextId = primaryId;
    else selectedTextId = unique[unique.length - 1] ?? null;
    deleteTextBtn.textContent =
      unique.length > 1 ? `Delete (${unique.length})` : 'Delete';
  };

  const clearTextSelection = () => setSelectedTexts([]);

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };

  const moveClip = (clipId: string, dir: -1 | 1) => {
    const project = api.getProject();
    const i = project.master.clips.findIndex((c) => c.id === clipId);
    if (i < 0) return;
    reorderClipTo(clipId, i + dir);
  };

  /** Move a master clip to `toIndex` (no-op if unchanged / out of range). */
  const reorderClipTo = (clipId: string, toIndex: number) => {
    const project = api.getProject();
    const clips = project.master.clips;
    const from = clips.findIndex((c) => c.id === clipId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(clips.length - 1, toIndex));
    if (from === to) return false;
    const [item] = clips.splice(from, 1);
    clips.splice(to, 0, item);
    api.onChange();
    refresh();
    return true;
  };

  /** Gap under the pointer → destination index in the clips array. */
  const gapToClipIndex = (gap: number, from: number, count: number) => {
    let to = gap;
    if (from < gap) to = gap - 1;
    return Math.max(0, Math.min(count - 1, to));
  };

  /**
   * Draft clip order while dragging. The dragged clip is removed then reinserted
   * at the live gap so neighbors slide aside under the pointer.
   */
  const draftClipOrder = (): MasterClip[] => {
    const clips = [...api.getProject().master.clips];
    if (!clipReorder?.active) return clips;
    const from = clips.findIndex((c) => c.id === clipReorder!.clipId);
    if (from < 0) return clips;
    const [item] = clips.splice(from, 1);
    const to = gapToClipIndex(clipReorder.gap, from, clips.length + 1);
    clips.splice(to, 0, item);
    return clips;
  };

  const beginClipDrag = (e: PointerEvent, clipId: string) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.ed-master-clip-actions, .ed-master-trim, .ed-master-qtrim')) return;

    const project = api.getProject();
    const clips = project.master.clips;
    const from = clips.findIndex((c) => c.id === clipId);
    if (from < 0) return;

    e.preventDefault();
    e.stopPropagation();

    selectedClipId = clipId;
    if (api.getPlaying()) api.onPause();

    const clipEl = track.querySelector<HTMLElement>(`.ed-master-clip[data-clip-id="${clipId}"]`);
    const grabOffsetX = clipEl
      ? e.clientX - clipEl.getBoundingClientRect().left
      : 0;

    // Midpoints in content pixels at press — stable while neighbors slide.
    const frozenMids: number[] = [];
    {
      let cursor = 0;
      for (const c of clips) {
        frozenMids.push((cursor + clipDuration(c) / 2) * PX_PER_SEC);
        cursor += clipDuration(c);
      }
    }

    const sceneName =
      getSceneById(project, clips[from]?.sceneId ?? '')?.name ?? 'clip';

    clipReorder = {
      clipId,
      from,
      gap: from,
      active: false,
      grabOffsetX,
      clientX: e.clientX,
    };
    layoutTrack();

    const gapFromClientX = (clientX: number) => {
      const x = clientX - track.getBoundingClientRect().left - padPx;
      for (let i = 0; i < frozenMids.length; i++) {
        if (i === from) continue;
        if (x < frozenMids[i]) return i;
      }
      return frozenMids.length;
    };

    const swallowNextClick = () => {
      const sink = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        window.removeEventListener('click', sink, true);
      };
      window.addEventListener('click', sink, true);
    };

    const move = (ev: PointerEvent) => {
      if (!clipReorder || clipReorder.clipId !== clipId) return;
      clipReorder.clientX = ev.clientX;
      if (!clipReorder.active) {
        if (Math.abs(ev.clientX - e.clientX) < CLIP_DRAG_THRESHOLD_PX) return;
        clipReorder.active = true;
        track.classList.add('reordering');
        api.setStatus('Drop to reorder');
      }
      ev.preventDefault();
      clipReorder.gap = gapFromClientX(ev.clientX);
      layoutTrack();
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      track.classList.remove('reordering');
      const drag = clipReorder;
      clipReorder = null;
      if (!drag) {
        layoutTrack();
        return;
      }
      if (!drag.active) {
        api.setStatus('Drag to reorder · yellow edges trim');
        layoutTrack();
        return;
      }
      swallowNextClick();
      const to = gapToClipIndex(
        drag.gap,
        drag.from,
        api.getProject().master.clips.length,
      );
      if (to === drag.from || !reorderClipTo(drag.clipId, to)) {
        layoutTrack();
        return;
      }
      api.setStatus(`Moved “${sceneName}”`);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const removeClip = (clipId: string) => {
    const project = api.getProject();
    if (project.master.clips.length <= 1) {
      api.setStatus('Master needs at least one clip');
      return;
    }
    project.master.clips = project.master.clips.filter((c) => c.id !== clipId);
    if (selectedClipId === clipId) selectedClipId = null;
    pruneMasterTextsToDuration(project);
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
      pruneMasterTextsToDuration(api.getProject());
      api.setStatus(`Trim ${clip.in.toFixed(2)}–${clip.out.toFixed(2)}s`);
      api.onChange();
      refresh();
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
    // Buttons, trim handles, and clip bodies own their gestures.
    if (
      el.closest(
        '.ed-master-clip-actions, .ed-master-trim, .ed-master-qtrim, .ed-master-clip',
      )
    ) {
      return;
    }
    selectedClipId = null;
    layoutTrack();
  });

  const selectedText = (): MasterTextClip | null =>
    api.getProject().master.texts.find((t) => t.id === selectedTextId) ?? null;

  const deleteSelectedTexts = () => {
    if (!selectedTextIds.length) return;
    const project = api.getProject();
    const removing = new Set(selectedTextIds);
    const count = removing.size;
    project.master.texts = project.master.texts.filter((t) => !removing.has(t.id));
    compactMasterTextLanes(project.master.texts);
    clearTextSelection();
    api.onChange();
    api.setStatus(count > 1 ? `Removed ${count} titles` : 'Removed title');
    refresh();
  };

  const duplicateSelectedText = () => {
    const source = selectedText();
    if (!source) return;
    const copy = duplicateMasterText(api.getProject(), source.id);
    if (!copy) return;
    setSelectedTexts([copy.id], copy.id);
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
    setSelectedTexts([clip.id], clip.id);
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

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (edge === 'end') {
      // Keep multi-select so duration drag can resize the whole group.
      if (!isTextSelected(clip.id)) setSelectedTexts([clip.id], clip.id);
      else setSelectedTexts(selectedTextIds, clip.id);
    } else if (additive) {
      if (isTextSelected(clip.id)) {
        setSelectedTexts(
          selectedTextIds.filter((id) => id !== clip.id),
          selectedTextId === clip.id ? null : selectedTextId,
        );
        syncForm();
        layoutTrack();
        placement.sync();
        return;
      }
      setSelectedTexts([...selectedTextIds, clip.id], clip.id);
    } else if (!isTextSelected(clip.id)) {
      setSelectedTexts([clip.id], clip.id);
    } else {
      setSelectedTexts(selectedTextIds, clip.id);
    }

    const groupIds =
      isTextSelected(clip.id) && selectedTextIds.length > 1
        ? [...selectedTextIds]
        : [clip.id];
    const groupMove = edge === 'move' && groupIds.length > 1;
    const groupResize = edge === 'end' && groupIds.length > 1;

    const startX = e.clientX;
    const originStart = clip.start;
    const originDur = clip.duration;
    const origins = groupIds.flatMap((id) => {
      const t = api.getProject().master.texts.find((x) => x.id === id);
      return t ? [{ id, start: t.start, duration: t.duration, lane: t.lane }] : [];
    });
    const snapshot = api.getProject().master.texts.map((t) => ({ id: t.id, lane: t.lane }));
    syncForm();
    placement.sync();
    layoutTrack();

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

    const clampGroupDt = (rawDt: number) => {
      const total = masterDuration(api.getProject());
      let lo = -Infinity;
      let hi = Infinity;
      for (const o of origins) {
        lo = Math.max(lo, -o.start);
        hi = Math.min(hi, Math.max(0, total - 0.25) - o.start);
      }
      return Math.max(lo, Math.min(hi, rawDt));
    };

    const clampGroupDurDt = (rawDt: number) => {
      const total = masterDuration(api.getProject());
      let lo = -Infinity;
      let hi = Infinity;
      for (const o of origins) {
        lo = Math.max(lo, 0.25 - o.duration);
        hi = Math.min(hi, Math.max(0.25, total - o.start) - o.duration);
      }
      return Math.max(lo, Math.min(hi, rawDt));
    };

    const apply = (clientX: number, clientY: number) => {
      const rawDt = (clientX - startX) / PX_PER_SEC;
      const timeMoved = Math.abs(rawDt) >= 0.02;
      if (edge === 'end') {
        if (groupResize) {
          const dt = clampGroupDurDt(rawDt);
          const texts = api.getProject().master.texts;
          for (const o of origins) {
            const t = texts.find((x) => x.id === o.id);
            if (t) placeText(t, o.start, o.duration + dt);
          }
        } else if (timeMoved) {
          placeText(clip, originStart, originDur + rawDt);
        }
      } else if (groupMove) {
        const dt = clampGroupDt(rawDt);
        const texts = api.getProject().master.texts;
        for (const o of origins) {
          const t = texts.find((x) => x.id === o.id);
          if (t) placeText(t, o.start + dt, o.duration);
        }
      } else {
        if (timeMoved) placeText(clip, originStart + rawDt, originDur);
        reorderTo(rowFromY(clientY));
      }
      layoutTrack();
    };

    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const texts = api.getProject().master.texts;
      const changed = origins.some((o) => {
        const t = texts.find((x) => x.id === o.id);
        if (!t) return false;
        return t.start !== o.start || t.duration !== o.duration || t.lane !== o.lane;
      });
      if (!changed) {
        if (!additive && !groupMove && !groupResize) setSelectedTexts([clip.id], clip.id);
        layoutTrack();
        syncForm();
        return;
      }
      if (groupMove) {
        api.setStatus(`Moved ${origins.length} titles`);
      } else if (groupResize) {
        api.setStatus(`Resized ${origins.length} titles`);
      } else {
        api.setStatus(
          `${clip.name}  ${clip.start.toFixed(2)}–${(clip.start + clip.duration).toFixed(2)}s`,
        );
      }
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

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const stackRect = () => textStack.getBoundingClientRect();
    const localPoint = (ev: PointerEvent) => {
      const rect = stackRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const origin = localPoint(e);
    let moved = false;
    let marquee: HTMLDivElement | null = null;

    const ensureMarquee = () => {
      if (marquee) return marquee;
      marquee = document.createElement('div');
      marquee.className = 'ed-tl-marquee';
      textStack.append(marquee);
      return marquee;
    };

    const pillsInMarquee = (box: {
      left: number;
      top: number;
      right: number;
      bottom: number;
    }): string[] => {
      const rect = stackRect();
      const hits: string[] = [];
      for (const pill of textStack.querySelectorAll<HTMLElement>('.ed-master-text-pill')) {
        const id = pill.dataset.textId;
        if (!id) continue;
        const r = pill.getBoundingClientRect();
        const left = r.left - rect.left;
        const right = r.right - rect.left;
        const top = r.top - rect.top;
        const bottom = r.bottom - rect.top;
        if (right < box.left || left > box.right || bottom < box.top || top > box.bottom) continue;
        hits.push(id);
      }
      return hits;
    };

    const move = (ev: PointerEvent) => {
      const cur = localPoint(ev);
      if (!moved && Math.abs(cur.x - origin.x) < 4 && Math.abs(cur.y - origin.y) < 4) return;
      moved = true;
      const box = {
        left: Math.min(origin.x, cur.x),
        top: Math.min(origin.y, cur.y),
        right: Math.max(origin.x, cur.x),
        bottom: Math.max(origin.y, cur.y),
      };
      const m = ensureMarquee();
      m.style.left = `${box.left}px`;
      m.style.top = `${box.top}px`;
      m.style.width = `${box.right - box.left}px`;
      m.style.height = `${box.bottom - box.top}px`;
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      marquee?.remove();
      if (!moved) {
        if (!additive) clearTextSelection();
        syncForm();
        layoutTrack();
        placement.sync();
        return;
      }
      const cur = localPoint(ev);
      const box = {
        left: Math.min(origin.x, cur.x),
        top: Math.min(origin.y, cur.y),
        right: Math.max(origin.x, cur.x),
        bottom: Math.max(origin.y, cur.y),
      };
      const hits = pillsInMarquee(box);
      if (additive) {
        const merged = [...selectedTextIds];
        for (const id of hits) {
          if (!merged.includes(id)) merged.push(id);
        }
        setSelectedTexts(merged);
      } else {
        setSelectedTexts(hits);
      }
      syncForm();
      layoutTrack();
      placement.sync();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const refresh = () => {
    const project = api.getProject();
    playBtn.textContent = api.getPlaying() ? 'Pause' : 'Play';

    track.replaceChildren();

    textStack.replaceChildren();

    // Scene length changes must clamp clip in/out (e.g. 5s → 1.5s).
    const clippedToScenes = normalizeAllMasterClips(project);
    // Titles past the master end leave empty “T” rows (pills sit outside the track).
    const prunedOrphans = pruneMasterTextsToDuration(project);
    setSelectedTexts(
      selectedTextIds.filter((id) => project.master.texts.some((t) => t.id === id)),
      selectedTextId,
    );

    // One row per title; no titles → no rows.
    const laneCount = project.master.texts.length;
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
      pill.title =
        'Drag sideways to move · up/down to change row · drag empty area to multi-select · Delete to remove';

      const label = document.createElement('div');
      label.className = 'ed-master-text-pill-label';
      label.textContent = clip.name || clip.text.split('\n')[0] || 'Title';

      const edge = document.createElement('div');
      edge.className = 'ed-master-text-pill-edge';
      edge.title = 'Drag to change duration · extends all selected';
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
      el.title = 'Drag to reorder · click then yellow edges to trim';
      el.addEventListener('pointerdown', (ev) => beginClipDrag(ev, clip.id));
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
    if (clippedToScenes || prunedOrphans) {
      if (prunedOrphans) {
        api.setStatus('Removed titles past the end of the master');
      } else if (clippedToScenes) {
        api.setStatus('Master clips trimmed to scene length');
      }
      queueMicrotask(() => api.onChange());
    }
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
    track.classList.toggle(
      'trimming-open',
      Boolean(selected && selectedScene && !clipReorder?.active),
    );
    renderRuler(total, width, padPx);

    const pills = textStack.querySelectorAll<HTMLElement>('.ed-master-text-pill');
    pills.forEach((el) => {
      const clip = project.master.texts.find((t) => t.id === el.dataset.textId);
      if (!clip) return;
      const row = textStack.querySelector<HTMLElement>(`[data-lane="${clip.lane}"]`);
      if (row && el.parentElement !== row) row.append(el);
      el.style.left = `${padPx + clip.start * PX_PER_SEC}px`;
      el.style.width = `${Math.max(clip.duration * PX_PER_SEC, 36)}px`;
      el.classList.toggle('selected', isTextSelected(clip.id));
      const label = el.querySelector('.ed-master-text-pill-label');
      if (label) label.textContent = clip.name || clip.text.split('\n')[0] || 'Title';
    });

    const order = draftClipOrder();
    const nodeById = new Map(
      [...track.querySelectorAll<HTMLElement>('.ed-master-clip')].map((el) => [
        el.dataset.clipId ?? '',
        el,
      ]),
    );
    const reordering = Boolean(clipReorder?.active);
    let cursor = 0;
    let dropLineX: number | null = null;
    for (const clip of order) {
      const el = nodeById.get(clip.id);
      if (!el) continue;
      const scene = getSceneById(project, clip.sceneId);
      const dur = clipDuration(clip);
      const trimming = !reordering && trimmingId === clip.id;
      const selectedHere = selectedClipId === clip.id;
      const draggingHere = reordering && clipReorder?.clipId === clip.id;
      const slotLeft = padPx + cursor * PX_PER_SEC;
      const width = Math.max(dur * PX_PER_SEC, 4);
      if (draggingHere && clipReorder) {
        const trackLeft = track.getBoundingClientRect().left;
        const follow = clipReorder.clientX - trackLeft - clipReorder.grabOffsetX;
        el.style.left = `${follow}px`;
        dropLineX = slotLeft;
      } else {
        el.style.left = `${slotLeft}px`;
      }
      el.style.width = `${width}px`;
      el.classList.toggle('selected', selectedHere);
      el.classList.toggle('trimming', trimming);
      el.classList.toggle('dragging', draggingHere);
      el.title = draggingHere
        ? 'Drop to place'
        : selectedHere
          ? `${scene?.name ?? 'Missing'}  ${clip.in.toFixed(2)}–${clip.out.toFixed(2)}s · drag to reorder`
          : 'Drag to reorder · click then yellow edges to trim';
      const meta = el.querySelector('.ed-master-clip-meta');
      if (meta) {
        meta.textContent =
          trimming && trimmingEdge
            ? `${trimmingEdge === 'in' ? 'In' : 'Out'} ${(trimmingEdge === 'in' ? clip.in : clip.out).toFixed(2)}s`
            : `${dur.toFixed(1)}s`;
      }
      cursor += dur;
    }

    let drop = track.querySelector<HTMLElement>('.ed-master-drop');
    if (reordering && dropLineX != null) {
      if (!drop) {
        drop = document.createElement('div');
        drop.className = 'ed-master-drop';
        track.append(drop);
      }
      drop.hidden = false;
      drop.style.left = `${dropLineX}px`;
    } else if (drop) {
      drop.hidden = true;
    }

    const qtrim = track.querySelector<HTMLElement>('.ed-master-qtrim');
    if (qtrim && selected && selectedScene && !reordering) {
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
    if (isTypingTarget(e.target)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTextIds.length) {
      e.preventDefault();
      deleteSelectedTexts();
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'd') return;
    if (!selectedText()) return;
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
      setSelectedTexts([id], id);
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
