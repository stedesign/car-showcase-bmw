import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import {
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
  onChange: () => void;
  onSelectScene?: (sceneId: string) => void;
  onAddScene?: () => void;
  onDuplicateScene?: () => void;
  onDeleteScene?: (sceneId: string) => void;
  onDeleteAllScenes?: () => void;
  onRenameScene?: (sceneId: string, name: string) => void;
  /** Delete timeline keyframes and dedicated cameras. Free camera stays. */
  onClearScene?: () => void;
};

const SIDEBAR_COLLAPSE_KEY = 'wrt-director-sidebar-collapsed';
const TWIST_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">' +
  '<path d="M2.2 3.5 L5 6.5 L7.8 3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

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

const collapsedSections = loadCollapsedSections();

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
  for (const s of project.scenes) {
    const row = document.createElement('div');
    row.className = `ed-tree-item${s.id === scene.id ? ' active' : ''}`;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
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
  applySectionFold(scenesHead, scenesBody, 'scenes', 'Scenes');
  scenes.append(scenesHead, scenesBody);
  host.append(scenes);

  const rest = document.createElement('div');
  rest.className = 'ed-sidebar-rest';
  host.append(rest);

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
}
