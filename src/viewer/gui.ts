import GUI from 'lil-gui';
import { ENVIRONMENT_PRESETS, type Viewer } from './Viewer';
import type { Recorder } from '../recorder/Recorder';
import {
  applySettings,
  captureSettings,
  clearSettingsStorage,
  defaultSettings,
  loadSettingsFromStorage,
  saveSettingsToStorage,
} from './settings';

export type GuiHandle = {
  gui: GUI;
  setVisible: (visible: boolean) => void;
};

export function createGui(
  viewer: Viewer,
  recorder: Recorder,
  setStatus: (msg: string) => void,
): GuiHandle {
  const gui = new GUI({ title: 'WRT Paddock Viewer' });

  const refreshGui = () => {
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  };

  /** Assigned after custom-lights UI is wired. */
  let rebuildCustomLightsUi: () => void = () => {};

  const settingsActions = {
    save: () => {
      const snapshot = captureSettings(viewer);
      saveSettingsToStorage(snapshot);
      setStatus('Settings saved');
    },
    resetDefaults: async () => {
      await applySettings(viewer, defaultSettings());
      rebuildCustomLightsUi();
      refreshGui();
      setStatus('Reset to defaults');
    },
    clearSaved: () => {
      clearSettingsStorage();
      setStatus('Cleared saved settings');
    },
  };

  const settingsFolder = gui.addFolder('Settings');
  settingsFolder.add(settingsActions, 'save').name('Save current values');
  settingsFolder
    .add(settingsActions, 'resetDefaults')
    .name('Reset to defaults');
  settingsFolder.add(settingsActions, 'clearSaved').name('Clear saved');
  settingsFolder.open();

  const displayFolder = gui.addFolder('Display');
  displayFolder
    .add(viewer.state.display, 'background')
    .onChange(() => viewer.applyDisplay());
  displayFolder
    .add(viewer.state.display, 'autoRotate')
    .onChange(() => viewer.applyDisplay());
  displayFolder
    .add(viewer.state.display, 'wireframe')
    .onChange(() => viewer.applyDisplay());
  displayFolder
    .add(viewer.state.display, 'grid')
    .onChange(() => viewer.applyDisplay());
  displayFolder
    .addColor(viewer.state.display, 'bgColor')
    .onChange(() => viewer.applyDisplay());
  displayFolder
    .add(viewer.state, 'floorReflectivity', 0, 1, 0.01)
    .name('floorReflect')
    .onChange((v: number) => viewer.setFloorReflectivity(v));
  displayFolder
    .add(viewer.state, 'floorPuddles', 0, 1, 0.01)
    .name('floorPuddles')
    .onChange((v: number) => viewer.setFloorPuddles(v));

  const lightingFolder = gui.addFolder('Lighting');
  lightingFolder
    .add(viewer.state.lighting, 'environment', [...ENVIRONMENT_PRESETS])
    .onChange(() => {
      void viewer.applyEnvironment();
    });
  lightingFolder
    .add(viewer.state.lighting, 'environmentIntensity', 0, 3, 0.01)
    .name('envIntensity')
    .onChange(() => viewer.applyEnvironmentTuning());
  lightingFolder
    .add(viewer.state.lighting, 'envMapIntensity', 0, 2, 0.01)
    .name('otherEnvMap')
    .onChange(() => viewer.applyEnvMapIntensity());
  lightingFolder
    .add(viewer.state.lighting, 'envAsBackground')
    .name('env as bg')
    .onChange(() => viewer.applyEnvironmentTuning());
  lightingFolder
    .add(viewer.state.lighting, 'backgroundBlurriness', 0, 1, 0.01)
    .name('bgBlur')
    .onChange(() => viewer.applyEnvironmentTuning());
  lightingFolder
    .add(viewer.state.lighting, 'backgroundIntensity', 0, 2, 0.01)
    .name('bgIntensity')
    .onChange(() => viewer.applyEnvironmentTuning());
  lightingFolder
    .add(viewer.state.lighting, 'toneMapping', [
      'None',
      'Linear',
      'Reinhard',
      'Cineon',
      'ACES Filmic',
    ])
    .onChange(() => viewer.applyLighting());
  lightingFolder
    .add(viewer.state.lighting, 'exposure', 0, 2, 0.01)
    .onChange(() => viewer.applyLighting());
  lightingFolder
    .add(viewer.state.lighting, 'punctualLights')
    .onChange(() => viewer.applyLighting());
  lightingFolder
    .add(viewer.state.lighting, 'ambientIntensity', 0, 2, 0.01)
    .onChange(() => viewer.applyLighting());
  lightingFolder
    .addColor(viewer.state.lighting, 'ambientColor')
    .onChange(() => viewer.applyLighting());
  lightingFolder
    .add(viewer.state.lighting, 'directIntensity', 0, 5, 0.01)
    .onChange(() => viewer.applyLighting());
  lightingFolder
    .addColor(viewer.state.lighting, 'directColor')
    .onChange(() => viewer.applyLighting());

  const paintFolder = gui.addFolder('Paint / Materials');
  const paint = viewer.carMaterials.params;
  paintFolder
    .add(paint, 'enabled')
    .name('enhance')
    .onChange(() => viewer.carMaterials.applyParams());
  paintFolder
    .add(paint, 'clearcoat', 0, 1, 0.01)
    .onChange(() => viewer.carMaterials.applyParams());
  paintFolder
    .add(paint, 'clearcoatRoughness', 0, 0.5, 0.005)
    .name('coatRough')
    .onChange(() => viewer.carMaterials.applyParams());
  paintFolder
    .add(paint, 'paintEnv', 0, 2.5, 0.01)
    .name('paintEnv')
    .onChange(() => viewer.carMaterials.applyParams());
  paintFolder
    .add(paint, 'carbonEnv', 0, 2, 0.01)
    .name('carbonEnv')
    .onChange(() => viewer.carMaterials.applyParams());
  paintFolder
    .add(paint, 'tireEnv', 0, 1, 0.01)
    .name('tireEnv')
    .onChange(() => viewer.carMaterials.applyParams());
  paintFolder.open();

  const softboxFolder = gui.addFolder('Softboxes');
  const soft = viewer.softboxes.params;
  softboxFolder
    .add(soft, 'enabled')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .add(soft, 'intensity', 0, 3, 0.01)
    .name('master')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .add(soft, 'keyIntensity', 0, 12, 0.05)
    .name('key')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .add(soft, 'fillIntensity', 0, 8, 0.05)
    .name('fill')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .add(soft, 'rimIntensity', 0, 10, 0.05)
    .name('rim')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .addColor(soft, 'keyColor')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .addColor(soft, 'fillColor')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .addColor(soft, 'rimColor')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder
    .add(soft, 'showHelpers')
    .name('helpers')
    .onChange(() => viewer.softboxes.applyParams());
  softboxFolder.open();

  const roofFolder = gui.addFolder('Roof Strobe');
  const roof = viewer.roofStrobe.params;
  roofFolder
    .add(roof, 'enabled')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'intensity', 0, 30, 0.05)
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .addColor(roof, 'color')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'flashDuration', 1, 10, 0.1)
    .name('duration (s)')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'strobeHz', 1, 16, 0.1)
    .name('strobe Hz')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'strobeDuty', 0.1, 0.9, 0.01)
    .name('duty')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'strobing')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'width', 0.3, 3, 0.01)
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'length', 0.5, 8, 0.05)
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'thickness', 0.04, 0.5, 0.01)
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'yOffset', 0.1, 3, 0.01)
    .name('height')
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder
    .add(roof, 'zOffset', -2, 2, 0.01)
    .onChange(() => viewer.roofStrobe.applyParams());
  roofFolder.add(roof, 'flashDecay', 0.5, 14, 0.1);
  const roofActions = {
    triggerStrobe: () => viewer.roofStrobe.triggerFlash(roof.flashDuration),
    stop: () => {
      viewer.roofStrobe.stopFlash();
      roof.strobing = false;
      viewer.roofStrobe.applyParams();
    },
  };
  roofFolder.add(roofActions, 'triggerStrobe').name('Trigger strobe');
  roofFolder.add(roofActions, 'stop').name('Stop');
  roofFolder.open();

  const carLightsFolder = gui.addFolder('Car Lights');
  const carLights = viewer.carLights.params;
  carLightsFolder
    .add(carLights, 'enabled')
    .name('lights on')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'grilleEnabled')
    .name('grille outline')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'grilleStrength', 0, 20, 0.01)
    .name('grille strength')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'edgeEnabled')
    .name('edge LEDs')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'edgeStrength', 0, 20, 0.01)
    .name('edge strength')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'redEnabled')
    .name('rear red')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'redStrength', 0, 20, 0.01)
    .name('red strength')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'groundGlow')
    .name('ground reflection')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'groundGlowStrength', 0, 10, 0.01)
    .name('ground strength')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'beamsEnabled')
    .name('headlight beams')
    .onChange(() => viewer.carLights.applyParams());
  carLightsFolder
    .add(carLights, 'beamStrength', 0, 3, 0.01)
    .name('beam strength')
    .onChange(() => viewer.carLights.applyParams());

  const ambientFolder = gui.addFolder('Ambient Shadows');
  const ambient = viewer.ambientShadows.params;
  ambientFolder
    .add(ambient, 'enabled')
    .name('enabled')
    .onChange(() => viewer.ambientShadows.applyParams());
  ambientFolder
    .add(ambient, 'radius', 0, 500, 0.1)
    .name('Radius')
    .onChange(() => viewer.ambientShadows.applyParams());
  ambientFolder
    .add(ambient, 'bias', 0, 1, 0.01)
    .name('Bias')
    .onChange(() => viewer.ambientShadows.applyParams());
  ambientFolder
    .addColor(ambient, 'tint')
    .name('Tint')
    .onChange(() => viewer.ambientShadows.applyParams());
  ambientFolder
    .add(ambient, 'quality', ['Low', 'Normal', 'High'])
    .name('Quality')
    .onChange(() => viewer.ambientShadows.applyParams());
  ambientFolder
    .add(ambient, 'opacity', 0, 1, 0.01)
    .name('Opacity')
    .onChange(() => viewer.ambientShadows.applyParams());
  ambientFolder.open();

  // --- Custom lights: point + cone (spot) ---
  const customLightsFolder = gui.addFolder('Custom Lights');
  const customUi = {
    selected: '— none —',
    showHelpers: true,
    dragInViewport: true,
    gizmoMode: 'translate' as 'translate' | 'rotate',
  };

  /** Fully rebuilt when the light list or selection changes. */
  let dynamicFolder: GUI | null = null;

  const lightLabelOptions = (): string[] => {
    const labels = viewer.customLights.entries.map((e) => {
      const kind = e.params.type === 'spot' ? 'cone' : 'point';
      return `${e.params.name} (${kind})`;
    });
    return labels.length ? labels : ['— none —'];
  };

  const labelToId = (label: string): string | null => {
    const entry = viewer.customLights.entries.find((e) => {
      const kind = e.params.type === 'spot' ? 'cone' : 'point';
      return `${e.params.name} (${kind})` === label;
    });
    return entry?.id ?? null;
  };

  const entryLabel = (entry: {
    params: { name: string; type: string };
  }): string => {
    const kind = entry.params.type === 'spot' ? 'cone' : 'point';
    return `${entry.params.name} (${kind})`;
  };

  rebuildCustomLightsUi = () => {
    if (dynamicFolder) {
      dynamicFolder.destroy();
      dynamicFolder = null;
    }

    dynamicFolder = customLightsFolder.addFolder('Selection');
    const options = lightLabelOptions();
    const selectedEntry = viewer.customLights.entries.find(
      (e) => e.id === viewer.customLights.selectedId,
    );
    customUi.selected = selectedEntry
      ? entryLabel(selectedEntry)
      : options[0]!;
    customUi.gizmoMode = viewer.customLights.transformMode;

    dynamicFolder
      .add(customUi, 'selected', options)
      .name('selected')
      .onChange((label: string) => {
        viewer.customLights.select(labelToId(label));
        rebuildCustomLightsUi();
      });

    const entry = viewer.customLights.entries.find(
      (e) => e.id === viewer.customLights.selectedId,
    );
    if (!entry) {
      dynamicFolder.open();
      return;
    }

    const params = entry.params;
    const apply = () => viewer.customLights.apply(entry.id);
    const isSpot = params.type === 'spot';

    if (isSpot) {
      dynamicFolder
        .add(customUi, 'gizmoMode', ['translate', 'rotate'])
        .name('gizmo mode')
        .onChange((mode: 'translate' | 'rotate') => {
          viewer.customLights.setTransformMode(mode);
        });
    }

    const lightFolder = dynamicFolder.addFolder('Light');
    lightFolder
      .add(params, 'name')
      .onFinishChange(() => {
        apply();
        rebuildCustomLightsUi();
      });
    lightFolder.add(params, 'enabled').onChange(apply);
    lightFolder.addColor(params, 'color').onChange(apply);
    lightFolder.add(params, 'intensity', 0, 20, 0.01).onChange(apply);
    lightFolder.add(params, 'distance', 0, 500, 1).onChange(apply);
    lightFolder.add(params, 'decay', 0, 10, 0.01).onChange(apply);

    if (isSpot) {
      lightFolder
        .add(params, 'angle', 1, 90, 0.5)
        .name('cone angle°')
        .onChange(apply);
      lightFolder.add(params, 'penumbra', 0, 1, 0.01).onChange(apply);
    }

    const posFolder = lightFolder.addFolder('Position');
    posFolder.add(params, 'x', -20, 20, 0.01).listen().onChange(apply);
    posFolder.add(params, 'y', -2, 15, 0.01).listen().onChange(apply);
    posFolder.add(params, 'z', -20, 20, 0.01).listen().onChange(apply);
    posFolder.open();

    if (isSpot) {
      const rotFolder = lightFolder.addFolder('Rotation');
      rotFolder.add(params, 'rotX', -180, 180, 0.5).listen().name('x°').onChange(apply);
      rotFolder.add(params, 'rotY', -180, 180, 0.5).listen().name('y°').onChange(apply);
      rotFolder.add(params, 'rotZ', -180, 180, 0.5).listen().name('z°').onChange(apply);
      rotFolder.open();
    }

    lightFolder.open();
    dynamicFolder.open();
  };

  const customActions = {
    addPoint: () => {
      const entry = viewer.customLights.addPoint();
      rebuildCustomLightsUi();
      setStatus(`Added ${entry.params.name}`);
    },
    addCone: () => {
      const entry = viewer.customLights.addSpot();
      rebuildCustomLightsUi();
      setStatus(`Added ${entry.params.name} (cone)`);
    },
    removeSelected: () => {
      const before = viewer.customLights.selectedId;
      if (!before) {
        setStatus('No light selected');
        return;
      }
      const name =
        viewer.customLights.entries.find((e) => e.id === before)?.params.name ??
        'light';
      viewer.customLights.removeSelected();
      rebuildCustomLightsUi();
      setStatus(`Removed ${name}`);
    },
  };

  customLightsFolder.add(customActions, 'addPoint').name('+ Add point light');
  customLightsFolder.add(customActions, 'addCone').name('+ Add cone light');
  customLightsFolder.add(customActions, 'removeSelected').name('− Remove selected');
  customLightsFolder
    .add(customUi, 'showHelpers')
    .name('helpers')
    .onChange((v: boolean) => viewer.customLights.setShowHelpers(v));
  customLightsFolder
    .add(customUi, 'dragInViewport')
    .name('drag gizmo')
    .onChange((v: boolean) => viewer.customLights.setTransformEnabled(v));

  rebuildCustomLightsUi();

  const logoFolder = gui.addFolder('WRT Logo');
  const logo = viewer.logo.params;
  logoFolder.add(logo, 'enabled').onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'intensity', 0, 10, 0.05)
    .onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'opacity', 0, 1, 0.01)
    .onChange(() => viewer.logo.applyParams());
  logoFolder.addColor(logo, 'emissiveColor').onChange(() => viewer.logo.applyParams());
  logoFolder.add(logo, 'strobeEnabled').name('strobe');
  logoFolder.add(logo, 'strobeHz', 0.1, 10, 0.05);
  logoFolder.add(logo, 'strobeDuty', 0.05, 0.95, 0.01);
  logoFolder.add(logo, 'strobeMin', 0, 5, 0.05);
  logoFolder.add(logo, 'strobeMax', 0.5, 12, 0.05);
  logoFolder.add(logo, 'scale', 1, 8, 0.05).onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'distance', 2, 20, 0.1)
    .onChange(() => viewer.logo.applyParams());
  logoFolder.add(logo, 'height', 0.2, 6, 0.05).onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'reflectionEnabled')
    .name('floor reflection')
    .onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'reflectionOpacity', 0, 1, 0.01)
    .name('reflect opacity')
    .onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'reflectionFade', 0, 1, 0.01)
    .name('reflect fade')
    .onChange(() => viewer.logo.applyParams());
  logoFolder
    .add(logo, 'reflectionLength', 0.5, 6, 0.05)
    .name('reflect length')
    .onChange(() => viewer.logo.applyParams());

  const presets = {
    idleGlow: () => {
      viewer.logo.applyPreset('idle');
      refreshGui();
    },
    paddockPulse: () => {
      viewer.logo.applyPreset('paddock');
      refreshGui();
    },
    strobeFlash: () => {
      viewer.logo.applyPreset('strobe');
      refreshGui();
    },
  };
  logoFolder.add(presets, 'idleGlow').name('Preset: Idle glow');
  logoFolder.add(presets, 'paddockPulse').name('Preset: Paddock pulse');
  logoFolder.add(presets, 'strobeFlash').name('Preset: Strobe flash');

  const dotFolder = gui.addFolder('Dot Grid WRT');
  const dg = viewer.dotGrid.params;
  const applyDg = () => viewer.dotGrid.applyParams();
  dotFolder.add(dg, 'enabled').onChange(applyDg);
  dotFolder
    .add(dg, 'effectMode', {
      Idle: 0,
      Wave: 1,
      Scan: 2,
      Rain: 3,
      Sparkle: 4,
      Breathe: 5,
      'Shock loop': 6,
      'Reveal loop': 7,
    })
    .name('effect')
    .onChange(applyDg);
  dotFolder.add(dg, 'effectStrength', 0, 2, 0.01).name('effectStrength').onChange(applyDg);
  dotFolder.add(dg, 'opacity', 0, 1, 0.01).onChange(applyDg);
  dotFolder.add(dg, 'reveal', 0, 1, 0.01).onChange(applyDg);
  dotFolder.add(dg, 'pulse', 0, 2, 0.01).onChange(applyDg);
  dotFolder.add(dg, 'pulseHz', 0.1, 4, 0.05).onChange(applyDg);
  dotFolder.add(dg, 'wave', 0, 2, 0.01).onChange(applyDg);
  dotFolder.add(dg, 'waveSpeed', 0.1, 4, 0.05).onChange(applyDg);
  dotFolder.add(dg, 'glow', 0, 2, 0.01).onChange(applyDg);
  dotFolder.add(dg, 'flashDecay', 0.5, 8, 0.1);
  dotFolder.add(dg, 'dotSize', 0.1, 0.9, 0.01).onChange(applyDg);
  dotFolder.add(dg, 'density', 24, 160, 1).onChange(applyDg);
  dotFolder.addColor(dg, 'baseColor').onChange(applyDg);
  dotFolder.addColor(dg, 'activeColor').onChange(applyDg);
  dotFolder.addColor(dg, 'panelColor').onChange(applyDg);
  dotFolder.add(dg, 'distance', 4, 24, 0.1).onChange(applyDg);
  dotFolder.add(dg, 'height', 0.5, 8, 0.05).onChange(applyDg);
  dotFolder.add(dg, 'scale', 0.3, 3, 0.05).onChange(applyDg);
  dotFolder.add(dg, 'width', 4, 24, 0.1).onChange(applyDg);
  dotFolder.add(dg, 'heightWorld', 2, 14, 0.1).name('planeHeight').onChange(applyDg);
  dotFolder
    .add(dg, 'reflectionEnabled')
    .name('floor reflection')
    .onChange(applyDg);
  dotFolder
    .add(dg, 'reflectionOpacity', 0, 1, 0.01)
    .name('reflect opacity')
    .onChange(applyDg);
  dotFolder
    .add(dg, 'reflectionFade', 0, 1, 0.01)
    .name('reflect fade')
    .onChange(applyDg);
  dotFolder
    .add(dg, 'reflectionLength', 0.5, 8, 0.05)
    .name('reflect length')
    .onChange(applyDg);
  const dgActions = {
    frame: () => viewer.frameDotGridScreen(),
    flash: () => viewer.dotGrid.triggerFlash(1.35),
    idle: () => {
      viewer.dotGrid.applyPreset('idle');
      refreshGui();
    },
    pulse: () => {
      viewer.dotGrid.applyPreset('pulse');
      refreshGui();
    },
    shockwave: () => {
      viewer.dotGrid.applyPreset('shockwave');
      refreshGui();
    },
  };
  dotFolder.add(dgActions, 'frame').name('Frame screen');
  dotFolder.add(dgActions, 'flash').name('Trigger flash');
  dotFolder.add(dgActions, 'idle').name('Preset: Idle');
  dotFolder.add(dgActions, 'pulse').name('Preset: Pulse');
  dotFolder.add(dgActions, 'shockwave').name('Preset: Shockwave');

  const fxFolder = gui.addFolder('FX');
  const fx = viewer.effects.params;
  fxFolder.add(fx, 'bloomEnabled').name('bloom').onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'bloomStrength', 0, 2.5, 0.01)
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'bloomRadius', 0, 1.5, 0.01)
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'bloomThreshold', 0, 1, 0.01)
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'vignetteEnabled')
    .name('vignette')
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'vignetteDarkness', 0, 2, 0.01)
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'vignetteOffset', 0, 3, 0.01)
    .onChange(() => viewer.effects.applyParams());
  fxFolder.add(fx, 'smokeEnabled').name('fog').onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'fogOpacity', 0, 1, 0.01)
    .name('fogOpacity')
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'smokeDensity', 0, 1, 0.01)
    .name('fogDensity')
    .onChange(() => viewer.effects.applyParams());
  fxFolder.add(fx, 'smokeSpeed', 0, 1, 0.01).name('fogDrift');
  fxFolder
    .add(fx, 'fogDensity', 0, 0.08, 0.001)
    .name('atmosphere')
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'grainEnabled')
    .name('film grain')
    .onChange(() => viewer.effects.applyParams());
  fxFolder
    .add(fx, 'grainStrength', 0, 0.35, 0.005)
    .name('grain amount')
    .onChange(() => viewer.effects.applyParams());
  fxFolder.add(fx, 'flashDecay', 0.5, 8, 0.1).name('flashDecay');
  const flashActions = {
    triggerFlash: () => viewer.effects.triggerFlash(14),
  };
  fxFolder.add(flashActions, 'triggerFlash').name('Trigger flash');

  const recordState = {
    fps: 30,
    bitrateMbps: 12,
    hideGuiWhileRecording: true,
  };
  const recordFolder = gui.addFolder('Record');
  recordFolder.add(recordState, 'fps', 24, 60, 1);
  recordFolder.add(recordState, 'bitrateMbps', 4, 40, 1).name('Mbps');
  recordFolder.add(recordState, 'hideGuiWhileRecording').name('hide GUI');

  const recordActions = {
    start: () => {
      if (recorder.isRecording) return;
      recorder.configure({
        fps: recordState.fps,
        videoBitsPerSecond: recordState.bitrateMbps * 1_000_000,
      });
      if (recordState.hideGuiWhileRecording) gui.hide();
      viewer.setGridVisible(false);
      recorder.start();
      setStatus('Recording… click Stop & Export when done');
    },
    stopExport: async () => {
      await recorder.stopAndExport('bmw-m-hybrid-v8-wrt');
      gui.show();
    },
  };
  recordFolder.add(recordActions, 'start').name('● Start recording');
  recordFolder.add(recordActions, 'stopExport').name('■ Stop & export MP4');

  const perfFolder = gui.addFolder('Performance');
  const perf = {
    pixelRatio: Math.min(window.devicePixelRatio, 2),
    shadows: true,
  };
  perfFolder
    .add(perf, 'pixelRatio', 0.5, 2, 0.25)
    .onChange((v: number) => {
      viewer.renderer.setPixelRatio(v);
      viewer.effects.resize(viewer.canvas.clientWidth, viewer.canvas.clientHeight);
    });
  perfFolder.add(perf, 'shadows').onChange((v: boolean) => {
    viewer.renderer.shadowMap.enabled = v;
  });
  perfFolder.close();

  displayFolder.open();
  lightingFolder.open();
  paintFolder.open();
  softboxFolder.open();
  carLightsFolder.open();
  ambientFolder.open();
  customLightsFolder.open();
  logoFolder.open();
  dotFolder.open();
  fxFolder.open();
  recordFolder.open();

  const saved = loadSettingsFromStorage();
  if (saved) {
    void applySettings(viewer, saved).then(() => {
      rebuildCustomLightsUi();
      refreshGui();
      setStatus('Loaded saved settings');
    });
  }

  return {
    gui,
    setVisible: (visible: boolean) => {
      if (visible) gui.show();
      else gui.hide();
    },
  };
}
