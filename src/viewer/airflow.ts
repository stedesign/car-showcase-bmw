import * as THREE from 'three';

export type AirflowParams = {
  /** Master on/off. */
  enabled: boolean;
  /** Ribbon lengths traveled per second. 0 holds the streaks still. */
  speed: number;
  /** How hot the core is. Drives the bloom. */
  brightness: number;
  /** How solid the ribbons are, separate from brightness. */
  opacity: number;
  /** Thickness relative to the default. 1 is the base width. */
  width: number;
  /** Main stream color (body, roof, upper wake). */
  flowColor: string;
  /** Second stream color (splitter, sills, rear wing). */
  accentColor: string;
};

export const DEFAULT_AIRFLOW_PARAMS: AirflowParams = {
  enabled: true,
  /** Continuous streak travel once fully on (independent of the grow intro). */
  speed: 1.35,
  brightness: 2.4,
  opacity: 0.9,
  width: 1,
  flowColor: '#3ad7ff',
  accentColor: '#ff2d4a',
};

/** Seconds for the front→back grow when switching on. */
const GROW_IN_SEC = 1.35;
/** Seconds to fade out when switching off (no reverse fill). */
const FADE_OUT_SEC = 0.45;
/** Streak motion is quieter while the fill is still growing in. */
const GROW_FLOW_SCALE = 0.22;

export type AirflowEnabledKey = { t: number; value: boolean };

export type AirflowHandle = {
  group: THREE.Group;
  params: AirflowParams;
  applyParams: () => void;
  /**
   * Drive grow / fade from the `airflow.enabled` timeline track so the fill
   * follows the playhead between Off → On (and fades Off → without reversing).
   */
  syncTimeline: (timelineTime: number, enabledKeys: AirflowEnabledKey[]) => void;
  /** Fit the streams to the car after load / reframe. Nose is +Z. */
  setFromCarBounds: (box: THREE.Box3) => void;
  /** Hide with the car without changing `enabled`. */
  setCarVisible: (visible: boolean) => void;
  update: (dt: number, camera: THREE.Camera) => void;
  dispose: () => void;
};

/** Grow across Off→On; fade across On→Off. */
export function evalAirflowEnabledKeys(
  keysIn: AirflowEnabledKey[],
  t: number,
): { reveal: number; fade: number } {
  if (!keysIn.length) return { reveal: 0, fade: 0 };
  const keys = [...keysIn].sort((a, b) => a.t - b.t);

  if (t <= keys[0].t) {
    return keys[0].value ? { reveal: 1, fade: 1 } : { reveal: 1, fade: 0 };
  }
  const last = keys[keys.length - 1]!;
  if (t >= last.t) {
    return last.value ? { reveal: 1, fade: 1 } : { reveal: 1, fade: 0 };
  }

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1]!.t < t) i += 1;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);

  if (!a.value && b.value) {
    // Spreading from the nose as we approach On.
    return { reveal: THREE.MathUtils.clamp(u, 0, 1), fade: 1 };
  }
  if (a.value && !b.value) {
    // Keep the filled shape; only fade out toward Off.
    return { reveal: 1, fade: 1 - THREE.MathUtils.clamp(u, 0, 1) };
  }
  if (a.value && b.value) return { reveal: 1, fade: 1 };
  return { reveal: 1, fade: 0 };
}

/**
 * Normalized car space. x: −1 left … +1 right (half-width).
 * y: 0 floor … 1 roof. z: +1 nose … −1 tail (half-length).
 */
type N3 = readonly [number, number, number];

type Seed = {
  points: N3[];
  accent: number;
  accentTail: number;
  halfWidth: number;
  streaks: number;
  mirror: boolean;
  offsets: number[];
  /** Extra delay (0–1) so outer streams grow slightly later. */
  growBias: number;
};

const SEGMENTS = 80;

/**
 * Even bands around the shell: roof, canopy, mid-body, sills, undertray,
 * front intake, flanks, and wing — so the car reads as a full volume of flow.
 */
const SEEDS: Seed[] = [
  {
    points: [
      [0, 0.3, 1.22],
      [0, 0.55, 1.05],
      [0, 1.12, 0.55],
      [0, 1.14, 0.05],
      [0, 1.16, -0.4],
      [0, 1.18, -0.85],
      [0, 1.08, -1.2],
      [0, 0.65, -1.55],
      [0, 0.35, -1.9],
    ],
    accent: 0,
    accentTail: 0.3,
    halfWidth: 0.016,
    streaks: 2.4,
    mirror: false,
    offsets: [0, 0.12, -0.12, 0.24, -0.24],
    growBias: 0,
  },
  {
    points: [
      [0.18, 0.28, 1.2],
      [0.28, 0.5, 1.02],
      [0.22, 1.08, 0.5],
      [0.2, 1.1, 0.02],
      [0.26, 1.12, -0.42],
      [0.32, 1.14, -0.88],
      [0.14, 1.02, -1.2],
      [0.06, 0.55, -1.55],
      [0.02, 0.3, -1.9],
    ],
    accent: 0.08,
    accentTail: 0.4,
    halfWidth: 0.014,
    streaks: 2.1,
    mirror: true,
    offsets: [0, 0.1],
    growBias: 0.04,
  },
  {
    // Mid canopy / door height — fills the gap between roof and sills.
    points: [
      [0.35, 0.22, 1.18],
      [0.72, 0.42, 1.0],
      [0.85, 0.72, 0.45],
      [0.82, 0.78, -0.15],
      [0.88, 0.82, -0.7],
      [0.7, 0.7, -1.15],
      [0.4, 0.45, -1.5],
      [0.18, 0.28, -1.85],
    ],
    accent: 0.25,
    accentTail: 0.45,
    halfWidth: 0.015,
    streaks: 2.3,
    mirror: true,
    offsets: [0, 0.12, 0.22],
    growBias: 0.08,
  },
  {
    // Wheel-arch band.
    points: [
      [0.55, 0.18, 1.16],
      [1.05, 0.35, 0.95],
      [1.12, 0.48, 0.35],
      [1.1, 0.5, -0.25],
      [1.14, 0.55, -0.75],
      [1.0, 0.42, -1.2],
      [0.65, 0.28, -1.55],
      [0.35, 0.18, -1.85],
    ],
    accent: 0.45,
    accentTail: 0.4,
    halfWidth: 0.016,
    streaks: 2.5,
    mirror: true,
    offsets: [0, 0.1],
    growBias: 0.1,
  },
  {
    // Low sill / splitter.
    points: [
      [0.2, 0.12, 1.22],
      [0.55, 0.16, 1.06],
      [1.05, 0.22, 0.85],
      [1.1, 0.26, 0.15],
      [1.08, 0.28, -0.5],
      [1.05, 0.32, -1.0],
      [0.7, 0.2, -1.4],
      [0.35, 0.12, -1.8],
    ],
    accent: 0.85,
    accentTail: 0.15,
    halfWidth: 0.014,
    streaks: 2.9,
    mirror: true,
    offsets: [0, 0.1, 0.18],
    growBias: 0.12,
  },
  {
    // Undertray / floor flow.
    points: [
      [0.08, 0.06, 1.2],
      [0.35, 0.08, 1.0],
      [0.7, 0.1, 0.55],
      [0.75, 0.1, -0.1],
      [0.7, 0.1, -0.7],
      [0.45, 0.08, -1.25],
      [0.2, 0.06, -1.7],
      [0.05, 0.05, -2.0],
    ],
    accent: 0.95,
    accentTail: 0.05,
    halfWidth: 0.012,
    streaks: 3.1,
    mirror: true,
    offsets: [0, 0.14, 0.28],
    growBias: 0.16,
  },
  {
    // Center underbody.
    points: [
      [0, 0.05, 1.18],
      [0, 0.07, 0.9],
      [0, 0.08, 0.3],
      [0, 0.08, -0.3],
      [0, 0.08, -0.9],
      [0, 0.1, -1.4],
      [0, 0.12, -1.85],
    ],
    accent: 0.7,
    accentTail: 0.2,
    halfWidth: 0.013,
    streaks: 2.7,
    mirror: false,
    offsets: [0, 0.1, -0.1],
    growBias: 0.14,
  },
  {
    // Front intake / nose wrap into the side.
    points: [
      [0.12, 0.2, 1.28],
      [0.45, 0.28, 1.12],
      [0.85, 0.38, 0.95],
      [1.08, 0.48, 0.55],
      [1.12, 0.55, 0.05],
      [1.1, 0.58, -0.5],
      [0.9, 0.48, -1.05],
      [0.5, 0.3, -1.5],
      [0.22, 0.18, -1.85],
    ],
    accent: 0.55,
    accentTail: 0.35,
    halfWidth: 0.015,
    streaks: 2.4,
    mirror: true,
    offsets: [0, 0.08],
    growBias: 0.06,
  },
  {
    // Outer wake.
    points: [
      [1.08, 0.22, 1.05],
      [1.16, 0.28, 0.35],
      [1.18, 0.32, -0.3],
      [1.14, 0.36, -0.85],
      [0.9, 0.26, -1.35],
      [0.5, 0.16, -1.8],
    ],
    accent: 1,
    accentTail: 0,
    halfWidth: 0.013,
    streaks: 2.8,
    mirror: true,
    offsets: [0],
    growBias: 0.18,
  },
  {
    // Rear wing / shark fin wake.
    points: [
      [0.12, 1.1, -0.05],
      [0.28, 1.18, -0.5],
      [0.42, 1.24, -0.88],
      [0.22, 1.14, -1.18],
      [0.08, 0.7, -1.5],
      [0.03, 0.35, -1.9],
    ],
    accent: 0.65,
    accentTail: 0.3,
    halfWidth: 0.013,
    streaks: 1.8,
    mirror: true,
    offsets: [0, 0.12],
    growBias: 0.2,
  },
];

const vertexShader = /* glsl */ `
  uniform float uWidth;
  uniform float uRadius;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec3 pos = position + normal * (uRadius * (uWidth - 1.0));
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = cameraPosition - worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uFlow;
  uniform vec3 uAccent;
  uniform float uAccentMix;
  uniform float uAccentTail;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uBrightness;
  uniform float uOpacity;
  uniform float uPhase;
  uniform float uStreaks;
  uniform float uReveal;
  uniform float uGrowBias;
  uniform float uFade;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    if (uFade < 0.001) discard;

    float localReveal = clamp((uReveal - uGrowBias) / max(0.001, 1.0 - uGrowBias), 0.0, 1.0);
    // Soft front-to-back grow: hide everything past the reveal tip.
    float tip = smoothstep(localReveal + 0.04, localReveal - 0.02, vUv.x);
    if (tip < 0.001) discard;

    float ndv = abs(dot(normalize(vNormal), normalize(vView)));
    float profile = 0.55 + 0.45 * ndv;

    float flow = fract(vUv.x * uStreaks - uTime * uSpeed * uStreaks + uPhase);
    float head = smoothstep(0.62, 0.36, flow);
    float tail = smoothstep(0.0, 0.46, flow);
    float dash = head * tail;
    float energy = 0.72 + dash * 0.7;

    float ends = smoothstep(0.0, 0.07, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
    float mixAmt = clamp(uAccentMix + vUv.x * uAccentTail, 0.0, 1.0);
    vec3 col = mix(uFlow, uAccent, mixAmt);

    // Bright tip while growing so the front edge reads as a leading pulse.
    float growGlow = mix(1.0, 1.35, tip * (1.0 - localReveal));
    float hot = energy * uBrightness * profile * growGlow;
    float cover = clamp(ends * tip * uOpacity * uFade, 0.0, 1.0);
    gl_FragColor = vec4(col * hot, cover);
  }
`;

type Ribbon = {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
};

function makeMaterial(
  params: AirflowParams,
  radius: number,
  growBias: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFlow: { value: new THREE.Color(params.flowColor) },
      uAccent: { value: new THREE.Color(params.accentColor) },
      uAccentMix: { value: 0 },
      uAccentTail: { value: 0 },
      uTime: { value: 0 },
      uSpeed: { value: params.speed },
      uBrightness: { value: params.brightness },
      uOpacity: { value: params.opacity },
      uPhase: { value: 0 },
      uStreaks: { value: 2 },
      uWidth: { value: Math.max(0.05, params.width) },
      uRadius: { value: radius },
      uReveal: { value: 1 },
      uGrowBias: { value: growBias },
      uFade: { value: 1 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    premultipliedAlpha: false,
  });
}

function shiftPoint(n: N3, dx: number): N3 {
  const x = n[0];
  const sign = x === 0 ? 1 : Math.sign(x);
  return [x + dx * sign, n[1], n[2]];
}

export function createAirflow(): AirflowHandle {
  const params: AirflowParams = { ...DEFAULT_AIRFLOW_PARAMS };
  const group = new THREE.Group();
  group.name = 'Airflow';
  group.visible = false;

  const ribbons: Ribbon[] = [];
  let placed = false;
  let carVisible = true;
  let time = 0;
  let reveal = params.enabled ? 1 : 0;
  let fade = params.enabled ? 1 : 0;
  let fadeTarget = fade;
  let wasWanted = false;
  /** When true, reveal/fade follow the enabled timeline track (not wall-clock). */
  let timelineDriving = false;

  const clearRibbons = () => {
    for (const ribbon of ribbons) {
      ribbon.mesh.geometry.dispose();
      ribbon.material.dispose();
      group.remove(ribbon.mesh);
    }
    ribbons.length = 0;
  };

  const wanted = () => params.enabled && carVisible;

  const syncVisible = () => {
    // Visible while growing (reveal) or fading, even if enabled is still false
    // between Off → On keys on the timeline.
    group.visible = placed && carVisible && fade > 0.001 && reveal > 0.001;
  };

  const flowSpeed = () => {
    // Fill intro stays calm; once fully on, Speed drives a faster streak travel.
    const grown = THREE.MathUtils.smoothstep(reveal, 0.55, 1);
    const scale = THREE.MathUtils.lerp(GROW_FLOW_SCALE, 1, grown);
    return Math.max(0, params.speed) * scale;
  };

  const pushUniforms = () => {
    for (const ribbon of ribbons) {
      const u = ribbon.material.uniforms;
      u.uTime.value = time;
      u.uSpeed.value = flowSpeed();
      u.uBrightness.value = params.brightness;
      u.uOpacity.value = params.opacity;
      (u.uFlow.value as THREE.Color).set(params.flowColor);
      (u.uAccent.value as THREE.Color).set(params.accentColor);
      u.uWidth.value = Math.max(0.05, params.width);
      u.uReveal.value = reveal;
      u.uFade.value = fade;
    }
  };

  const applyParams = () => {
    timelineDriving = false;
    const on = wanted();
    if (on && !wasWanted) {
      // Fresh activate — grow from the nose, fully opaque.
      reveal = 0;
      fade = 1;
      fadeTarget = 1;
    } else if (!on) {
      // Switch off — keep the filled shape, only fade out.
      fadeTarget = 0;
    } else {
      fadeTarget = 1;
      if (fade < 0.001) fade = 1;
      // Do not snap reveal — a grow may already be in progress.
    }
    wasWanted = on;
    syncVisible();
    pushUniforms();
  };

  const syncTimeline = (timelineTime: number, enabledKeys: AirflowEnabledKey[]) => {
    if (!enabledKeys.length) {
      // No On/Off animation — keep whatever UI / look state we have.
      pushUniforms();
      return;
    }
    timelineDriving = true;
    const next = evalAirflowEnabledKeys(enabledKeys, timelineTime);
    reveal = next.reveal;
    fade = next.fade;
    fadeTarget = next.fade;
    wasWanted = wanted();
    syncVisible();
    pushUniforms();
  };

  const build = (box: THREE.Box3) => {
    clearRibbons();
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    const hx = Math.max(0.2, (box.max.x - box.min.x) * 0.5);
    const hy = Math.max(0.2, box.max.y - box.min.y);
    const hz = Math.max(0.2, (box.max.z - box.min.z) * 0.5);
    const widthScale = THREE.MathUtils.clamp(hx / 1.02, 0.45, 2.4);

    const add = (points: N3[], seed: Seed, phase: number) => {
      const vectors = points.map(
        (n) =>
          new THREE.Vector3(
            cx + n[0] * hx,
            box.min.y + n[1] * hy,
            cz + n[2] * hz,
          ),
      );
      const curve = new THREE.CatmullRomCurve3(vectors, false, 'centripetal', 0.45);
      const radius = seed.halfWidth * widthScale;
      const geo = new THREE.TubeGeometry(curve, SEGMENTS, radius, 6, false);
      const material = makeMaterial(params, radius, seed.growBias);
      material.uniforms.uAccentMix.value = seed.accent;
      material.uniforms.uAccentTail.value = seed.accentTail;
      material.uniforms.uPhase.value = phase;
      material.uniforms.uStreaks.value = seed.streaks;
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = 'AirflowRibbon';
      mesh.renderOrder = 20;
      mesh.raycast = () => {};
      group.add(mesh);
      ribbons.push({ mesh, material });
    };

    let phase = 0.17;
    for (const seed of SEEDS) {
      const sides = seed.mirror ? [1, -1] : [1];
      for (const sideSign of sides) {
        for (const offset of seed.offsets) {
          const points = seed.points.map((n) => {
            const shifted = shiftPoint(n, offset);
            return [shifted[0] * sideSign, shifted[1], shifted[2]] as N3;
          });
          add(points, seed, phase % 1);
          phase += 0.173;
        }
      }
    }
    placed = true;
    // Rebuild keeps the current look; don't replay the grow intro.
    wasWanted = wanted();
    if (wasWanted) {
      if (reveal < 0.001) reveal = 1;
      fade = 1;
      fadeTarget = 1;
    } else {
      reveal = 1;
      fade = 0;
      fadeTarget = 0;
    }
    syncVisible();
    pushUniforms();
  };

  const setFromCarBounds = (box: THREE.Box3) => {
    if (box.isEmpty()) return;
    build(box);
  };

  const setCarVisible = (visible: boolean) => {
    carVisible = visible;
    applyParams();
  };

  const update = (dt: number, _camera: THREE.Camera) => {
    if (!placed) return;
    time += dt;

    if (!timelineDriving) {
      if (wanted() && reveal < 1) {
        reveal = Math.min(1, reveal + dt / GROW_IN_SEC);
      }

      if (fade < fadeTarget) {
        fade = Math.min(1, fade + dt / FADE_OUT_SEC);
      } else if (fade > fadeTarget) {
        fade = Math.max(0, fade - dt / FADE_OUT_SEC);
      }
    }

    syncVisible();
    if (!group.visible) return;
    pushUniforms();
  };

  const dispose = () => {
    clearRibbons();
    placed = false;
  };

  return {
    group,
    params,
    applyParams,
    syncTimeline,
    setFromCarBounds,
    setCarVisible,
    update,
    dispose,
  };
}
