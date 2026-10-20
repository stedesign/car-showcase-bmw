import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

export type RoofStrobeParams = {
  /** Master on/off. */
  enabled: boolean;
  /**
   * Sustained panel brightness (timeline-friendly).
   * 0 = fixture still visible but dim; raise and Animate for a sequence pop.
   */
  intensity: number;
  color: string;
  /** Panel size across the car (world X). */
  width: number;
  /** Panel size along the car (world Z / length). */
  length: number;
  /** Softbox housing thickness (visible from side camera). */
  thickness: number;
  /** Meters above the roof. */
  yOffset: number;
  /** Nose/tail bias (model nose is +Z). */
  zOffset: number;
  /** How fast each pulse falls off between strobe hits. */
  flashDecay: number;
  /** One-shot / button burst length in seconds (1–10). */
  flashDuration: number;
  /** Flashes per second while bursting or `strobing`. */
  strobeHz: number;
  /** Fraction of each cycle the light is on (0–1). */
  strobeDuty: number;
  /**
   * Continuous strobe (timeline-friendly).
   * Animate true at start, false when you want it to stop.
   */
  strobing: boolean;
  /** Transient flash energy (decays; not restored from saves). */
  flashIntensity: number;
};

export const DEFAULT_ROOF_STROBE_PARAMS: RoofStrobeParams = {
  enabled: true,
  intensity: 0,
  color: '#ffffff',
  width: 0.7,
  length: 3.6,
  thickness: 0.14,
  yOffset: 0.65,
  zOffset: 0.1,
  flashDecay: 8,
  flashDuration: 3,
  strobeHz: 6,
  strobeDuty: 0.35,
  strobing: false,
  flashIntensity: 0,
};

/** Intensity slider max — maps to a very hot softbox. */
export const ROOF_STROBE_INTENSITY_MAX = 30;

export type RoofStrobeHandle = {
  group: THREE.Group;
  params: RoofStrobeParams;
  applyParams: () => void;
  /** Place above the car after framing / load. */
  setFromCarBounds: (box: THREE.Box3) => void;
  /**
   * Start a timed strobe burst.
   * @param durationSec overrides `flashDuration` (clamped 1–10).
   * @param peak pulse peak energy (default: hot).
   */
  triggerFlash: (durationSec?: number, peak?: number) => void;
  /** Stop a running burst / clear pulse energy (does not clear `strobing`). */
  stopFlash: () => void;
  update: (dt: number) => void;
  dispose: () => void;
};

let uniformsReady = false;

function ensureUniforms() {
  if (uniformsReady) return;
  RectAreaLightUniformsLib.init();
  uniformsReady = true;
}

export function createRoofStrobe(): RoofStrobeHandle {
  ensureUniforms();

  const params: RoofStrobeParams = { ...DEFAULT_ROOF_STROBE_PARAMS };

  const group = new THREE.Group();
  group.name = 'RoofStrobe';

  const light = new THREE.RectAreaLight(params.color, 0, params.width, params.length);
  light.name = 'RoofStrobe_Rect';
  group.add(light);

  /**
   * Thick softbox housing — a flat Plane was invisible from the side hero camera
   * (edge-on). Box reads as the hanging LED bar from the reference.
   */
  const housingMat = new THREE.MeshBasicMaterial({
    color: 0x2a2a30,
    toneMapped: false,
    fog: false,
  });
  const faceMat = new THREE.MeshBasicMaterial({
    color: params.color,
    toneMapped: false,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });

  const housing = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), housingMat);
  housing.name = 'RoofStrobe_Housing';
  housing.castShadow = false;
  housing.receiveShadow = false;
  group.add(housing);

  const face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), faceMat);
  face.name = 'RoofStrobe_Face';
  face.rotation.x = Math.PI / 2;
  face.renderOrder = 2;
  face.frustumCulled = false;
  group.add(face);

  const punch = new THREE.PointLight(params.color, 0, 28, 1.8);
  punch.name = 'RoofStrobe_Punch';
  group.add(punch);

  // Extra wide fill so max intensity washes the car / floor hard.
  const wash = new THREE.PointLight(params.color, 0, 40, 1.5);
  wash.name = 'RoofStrobe_Wash';
  group.add(wash);

  let carCenter = new THREE.Vector3(0, 0.55, 0);
  let roofY = 1.1;

  /** Seconds left on a button-triggered burst. */
  let burstRemaining = 0;
  /** Peak energy used for strobe pulses. */
  let pulsePeak = 22;
  let strobePhase = 0;

  const effectiveIntensity = () => {
    if (!params.enabled) return 0;
    return Math.max(0, params.intensity) + Math.max(0, params.flashIntensity);
  };

  const place = () => {
    const w = Math.max(0.2, params.width);
    const len = Math.max(0.2, params.length);
    const th = Math.max(0.04, params.thickness);

    group.position.set(
      carCenter.x,
      roofY + params.yOffset,
      carCenter.z + params.zOffset,
    );

    housing.scale.set(w, th, len);
    face.scale.set(w * 0.92, len * 0.92, 1);
    face.position.set(0, -th * 0.5 - 0.002, 0);

    light.position.set(0, -th * 0.5, 0);
    light.width = w;
    light.height = len;
    const aim = new THREE.Vector3(
      carCenter.x,
      Math.max(0.35, carCenter.y * 0.85),
      carCenter.z + params.zOffset,
    );
    light.lookAt(aim);

    punch.position.set(0, -th * 0.6 - 0.08, 0);
    wash.position.set(0, -th * 0.4, 0);
  };

  const applyParams = () => {
    const e = effectiveIntensity();
    const col = new THREE.Color(params.color);
    light.color.copy(col);
    punch.color.copy(col);
    wash.color.copy(col);
    faceMat.color.copy(col);
    // Hot curve: max intensity should blow out the bar + wash the car.
    const hot = e / ROOF_STROBE_INTENSITY_MAX; // 0–1+ when overdriven by flash
    housingMat.color
      .copy(col)
      .multiplyScalar(THREE.MathUtils.clamp(0.2 + hot * 2.4 + e * 0.08, 0.2, 4));
    faceMat.opacity = THREE.MathUtils.clamp(0.55 + hot * 0.45, 0.55, 1);

    light.intensity = e * 9.5;
    punch.intensity = e * 7.5;
    wash.intensity = e * 4.5;

    // Independent of car hide — authoring/timeline can flash with car off.
    group.visible = params.enabled;
    place();
  };

  const setFromCarBounds = (box: THREE.Box3) => {
    box.getCenter(carCenter);
    roofY = box.max.y;
    place();
    applyParams();
  };

  const triggerFlash = (durationSec?: number, peak = 28) => {
    const d =
      durationSec !== undefined ? durationSec : params.flashDuration;
    burstRemaining = THREE.MathUtils.clamp(d, 1, 10);
    pulsePeak = peak;
    strobePhase = 0;
    params.flashIntensity = peak;
    applyParams();
  };

  const stopFlash = () => {
    burstRemaining = 0;
    params.flashIntensity = 0;
    applyParams();
  };

  const update = (dt: number) => {
    const hz = Math.max(0.5, params.strobeHz);
    const duty = THREE.MathUtils.clamp(params.strobeDuty, 0.05, 0.95);
    const activeBurst = burstRemaining > 0;
    const activeLoop = params.strobing && params.enabled;

    if (activeBurst) {
      burstRemaining = Math.max(0, burstRemaining - dt);
    }

    if (activeBurst || activeLoop) {
      const peak = Math.max(
        pulsePeak,
        params.intensity > 1 ? params.intensity : 0,
        22,
      );
      strobePhase += dt * hz;
      const cycle = strobePhase % 1;
      if (cycle < duty) {
        params.flashIntensity = peak;
      } else if (params.flashIntensity > 0.01) {
        params.flashIntensity = Math.max(
          0,
          params.flashIntensity - params.flashDecay * dt * params.flashIntensity,
        );
      } else {
        params.flashIntensity = 0;
      }
      applyParams();
      return;
    }

    // Residual decay after burst ends / strobing off.
    if (params.flashIntensity > 0.01) {
      params.flashIntensity = Math.max(
        0,
        params.flashIntensity - params.flashDecay * dt * params.flashIntensity,
      );
      applyParams();
    } else if (params.flashIntensity !== 0) {
      params.flashIntensity = 0;
      applyParams();
    }
  };

  const dispose = () => {
    housing.geometry.dispose();
    face.geometry.dispose();
    housingMat.dispose();
    faceMat.dispose();
    light.dispose();
    punch.dispose();
    wash.dispose();
    group.clear();
  };

  place();
  applyParams();

  return {
    group,
    params,
    applyParams,
    setFromCarBounds,
    triggerFlash,
    stopFlash,
    update,
    dispose,
  };
}
