import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import type { PathsHandle } from '../paths';
import {
  AIRFLOW_ID,
  MOTION_ID,
  CAR_ID,
  CAR_LIGHTS_ID,
  DOT_GRID_ID,
  FREE_CAMERA_ID,
  LIGHTING_ID,
  ROOF_STROBE_ID,
  type Project,
  type Scene,
  type Selection,
} from '../project';

export type HierarchyApi = {
  viewer: Viewer;
  getProject: () => Project;
  getScene: () => Scene;
  getSelection: () => Selection;
  select: (kind: Selection['kind'], id: string | null) => void;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  paths: PathsHandle;
  onChange: () => void;
  onSelectScene?: (sceneId: string) => void;
  onAddScene?: () => void;
  onDuplicateScene?: () => void;
  onDeleteScene?: (sceneId: string) => void;
  onDeleteAllScenes?: () => void;
  onRenameScene?: (sceneId: string, name: string) => void;
  onReorderScenes?: (sceneId: string, toIndex: number) => void;
  /** Delete timeline keyframes and dedicated cameras. Free camera stays. */
  onClearScene?: () => void;
};

const SIDEBAR_COLLAPSE_KEY = 'wrt-director-sidebar-collapsed';
const SIDEBAR_SPLIT_KEY = 'wrt-director-sidebar-split';
const SIDEBAR_PANE_KEY = 'wrt-director-sidebar-pane';
const TWIST_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">' +
  '<path d="M2.2 3.5 L5 6.5 L7.8 3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const SPLIT_ICON =
  '<svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">' +
  '<path d="M6 1.5 L9.2 5 H2.8 Z" fill="currentColor"/>' +
  '<path d="M6 12.5 L2.8 9 H9.2 Z" fill="currentColor"/>' +
  '</svg>';

type SidebarPane = 'none' | 'scenes' | 'rest';

function loadCollapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function saveCollapsedSections(ids: Set<string>) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota or private mode */
  }
}

function loadSplitPct(): number {
  try {
    const n = Number.parseFloat(localStorage.getItem(SIDEBAR_SPLIT_KEY) ?? '');
    if (Number.isFinite(n) && n >= 18 && n <= 82) return n;
  } catch {
    /* ignore */
  }
  return 42;
}

function saveSplitPct(pct: number) {
  try {
    localStorage.setItem(SIDEBAR_SPLIT_KEY, String(Math.round(pct * 10) / 10));
  } catch {
    /* ignore */
  }
}

function loadCollapsedPane(): SidebarPane {
  try {
    const v = localStorage.getItem(SIDEBAR_PANE_KEY);
    if (v === 'scenes' || v === 'rest' || v === 'none') return v;
  } catch {
    /* ignore */
  }
  return 'none';
}

function saveCollapsedPane(pane: SidebarPane) {
  try {
    localStorage.setItem(SIDEBAR_PANE_KEY, pane);
  } catch {
    /* ignore */
  }
}

const collapsedSections = loadCollapsedSections();
let scenesSplitPct = loadSplitPct();
let collapsedPane: SidebarPane = loadCollapsedPane();

function applySectionFold(head: HTMLElement, body: HTMLElement, id: string, label: string) {
  const folded = collapsedSections.has(id);
  head.classList.add('ed-section-fold');

  const twist = document.createElement('button');
  twist.type = 'button';
  twist.className = 'ed-twist';
  if (folded) twist.classList.add('collapsed');
  twist.setAttribute('aria-expanded', folded ? 'false' : 'true');
  twist.setAttribute('aria-label', `${folded ? 'Expand' : 'Collapse'} ${label}`);
  twist.innerHTML = TWIST_ICON;

  const titleEl = head.querySelector(':scope > span');
  if (titleEl) head.insertBefore(twist, titleEl);
  else head.prepend(twist);

  const count = document.createElement('span');
  const childCount = body.childElementCount;
  count.className = 'ed-fold-count';
  count.textContent = String(childCount);
  count.hidden = !folded || childCount === 0;
  titleEl?.after(count);

  body.hidden = folded;

  const toggle = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = !collapsedSections.has(id);
    if (next) collapsedSections.add(id);
    else collapsedSections.delete(id);
    saveCollapsedSections(collapsedSections);
    body.hidden = next;
    count.hidden = !next || childCount === 0;
    twist.classList.toggle('collapsed', next);
    twist.setAttribute('aria-expanded', next ? 'false' : 'true');
    twist.setAttribute('aria-label', `${next ? 'Expand' : 'Collapse'} ${label}`);
  };

  twist.addEventListener('click', toggle);
  head.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('.ed-twist, .ed-btn')) return;
    toggle(event);
  });
}

const DRAG_THRESHOLD_PX = 5;

function bindSceneReorder(body: HTMLElement, api: HierarchyApi) {
  let dragId: string | null = null;
  let fromIndex = -1;
  /** Gap index 0..n (before first … after last). */
  let slot = -1;
  let startY = 0;
  let active = false;
  let pointerId = -1;

  const rows = () =>
    [...body.querySelectorAll<HTMLElement>('.ed-tree-item[data-scene-id]')];

  const clearIndicators = () => {
    for (const row of rows()) {
      row.classList.remove('ed-drop-before', 'ed-drop-after', 'ed-dragging');
    }
  };

  /** Gap under the pointer: 0 = before first row, n = after last. */
  const slotFromY = (clientY: number) => {
    const list = rows();
    for (let i = 0; i < list.length; i++) {
      const rect = list[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return list.length;
  };

  const slotToIndex = (gap: number, from: number) => {
    let to = gap;
    if (from < gap) to = gap - 1;
    return Math.max(0, Math.min(rows().length - 1, to));
  };

  const paintSlot = (gap: number, excludeId: string, from: number) => {
    clearIndicators();
    const list = rows();
    const dragRow = list.find((r) => r.dataset.sceneId === excludeId);
    if (dragRow) dragRow.classList.add('ed-dragging');
    if (!list.length) return;
    // Same position — no insert line.
    if (gap === from || gap === from + 1) return;
    if (gap <= 0) {
      list[0].classList.add('ed-drop-before');
      return;
    }
    if (gap >= list.length) {
      list[list.length - 1].classList.add('ed-drop-after');
      return;
    }
    list[gap].classList.add('ed-drop-before');
  };

  const swallowNextClick = () => {
    const sink = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      window.removeEventListener('click', sink, true);
    };
    window.addEventListener('click', sink, true);
  };

  const onMove = (e: PointerEvent) => {
    if (!dragId || e.pointerId !== pointerId) return;
    if (!active) {
      if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      active = true;
      body.classList.add('ed-reordering');
    }
    e.preventDefault();
    slot = slotFromY(e.clientY);
    paintSlot(slot, dragId, fromIndex);
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    body.classList.remove('ed-reordering');
    const id = dragId;
    const from = fromIndex;
    const gap = slot;
    const didDrag = active;
    clearIndicators();
    dragId = null;
    fromIndex = -1;
    slot = -1;
    active = false;
    pointerId = -1;
    if (!didDrag || !id || from < 0 || gap < 0) return;
    const to = slotToIndex(gap, from);
    if (from === to) return;
    swallowNextClick();
    api.onReorderScenes?.(id, to);
  };

  body.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.ed-btn')) return;
    const row = target.closest<HTMLElement>('.ed-tree-item[data-scene-id]');
    if (!row || !body.contains(row)) return;
    const id = row.dataset.sceneId;
    if (!id) return;
    dragId = id;
    fromIndex = rows().findIndex((r) => r.dataset.sceneId === id);
    slot = fromIndex;
    startY = e.clientY;
    active = false;
    pointerId = e.pointerId;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

function section(
  title: string,
  actions: { label: string; title?: string; onClick: () => void }[],
  items: { id: string; label: string; kind: Selection['kind']; active: boolean }[],
  api: HierarchyApi,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'ed-section';

  const head = document.createElement('div');
  head.className = 'ed-section-title';
  const titleEl = document.createElement('span');
  titleEl.textContent = title;
  const btns = document.createElement('div');
  btns.className = 'ed-section-actions';
  for (const action of actions) {
    const b = document.createElement('button');
    b.className = 'ed-btn';
    b.textContent = action.label;
    if (action.title) b.title = action.title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      action.onClick();
    });
    btns.append(b);
  }
  head.append(titleEl, btns);

  const body = document.createElement('div');
  body.className = 'ed-section-body';
  for (const item of items) {
    const row = document.createElement('button');
    row.className = `ed-tree-item${item.active ? ' active' : ''}`;
    row.type = 'button';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.kind ?? '';
    const name = document.createElement('span');
    name.textContent = item.label;
    row.append(tag, name);
    row.addEventListener('click', () => api.select(item.kind, item.id));
    body.append(row);
  }

  applySectionFold(head, body, title.toLowerCase(), title);
  root.append(head, body);
  return root;
}

export function renderHierarchy(host: HTMLElement, api: HierarchyApi): void {
  host.replaceChildren();
  const project = api.getProject();
  const scene = api.getScene();
  const sel = api.getSelection();

  const scenes = document.createElement('div');
  scenes.className = 'ed-section ed-scenes';
  const scenesHead = document.createElement('div');
  scenesHead.className = 'ed-section-title';
  const scenesTitle = document.createElement('span');
  scenesTitle.textContent = 'Scenes';
  const scenesBtns = document.createElement('div');
  scenesBtns.className = 'ed-section-actions';
  if (api.onAddScene) {
    const addBtn = document.createElement('button');
    addBtn.className = 'ed-btn';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addBtn.title = 'Add scene';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.onAddScene?.();
    });
    scenesBtns.append(addBtn);
  }
  if (api.onDuplicateScene) {
    const dupBtn = document.createElement('button');
    dupBtn.className = 'ed-btn';
    dupBtn.type = 'button';
    dupBtn.textContent = 'Dup';
    dupBtn.title = 'Duplicate active scene';
    dupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.onDuplicateScene?.();
    });
    scenesBtns.append(dupBtn);
  }
  if (api.onDeleteAllScenes && project.scenes.length > 1) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'ed-btn';
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Delete all scenes';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.onDeleteAllScenes?.();
    });
    scenesBtns.append(clearBtn);
  }
  scenesHead.append(scenesTitle, scenesBtns);
  const scenesBody = document.createElement('div');
  scenesBody.className = 'ed-section-body';
  const canReorder = !!api.onReorderScenes && project.scenes.length > 1;
  for (const s of project.scenes) {
    const row = document.createElement('div');
    row.className = `ed-tree-item${s.id === scene.id ? ' active' : ''}${canReorder ? ' ed-scene-row' : ''}`;
    row.dataset.sceneId = s.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    if (canReorder) row.title = 'Drag to reorder';
    if (canReorder) {
      const grip = document.createElement('span');
      grip.className = 'ed-drag-handle';
      grip.setAttribute('aria-hidden', 'true');
      grip.textContent = '⠿';
      row.append(grip);
    }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'scene';
    const name = document.createElement('span');
    name.textContent = s.name;
    name.style.flex = '1';
    name.style.textAlign = 'left';
    row.append(tag, name);
    const activate = () => api.onSelectScene?.(s.id);
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!api.onRenameScene) return;
      const next = window.prompt('Scene name', s.name);
      if (next != null && next.trim()) api.onRenameScene(s.id, next.trim());
    });
    if (api.onDeleteScene && project.scenes.length > 1) {
      const del = document.createElement('button');
      del.className = 'ed-btn';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Delete scene';
      del.style.padding = '0 4px';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.confirm(`Delete “${s.name}”?`)) api.onDeleteScene?.(s.id);
      });
      row.append(del);
    }
    scenesBody.append(row);
  }
  if (canReorder) bindSceneReorder(scenesBody, api);
  applySectionFold(scenesHead, scenesBody, 'scenes', 'Scenes');
  scenes.append(scenesHead, scenesBody);
  host.append(scenes);

  const splitter = document.createElement('div');
  splitter.className = 'ed-sidebar-split';
  splitter.title = 'Drag to resize · click to collapse/expand';
  const splitGrip = document.createElement('button');
  splitGrip.type = 'button';
  splitGrip.className = 'ed-sidebar-split-grip';
  splitGrip.setAttribute('aria-label', 'Resize or collapse sidebar areas');
  splitGrip.innerHTML = SPLIT_ICON;
  splitter.append(splitGrip);
  host.append(splitter);

  const rest = document.createElement('div');
  rest.className = 'ed-sidebar-rest';
  host.append(rest);

  const restCollapseBar = document.createElement('button');
  restCollapseBar.type = 'button';
  restCollapseBar.className = 'ed-sidebar-rest-bar';
  restCollapseBar.textContent = 'Layers';
  restCollapseBar.title = 'Expand layers';
  restCollapseBar.hidden = collapsedPane !== 'rest';
  restCollapseBar.addEventListener('click', () => setCollapsedPane('none'));
  host.append(restCollapseBar);

  const syncSplitChrome = () => {
    const label =
      collapsedPane === 'scenes'
        ? 'Expand scenes'
        : collapsedPane === 'rest'
          ? 'Expand layers'
          : 'Drag to resize · click to collapse';
    splitter.title = label;
    splitGrip.setAttribute('aria-label', label);
    restCollapseBar.hidden = collapsedPane !== 'rest';
  };

  const applyPaneLayout = () => {
    host.classList.toggle('ed-pane-scenes-collapsed', collapsedPane === 'scenes');
    host.classList.toggle('ed-pane-rest-collapsed', collapsedPane === 'rest');
    scenes.style.flex = '';
    rest.style.flex = '';
    if (collapsedPane === 'none') {
      scenes.style.flex = `${scenesSplitPct} 0 0`;
      rest.style.flex = `${100 - scenesSplitPct} 1 0`;
    }
    syncSplitChrome();
  };

  const setCollapsedPane = (pane: SidebarPane) => {
    collapsedPane = pane;
    saveCollapsedPane(pane);
    applyPaneLayout();
  };

  applyPaneLayout();

  const COLLAPSE_EDGE_PX = 56;
  const bindSplitter = () => {
    let pointerId = -1;
    let startY = 0;
    let startScenesH = 0;
    let hostH = 0;
    let dragged = false;

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dy = e.clientY - startY;
      if (!dragged && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      dragged = true;
      e.preventDefault();
      splitter.classList.add('dragging');
      document.body.classList.add('ed-sidebar-resizing');

      const nextH = Math.max(0, Math.min(hostH, startScenesH + dy));
      if (nextH <= COLLAPSE_EDGE_PX) {
        setCollapsedPane('scenes');
        return;
      }
      if (hostH - nextH <= COLLAPSE_EDGE_PX) {
        setCollapsedPane('rest');
        return;
      }
      if (collapsedPane !== 'none') setCollapsedPane('none');
      scenesSplitPct = (nextH / hostH) * 100;
      applyPaneLayout();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      splitter.classList.remove('dragging');
      document.body.classList.remove('ed-sidebar-resizing');
      const wasDrag = dragged;
      pointerId = -1;
      dragged = false;
      if (wasDrag) {
        if (collapsedPane === 'none') saveSplitPct(scenesSplitPct);
        return;
      }
      // Click cycles: both → collapse scenes → collapse layers → both
      if (collapsedPane === 'none') setCollapsedPane('scenes');
      else if (collapsedPane === 'scenes') setCollapsedPane('rest');
      else setCollapsedPane('none');
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pointerId = e.pointerId;
      startY = e.clientY;
      hostH = Math.max(1, host.getBoundingClientRect().height);
      const prior = collapsedPane;
      // Seed drag height so pulling out of a collapsed pane expands smoothly.
      if (prior === 'scenes') startScenesH = COLLAPSE_EDGE_PX;
      else if (prior === 'rest') startScenesH = hostH - COLLAPSE_EDGE_PX;
      else startScenesH = scenes.getBoundingClientRect().height;
      dragged = false;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    splitter.addEventListener('pointerdown', onDown);
    splitGrip.addEventListener('pointerdown', onDown);
  };
  bindSplitter();

  rest.append(
    section(
      'Car',
      [
        {
          label: api.viewer.carVisible ? 'Hide' : 'Show',
          onClick: () => {
            const next = !api.viewer.carVisible;
            api.viewer.setCarVisible(next);
            scene.carVisible = next;
            api.onChange();
            // Rebuild hierarchy so Hide/Show + "(hidden)" update immediately.
            renderHierarchy(host, api);
          },
        },
      ],
      [
        {
          id: CAR_ID,
          label: api.viewer.carVisible ? 'BMW M Hybrid V8' : 'BMW M Hybrid V8 (hidden)',
          kind: 'car' as const,
          active: sel.kind === 'car' && sel.id === CAR_ID,
        },
      ],
      api,
    ),
  );

  rest.append(
    section(
      'Cameras',
      [
        {
          label: api.cameras.helpersVisible ? 'Hide' : 'Show',
          onClick: () => {
            api.cameras.setHelpersVisible(!api.cameras.helpersVisible);
            api.onChange();
          },
        },
        {
          label: '+',
          onClick: () => {
            api.cameras.enterFree();
            const clip = api.cameras.add();
            scene.cameras = api.cameras.clips.map((c) => structuredClone(c));
            api.select('camera', clip.id);
            api.onChange();
          },
        },
        ...(api.onClearScene
          ? [
              {
                label: 'Clear',
                title:
                  'Delete all cameras and timeline keyframes. Free camera stays.',
                onClick: () => api.onClearScene?.(),
              },
            ]
          : []),
      ],
      [
        {
          id: FREE_CAMERA_ID,
          label:
            api.cameras.viewMode === 'free'
              ? 'Free Camera'
              : 'Free Camera · return',
          kind: 'freeCamera' as const,
          active: sel.kind === 'freeCamera',
        },
        ...api.cameras.clips.map((c) => {
          const through =
            api.cameras.viewMode === 'through' &&
            api.cameras.throughCameraId === c.id;
          return {
            id: c.id,
            label: through ? `${c.name} ●` : c.name,
            kind: 'camera' as const,
            active: sel.kind === 'camera' && sel.id === c.id,
          };
        }),
      ],
      api,
    ),
  );

  rest.append(
    section(
      'Lights',
      [
        {
          label: '+ Point',
          onClick: () => {
            const entry = api.viewer.customLights.addPoint();
            api.select('light', entry.id);
            api.onChange();
          },
        },
        {
          label: '+ Spot',
          onClick: () => {
            const entry = api.viewer.customLights.addSpot();
            api.select('light', entry.id);
            api.onChange();
          },
        },
      ],
      [
        {
          id: LIGHTING_ID,
          label: 'Lighting',
          kind: 'lighting' as const,
          active: sel.kind === 'lighting' && sel.id === LIGHTING_ID,
        },
        {
          id: CAR_LIGHTS_ID,
          label: 'Car Lights',
          kind: 'carLights' as const,
          active: sel.kind === 'carLights' && sel.id === CAR_LIGHTS_ID,
        },
        {
          id: ROOF_STROBE_ID,
          label: 'Roof Strobe',
          kind: 'roofStrobe' as const,
          active: sel.kind === 'roofStrobe' && sel.id === ROOF_STROBE_ID,
        },
        {
          id: AIRFLOW_ID,
          label: 'Airflow',
          kind: 'airflow' as const,
          active: sel.kind === 'airflow' && sel.id === AIRFLOW_ID,
        },
        {
          id: MOTION_ID,
          label: 'Speed',
          kind: 'motion' as const,
          active: sel.kind === 'motion' && sel.id === MOTION_ID,
        },
        {
          id: DOT_GRID_ID,
          label: 'Dot Grid WRT',
          kind: 'dotGrid' as const,
          active: sel.kind === 'dotGrid' && sel.id === DOT_GRID_ID,
        },
        ...api.viewer.customLights.entries.map((e) => ({
          id: e.id,
          label: e.params.name,
          kind: 'light' as const,
          active: sel.kind === 'light' && sel.id === e.id,
        })),
      ],
      api,
    ),
  );

  rest.append(
    section(
      'Rectangles',
      [
        {
          label: '+',
          onClick: () => {
            const plane = api.planes.add();
            scene.planes = api.planes.serialize();
            api.select('plane', plane.id);
            api.onChange();
          },
        },
      ],
      api.planes.entries.map((e) => ({
        id: e.id,
        label: e.params.name,
        kind: 'plane' as const,
        active: sel.kind === 'plane' && sel.id === e.id,
      })),
      api,
    ),
  );

  rest.append(
    section(
      'Paths',
      [
        {
          label: '+',
          onClick: () => {
            const path = api.paths.add();
            scene.paths = api.paths.serialize();
            api.select('path', path.id);
            api.onChange();
          },
        },
      ],
      api.paths.entries.map((e) => ({
        id: e.id,
        label: e.params.name,
        kind: 'path' as const,
        active: sel.kind === 'path' && sel.id === e.id,
      })),
      api,
    ),
  );
}
