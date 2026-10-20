import type { Viewer } from '../viewer/Viewer';
import { captureSettings, defaultSettings } from '../viewer/settings';
import { DEFAULT_DOT_GRID_PARAMS } from '../viewer/dottedWrtScreen';
import type { CustomLightParams } from '../viewer/customLights';
import { carSpecs } from '../data/carSpecs';
import { defaultBezier } from './bezier';
import {
  nextAuthoringId,
  resetAuthoringIdCounter,
  vec3,
  wrapSceneAsProject,
  type CameraClip,
  type CameraPoseValue,
  type EasingName,
  type Keyframe,
  type KeyframeValue,
  type Project,
  type Scene,
  type TextClip,
  type TimelineTrack,
} from './project';

/** Cinematic commercial from the M Hybrid V8 storyboard (+ light-sweep coda). */
export const STORYBOARD_DURATION = 25;
export const STORYBOARD_NAME = 'BMW M Hybrid V8 — 25s Storyboard v2';
/** Prior default name — Editor upgrades these saves to the current storyboard. */
export const STORYBOARD_LEGACY_NAMES = [
  'WRT Commercial',
  'BMW M Hybrid V8 — 20s Storyboard',
  'BMW M Hybrid V8 — 25s Storyboard',
] as const;

const SWEEP_DETAIL_ID = 'sweep-detail';
const SWEEP_LOGO_ID = 'sweep-logo';

type Pose = CameraPoseValue;

function pose(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov: number): Pose {
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

/**
 * Build the storyboard project: 8 storyboard cuts + 5s light-sweep coda
 * (detail macro → BMW logo macro) + end card.
 * Car is framed near origin, nose toward +Z (front-facing hero).
 */
export function createStoryboardProject(viewer?: Viewer): Project {
  resetAuthoringIdCounter(1);

  // --- Shot poses (start → end of each beat) ---
  const headlightClose = pose(0.62, 0.48, 2.15, 0.42, 0.44, 1.85, 26);
  const headlightPull = pose(0.95, 0.55, 2.85, 0.28, 0.42, 1.7, 32);

  const splitterA = pose(-0.55, 0.1, 2.95, 0.05, 0.06, 1.55, 36);
  const splitterB = pose(0.65, 0.14, 2.7, 0.12, 0.1, 1.45, 32);

  const heroA = pose(3.35, 0.95, 4.6, 0, 0.52, 0.15, 33);
  const heroB = pose(2.95, 0.85, 4.15, 0, 0.5, 0.15, 30);

  const badgeA = pose(2.55, 0.58, 0.45, 1.05, 0.52, 0.25, 24);
  const badgeB = pose(2.48, 0.56, 0.4, 1.05, 0.52, 0.25, 24);

  const rearLow = pose(-0.35, 0.22, -4.35, 0, 0.65, -1.55, 34);
  const rearHigh = pose(-0.15, 1.85, -5.15, 0, 0.95, -1.15, 30);

  const cockpitA = pose(1.95, 1.15, 0.55, 0.15, 0.88, 0.05, 42);
  const cockpitB = pose(1.55, 1.05, 0.35, 0.1, 0.85, 0, 38);

  const wheelA = pose(2.15, 0.38, 1.55, 1.05, 0.34, 1.35, 30);
  const wheelB = pose(1.9, 0.34, 1.42, 1.05, 0.34, 1.35, 27);

  const wideA = pose(4.4, 0.85, 5.4, 0, 0.45, 0.1, 36);
  const wideB = pose(5.6, 1.15, 7.0, 0, 0.5, 0, 38);

  // Light-sweep coda — locked macros, specular travels via spots
  const detailSweepA = pose(0.78, 0.4, 2.35, 0.48, 0.4, 1.92, 20);
  const detailSweepB = pose(0.72, 0.38, 2.28, 0.48, 0.4, 1.92, 19);

  // Front-nose BMW roundel — fill frame (logo sits at hood tip, not under #15)
  const logoSweepA = pose(0.22, 0.52, 2.68, 0, 0.34, 2.1, 12);
  const logoSweepB = pose(0.16, 0.48, 2.58, 0, 0.34, 2.1, 11);

  const cameras: CameraClip[] = [
    cam('1 Headlight Macro', headlightClose),
    cam('2 Splitter Low', splitterA),
    cam('3 Hero Reveal', heroA),
    cam('4 M Badge', badgeA),
    cam('5 Rear Crane', rearLow),
    cam('6 Cockpit', cockpitA),
    cam('7 Wheel Heat', wheelA),
    cam('8 Wide Hero', wideA),
    cam('9 Detail Sweep', detailSweepA),
    cam('10 BMW Logo Sweep', logoSweepA),
  ];

  const [
    cHead,
    cSplit,
    cHero,
    cBadge,
    cRear,
    cCockpit,
    cWheel,
    cWide,
    cDetail,
    cLogo,
  ] = cameras;

  const titleText: TextClip = {
    id: nextAuthoringId('text'),
    name: 'End Card Title',
    content: 'BMW M',
    position: vec3(0, 1.85, 3.2),
    rotation: vec3(0, 0, 0),
    scale: 1.35,
    opacity: 0,
    align: 'center',
    color: '#ffffff',
    billboard: true,
  };

  const subtitleText: TextClip = {
    id: nextAuthoringId('text'),
    name: 'End Card Subtitle',
    content: carSpecs.name.toUpperCase(),
    position: vec3(0, 1.45, 3.2),
    rotation: vec3(0, 0, 0),
    scale: 0.55,
    opacity: 0,
    align: 'center',
    color: '#c8d4e0',
    billboard: true,
  };

  const look = viewer ? captureSettings(viewer) : defaultSettings();
  // Dark open — timeline drives softboxes / car lights from black.
  look.softboxes = {
    ...look.softboxes,
    enabled: true,
    intensity: 0,
    keyIntensity: 2.4,
    fillIntensity: 1.1,
    rimIntensity: 1.8,
  };
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
  look.lighting = {
    ...look.lighting,
    exposure: 0.22,
    ambientIntensity: 0.03,
    directIntensity: 0.15,
    environmentIntensity: 0.35,
  };
  look.display = {
    ...look.display,
    bgColor: '#000000',
    background: true,
  };
  look.dotGrid = {
    ...DEFAULT_DOT_GRID_PARAMS,
    enabled: true,
    opacity: 1,
    reveal: 1,
    glow: 1.15,
    effectMode: 1,
    effectStrength: 1,
    reflectionEnabled: true,
  };
  // Narrow white spots for McLaren-style specular sweeps (intensity keyed on timeline).
  look.customLights = [
    sweepSpot(SWEEP_DETAIL_ID, 'Sweep Detail', -0.35, 0.95, 2.9, -28, 18, 0),
    sweepSpot(SWEEP_LOGO_ID, 'Sweep BMW Logo', -0.7, 0.75, 2.7, -22, 22, 0),
  ];

  const timelineTracks: TimelineTrack[] = [
    // Camera cuts
    track('camera.active', [
      kf(0, cHead.id, 'linear'),
      kf(3, cSplit.id, 'linear'),
      kf(5, cHero.id, 'linear'),
      kf(8, cBadge.id, 'linear'),
      kf(10, cRear.id, 'linear'),
      kf(13, cCockpit.id, 'linear'),
      kf(14.5, cWheel.id, 'linear'),
      kf(16, cWide.id, 'linear'),
      kf(20, cDetail.id, 'linear'),
      kf(22.5, cLogo.id, 'linear'),
    ]),

    // Per-shot moves
    track(`camera.${cHead.id}.pose`, [
      kf(0, headlightClose, 'easeInOut'),
      kf(3, headlightPull, 'easeInOut'),
    ]),
    track(`camera.${cSplit.id}.pose`, [
      kf(3, splitterA, 'easeInOut'),
      kf(5, splitterB, 'easeInOut'),
    ]),
    track(`camera.${cHero.id}.pose`, [
      kf(5, heroA, 'easeInOut'),
      kf(8, heroB, 'easeInOut'),
    ]),
    track(`camera.${cBadge.id}.pose`, [
      kf(8, badgeA, 'easeInOut'),
      kf(10, badgeB, 'easeInOut'),
    ]),
    track(`camera.${cRear.id}.pose`, [
      kf(10, rearLow, 'easeInOut'),
      kf(13, rearHigh, 'easeInOut'),
    ]),
    track(`camera.${cCockpit.id}.pose`, [
      kf(13, cockpitA, 'easeInOut'),
      kf(14.5, cockpitB, 'easeInOut'),
    ]),
    track(`camera.${cWheel.id}.pose`, [
      kf(14.5, wheelA, 'easeInOut'),
      kf(16, wheelB, 'easeInOut'),
    ]),
    track(`camera.${cWide.id}.pose`, [
      kf(16, wideA, 'easeInOut'),
      kf(19.2, wideB, 'easeInOut'),
      kf(20, wideB, 'easeInOut'),
    ]),
    track(`camera.${cDetail.id}.pose`, [
      kf(20, detailSweepA, 'easeInOut'),
      kf(22.5, detailSweepB, 'easeInOut'),
    ]),
    track(`camera.${cLogo.id}.pose`, [
      kf(22.5, logoSweepA, 'easeInOut'),
      kf(24.2, logoSweepB, 'easeInOut'),
      kf(25, logoSweepB, 'easeInOut'),
    ]),

    // Softbox garage reveal — crush to black for sweep coda
    track('softboxes.intensity', [
      kf(0, 0, 'linear'),
      kf(5, 0, 'linear'),
      kf(5.4, 0.25, 'easeInOut'),
      kf(6.2, 0.7, 'easeInOut'),
      kf(6.8, 1.05, 'easeInOut'),
      kf(13, 0.85, 'easeInOut'),
      kf(14.5, 0.55, 'easeInOut'),
      kf(16, 1.1, 'easeInOut'),
      kf(19.6, 1.0, 'easeInOut'),
      kf(20.05, 0.04, 'easeInOut'),
      kf(25, 0.02, 'easeInOut'),
    ]),

    // Frame 1 — LED flicker on
    track('carLights.enabled', [kf(0, true, 'linear')]),
    track('carLights.edgeEnabled', [kf(0, true, 'linear')]),
    track('carLights.grilleEnabled', [kf(0, true, 'linear')]),
    track('carLights.redEnabled', [kf(0, true, 'linear')]),
    track('carLights.groundGlow', [kf(0, true, 'linear')]),
    track('carLights.beamsEnabled', [kf(0, true, 'linear')]),

    track('carLights.edgeStrength', [
      kf(0, 0, 'linear'),
      kf(0.35, 0, 'linear'),
      kf(0.45, 0.55, 'linear'),
      kf(0.55, 0.08, 'linear'),
      kf(0.7, 1.6, 'linear'),
      kf(0.82, 0.45, 'linear'),
      kf(1.0, 1.35, 'easeInOut'),
      kf(3, 1.2, 'easeInOut'),
      kf(5, 1.0, 'easeInOut'),
      kf(8, 0.85, 'easeInOut'),
      kf(10, 0.5, 'easeInOut'),
      kf(13, 0.35, 'easeInOut'),
      kf(16, 0.9, 'easeInOut'),
      kf(17.4, 0.9, 'linear'),
      kf(17.55, 1.85, 'easeInOut'),
      kf(17.85, 1.0, 'easeInOut'),
      kf(18.25, 1.0, 'linear'),
      kf(18.4, 1.75, 'easeInOut'),
      kf(18.7, 1.15, 'easeInOut'),
      kf(19.8, 1.15, 'easeInOut'),
      kf(20.1, 0.08, 'easeInOut'),
      kf(25, 0.05, 'easeInOut'),
    ]),

    track('carLights.grilleStrength', [
      kf(0, 0, 'linear'),
      kf(0.6, 0, 'linear'),
      kf(0.85, 0.9, 'easeInOut'),
      kf(1.2, 2.2, 'easeInOut'),
      kf(3, 2.6, 'easeInOut'),
      kf(5, 2.0, 'easeInOut'),
      kf(8, 1.6, 'easeInOut'),
      kf(10, 0.8, 'easeInOut'),
      kf(13, 0.4, 'easeInOut'),
      kf(16, 1.8, 'easeInOut'),
      kf(17.4, 1.8, 'linear'),
      kf(17.55, 3.0, 'easeInOut'),
      kf(17.85, 2.0, 'easeInOut'),
      kf(18.25, 2.0, 'linear'),
      kf(18.4, 2.9, 'easeInOut'),
      kf(18.7, 2.2, 'easeInOut'),
      kf(19.8, 2.2, 'easeInOut'),
      kf(20.1, 0.12, 'easeInOut'),
      kf(25, 0.08, 'easeInOut'),
    ]),

    track('carLights.beamStrength', [
      kf(0, 0, 'linear'),
      kf(1.0, 0, 'linear'),
      kf(1.4, 0.55, 'easeInOut'),
      kf(3, 0.7, 'easeInOut'),
      kf(5, 0.45, 'easeInOut'),
      kf(10, 0.2, 'easeInOut'),
      kf(16, 0.5, 'easeInOut'),
      kf(17.5, 0.95, 'easeInOut'),
      kf(19.8, 0.75, 'easeInOut'),
      kf(20.1, 0, 'easeInOut'),
      kf(25, 0, 'easeInOut'),
    ]),

    track('carLights.groundGlowStrength', [
      kf(0, 0, 'linear'),
      kf(2.8, 0, 'linear'),
      kf(3.2, 1.4, 'easeInOut'),
      kf(5, 1.8, 'easeInOut'),
      kf(8, 1.2, 'easeInOut'),
      kf(10, 0.9, 'easeInOut'),
      kf(13, 0.5, 'easeInOut'),
      kf(16, 1.5, 'easeInOut'),
      kf(19.8, 1.35, 'easeInOut'),
      kf(20.1, 0.05, 'easeInOut'),
      kf(25, 0.02, 'easeInOut'),
    ]),

    track('carLights.redStrength', [
      kf(0, 0, 'linear'),
      kf(9.8, 0, 'linear'),
      kf(10.25, 1.6, 'easeInOut'),
      kf(12.5, 1.9, 'easeInOut'),
      kf(13, 1.2, 'easeInOut'),
      kf(14.5, 0.85, 'easeInOut'),
      kf(14.6, 0.85, 'linear'),
      kf(15.0, 2.4, 'easeInOut'),
      kf(15.8, 1.6, 'easeInOut'),
      kf(16, 1.1, 'easeInOut'),
      kf(19.8, 1.0, 'easeInOut'),
      kf(20.1, 0.05, 'easeInOut'),
      kf(25, 0.02, 'easeInOut'),
    ]),

    // 20–22.5s — detail specular sweep
    track(`light.${SWEEP_DETAIL_ID}.intensity`, [
      kf(0, 0, 'linear'),
      kf(19.95, 0, 'linear'),
      kf(20.15, 7.5, 'easeInOut'),
      kf(22.2, 6.8, 'easeInOut'),
      kf(22.5, 0, 'linear'),
      kf(25, 0, 'linear'),
    ]),
    track(`light.${SWEEP_DETAIL_ID}.position`, [
      kf(0, vec3(-0.35, 0.95, 2.9), 'linear'),
      kf(20, vec3(-0.35, 0.95, 2.9), 'linear'),
      kf(21.25, vec3(0.55, 0.55, 2.55), 'easeInOut'),
      kf(22.5, vec3(1.25, 0.28, 2.15), 'easeInOut'),
    ]),
    track(`light.${SWEEP_DETAIL_ID}.rotation`, [
      kf(0, vec3(-28, 18, 0), 'linear'),
      kf(20, vec3(-28, 18, 0), 'linear'),
      kf(21.25, vec3(-18, -5, 0), 'easeInOut'),
      kf(22.5, vec3(-8, -28, 0), 'easeInOut'),
    ]),

    // 22.5–24.2s — BMW logo specular sweep
    track(`light.${SWEEP_LOGO_ID}.intensity`, [
      kf(0, 0, 'linear'),
      kf(22.45, 0, 'linear'),
      kf(22.65, 8.2, 'easeInOut'),
      kf(24.0, 7.4, 'easeInOut'),
      kf(24.35, 1.2, 'easeInOut'),
      kf(25, 0.4, 'easeInOut'),
    ]),
    track(`light.${SWEEP_LOGO_ID}.position`, [
      kf(0, vec3(-0.7, 0.75, 2.7), 'linear'),
      kf(22.5, vec3(-0.7, 0.75, 2.7), 'linear'),
      kf(23.35, vec3(0.0, 0.55, 2.45), 'easeInOut'),
      kf(24.5, vec3(0.75, 0.38, 2.25), 'easeInOut'),
      kf(25, vec3(0.85, 0.36, 2.2), 'easeInOut'),
    ]),
    track(`light.${SWEEP_LOGO_ID}.rotation`, [
      kf(0, vec3(-22, 22, 0), 'linear'),
      kf(22.5, vec3(-22, 22, 0), 'linear'),
      kf(23.35, vec3(-14, 0, 0), 'easeInOut'),
      kf(24.5, vec3(-8, -24, 0), 'easeInOut'),
      kf(25, vec3(-6, -26, 0), 'easeInOut'),
    ]),

    // End card after logo sweep
    track(`text.${titleText.id}.opacity`, [
      kf(0, 0, 'linear'),
      kf(24.15, 0, 'linear'),
      kf(24.55, 1, 'easeInOut'),
      kf(25, 1, 'easeInOut'),
    ]),
    track(`text.${titleText.id}.scale`, [
      kf(0, 1.2, 'linear'),
      kf(24.15, 1.2, 'linear'),
      kf(24.7, 1.35, 'easeInOut'),
      kf(25, 1.35, 'easeInOut'),
    ]),
    track(`text.${subtitleText.id}.opacity`, [
      kf(0, 0, 'linear'),
      kf(24.35, 0, 'linear'),
      kf(24.75, 0.92, 'easeInOut'),
      kf(25, 0.92, 'easeInOut'),
    ]),
  ];

  const scene: Scene = {
    id: nextAuthoringId('scene'),
    name: 'Storyboard',
    duration: STORYBOARD_DURATION,
    playCameraId: cHead.id,
    carVisible: true,
    look,
    cameras,
    planes: [],
    texts: [titleText, subtitleText],
    timeline: { tracks: timelineTracks },
  };

  return wrapSceneAsProject(scene, STORYBOARD_NAME, 30);
}
