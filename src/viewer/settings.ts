import {
  DEFAULT_VIEWER_STATE,
  type Viewer,
  type ViewerState,
} from './Viewer';
import {
  DEFAULT_CAR_MATERIALS_PARAMS,
  type CarMaterialsParams,
} from './carMaterials';
import { DEFAULT_SOFTBOX_PARAMS, type SoftboxParams } from './softboxes';
import {
  DEFAULT_CAR_LIGHTS_PARAMS,
  type CarLightsParams,
} from './carLights';
import {
  DEFAULT_AMBIENT_SHADOW_PARAMS,
  type AmbientShadowParams,
} from './ambientShadows';
import { DEFAULT_LOGO_PARAMS, type WrtLogoParams } from './wrtLogo';
import { DEFAULT_EFFECTS_PARAMS, type EffectsParams } from './effects';
import type { CustomLightParams } from './customLights';

export const SETTINGS_STORAGE_KEY = 'wrt-paddock-viewer-settings';

export type SavedSettings = {
  version: 1;
  display: ViewerState['display'];
  lighting: ViewerState['lighting'];
  floorReflectivity: number;
  floorPuddles: number;
  paint: CarMaterialsParams;
  softboxes: SoftboxParams;
  carLights: CarLightsParams;
  ambient: AmbientShadowParams;
  logo: WrtLogoParams;
  effects: EffectsParams;
  customLights: CustomLightParams[];
};

function assignDeep<T extends object>(target: T, source: T): void {
  Object.assign(target, structuredClone(source));
}

export function captureSettings(viewer: Viewer): SavedSettings {
  return {
    version: 1,
    display: structuredClone(viewer.state.display),
    lighting: structuredClone(viewer.state.lighting),
    floorReflectivity: viewer.state.floorReflectivity,
    floorPuddles: viewer.state.floorPuddles,
    paint: structuredClone(viewer.carMaterials.params),
    softboxes: structuredClone(viewer.softboxes.params),
    carLights: structuredClone(viewer.carLights.params),
    ambient: structuredClone(viewer.ambientShadows.params),
    logo: structuredClone(viewer.logo.params),
    effects: structuredClone(viewer.effects.params),
    customLights: viewer.customLights.entries.map((e) => ({
      ...structuredClone(e.params),
      id: e.id,
    })),
  };
}

export function defaultSettings(): SavedSettings {
  return {
    version: 1,
    display: structuredClone(DEFAULT_VIEWER_STATE.display),
    lighting: structuredClone(DEFAULT_VIEWER_STATE.lighting),
    floorReflectivity: DEFAULT_VIEWER_STATE.floorReflectivity,
    floorPuddles: DEFAULT_VIEWER_STATE.floorPuddles,
    paint: structuredClone(DEFAULT_CAR_MATERIALS_PARAMS),
    softboxes: structuredClone(DEFAULT_SOFTBOX_PARAMS),
    carLights: structuredClone(DEFAULT_CAR_LIGHTS_PARAMS),
    ambient: structuredClone(DEFAULT_AMBIENT_SHADOW_PARAMS),
    logo: structuredClone(DEFAULT_LOGO_PARAMS),
    effects: structuredClone(DEFAULT_EFFECTS_PARAMS),
    customLights: [],
  };
}

export async function applySettings(
  viewer: Viewer,
  settings: SavedSettings,
): Promise<void> {
  assignDeep(viewer.state.display, settings.display);
  assignDeep(viewer.state.lighting, settings.lighting);
  viewer.state.floorReflectivity = settings.floorReflectivity;
  viewer.state.floorPuddles = settings.floorPuddles;

  assignDeep(viewer.carMaterials.params, settings.paint);
  assignDeep(viewer.softboxes.params, settings.softboxes);
  assignDeep(viewer.carLights.params, settings.carLights);
  assignDeep(viewer.ambientShadows.params, settings.ambient);
  assignDeep(viewer.logo.params, settings.logo);
  assignDeep(viewer.effects.params, {
    ...settings.effects,
    // Don't restore a mid-flash peak
    flashIntensity: 0,
    flashEnabled: false,
  });

  viewer.customLights.replaceAll(settings.customLights);

  viewer.applyDisplay();
  viewer.setFloorReflectivity(settings.floorReflectivity);
  viewer.setFloorPuddles(settings.floorPuddles);
  await viewer.applyEnvironment();
  viewer.applyLighting();
  viewer.carMaterials.applyParams();
  viewer.softboxes.applyParams();
  viewer.carLights.applyParams();
  viewer.ambientShadows.applyParams();
  viewer.logo.applyParams();
  viewer.effects.applyParams();
}

export function saveSettingsToStorage(settings: SavedSettings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function loadSettingsFromStorage(): SavedSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSettings;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSettingsStorage(): void {
  localStorage.removeItem(SETTINGS_STORAGE_KEY);
}
