import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';

export type SoftboxParams = {
  enabled: boolean;
  /** Global intensity scale for all softboxes. */
  intensity: number;
  keyIntensity: number;
  fillIntensity: number;
  rimIntensity: number;
  /** Cool key / warm fill tint for cinematic separation. */
  keyColor: string;
  fillColor: string;
  rimColor: string;
  showHelpers: boolean;
};

export const DEFAULT_SOFTBOX_PARAMS: SoftboxParams = {
  enabled: true,
  intensity: 1,
  keyIntensity: 4.2,
  fillIntensity: 1.8,
  rimIntensity: 2.6,
  keyColor: '#d8e6ff',
  fillColor: '#a8b8d0',
  rimColor: '#c4d4f0',
  showHelpers: false,
};

type SoftboxEntry = {
  light: THREE.RectAreaLight;
  helper: RectAreaLightHelper;
  role: 'key' | 'fill' | 'rim';
};

export type SoftboxesHandle = {
  group: THREE.Group;
  params: SoftboxParams;
  applyParams: () => void;
  /** Re-aim softboxes at the car after framing. */
  setTarget: (center: THREE.Vector3, radius: number) => void;
  dispose: () => void;
};

let uniformsReady = false;

function ensureUniforms() {
  if (uniformsReady) return;
  RectAreaLightUniformsLib.init();
  uniformsReady = true;
}

function aimAt(light: THREE.RectAreaLight, target: THREE.Vector3) {
  light.lookAt(target);
}

export function createSoftboxes(): SoftboxesHandle {
  ensureUniforms();

  const params: SoftboxParams = { ...DEFAULT_SOFTBOX_PARAMS };
  const group = new THREE.Group();
  group.name = 'Softboxes';

  const entries: SoftboxEntry[] = [];

  const make = (
    role: SoftboxEntry['role'],
    width: number,
    height: number,
    color: string,
  ): SoftboxEntry => {
    const light = new THREE.RectAreaLight(color, 1, width, height);
    light.name = `Softbox_${role}`;
    const helper = new RectAreaLightHelper(light);
    helper.visible = params.showHelpers;
    light.add(helper);
    group.add(light);
    const entry = { light, helper, role };
    entries.push(entry);
    return entry;
  };

  make('key', 6.5, 3.2, params.keyColor);
  make('fill', 4.5, 2.8, params.fillColor);
  make('rim', 5.5, 2.2, params.rimColor);

  let target = new THREE.Vector3(0, 0.55, 0);
  let radius = 3;

  const place = () => {
    const r = Math.max(radius, 2.2);
    const key = entries.find((e) => e.role === 'key')!;
    const fill = entries.find((e) => e.role === 'fill')!;
    const rim = entries.find((e) => e.role === 'rim')!;

    // Front-right overhead softbox — long streak reflections on hood / nose
    key.light.position.set(
      target.x + r * 0.55,
      target.y + r * 1.35,
      target.z + r * 1.45,
    );
    key.light.width = r * 2.1;
    key.light.height = r * 1.05;
    aimAt(key.light, target);

    // Camera-left fill — softens shadows without killing contrast
    fill.light.position.set(
      target.x - r * 1.35,
      target.y + r * 0.95,
      target.z + r * 0.55,
    );
    fill.light.width = r * 1.5;
    fill.light.height = r * 0.95;
    aimAt(fill.light, target);

    // Rear rim — separates wing / shark fin from crushed blacks
    rim.light.position.set(
      target.x - r * 0.25,
      target.y + r * 1.55,
      target.z - r * 1.7,
    );
    rim.light.width = r * 1.85;
    rim.light.height = r * 0.75;
    aimAt(rim.light, target);
  };

  const intensityFor = (role: SoftboxEntry['role']): number => {
    if (!params.enabled) return 0;
    const scale = params.intensity;
    switch (role) {
      case 'key':
        return params.keyIntensity * scale;
      case 'fill':
        return params.fillIntensity * scale;
      case 'rim':
        return params.rimIntensity * scale;
    }
  };

  const applyParams = () => {
    for (const entry of entries) {
      entry.light.intensity = intensityFor(entry.role);
      entry.helper.visible = params.enabled && params.showHelpers;
      if (entry.role === 'key') entry.light.color.set(params.keyColor);
      if (entry.role === 'fill') entry.light.color.set(params.fillColor);
      if (entry.role === 'rim') entry.light.color.set(params.rimColor);
    }
    group.visible = params.enabled;
  };

  const setTarget = (center: THREE.Vector3, contentRadius: number) => {
    target = center.clone();
    // Bias aim slightly toward body mid-height
    target.y = Math.max(0.4, center.y * 0.85);
    radius = contentRadius;
    place();
    applyParams();
  };

  place();
  applyParams();

  const dispose = () => {
    for (const entry of entries) {
      entry.helper.dispose();
      group.remove(entry.light);
      entry.light.dispose();
    }
    entries.length = 0;
  };

  return { group, params, applyParams, setTarget, dispose };
}
