import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import type { TextsHandle } from '../texts';
import type { Project, Selection } from '../project';

export type HierarchyApi = {
  viewer: Viewer;
  getProject: () => Project;
  getSelection: () => Selection;
  select: (kind: Selection['kind'], id: string | null) => void;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  texts: TextsHandle;
  onChange: () => void;
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
  const sel = api.getSelection();

  const scenes = document.createElement('div');
  scenes.className = 'ed-section';
  scenes.innerHTML = `
    <div class="ed-section-title"><span>Scenes</span></div>
    <div class="ed-section-body">
      <button class="ed-tree-item active" type="button">
        <span class="tag">scene</span><span>Scene 1</span>
      </button>
    </div>`;
  host.append(scenes);

  host.append(
    section(
      'Cameras',
      [
        {
          label: '+',
          onClick: () => {
            const clip = api.cameras.add();
            project.cameras = api.cameras.clips.map((c) => structuredClone(c));
            api.select('camera', clip.id);
            api.onChange();
          },
        },
      ],
      api.cameras.clips.map((c) => ({
        id: c.id,
        label: c.name,
        kind: 'camera' as const,
        active: sel.kind === 'camera' && sel.id === c.id,
      })),
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
      api.viewer.customLights.entries.map((e) => ({
        id: e.id,
        label: e.params.name,
        kind: 'light' as const,
        active: sel.kind === 'light' && sel.id === e.id,
      })),
      api,
    ),
  );

  host.append(
    section(
      'Planes',
      [
        {
          label: '+',
          onClick: () => {
            const plane = api.planes.add();
            project.planes = api.planes.serialize();
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
            project.texts = api.texts.serialize();
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
