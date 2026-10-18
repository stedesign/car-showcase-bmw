import { ENVIRONMENT_PRESETS, type Viewer } from '../../viewer/Viewer';

function field(
  label: string,
  control: HTMLElement,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ed-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.append(lab, control);
  return row;
}

function numInput(
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
  input.addEventListener('input', () => onChange(parseFloat(input.value)));
  return input;
}

function colorInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value.startsWith('#') ? value : '#ffffff';
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function checkInput(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function details(title: string): { root: HTMLDetailsElement; body: HTMLElement } {
  const root = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('div');
  root.append(summary, body);
  return { root, body };
}

export function renderLookPanel(
  viewer: Viewer,
  host: HTMLElement,
  onEdit?: () => void,
): void {
  host.replaceChildren();
  host.className = 'ed-look';

  const note = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    onEdit?.();
  };

  const display = details('Display');
  display.body.append(
    field('Show car', checkInput(viewer.carVisible, note((v) => {
      viewer.setCarVisible(v);
    }))),
    field('Background', checkInput(viewer.state.display.background, note((v) => {
      viewer.state.display.background = v;
      viewer.applyDisplay();
    }))),
    field('Auto rotate', checkInput(viewer.state.display.autoRotate, note((v) => {
      viewer.state.display.autoRotate = v;
      viewer.applyDisplay();
    }))),
    field('Grid', checkInput(viewer.state.display.grid, note((v) => {
      viewer.state.display.grid = v;
      viewer.applyDisplay();
    }))),
    field('BG color', colorInput(viewer.state.display.bgColor, note((v) => {
      viewer.state.display.bgColor = v;
      viewer.applyDisplay();
    }))),
    field(
      'Floor reflect',
      numInput(viewer.state.floorReflectivity, 0, 1, 0.01, note((v) => viewer.setFloorReflectivity(v))),
    ),
    field(
      'Floor puddles',
      numInput(viewer.state.floorPuddles, 0, 1, 0.01, note((v) => viewer.setFloorPuddles(v))),
    ),
  );
  host.append(display.root);

  const lighting = details('Lighting');
  const envSelect = document.createElement('select');
  for (const preset of ENVIRONMENT_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset;
    opt.textContent = preset;
    if (preset === viewer.state.lighting.environment) opt.selected = true;
    envSelect.append(opt);
  }
  envSelect.addEventListener('change', () => {
    viewer.state.lighting.environment = envSelect.value as typeof viewer.state.lighting.environment;
    void viewer.applyEnvironment();
    onEdit?.();
  });
  lighting.body.append(
    field('Environment', envSelect),
    field(
      'Env intensity',
      numInput(viewer.state.lighting.environmentIntensity, 0, 3, 0.01, note((v) => {
        viewer.state.lighting.environmentIntensity = v;
        viewer.applyEnvironmentTuning();
      })),
    ),
    field(
      'Exposure',
      numInput(viewer.state.lighting.exposure, 0, 2, 0.01, note((v) => {
        viewer.state.lighting.exposure = v;
        viewer.applyLighting();
      })),
    ),
    field(
      'Key intensity',
      numInput(viewer.state.lighting.directIntensity, 0, 3, 0.01, note((v) => {
        viewer.state.lighting.directIntensity = v;
        viewer.applyLighting();
      })),
    ),
  );
  host.append(lighting.root);

  const soft = details('Softboxes');
  soft.body.append(
    field('Enabled', checkInput(viewer.softboxes.params.enabled, note((v) => {
      viewer.softboxes.params.enabled = v;
      viewer.softboxes.applyParams();
    }))),
    field(
      'Intensity',
      numInput(viewer.softboxes.params.intensity, 0, 4, 0.01, note((v) => {
        viewer.softboxes.params.intensity = v;
        viewer.softboxes.applyParams();
      })),
    ),
    field(
      'Key',
      numInput(viewer.softboxes.params.keyIntensity, 0, 10, 0.1, note((v) => {
        viewer.softboxes.params.keyIntensity = v;
        viewer.softboxes.applyParams();
      })),
    ),
    field(
      'Fill',
      numInput(viewer.softboxes.params.fillIntensity, 0, 10, 0.1, note((v) => {
        viewer.softboxes.params.fillIntensity = v;
        viewer.softboxes.applyParams();
      })),
    ),
    field(
      'Rim',
      numInput(viewer.softboxes.params.rimIntensity, 0, 10, 0.1, note((v) => {
        viewer.softboxes.params.rimIntensity = v;
        viewer.softboxes.applyParams();
      })),
    ),
  );
  host.append(soft.root);

  const paint = details('Paint');
  paint.body.append(
    field(
      'Clearcoat',
      numInput(viewer.carMaterials.params.clearcoat, 0, 1, 0.01, note((v) => {
        viewer.carMaterials.params.clearcoat = v;
        viewer.carMaterials.applyParams();
      })),
    ),
    field(
      'Paint env',
      numInput(viewer.carMaterials.params.paintEnv, 0, 3, 0.01, note((v) => {
        viewer.carMaterials.params.paintEnv = v;
        viewer.carMaterials.applyParams();
      })),
    ),
  );
  host.append(paint.root);

  const fx = details('FX');
  fx.body.append(
    field('Bloom', checkInput(viewer.effects.params.bloomEnabled, note((v) => {
      viewer.effects.params.bloomEnabled = v;
      viewer.effects.applyParams();
    }))),
    field(
      'Bloom strength',
      numInput(viewer.effects.params.bloomStrength, 0, 2, 0.01, note((v) => {
        viewer.effects.params.bloomStrength = v;
        viewer.effects.applyParams();
      })),
    ),
    field('Smoke', checkInput(viewer.effects.params.smokeEnabled, note((v) => {
      viewer.effects.params.smokeEnabled = v;
      viewer.effects.applyParams();
    }))),
    field(
      'Fog opacity',
      numInput(viewer.effects.params.fogOpacity, 0, 1, 0.01, note((v) => {
        viewer.effects.params.fogOpacity = v;
        viewer.effects.applyParams();
      })),
    ),
    field('Grain', checkInput(viewer.effects.params.grainEnabled, note((v) => {
      viewer.effects.params.grainEnabled = v;
      viewer.effects.applyParams();
    }))),
  );
  host.append(fx.root);

  const logo = details('WRT Logo');
  logo.body.append(
    field('Enabled', checkInput(viewer.logo.params.enabled, note((v) => {
      viewer.logo.params.enabled = v;
      viewer.logo.applyParams();
    }))),
    field(
      'Intensity',
      numInput(viewer.logo.params.intensity, 0, 8, 0.05, note((v) => {
        viewer.logo.params.intensity = v;
        viewer.logo.applyParams();
      })),
    ),
    field('Strobe', checkInput(viewer.logo.params.strobeEnabled, note((v) => {
      viewer.logo.params.strobeEnabled = v;
      viewer.logo.applyParams();
    }))),
  );
  host.append(logo.root);

  const carLights = details('Car lights');
  const cl = viewer.carLights.params;
  const applyCl = () => viewer.carLights.applyParams();
  carLights.body.append(
    field('Enabled', checkInput(cl.enabled, note((v) => {
      cl.enabled = v;
      applyCl();
    }))),
    field('Grille outline', checkInput(cl.grilleEnabled, note((v) => {
      cl.grilleEnabled = v;
      applyCl();
    }))),
    field(
      'Grille strength',
      numInput(cl.grilleStrength, 0, 20, 0.01, note((v) => {
        cl.grilleStrength = v;
        applyCl();
      })),
    ),
    field('Headlight edge', checkInput(cl.edgeEnabled, note((v) => {
      cl.edgeEnabled = v;
      applyCl();
    }))),
    field(
      'Edge strength',
      numInput(cl.edgeStrength, 0, 20, 0.01, note((v) => {
        cl.edgeStrength = v;
        applyCl();
      })),
    ),
    field('Rear red', checkInput(cl.redEnabled, note((v) => {
      cl.redEnabled = v;
      applyCl();
    }))),
    field(
      'Red strength',
      numInput(cl.redStrength, 0, 20, 0.01, note((v) => {
        cl.redStrength = v;
        applyCl();
      })),
    ),
    field('Ground glow', checkInput(cl.groundGlow, note((v) => {
      cl.groundGlow = v;
      applyCl();
    }))),
    field(
      'Glow strength',
      numInput(cl.groundGlowStrength, 0, 10, 0.01, note((v) => {
        cl.groundGlowStrength = v;
        applyCl();
      })),
    ),
    field('Beams', checkInput(cl.beamsEnabled, note((v) => {
      cl.beamsEnabled = v;
      applyCl();
    }))),
    field(
      'Beam strength',
      numInput(cl.beamStrength, 0, 3, 0.01, note((v) => {
        cl.beamStrength = v;
        applyCl();
      })),
    ),
  );
  host.append(carLights.root);
}
