import {
  MARQUEE_TRACKING_EM,
  masterTextType,
  measureMasterTextBlock,
  setMasterTextEditing,
  type MasterTextBlock,
} from '../masterTextOverlay';
import { TEXT_SIZE_MIN, textSizeMax, type MasterTextClip, type Project } from '../project';

type Corner = 'nw' | 'ne' | 'sw' | 'se';

export type TextPlacementApi = {
  getCanvas: () => HTMLCanvasElement;
  getProject: () => Project;
  getTime: () => number;
  getPlaying: () => boolean;
  getSelectedId: () => string | null;
  select: (id: string) => void;
  isHidden: () => boolean;
  /** Live form refresh while a drag is in progress. */
  onLive: () => void;
  /** Commit one history step when the pointer goes up. */
  onCommit: () => void;
  onPause: () => void;
  setStatus: (msg: string) => void;
};

export type TextPlacementHandle = {
  sync: () => void;
  /** Open the on-canvas editor and select the current text. */
  edit: (id: string) => void;
  dispose: () => void;
};

type HitNode = {
  id: string;
  hit: HTMLDivElement;
  badge: HTMLDivElement;
};

function toBuffer(e: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? canvas.width / rect.width : 1;
  const sy = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function activeAt(clip: MasterTextClip, time: number, editingId: string | null) {
  if (time < clip.start || time >= clip.start + clip.duration) return false;
  if (clip.id === editingId) return true;
  return clip.text.trim().length > 0;
}

function editorColor(clip: MasterTextClip): string {
  if (clip.effect === 'maskedHeading') return '#ffffff';
  return /^#[0-9a-fA-F]{6}$/.test(clip.color) ? clip.color : '#ffffff';
}

export function mountTextPlacement(
  viewport: HTMLElement,
  api: TextPlacementApi,
): TextPlacementHandle {
  const stage = document.createElement('div');
  stage.className = 'ed-text-stage';
  stage.hidden = true;
  viewport.append(stage);

  const nodes = new Map<string, HitNode>();
  let gestureId: string | null = null;
  let editingId: string | null = null;
  let editor: HTMLTextAreaElement | null = null;
  let suspendBlur = false;
  let disposed = false;

  const clipById = (id: string) => api.getProject().master.texts.find((t) => t.id === id) ?? null;

  const measureVisible = (clip: MasterTextClip, frameW: number, frameH: number) => {
    const block = measureMasterTextBlock(clip, frameW, frameH);
    if (block) return block;
    if (editingId !== clip.id) return null;
    return measureMasterTextBlock({ ...clip, text: 'Title' }, frameW, frameH);
  };

  const styleEditor = (clip: MasterTextClip, block: MasterTextBlock, sy: number) => {
    if (!editor || editingId !== clip.id) return;
    const type = masterTextType(clip);
    const cssPx = Math.round(block.fontPx * sy * 100) / 100;
    // Canvas draws from the top of the em square. CSS centers the em square
    // in the line box, so shift up by half the extra leading.
    const shift = Math.round(((type.lineHeight - 1) / 2) * cssPx * 100) / 100;
    const color = editorColor(clip);
    const tracking = clip.effect === 'marquee' ? cssPx * MARQUEE_TRACKING_EM : 0;
    const signature = [
      type.family,
      type.weight,
      cssPx,
      type.lineHeight,
      clip.align,
      color,
      shift,
      clip.effect,
      tracking,
    ].join('|');
    if (editor.dataset.style !== signature) {
      editor.dataset.style = signature;
      editor.style.fontFamily = type.family;
      editor.style.fontWeight = String(type.weight);
      editor.style.fontSize = `${cssPx}px`;
      editor.style.lineHeight = String(type.lineHeight);
      editor.style.letterSpacing = `${tracking}px`;
      editor.style.textAlign = clip.align;
      editor.style.color = color;
      editor.style.caretColor = color;
      editor.style.textShadow =
        clip.effect === 'fade' ? `0 0 ${cssPx * 0.18}px rgba(0, 0, 0, 0.55)` : 'none';
      editor.style.top = `${-shift}px`;
      editor.style.height = `calc(100% + ${shift}px)`;
    }
    if (editor.value !== clip.text) editor.value = clip.text;
  };

  const placeNode = (node: HitNode, clip: MasterTextClip) => {
    const canvas = api.getCanvas();
    const block = measureVisible(clip, canvas.width, canvas.height);
    if (!block) {
      node.hit.hidden = true;
      return;
    }
    const view = viewport.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width > 0 ? rect.width / canvas.width : 1;
    const sy = canvas.height > 0 ? rect.height / canvas.height : 1;
    let left = rect.left - view.left + block.originX * sx;
    let top = rect.top - view.top + block.originY * sy;
    let width = Math.max(Math.ceil(block.blockW * sx), 8);
    let height = Math.max(Math.ceil(block.blockH * sy), 8);
    if (clip.effect === 'marquee') {
      const boundsLeft = rect.left - view.left;
      const boundsTop = rect.top - view.top;
      const boundsRight = rect.right - view.left;
      const boundsBottom = rect.bottom - view.top;
      const nextLeft = Math.max(left, boundsLeft);
      const nextTop = Math.max(top, boundsTop);
      const nextRight = Math.min(left + width, boundsRight);
      const nextBottom = Math.min(top + height, boundsBottom);
      left = nextLeft;
      top = nextTop;
      width = Math.max(8, nextRight - nextLeft);
      height = Math.max(8, nextBottom - nextTop);
    }
    node.hit.hidden = false;
    node.hit.style.left = `${left}px`;
    node.hit.style.top = `${top}px`;
    node.hit.style.width = `${width}px`;
    node.hit.style.height = `${height}px`;
    node.hit.title =
      clip.effect === 'marquee'
        ? 'Drag up or down to move. Drag a corner to resize. The line slides on its own.'
        : 'Drag to move. Click to edit';
    const selected = api.getSelectedId() === clip.id;
    node.hit.classList.toggle('selected', selected);
    node.hit.classList.toggle('editing', editingId === clip.id);
    styleEditor(clip, block, sy);
    const showBadge = gestureId === clip.id && editingId !== clip.id;
    node.badge.hidden = !showBadge;
    if (showBadge) {
      const cssW = Math.round(block.blockW * sx);
      const cssH = Math.round(block.blockH * sy);
      node.badge.textContent = `${cssW} × ${cssH}`;
    }
  };

  const finishGesture = (moved: boolean, label: string) => {
    gestureId = null;
    sync();
    if (!moved) return;
    api.setStatus(label);
    api.onCommit();
  };

  let finishing = false;

  const finishEdit = () => {
    if (!editingId || finishing) return;
    finishing = true;
    editingId = null;
    setMasterTextEditing(null);
    const area = editor;
    editor = null;
    area?.remove();
    sync();
    finishing = false;
  };

  const focusEditor = (
    area: HTMLTextAreaElement,
    point: { x: number; y: number } | undefined,
    selectAll: boolean,
  ) => {
    area.focus();
    if (selectAll) {
      area.select();
      return;
    }
    const end = area.value.length;
    if (!point) {
      area.setSelectionRange(end, end);
      return;
    }
    area.getBoundingClientRect();
    const pos = document.caretPositionFromPoint(point.x, point.y);
    const node = pos?.offsetNode;
    if (pos && node && (node === area || area.contains(node))) {
      const offset = Math.max(0, Math.min(area.value.length, pos.offset));
      area.setSelectionRange(offset, offset);
      return;
    }
    area.setSelectionRange(end, end);
  };

  const beginEdit = (id: string, point?: { x: number; y: number }, selectAll = false) => {
    const clip = clipById(id);
    if (!clip || api.isHidden()) return;
    const time = api.getTime();
    if (time < clip.start || time >= clip.start + clip.duration) return;
    if (editingId === id && editor) {
      focusEditor(editor, point, selectAll);
      return;
    }
    if (editingId) finishEdit();
    if (api.getPlaying()) api.onPause();
    api.select(id);
    editingId = id;
    setMasterTextEditing(id);

    const node = nodes.get(id) ?? makeNode(id);
    const area = document.createElement('textarea');
    area.className = 'ed-text-editor';
    area.wrap = 'off';
    area.spellcheck = false;
    area.placeholder = 'Type';
    area.setAttribute('aria-label', 'Title text');
    area.value = clip.text;
    area.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    area.addEventListener('input', () => {
      const current = clipById(id);
      if (!current || editor !== area) return;
      current.text = area.value;
      current.name = area.value.split('\n')[0].slice(0, 40) || 'Title';
      const start = area.selectionStart;
      const end = area.selectionEnd;
      suspendBlur = true;
      api.onCommit();
      suspendBlur = false;
      if (editor !== area) return;
      if (document.activeElement !== area) {
        area.focus();
        area.setSelectionRange(start, end);
      }
    });
    area.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finishEdit();
      }
      ev.stopPropagation();
    });
    area.addEventListener('blur', () => {
      if (suspendBlur || editor !== area) return;
      finishEdit();
    });
    editor = area;
    node.hit.append(area);
    sync();
    focusEditor(area, point, selectAll);
  };

  const onWindowPointerDown = (ev: PointerEvent) => {
    if (!editingId || !editor) return;
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (editor.contains(target)) return;
    if (editor.closest('.ed-text-hit')?.contains(target)) return;
    finishEdit();
  };
  window.addEventListener('pointerdown', onWindowPointerDown, true);

  const beginMove = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    if (editingId === id) return;
    e.preventDefault();
    e.stopPropagation();
    api.select(id);
    if (api.getPlaying()) api.onPause();
    const clip = clipById(id);
    const canvas = api.getCanvas();
    if (!clip || canvas.width < 2) return;
    const before = measureMasterTextBlock(clip, canvas.width, canvas.height);
    if (!before) return;
    const originX = before.originX;
    const originY = before.originY;
    const pointer = toBuffer(e, canvas);
    let moved = false;
    gestureId = id;

    const move = (ev: PointerEvent) => {
      const p = toBuffer(ev, canvas);
      const dx = p.x - pointer.x;
      const dy = p.y - pointer.y;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      if (clip.effect === 'marquee') {
        clip.y = (originY + dy) / canvas.height;
        const placed = measureMasterTextBlock(clip, canvas.width, canvas.height);
        if (placed) clip.y = placed.originY / canvas.height;
      } else {
        clip.x = (originX + dx) / canvas.width;
        clip.y = (originY + dy) / canvas.height;
        const placed = measureMasterTextBlock(clip, canvas.width, canvas.height);
        if (placed) {
          clip.x = placed.originX / canvas.width;
          clip.y = placed.originY / canvas.height;
        }
      }
      api.onLive();
      sync();
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const didMove = moved;
      finishGesture(didMove, `${clip.name} moved`);
      if (!didMove) beginEdit(id, { x: ev.clientX, y: ev.clientY });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const beginScale = (e: PointerEvent, id: string, corner: Corner) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    api.select(id);
    if (api.getPlaying()) api.onPause();
    const clip = clipById(id);
    const canvas = api.getCanvas();
    if (!clip || canvas.width < 2) return;
    const startBlock = measureMasterTextBlock(clip, canvas.width, canvas.height);
    if (!startBlock) return;
    const fixedX =
      corner === 'nw' || corner === 'sw' ? startBlock.originX + startBlock.blockW : startBlock.originX;
    const fixedY =
      corner === 'nw' || corner === 'ne' ? startBlock.originY + startBlock.blockH : startBlock.originY;
    const dragX =
      corner === 'ne' || corner === 'se' ? startBlock.originX + startBlock.blockW : startBlock.originX;
    const dragY =
      corner === 'sw' || corner === 'se' ? startBlock.originY + startBlock.blockH : startBlock.originY;
    const startDist = Math.hypot(dragX - fixedX, dragY - fixedY) || 1;
    const startSize = clip.size;
    const pointer = toBuffer(e, canvas);
    let moved = false;
    gestureId = id;
    const marquee = clip.effect === 'marquee';

    const move = (ev: PointerEvent) => {
      const p = toBuffer(ev, canvas);
      if (marquee) {
        const ySign = corner === 'nw' || corner === 'ne' ? -1 : 1;
        const xSign = corner === 'nw' || corner === 'sw' ? -1 : 1;
        const grow = Math.max((p.y - pointer.y) * ySign, (p.x - pointer.x) * xSign);
        if (!moved && Math.abs(grow) < 3) return;
        moved = true;
        clip.size =
          Math.round(
            Math.min(textSizeMax('marquee'), Math.max(TEXT_SIZE_MIN, startSize + grow / canvas.height)) *
              10000,
          ) / 10000;
        const next = measureMasterTextBlock(clip, canvas.width, canvas.height);
        if (!next) return;
        clip.y =
          (corner === 'nw' || corner === 'ne' ? fixedY - next.blockH : startBlock.originY) /
          canvas.height;
        const placed = measureMasterTextBlock(clip, canvas.width, canvas.height);
        if (placed) clip.y = placed.originY / canvas.height;
        api.onLive();
        sync();
        return;
      }
      const dist = Math.hypot(dragX + (p.x - pointer.x) - fixedX, dragY + (p.y - pointer.y) - fixedY);
      if (!moved && Math.abs(dist - startDist) < 3) return;
      moved = true;
      const scale = dist / startDist;
      clip.size =
        Math.round(
          Math.min(textSizeMax(clip.effect), Math.max(TEXT_SIZE_MIN, startSize * scale)) * 10000,
        ) / 10000;
      const next = measureMasterTextBlock(clip, canvas.width, canvas.height);
      if (!next) return;
      let ox = startBlock.originX;
      let oy = startBlock.originY;
      if (corner === 'nw' || corner === 'sw') ox = fixedX - next.blockW;
      if (corner === 'nw' || corner === 'ne') oy = fixedY - next.blockH;
      clip.x = ox / canvas.width;
      clip.y = oy / canvas.height;
      const placed = measureMasterTextBlock(clip, canvas.width, canvas.height);
      if (placed) {
        clip.x = placed.originX / canvas.width;
        clip.y = placed.originY / canvas.height;
      }
      api.onLive();
      sync();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      finishGesture(moved, `${clip.name} resized`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const makeNode = (id: string): HitNode => {
    const hit = document.createElement('div');
    hit.className = 'ed-text-hit';
    hit.dataset.textId = id;
    hit.title = 'Drag to move. Click to edit';
    const frame = document.createElement('div');
    frame.className = 'ed-text-frame';
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = document.createElement('div');
      handle.className = `ed-text-handle ${corner}`;
      handle.title = 'Drag to resize';
      handle.addEventListener('pointerdown', (ev) => beginScale(ev, id, corner));
      frame.append(handle);
    }
    const badge = document.createElement('div');
    badge.className = 'ed-text-badge';
    badge.hidden = true;
    hit.append(frame, badge);
    hit.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).closest('.ed-text-handle, .ed-text-editor')) return;
      beginMove(ev, id);
    });
    stage.append(hit);
    const node = { id, hit, badge };
    nodes.set(id, node);
    return node;
  };

  const sync = () => {
    if (disposed) return;
    if (editingId && !finishing) {
      const clip = clipById(editingId);
      const time = api.getTime();
      const still =
        clip &&
        time >= clip.start &&
        time < clip.start + clip.duration &&
        !api.isHidden();
      if (!still) {
        finishEdit();
        return;
      }
    }
    const canvas = api.getCanvas();
    const hide = api.isHidden() || canvas.width < 2 || canvas.height < 2;
    if (hide) {
      stage.hidden = true;
      return;
    }
    const time = api.getTime();
    const active = api.getProject().master.texts.filter((clip) =>
      activeAt(clip, time, editingId),
    );
    const ids = new Set(active.map((clip) => clip.id));
    for (const [id, node] of nodes) {
      if (!ids.has(id)) {
        node.hit.remove();
        nodes.delete(id);
      }
    }
    stage.hidden = active.length === 0;
    for (const clip of active) {
      const node = nodes.get(clip.id) ?? makeNode(clip.id);
      placeNode(node, clip);
    }
  };

  const observer = new ResizeObserver(() => sync());
  observer.observe(viewport);

  return {
    sync,
    edit(id: string) {
      beginEdit(id, undefined, true);
    },
    dispose() {
      disposed = true;
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      editingId = null;
      setMasterTextEditing(null);
      editor = null;
      observer.disconnect();
      stage.remove();
      nodes.clear();
    },
  };
}
