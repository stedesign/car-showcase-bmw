import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import type { TextsHandle } from '../texts';
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
  texts: TextsHandle;
  onChange: () => void;
  onSelectScene?: (sceneId: string) => void;
  onAddScene?: () => void;
  onDuplicateScene?: () => void;
  onDeleteScene?: (sceneId: string) => void;
  onRenameScene?: (sceneId: string, name: string) => void;
};

function section(
  title: string,
  actions: { label: string; onClick: () => void }[],
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
  btns.className = 'ed-row';
  btns.style.margin = '0';
  for (const action of actions) {
    const b = document.createElement('button');
    b.className = 'ed-btn';
    b.textContent = action.label;
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

  root.append(head, body);
  return root;
}

export function renderHierarchy(host: HTMLElement, api: HierarchyApi): void {
  host.replaceChildren();
  const project = api.getProject();
  const scene = api.getScene();
  const sel = api.getSelection();

  const scenes = document.createElement('div');
  scenes.className = 'ed-section';
  const scenesHead = document.createElement('div');
  scenesHead.className = 'ed-section-title';
  const scenesTitle = document.createElement('span');
  scenesTitle.textContent = 'Scenes';
  const scenesBtns = document.createElement('div');
  scenesBtns.className = 'ed-row';
  scenesBtns.style.margin = '0';
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
  scenes.append(scenesHead, scenesBody);
  host.append(scenes);

  host.append(
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

  host.append(
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

  host.append(
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

  host.append(
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

  host.append(
    section(
      'Texts',
      [
        {
          label: '+',
          onClick: () => {
            const text = api.texts.add();
            scene.texts = api.texts.serialize();
            api.select('text', text.id);
            api.onChange();
          },
        },
      ],
      api.texts.entries.map((e) => ({
        id: e.id,
        label: e.params.name,
        kind: 'text' as const,
        active: sel.kind === 'text' && sel.id === e.id,
      })),
      api,
    ),
  );
}
