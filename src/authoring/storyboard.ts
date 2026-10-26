import type { Viewer } from '../viewer/Viewer';
import { captureSettings, defaultSettings, type SavedSettings } from '../viewer/settings';
import type { CustomLightParams } from '../viewer/customLights';
import { defaultBezier } from './bezier';
import {
  DEFAULT_TEXT_COLOR,
  MASKED_TEXT_COLOR,
  PROJECT_VERSION,
  nextAuthoringId,
  resetAuthoringIdCounter,
  vec3,
  type CameraClip,
  type CameraPoseValue,
  type EasingName,
  type Keyframe,
  type KeyframeValue,
  type MasterClip,
  type MasterTextAlign,
  type MasterTextAnchor,
  type MasterTextClip,
  type MasterTextEffect,
  type Project,
  type Scene,
  type TimelineTrack,
} from './project';

/**
 * 60-second loop. Each shot is its own scene. The master orders them.
 * The last clip reuses the opening scene so the join is the same frame.
 */
export const STORYBOARD_DURATION = 60;
export const STORYBOARD_NAME = 'BMW M Hybrid V8 — 60s Loop v2';
/** Prior default names — Editor upgrades these saves to the current storyboard. */
export const STORYBOARD_LEGACY_NAMES = [
  'WRT Commercial',
  'BMW M Hybrid V8 — 20s Storyboard',
  'BMW M Hybrid V8 — 25s Storyboard',
  'BMW M Hybrid V8 — 25s Storyboard v2',
  'BMW M Hybrid V8 — 60s Loop',
] as const;

const SWEEP_DETAIL_ID = 'sweep-detail';
const SWEEP_LOGO_ID = 'sweep-logo';

type Pose = CameraPoseValue;

function pose(
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  fov: number,
): Pose {
  return {
    position: vec3(px, py, pz),
    target: vec3(tx, ty, tz),
    fov,
  };
}

function kf(t: number, value: KeyframeValue, easing: EasingName = 'easeInOut'): Keyframe {
  return {
    t,
    value: typeof value === 'object' && value !== null ? structuredClone(value) : value,
    easing,
    bezier: defaultBezier(easing),
  };
}

function track(target: string, keyframes: Keyframe[]): TimelineTrack {
  return {
    id: nextAuthoringId('track'),
    target,
    keyframes: [...keyframes].sort((a, b) => a.t - b.t),
  };
}

function cam(name: string, start: Pose): CameraClip {
  return {
    id: nextAuthoringId('camera'),
    name,
    position: { ...start.position },
    target: { ...start.target },
    fov: start.fov,
  };
}

function sweepSpot(
  id: string,
  name: string,
  x: number,
  y: number,
  z: number,
  rotX: number,
  rotY: number,
  rotZ: number,
): CustomLightParams {
  return {
    id,
    name,
    type: 'spot',
    enabled: true,
    color: '#ffffff',
    intensity: 0,
    distance: 6,
    decay: 1.4,
    angle: 22,
    penumbra: 0.45,
    x,
    y,
    z,
    rotX,
    rotY,
    rotZ,
  };
}

/** Nose camera, high enough that the rear-wall mark clears the roof. */
const FRONT = pose(0, 1.55, 5.6, 0, 1.35, -4, 28);

function freshLook(viewer?: Viewer): SavedSettings {
  const look = viewer ? captureSettings(viewer) : defaultSettings();
  look.customLights = [];
  look.display = {
    ...look.display,
    background: true,
    grid: false,
    bgColor: '#000000',
  };
  return look;
}

/** Car present, almost unlit. The WRT mark is the only bright thing. */
function crush(look: SavedSettings): void {
  look.lighting = {
    ...look.lighting,
    exposure: 0.16,
    ambientIntensity: 0.015,
    directIntensity: 0.05,
    environmentIntensity: 0.18,
  };
  look.softboxes = { ...look.softboxes, enabled: true, intensity: 0, showHelpers: false };
  look.carLights = {
    ...look.carLights,
    enabled: true,
    grilleEnabled: true,
    grilleStrength: 0,
    edgeEnabled: true,
    edgeStrength: 0,
    redEnabled: true,
    redStrength: 0,
    groundGlow: true,
    groundGlowStrength: 0,
    beamsEnabled: true,
    beamStrength: 0,
  };
  look.airflow = {
    ...look.airflow,
    enabled: false,
  };
  look.roofStrobe = {
    ...look.roofStrobe,
    enabled: false,
    intensity: 0,
    strobing: false,
    color: '#ffffff',
    strobeHz: 1.2,
    strobeDuty: 0.12,
    flashDecay: 12,
    flashIntensity: 0,
  };
  look.logo = {
    ...look.logo,
    enabled: true,
    intensity: 2.6,
    opacity: 0.95,
    strobeEnabled: false,
    reflectionEnabled: true,
  };
  look.dotGrid = {
    ...look.dotGrid,
    enabled: true,
    opacity: 0,
    reveal: 0,
    glow: 0,
    effectMode: 0,
    effectStrength: 0,
    reflectionEnabled: false,
  };
}

/** Lit paddock for the car chapters. The wall stays in the background. */
function garage(look: SavedSettings): void {
  crush(look);
  look.lighting.exposure = 0.34;
  look.lighting.ambientIntensity = 0.04;
  look.lighting.directIntensity = 0.22;
  look.lighting.environmentIntensity = 0.42;
  look.softboxes.intensity = 1;
  look.softboxes.keyIntensity = 2.6;
  look.softboxes.fillIntensity = 1.2;
  look.softboxes.rimIntensity = 1.9;
  look.carLights.edgeStrength = 1.35;
  look.carLights.grilleStrength = 1.7;
  look.carLights.beamStrength = 0.35;
  look.carLights.groundGlowStrength = 0.8;
  look.carLights.redStrength = 0.7;
  look.airflow.enabled = true;
  look.logo.intensity = 1.4;
  look.dotGrid.opacity = 0.35;
  look.dotGrid.reveal = 1;
  look.dotGrid.glow = 0.55;
  look.dotGrid.effectMode = 1;
  look.dotGrid.effectStrength = 0.45;
  look.dotGrid.waveSpeed = 0.8;
  look.dotGrid.reflectionEnabled = true;
  look.dotGrid.reflectionOpacity = 0.35;
}

function wallLook(look: SavedSettings, mode: number, waveSpeed: number): void {
  crush(look);
  look.lighting.exposure = 0.42;
  look.lighting.environmentIntensity = 0.22;
  look.logo.intensity = 0.25;
  look.dotGrid.opacity = 1;
  look.dotGrid.reveal = 1;
  look.dotGrid.glow = 1.5;
  look.dotGrid.effectMode = mode;
  look.dotGrid.effectStrength = 1.4;
  look.dotGrid.wave = 0.85;
  look.dotGrid.pulse = 0.8;
  look.dotGrid.waveSpeed = waveSpeed;
  look.dotGrid.reflectionEnabled = true;
  look.dotGrid.reflectionOpacity = 0.45;
}

function sceneOf(
  name: string,
  duration: number,
  camera: CameraClip,
  look: SavedSettings,
  tracks: TimelineTrack[],
): Scene {
  return {
    id: nextAuthoringId('scene'),
    name,
    duration,
    playCameraId: camera.id,
    carVisible: true,
    look,
    cameras: [camera],
    planes: [],
    timeline: { tracks },
  };
}

function poseTrack(camera: CameraClip, start: Pose, end: Pose, duration: number): TimelineTrack {
  return track(`camera.${camera.id}.pose`, [
    kf(0, start),
    kf(duration, end),
  ]);
}

type TitleOpts = {
  name: string;
  text: string;
  start: number;
  duration: number;
  effect: MasterTextEffect;
  anchor?: MasterTextAnchor;
  align?: MasterTextAlign;
  size: number;
  color?: string;
  x?: number;
  y?: number;
};

function buildProject(viewer: Viewer | undefined): Project {
  resetAuthoringIdCounter(1);

  const scenes: Scene[] = [];
  const clips: MasterClip[] = [];
  let clock = 0;
  const mark: Record<string, number> = {};
  let logoFlip = 0;
  /** Alternate the background mark on each new shot. The loop reuses the opening scene. */
  const stampLogo = (look: SavedSettings, tracks: TimelineTrack[]): TimelineTrack[] => {
    const logoMark = logoFlip % 2;
    logoFlip += 1;
    look.logo.mark = logoMark;
    look.dotGrid.mark = logoMark;
    return [track('logo.mark', [kf(0, logoMark, 'linear')]), ...tracks];
  };

  const mount = (scene: Scene, key: string, masterOut?: number) => {
    mark[key] = clock;
    const out = masterOut ?? scene.duration;
    scenes.push(scene);
    clips.push({
      id: nextAuthoringId('mclip'),
      sceneId: scene.id,
      in: 0,
      out,
    });
    clock += out - 0;
  };

  const mountAgain = (scene: Scene, key: string, masterOut: number) => {
    mark[key] = clock;
    clips.push({
      id: nextAuthoringId('mclip'),
      sceneId: scene.id,
      in: 0,
      out: masterOut,
    });
    clock += masterOut;
  };

  // --- Open ---
  const frontLook = freshLook(viewer);
  crush(frontLook);
  const frontCam = cam('Front', FRONT);
  const front = sceneOf('Front / Logo', 2.2, frontCam, frontLook, stampLogo(frontLook, []));
  mount(front, 'front');

  const strobeLook = freshLook(viewer);
  crush(strobeLook);
  strobeLook.roofStrobe.enabled = true;
  strobeLook.roofStrobe.intensity = 18;
  strobeLook.roofStrobe.strobeHz = 1.2;
  strobeLook.roofStrobe.strobeDuty = 0.08;
  strobeLook.roofStrobe.flashDecay = 12;
  const strobeCam = cam('Front', FRONT);
  mount(
    sceneOf('Strobe', 2.6, strobeCam, strobeLook, stampLogo(strobeLook, [
      track('roofStrobe.strobing', [kf(0, true, 'linear')]),
      track('roofStrobe.strobeHz', [kf(0, 1.2, 'linear')]),
      track('roofStrobe.intensity', [kf(0, 18, 'linear')]),
      track('roofStrobe.strobeDuty', [kf(0, 0.08), kf(2.6, 0.22)]),
    ])),
    'strobe',
  );

  const gridLook = freshLook(viewer);
  crush(gridLook);
  const gridCam = cam('Front', FRONT);
  mount(
    sceneOf('Grid On', 0.8, gridCam, gridLook, stampLogo(gridLook, [
      track('dotGrid.opacity', [kf(0, 0), kf(0.45, 1), kf(0.8, 1)]),
      track('dotGrid.reveal', [kf(0, 0), kf(0.45, 1), kf(0.8, 1)]),
      track('dotGrid.glow', [kf(0, 0), kf(0.45, 1.15), kf(0.8, 1.15)]),
      track('dotGrid.effectStrength', [kf(0, 0, 'linear'), kf(0.45, 0.7, 'linear')]),
    ])),
    'grid',
  );

  const wall = (
    name: string,
    key: string,
    mode: number,
    waveSpeed: number,
    shot: Pose,
  ) => {
    const look = freshLook(viewer);
    wallLook(look, mode, waveSpeed);
    mount(sceneOf(name, 1, cam('Wall', shot), look, stampLogo(look, [])), key);
  };

  // Three-quarter on the rear wall, alternating sides. One second, no move.
  wall('Wall / Scan', 'scan', 2, 2.2, pose(-2.8, 0.55, 0.4, -0.4, 1.7, -7.2, 32));
  wall('Wall / Rain', 'rain', 3, 1.8, pose(3.1, 1.8, -0.2, 0.3, 1.5, -7.2, 30));
  wall('Wall / Sparkle', 'sparkle', 4, 2, pose(-1.8, 1.15, -2.4, 0.2, 1.6, -7.2, 22));
  // waveSpeed ~4.5 so the shock ring lands inside the second.
  wall('Wall / Shock', 'shock', 6, 4.5, pose(2.4, 0.45, -1.6, -0.2, 1.35, -7.2, 28));

  const edgeLook = freshLook(viewer);
  crush(edgeLook);
  edgeLook.lighting.exposure = 0.2;
  edgeLook.logo.intensity = 2.2;
  edgeLook.dotGrid.opacity = 1;
  edgeLook.dotGrid.reveal = 1;
  edgeLook.dotGrid.glow = 1.1;
  edgeLook.dotGrid.effectMode = 1;
  edgeLook.dotGrid.effectStrength = 0.8;
  edgeLook.dotGrid.waveSpeed = 1.2;
  edgeLook.dotGrid.reflectionEnabled = true;
  const edgeCam = cam('Front', FRONT);
  mount(
    sceneOf('Edge', 2.4, edgeCam, edgeLook, stampLogo(edgeLook, [
      track('carLights.edgeStrength', [
        kf(0, 0, 'linear'),
        kf(0.02, 0, 'linear'),
        kf(0.07, 2.4, 'linear'),
        kf(2.4, 2.4, 'linear'),
      ]),
    ])),
    'edge',
  );

  // --- Car ---
  const heroStart = pose(3.35, 0.95, 4.6, 0, 0.52, 0.15, 33);
  const heroEnd = pose(2.95, 0.85, 4.15, 0, 0.5, 0.15, 30);
  const heroLook = freshLook(viewer);
  garage(heroLook);
  heroLook.lighting.exposure = 0.2;
  heroLook.softboxes.intensity = 0.08;
  heroLook.carLights.edgeStrength = 2.4;
  heroLook.carLights.grilleStrength = 0;
  heroLook.carLights.beamStrength = 0;
  heroLook.carLights.groundGlowStrength = 0;
  heroLook.dotGrid.opacity = 1;
  heroLook.dotGrid.effectStrength = 0.8;
  const heroCam = cam('Hero', heroStart);
  mount(
    sceneOf('Hero', 8, heroCam, heroLook, stampLogo(heroLook, [
      poseTrack(heroCam, heroStart, heroEnd, 8),
      track('lighting.exposure', [kf(0, 0.2), kf(2.2, 0.34), kf(8, 0.34)]),
      track('softboxes.intensity', [kf(0, 0.08), kf(0.5, 0.3), kf(2.2, 1), kf(8, 1)]),
      track('carLights.edgeStrength', [kf(0, 2.4), kf(2.4, 1.35), kf(8, 1.35)]),
      track('carLights.grilleStrength', [kf(0, 0), kf(1.4, 1.7), kf(8, 1.7)]),
      track('carLights.beamStrength', [kf(0, 0), kf(1.6, 0.35), kf(8, 0.35)]),
      track('carLights.groundGlowStrength', [kf(0, 0), kf(1.8, 0.8), kf(8, 0.8)]),
      track('dotGrid.opacity', [kf(0, 1), kf(2.4, 0.35), kf(8, 0.35)]),
    ])),
    'hero',
  );

  const spec = (name: string, key: string, start: Pose, end: Pose) => {
    const look = freshLook(viewer);
    garage(look);
    const camera = cam(name, start);
    mount(
      sceneOf(name, 4, camera, look, stampLogo(look, [poseTrack(camera, start, end, 4)])),
      key,
    );
  };

  spec(
    'Spec / Engine',
    'engine',
    pose(-0.55, 0.1, 2.95, 0.05, 0.06, 1.55, 36),
    pose(0.65, 0.14, 2.7, 0.12, 0.1, 1.45, 32),
  );
  spec(
    'Spec / Weight',
    'weight',
    pose(2.55, 0.58, 0.45, 1.05, 0.52, 0.25, 24),
    pose(2.35, 0.56, 0.55, 1.05, 0.52, 0.2, 23),
  );
  spec(
    'Spec / Chassis',
    'chassis',
    pose(-0.35, 0.22, -4.35, 0, 0.65, -1.55, 34),
    pose(-0.15, 1.15, -4.7, 0, 0.8, -1.3, 32),
  );
  spec(
    'Spec / Tyres',
    'tyres',
    pose(2.15, 0.38, 1.55, 1.05, 0.34, 1.35, 30),
    pose(1.9, 0.34, 1.42, 1.05, 0.34, 1.35, 27),
  );

  const history = (name: string, key: string, start: Pose, end: Pose) => {
    const look = freshLook(viewer);
    garage(look);
    const camera = cam(name, start);
    mount(
      sceneOf(name, 4, camera, look, stampLogo(look, [poseTrack(camera, start, end, 4)])),
      key,
    );
  };

  history(
    '2021',
    'y2021',
    pose(2.2, 0.7, 3.4, 0, 0.5, 0, 34),
    pose(1.6, 0.75, 3.6, 0, 0.5, 0.1, 33),
  );
  history(
    '2022',
    'y2022',
    pose(-2.4, 0.65, 3.2, 0, 0.5, 0, 34),
    pose(-1.8, 0.7, 3.5, 0, 0.48, 0.1, 33),
  );
  history(
    '2023',
    'y2023',
    pose(-3.2, 0.8, -2.4, 0, 0.55, 0, 32),
    pose(-2.6, 0.9, -2.8, 0, 0.55, -0.1, 31),
  );
  history(
    '2024',
    'y2024',
    pose(3.8, 1.3, 4.2, 0, 0.5, 0, 30),
    pose(3.2, 1.15, 3.7, 0, 0.5, 0.1, 28),
  );

  // --- Close ---
  const wideStart = pose(4.4, 0.85, 5.4, 0, 0.45, 0.1, 36);
  const wideEnd = pose(5.2, 1.05, 6.2, 0, 0.48, 0, 37);
  const wideLook = freshLook(viewer);
  garage(wideLook);
  wideLook.dotGrid.opacity = 0.2;
  const wideCam = cam('Wide', wideStart);
  mount(
    sceneOf('Wide', 3, wideCam, wideLook, stampLogo(wideLook, [
      poseTrack(wideCam, wideStart, wideEnd, 3),
      track('carLights.edgeStrength', [
        kf(0, 1.35, 'linear'),
        kf(0.35, 1.35, 'linear'),
        kf(0.5, 2.3, 'easeInOut'),
        kf(0.9, 1.3, 'easeInOut'),
        kf(1.35, 1.3, 'linear'),
        kf(1.5, 2.2, 'easeInOut'),
        kf(1.95, 1.35, 'easeInOut'),
        kf(3, 1.35, 'linear'),
      ]),
      track('carLights.grilleStrength', [
        kf(0, 1.7, 'linear'),
        kf(0.35, 1.7, 'linear'),
        kf(0.5, 2.8, 'easeInOut'),
        kf(0.9, 1.7, 'easeInOut'),
        kf(1.35, 1.7, 'linear'),
        kf(1.5, 2.7, 'easeInOut'),
        kf(1.95, 1.7, 'easeInOut'),
        kf(3, 1.7, 'linear'),
      ]),
    ])),
    'wide',
  );

  const detailStart = pose(0.78, 0.4, 2.35, 0.48, 0.4, 1.92, 20);
  const detailEnd = pose(0.72, 0.38, 2.28, 0.48, 0.4, 1.92, 19);
  const detailLook = freshLook(viewer);
  crush(detailLook);
  detailLook.lighting.exposure = 0.22;
  detailLook.softboxes.intensity = 0.08;
  detailLook.carLights.edgeStrength = 0.15;
  detailLook.logo.intensity = 0.4;
  detailLook.customLights = [
    sweepSpot(SWEEP_DETAIL_ID, 'Sweep Detail', -0.35, 0.95, 2.9, -28, 18, 0),
  ];
  const detailCam = cam('Detail', detailStart);
  mount(
    sceneOf('Detail Sweep', 2.5, detailCam, detailLook, stampLogo(detailLook, [
      poseTrack(detailCam, detailStart, detailEnd, 2.5),
      track(`light.${SWEEP_DETAIL_ID}.intensity`, [
        kf(0, 0, 'linear'),
        kf(0.2, 7.5),
        kf(2.2, 6.8),
        kf(2.5, 0, 'linear'),
      ]),
      track(`light.${SWEEP_DETAIL_ID}.position`, [
        kf(0, vec3(-0.35, 0.95, 2.9), 'linear'),
        kf(1.25, vec3(0.55, 0.55, 2.55)),
        kf(2.5, vec3(1.25, 0.28, 2.15)),
      ]),
      track(`light.${SWEEP_DETAIL_ID}.rotation`, [
        kf(0, vec3(-28, 18, 0), 'linear'),
        kf(1.25, vec3(-18, -5, 0)),
        kf(2.5, vec3(-8, -28, 0)),
      ]),
    ])),
    'detail',
  );

  const roundelStart = pose(0.22, 0.52, 2.68, 0, 0.34, 2.1, 12);
  const roundelEnd = pose(0.16, 0.48, 2.58, 0, 0.34, 2.1, 11);
  const roundelLook = freshLook(viewer);
  crush(roundelLook);
  roundelLook.lighting.exposure = 0.22;
  roundelLook.softboxes.intensity = 0.06;
  roundelLook.carLights.edgeStrength = 0.12;
  roundelLook.logo.intensity = 0.3;
  roundelLook.customLights = [
    sweepSpot(SWEEP_LOGO_ID, 'Sweep BMW Logo', -0.7, 0.75, 2.7, -22, 22, 0),
  ];
  const roundelCam = cam('Roundel', roundelStart);
  mount(
    sceneOf('Roundel', 1.5, roundelCam, roundelLook, stampLogo(roundelLook, [
      poseTrack(roundelCam, roundelStart, roundelEnd, 1.5),
      track(`light.${SWEEP_LOGO_ID}.intensity`, [
        kf(0, 0, 'linear'),
        kf(0.15, 8.2),
        kf(1.15, 7),
        kf(1.5, 0.6),
      ]),
      track(`light.${SWEEP_LOGO_ID}.position`, [
        kf(0, vec3(-0.7, 0.75, 2.7), 'linear'),
        kf(0.75, vec3(0.05, 0.52, 2.4)),
        kf(1.5, vec3(0.7, 0.38, 2.2)),
      ]),
      track(`light.${SWEEP_LOGO_ID}.rotation`, [
        kf(0, vec3(-22, 22, 0), 'linear'),
        kf(0.75, vec3(-14, 0, 0)),
        kf(1.5, vec3(-8, -22, 0)),
      ]),
    ])),
    'roundel',
  );

  // Same scene as the open, one second, so the loop joins on the logo in the dark.
  mountAgain(front, 'loop', 1);

  if (Math.abs(clock - STORYBOARD_DURATION) > 0.001) {
    throw new Error(`Storyboard master is ${clock}s, expected ${STORYBOARD_DURATION}s`);
  }

  let lane = 0;
  const title = (opts: TitleOpts): MasterTextClip => {
    const clip: MasterTextClip = {
      id: nextAuthoringId('mtext'),
      name: opts.name,
      text: opts.text,
      start: opts.start,
      duration: opts.duration,
      effect: opts.effect,
      anchor: opts.anchor ?? 'center',
      align: opts.align ?? 'center',
      size: opts.size,
      lane: lane++,
      font: 'helvetica',
      color:
        opts.color ??
        (opts.effect === 'maskedHeading' ? MASKED_TEXT_COLOR : DEFAULT_TEXT_COLOR),
      opacity: 1,
      speed: 0,
    };
    if (opts.x !== undefined) clip.x = opts.x;
    if (opts.y !== undefined) clip.y = opts.y;
    return clip;
  };

  const card = (key: string, length: number, head: string, sub: string, headSize = 0.1) => {
    const start = mark[key] + 0.15;
    const duration = length - 0.35;
    return [
      title({
        name: head,
        text: head,
        start,
        duration,
        effect: 'maskedHeading',
        size: headSize,
        y: 0.38,
      }),
      title({
        name: sub,
        text: sub,
        start,
        duration,
        effect: 'fade',
        size: 0.038,
        y: 0.54,
      }),
    ];
  };

  const date = (key: string, when: string, line: string) =>
    title({
      name: when,
      text: `${when}\n${line}`,
      start: mark[key] + 0.15,
      duration: 3.65,
      effect: 'fade',
      anchor: 'bottom',
      align: 'left',
      size: 0.042,
    });

  const texts: MasterTextClip[] = [
    title({
      name: 'Ident',
      text: 'BMW M HYBRID V8  ·  #15',
      start: 0.8,
      duration: 58.4,
      effect: 'fade',
      anchor: 'top',
      align: 'left',
      size: 0.032,
      x: 0.05,
      y: 0.05,
    }),
    title({
      name: 'BMW M Hybrid V8',
      text: 'BMW M HYBRID V8',
      start: mark.edge + 0.15,
      duration: 2.1,
      effect: 'maskedHeading',
      size: 0.078,
      y: 0.38,
    }),
    title({
      name: 'Team line',
      text: '#15  ·  BMW M TEAM WRT',
      start: mark.edge + 0.45,
      duration: 1.8,
      effect: 'fade',
      size: 0.036,
      y: 0.52,
    }),
    title({
      name: 'LMDh',
      text: 'LMDh',
      start: mark.hero + 0.3,
      duration: 3.4,
      effect: 'maskedHeading',
      size: 0.12,
      y: 0.4,
    }),
    title({
      name: 'Championship',
      text: 'FIA WORLD ENDURANCE CHAMPIONSHIP',
      start: mark.hero + 3.7,
      duration: 3.9,
      effect: 'fade',
      size: 0.036,
      y: 0.46,
    }),
    ...card('engine', 4, '3,999 cm³', 'Twin-turbo V8  ·  650 Nm'),
    ...card('weight', 4, '1,030 kg', 'About 1,200 mm high'),
    ...card('chassis', 4, 'DALLARA', 'Chassis partner'),
    ...card('tyres', 4, '18 × 12.5', 'Front  ·  Rear 18 × 14', 0.09),
    date('y2021', '10 JUN 2021', 'Green light for LMDh'),
    date('y2022', '25 JUL 2022', 'Roll-out at Varano  ·  Dallara'),
    date('y2023', '2023', 'Munich and Baudour'),
    title({
      name: '2024',
      text: '2024',
      start: mark.y2024 + 0.2,
      duration: 3.6,
      effect: 'maskedHeading',
      size: 0.14,
      y: 0.38,
    }),
    title({
      name: 'Le Mans',
      text: 'Le Mans, 25 years after the V12 LMR',
      start: mark.y2024 + 0.55,
      duration: 3.25,
      effect: 'fade',
      size: 0.036,
      y: 0.54,
    }),
  ];

  return {
    version: PROJECT_VERSION,
    name: STORYBOARD_NAME,
    fps: 30,
    activeSceneId: front.id,
    editorMode: 'master',
    scenes,
    master: { clips, texts },
    fonts: [],
  };
}

export function createStoryboardProject(viewer?: Viewer): Project {
  return buildProject(viewer);
}
