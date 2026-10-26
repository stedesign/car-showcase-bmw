import { ENVIRONMENT_PRESETS, type Viewer } from '../../viewer/Viewer';
import { logoMarkIndex } from '../../viewer/wrtLogo';
import {
  DEFAULT_DOT_GRID_PARAMS,
  DOT_GRID_EFFECT_MODES,
} from '../../viewer/dottedWrtScreen';

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

function selectInput(
  value: string,
  options: Array<{ value: string; label: string }>,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    select.append(o);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
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

  const roof = details('Roof strobe');
  const rs = viewer.roofStrobe.params;
  const applyRs = () => viewer.roofStrobe.applyParams();
  roof.body.append(
    field('Enabled', checkInput(rs.enabled, note((v) => {
      rs.enabled = v;
      applyRs();
    }))),
    field(
      'Intensity',
      numInput(rs.intensity, 0, 30, 0.05, note((v) => {
        rs.intensity = v;
        applyRs();
      })),
    ),
    field(
      'Color',
      colorInput(rs.color, note((v) => {
        rs.color = v;
        applyRs();
      })),
    ),
    field(
      'Flash duration (s)',
      numInput(rs.flashDuration, 1, 10, 0.1, note((v) => {
        rs.flashDuration = v;
        applyRs();
      })),
    ),
    field(
      'Strobe Hz',
      numInput(rs.strobeHz, 1, 16, 0.1, note((v) => {
        rs.strobeHz = v;
        applyRs();
      })),
    ),
    field('Strobing', checkInput(rs.strobing, note((v) => {
      rs.strobing = v;
      applyRs();
    }))),
    field(
      'Width',
      numInput(rs.width, 0.3, 3, 0.01, note((v) => {
        rs.width = v;
        applyRs();
      })),
    ),
    field(
      'Length',
      numInput(rs.length, 0.5, 8, 0.05, note((v) => {
        rs.length = v;
        applyRs();
      })),
    ),
    field(
      'Thickness',
      numInput(rs.thickness, 0.04, 0.5, 0.01, note((v) => {
        rs.thickness = v;
        applyRs();
      })),
    ),
    field(
      'Height offset',
      numInput(rs.yOffset, 0.1, 3, 0.01, note((v) => {
        rs.yOffset = v;
        applyRs();
      })),
    ),
  );
  const roofFlash = document.createElement('button');
  roofFlash.type = 'button';
  roofFlash.className = 'ed-btn';
  roofFlash.textContent = 'Trigger strobe';
  roofFlash.addEventListener('click', () => {
    viewer.roofStrobe.triggerFlash(rs.flashDuration);
    onEdit?.();
  });
  const roofStop = document.createElement('button');
  roofStop.type = 'button';
  roofStop.className = 'ed-btn';
  roofStop.textContent = 'Stop';
  roofStop.addEventListener('click', () => {
    viewer.roofStrobe.stopFlash();
    rs.strobing = false;
    applyRs();
    onEdit?.();
  });
  const roofBtnRow = document.createElement('div');
  roofBtnRow.className = 'ed-field';
  roofBtnRow.style.display = 'flex';
  roofBtnRow.style.gap = '8px';
  roofBtnRow.append(roofFlash, roofStop);
  roof.body.append(roofBtnRow);
  host.append(roof.root);

  const air = details('Airflow');
  air.root.open = true;
  const af = viewer.airflow.params;
  const applyAir = () => viewer.airflow.applyParams();
  air.body.append(
    field('On', checkInput(af.enabled, note((v) => {
      af.enabled = v;
      applyAir();
    }))),
    field(
      'Speed',
      numInput(af.speed, 0, 3, 0.01, note((v) => {
        af.speed = v;
        applyAir();
      })),
    ),
    field(
      'Brightness',
      numInput(af.brightness, 0, 8, 0.01, note((v) => {
        af.brightness = v;
        applyAir();
      })),
    ),
    field(
      'Opacity',
      numInput(af.opacity, 0, 1, 0.01, note((v) => {
        af.opacity = v;
        applyAir();
      })),
    ),
    field(
      'Width',
      numInput(af.width, 0.25, 4, 0.01, note((v) => {
        af.width = v;
        applyAir();
      })),
    ),
    field(
      'Flow color',
      colorInput(af.flowColor, note((v) => {
        af.flowColor = v;
        applyAir();
      })),
    ),
    field(
      'Accent color',
      colorInput(af.accentColor, note((v) => {
        af.accentColor = v;
        applyAir();
      })),
    ),
  );
  host.append(air.root);

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
      'Mark',
      selectInput(
        String(logoMarkIndex(viewer.logo.params.mark)),
        [
          { value: '0', label: 'WRT' },
          { value: '1', label: 'We are a team' },
        ],
        note((v) => {
          const mark = logoMarkIndex(Number(v));
          viewer.logo.params.mark = mark;
          viewer.dotGrid.params.mark = mark;
          viewer.logo.applyParams();
          viewer.dotGrid.applyParams();
        }),
      ),
    ),
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

  const dotGrid = details('Dot Grid WRT');
  const dg = viewer.dotGrid.params;
  const applyDg = () => viewer.dotGrid.applyParams();
  const modeOptions = DOT_GRID_EFFECT_MODES.map((m) => ({
    value: String(m.id),
    label: m.name,
  }));
  dotGrid.body.append(
    field('Enabled', checkInput(dg.enabled, note((v) => {
      dg.enabled = v;
      applyDg();
    }))),
    field(
      'Effect',
      selectInput(String(Math.round(dg.effectMode)), modeOptions, note((v) => {
        dg.effectMode = parseInt(v, 10);
        applyDg();
      })),
    ),
    field(
      'Effect strength',
      numInput(dg.effectStrength, 0, 2, 0.01, note((v) => {
        dg.effectStrength = v;
        applyDg();
      })),
    ),
    field(
      'Opacity',
      numInput(dg.opacity, 0, 1, 0.01, note((v) => {
        dg.opacity = v;
        applyDg();
      })),
    ),
    field(
      'Reveal',
      numInput(dg.reveal, 0, 1, 0.01, note((v) => {
        dg.reveal = v;
        applyDg();
      })),
    ),
    field(
      'Pulse',
      numInput(dg.pulse, 0, 2, 0.01, note((v) => {
        dg.pulse = v;
        applyDg();
      })),
    ),
    field(
      'Wave / speed',
      numInput(dg.wave, 0, 2, 0.01, note((v) => {
        dg.wave = v;
        applyDg();
      })),
    ),
    field(
      'Glow',
      numInput(dg.glow, 0, 2, 0.01, note((v) => {
        dg.glow = v;
        applyDg();
      })),
    ),
    field(
      'Density',
      numInput(dg.density, 24, 160, 1, note((v) => {
        dg.density = v;
        applyDg();
      })),
    ),
    field(
      'Distance',
      numInput(dg.distance, 4, 24, 0.1, note((v) => {
        dg.distance = v;
        applyDg();
      })),
    ),
    field(
      'Height',
      numInput(dg.height, 0.5, 8, 0.05, note((v) => {
        dg.height = v;
        applyDg();
      })),
    ),
    field(
      'Scale',
      numInput(dg.scale, 0.3, 3, 0.05, note((v) => {
        dg.scale = v;
        applyDg();
      })),
    ),
    field('Base', colorInput(dg.baseColor, note((v) => {
      dg.baseColor = v;
      applyDg();
    }))),
    field('Active', colorInput(dg.activeColor, note((v) => {
      dg.activeColor = v;
      applyDg();
    }))),
    field('Floor reflection', checkInput(dg.reflectionEnabled, note((v) => {
      dg.reflectionEnabled = v;
      applyDg();
    }))),
    field(
      'Reflect opacity',
      numInput(dg.reflectionOpacity, 0, 1, 0.01, note((v) => {
        dg.reflectionOpacity = v;
        applyDg();
      })),
    ),
    field(
      'Reflect length',
      numInput(dg.reflectionLength, 0.5, 8, 0.05, note((v) => {
        dg.reflectionLength = v;
        applyDg();
      })),
    ),
  );
  const flashBtn = document.createElement('button');
  flashBtn.type = 'button';
  flashBtn.className = 'ed-btn';
  flashBtn.textContent = 'Trigger flash';
  flashBtn.addEventListener('click', () => viewer.dotGrid.triggerFlash(1.35));
  const frameBtn = document.createElement('button');
  frameBtn.type = 'button';
  frameBtn.className = 'ed-btn';
  frameBtn.textContent = 'Frame screen';
  frameBtn.title = 'Move free camera to look at the dotted WRT wall';
  frameBtn.addEventListener('click', () => viewer.frameDotGridScreen());
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'ed-btn';
  resetBtn.textContent = 'Reset defaults';
  resetBtn.addEventListener('click', () => {
    Object.assign(dg, structuredClone(DEFAULT_DOT_GRID_PARAMS));
    applyDg();
    onEdit?.();
    renderLookPanel(viewer, host, onEdit);
    // Frame after rebuild so camera uses the fresh placement.
    requestAnimationFrame(() => viewer.frameDotGridScreen());
  });
  const btnRow = document.createElement('div');
  btnRow.className = 'ed-field';
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';
  btnRow.style.flexWrap = 'wrap';
  btnRow.append(frameBtn, flashBtn, resetBtn);
  dotGrid.body.append(btnRow);
  host.append(dotGrid.root);

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
