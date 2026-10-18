import type { Viewer } from '../../viewer/Viewer';
import type { CamerasHandle } from '../cameras';
import { ensureExtrudeDepth, type PlanesHandle } from '../planes';
import { TEXT_PRESETS, type TextsHandle } from '../texts';
import {
  CAR_ID,
  CAR_LIGHTS_ID,
  FREE_CAMERA_ID,
  type Project,
  type Selection,
  type Vec3,
} from '../project';
import { renderLookPanel } from './lookPanel';

export type InspectorApi = {
  viewer: Viewer;
  getProject: () => Project;
  getSelection: () => Selection;
  cameras: CamerasHandle;
  planes: PlanesHandle;
  texts: TextsHandle;
  onChange: () => void;
  /** History-only (no panel rebuild) — used by look sliders. */
  onLookEdit: () => void;
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

function slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.title = String(Number(value.toFixed(3)));
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    input.title = String(Number(v.toFixed(3)));
    onChange(v);
  });
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
    p.textContent = 'Select a camera, light, rectangle, or text.';
    body.append(p);
  } else if (sel.kind === 'car' && sel.id === CAR_ID) {
    body.append(
      field(
        'Visible',
        check(api.viewer.carVisible, (v) => {
          api.viewer.setCarVisible(v);
          project.carVisible = v;
          api.onChange();
        }),
      ),
    );
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--ed-muted);font-size:11px;margin:8px 0 0';
    hint.textContent =
      'Animate Visible on the timeline to reveal / hide the car.';
    body.append(hint);
  } else if (sel.kind === 'freeCamera' && sel.id === FREE_CAMERA_ID) {
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--ed-muted);font-size:12px;padding:4px 0 8px';
    hint.textContent =
      'Orbit / pan / zoom freely. Dedicated cameras stay as gizmos in the scene — select one to move it without leaving free view.';
    body.append(hint);
    body.append(
      btn('Stay in free view', () => {
        api.cameras.enterFree();
        api.setStatus('Free camera');
        api.onChange();
      }),
    );
  } else if (sel.kind === 'camera') {
    const clip = api.cameras.get(sel.id);
    if (clip) {
      const lookingThrough =
        api.cameras.viewMode === 'through' &&
        api.cameras.throughCameraId === clip.id;
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
            api.cameras.refreshHelpers();
            if (lookingThrough) api.cameras.applyClip(clip.id);
            api.onChange();
          }),
        ),
        field(
          'Position',
          vec3Inputs(clip.position, (v) => {
            clip.position = v;
            api.cameras.refreshHelpers();
            if (lookingThrough) api.cameras.applyClip(clip.id);
          }),
        ),
        field(
          'Target',
          vec3Inputs(clip.target, (v) => {
            clip.target = v;
            api.cameras.refreshHelpers();
            if (lookingThrough) api.cameras.applyClip(clip.id);
          }),
        ),
      );
      const gizmoRow = document.createElement('div');
      gizmoRow.className = 'ed-row';
      gizmoRow.append(
        btn('Move cam', () => {
          api.cameras.setGizmoTarget('body');
          api.cameras.setTransformMode('translate');
        }),
        btn('Rotate cam', () => {
          api.cameras.setGizmoTarget('body');
          api.cameras.setTransformMode('rotate');
        }),
        btn('Move aim', () => {
          api.cameras.setGizmoTarget('aim');
        }),
      );
      body.append(gizmoRow);

      const row = document.createElement('div');
      row.className = 'ed-row';
      row.append(
        btn(lookingThrough ? 'Looking through ●' : 'Look through', () => {
          api.cameras.lookThrough(clip.id);
          api.cameras.setPlayCameraId(clip.id);
          project.playCameraId = clip.id;
          api.setStatus(`Looking through ${clip.name}`);
          api.onChange();
        }, lookingThrough ? 'ed-btn primary' : 'ed-btn'),
        btn('Back to free', () => {
          api.cameras.enterFree();
          api.cameras.select(clip.id);
          api.setStatus('Free camera — drag gizmo to move/rotate');
          api.onChange();
        }),
        btn('Capture free view', () => {
          api.cameras.enterFree();
          api.cameras.captureFromView(clip.id);
          api.cameras.select(clip.id);
          api.setStatus(`Captured free view → ${clip.name}`);
          api.onChange();
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
      const tip = document.createElement('p');
      tip.style.cssText = 'color:var(--ed-muted);font-size:11px;margin:8px 0 0';
      tip.textContent = lookingThrough
        ? 'Looking through this shot. Use Back to free to edit the gizmo in free view.'
        : 'Drag the transform gizmo to move/rotate. Use Move aim for the gold target. Look through to preview.';
      body.append(tip);
    }
  } else if (sel.kind === 'carLights' && sel.id === CAR_LIGHTS_ID) {
    const cl = api.viewer.carLights.params;
    const applyCl = () => api.viewer.carLights.applyParams();
    body.append(
      field(
        'Enabled',
        check(cl.enabled, (v) => {
          cl.enabled = v;
          applyCl();
        }),
      ),
      field(
        'Grille outline',
        check(cl.grilleEnabled, (v) => {
          cl.grilleEnabled = v;
          applyCl();
        }),
      ),
      field(
        'Grille strength',
        slider(cl.grilleStrength, 0, 20, 0.01, (v) => {
          cl.grilleStrength = v;
          applyCl();
        }),
      ),
      field(
        'Headlight edge',
        check(cl.edgeEnabled, (v) => {
          cl.edgeEnabled = v;
          applyCl();
        }),
      ),
      field(
        'Edge strength',
        slider(cl.edgeStrength, 0, 20, 0.01, (v) => {
          cl.edgeStrength = v;
          applyCl();
        }),
      ),
      field(
        'Rear red',
        check(cl.redEnabled, (v) => {
          cl.redEnabled = v;
          applyCl();
        }),
      ),
      field(
        'Red strength',
        slider(cl.redStrength, 0, 20, 0.01, (v) => {
          cl.redStrength = v;
          applyCl();
        }),
      ),
      field(
        'Ground glow',
        check(cl.groundGlow, (v) => {
          cl.groundGlow = v;
          applyCl();
        }),
      ),
      field(
        'Glow strength',
        slider(cl.groundGlowStrength, 0, 10, 0.01, (v) => {
          cl.groundGlowStrength = v;
          applyCl();
        }),
      ),
      field(
        'Beams',
        check(cl.beamsEnabled, (v) => {
          cl.beamsEnabled = v;
          applyCl();
        }),
      ),
      field(
        'Beam strength',
        slider(cl.beamStrength, 0, 3, 0.01, (v) => {
          cl.beamStrength = v;
          applyCl();
        }),
      ),
    );
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--ed-muted);font-size:11px;margin:8px 0 0';
    hint.textContent =
      'Scrub the timeline and press Animate to keyframe strengths / toggles.';
    body.append(hint);
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
          'Extrude',
          check(!!p.extrude, (v) => {
            p.extrude = v;
            ensureExtrudeDepth(p);
            api.planes.apply(entry.id);
            api.onChange();
          }),
        ),
        ...(p.extrude
          ? [
              field(
                'Depth',
                num(p.scale.z, 0.01, (v) => {
                  p.scale = { ...p.scale, z: Math.max(0.001, v) };
                  api.planes.apply(entry.id);
                }),
              ),
            ]
          : []),
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
          p.extrude ? 'Size (X Y)' : 'Scale',
          p.extrude
            ? (() => {
                const wrap = document.createElement('div');
                wrap.className = 'ed-vec3';
                const mk = (key: 'x' | 'y') => {
                  const input = num(p.scale[key], 0.01, (n) => {
                    p.scale = { ...p.scale, [key]: n };
                    api.planes.apply(entry.id);
                  });
                  input.title = key.toUpperCase();
                  return input;
                };
                wrap.append(mk('x'), mk('y'));
                return wrap;
              })()
            : vec3Inputs(p.scale, (v) => {
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
  renderLookPanel(api.viewer, lookHost, api.onLookEdit);
}
