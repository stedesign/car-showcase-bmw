import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import type { PlanesHandle } from '../planes';
import { TEXT_PRESETS, type TextsHandle } from '../texts';
import type { Project, Selection, Vec3 } from '../project';
import { renderLookPanel } from './lookPanel';

export type InspectorApi = {
  viewer: Viewer;
  getProject: () => Project;
  getSelection: () => Selection;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  texts: TextsHandle;
  onChange: () => void;
  setStatus: (msg: string) => void;
};

function field(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ed-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.append(lab, control);
  return row;
}

function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function areaInput(value: string, onChange: (v: string) => void): HTMLTextAreaElement {
  const input = document.createElement('textarea');
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function num(
  value: number,
  step: number,
  onChange: (v: number) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(Number(value.toFixed(3)));
  input.addEventListener('change', () => onChange(parseFloat(input.value) || 0));
  return input;
}

function vec3Inputs(v: Vec3, onChange: (v: Vec3) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ed-vec3';
  const mk = (key: keyof Vec3) => {
    const input = num(v[key], 0.01, (n) => {
      const next = { ...v, [key]: n };
      onChange(next);
    });
    input.title = key.toUpperCase();
    return input;
  };
  wrap.append(mk('x'), mk('y'), mk('z'));
  return wrap;
}

function colorInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value.startsWith('#') ? value.slice(0, 7) : '#ffffff';
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function check(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function btn(label: string, onClick: () => void, cls = 'ed-btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function renderInspector(host: HTMLElement, api: InspectorApi): void {
  host.replaceChildren();
  const sel = api.getSelection();
  const project = api.getProject();

  const selectionHost = document.createElement('div');
  selectionHost.className = 'ed-section';
  const title = document.createElement('div');
  title.className = 'ed-section-title';
  title.innerHTML = '<span>Inspector</span>';
  const body = document.createElement('div');
  body.className = 'ed-section-body';
  selectionHost.append(title, body);
  host.append(selectionHost);

  if (!sel.kind || !sel.id) {
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--ed-muted);font-size:12px;padding:4px 0 12px';
    p.textContent = 'Select a camera, light, plane, or text.';
    body.append(p);
  } else if (sel.kind === 'camera') {
    const clip = api.cameras.get(sel.id);
    if (clip) {
      body.append(
        field(
          'Name',
          textInput(clip.name, (v) => {
            clip.name = v;
            api.onChange();
          }),
        ),
        field(
          'FOV',
          num(clip.fov, 0.1, (v) => {
            clip.fov = v;
            api.cameras.applyClip(clip.id);
            api.onChange();
          }),
        ),
        field(
          'Position',
          vec3Inputs(clip.position, (v) => {
            clip.position = v;
            api.cameras.applyClip(clip.id);
          }),
        ),
        field(
          'Target',
          vec3Inputs(clip.target, (v) => {
            clip.target = v;
            api.cameras.applyClip(clip.id);
          }),
        ),
      );
      const row = document.createElement('div');
      row.className = 'ed-row';
      row.append(
        btn('Capture view', () => {
          api.cameras.captureFromView(clip.id);
          api.setStatus(`Captured ${clip.name}`);
          api.onChange();
        }),
        btn('Apply', () => {
          api.cameras.applyClip(clip.id);
          api.cameras.setPlayCameraId(clip.id);
          project.playCameraId = clip.id;
        }),
        btn(
          'Delete',
          () => {
            if (api.cameras.remove(clip.id)) {
              project.cameras = api.cameras.clips.map((c) => structuredClone(c));
              project.playCameraId = api.cameras.playCameraId;
              api.onChange();
            }
          },
          'ed-btn danger',
        ),
      );
      body.append(row);
    }
  } else if (sel.kind === 'light') {
    const entry = api.viewer.customLights.entries.find((e) => e.id === sel.id);
    if (entry) {
      const p = entry.params;
      body.append(
        field(
          'Name',
          textInput(p.name, (v) => {
            p.name = v;
            api.viewer.customLights.apply(entry.id);
            api.onChange();
          }),
        ),
        field(
          'Enabled',
          check(p.enabled, (v) => {
            p.enabled = v;
            api.viewer.customLights.apply(entry.id);
          }),
        ),
        field(
          'Intensity',
          num(p.intensity, 0.05, (v) => {
            p.intensity = v;
            api.viewer.customLights.apply(entry.id);
          }),
        ),
        field(
          'Color',
          colorInput(p.color, (v) => {
            p.color = v;
            api.viewer.customLights.apply(entry.id);
          }),
        ),
        field(
          'Position',
          vec3Inputs({ x: p.x, y: p.y, z: p.z }, (v) => {
            p.x = v.x;
            p.y = v.y;
            p.z = v.z;
            api.viewer.customLights.apply(entry.id);
          }),
        ),
      );
      if (p.type === 'spot') {
        body.append(
          field(
            'Angle',
            num(p.angle, 1, (v) => {
              p.angle = v;
              api.viewer.customLights.apply(entry.id);
            }),
          ),
        );
        const modes = document.createElement('div');
        modes.className = 'ed-row';
        modes.append(
          btn('Move', () => api.viewer.customLights.setTransformMode('translate')),
          btn('Rotate', () => api.viewer.customLights.setTransformMode('rotate')),
        );
        body.append(modes);
      }
      body.append(
        btn(
          'Delete',
          () => {
            api.viewer.customLights.select(entry.id);
            api.viewer.customLights.removeSelected();
            api.onChange();
          },
          'ed-btn danger',
        ),
      );
    }
  } else if (sel.kind === 'plane') {
    const entry = api.planes.entries.find((e) => e.id === sel.id);
    if (entry) {
      const p = entry.params;
      body.append(
        field(
          'Name',
          textInput(p.name, (v) => {
            p.name = v;
            api.planes.apply(entry.id);
            api.onChange();
          }),
        ),
        field(
          'Opacity',
          num(p.opacity, 0.01, (v) => {
            p.opacity = v;
            api.planes.apply(entry.id);
          }),
        ),
        field(
          'Cast shadow',
          check(p.castShadow, (v) => {
            p.castShadow = v;
            api.planes.apply(entry.id);
          }),
        ),
        field(
          'Color',
          colorInput(p.color, (v) => {
            p.color = v;
            api.planes.apply(entry.id);
          }),
        ),
        field(
          'Position',
          vec3Inputs(p.position, (v) => {
            p.position = v;
            api.planes.apply(entry.id);
          }),
        ),
        field(
          'Rotation',
          vec3Inputs(p.rotation, (v) => {
            p.rotation = v;
            api.planes.apply(entry.id);
          }),
        ),
        field(
          'Scale',
          vec3Inputs(p.scale, (v) => {
            p.scale = v;
            api.planes.apply(entry.id);
          }),
        ),
      );
      const modes = document.createElement('div');
      modes.className = 'ed-row';
      modes.append(
        btn('Move', () => api.planes.setTransformMode('translate')),
        btn('Rotate', () => api.planes.setTransformMode('rotate')),
        btn('Scale', () => api.planes.setTransformMode('scale')),
        btn(
          'Delete',
          () => {
            api.planes.remove(entry.id);
            project.planes = api.planes.serialize();
            api.onChange();
          },
          'ed-btn danger',
        ),
      );
      body.append(modes);
    }
  } else if (sel.kind === 'text') {
    const entry = api.texts.entries.find((e) => e.id === sel.id);
    if (entry) {
      const p = entry.params;
      body.append(
        field(
          'Name',
          textInput(p.name, (v) => {
            p.name = v;
            api.onChange();
          }),
        ),
        field(
          'Content',
          areaInput(p.content, (v) => {
            p.content = v;
            api.texts.apply(entry.id);
          }),
        ),
        field(
          'Opacity',
          num(p.opacity, 0.01, (v) => {
            p.opacity = v;
            api.texts.apply(entry.id);
          }),
        ),
        field(
          'Scale',
          num(p.scale, 0.05, (v) => {
            p.scale = v;
            api.texts.apply(entry.id);
          }),
        ),
        field(
          'Color',
          colorInput(p.color, (v) => {
            p.color = v;
            api.texts.apply(entry.id);
          }),
        ),
        field(
          'Billboard',
          check(p.billboard, (v) => {
            p.billboard = v;
            api.texts.apply(entry.id);
          }),
        ),
        field(
          'Position',
          vec3Inputs(p.position, (v) => {
            p.position = v;
            api.texts.apply(entry.id);
          }),
        ),
      );
      const presets = document.createElement('select');
      const ph = document.createElement('option');
      ph.textContent = 'Insert preset…';
      ph.value = '';
      presets.append(ph);
      for (const preset of TEXT_PRESETS) {
        const opt = document.createElement('option');
        opt.value = preset.content;
        opt.textContent = preset.label;
        presets.append(opt);
      }
      presets.addEventListener('change', () => {
        if (!presets.value) return;
        p.content = presets.value;
        api.texts.apply(entry.id);
        api.onChange();
        presets.value = '';
      });
      body.append(field('Preset', presets));
      const modes = document.createElement('div');
      modes.className = 'ed-row';
      modes.append(
        btn('Move', () => api.texts.setTransformMode('translate')),
        btn('Rotate', () => api.texts.setTransformMode('rotate')),
        btn('Scale', () => api.texts.setTransformMode('scale')),
        btn(
          'Delete',
          () => {
            api.texts.remove(entry.id);
            project.texts = api.texts.serialize();
            api.onChange();
          },
          'ed-btn danger',
        ),
      );
      body.append(modes);
    }
  }

  const lookHost = document.createElement('div');
  host.append(lookHost);
  renderLookPanel(api.viewer, lookHost);
}
