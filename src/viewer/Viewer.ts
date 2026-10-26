import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createGround, type GroundHandle } from './ground';
import { createWrtLogo, type WrtLogoHandle } from './wrtLogo';
import {
  createDottedWrtScreen,
  type DottedWrtScreenHandle,
} from './dottedWrtScreen';
import { createEffects, type EffectsHandle } from './effects';
import { createCustomLights, type CustomLightsHandle } from './customLights';
import { createCarLights, type CarLightsHandle } from './carLights';
import {
  createAmbientShadows,
  type AmbientShadowsHandle,
} from './ambientShadows';
import { createCarMaterials, type CarMaterialsHandle } from './carMaterials';
import { createSoftboxes, type SoftboxesHandle } from './softboxes';
import { createRoofStrobe, type RoofStrobeHandle } from './roofStrobe';
import { createAirflow, type AirflowHandle } from './airflow';
import {
  EDITOR_OVERLAY_LAYER,
  renderEditorOverlays,
} from './editorOverlays';

export type ViewerDisplay = {
  background: boolean;
  autoRotate: boolean;
  wireframe: boolean;
  grid: boolean;
  bgColor: string;
};

/** Curated Poly Haven 1k HDRIs + procedural studio. */
export const ENVIRONMENT_PRESETS = [
  'None',
  'Studio',
  'Footprint Court',
  'Studio Small',
  'Empty Warehouse',
] as const;

export type EnvironmentPreset = (typeof ENVIRONMENT_PRESETS)[number];

export type ViewerLighting = {
  environment: EnvironmentPreset;
  /** Global IBL strength (scene.environmentIntensity). */
  environmentIntensity: number;
  /** Per-material envMapIntensity on the car. */
  envMapIntensity: number;
  /** Use the active HDR / studio map as scene.background. */
  envAsBackground: boolean;
  /** Softens HDR background (0–1). Only applies when envAsBackground. */
  backgroundBlurriness: number;
  /** Attenuates HDR background brightness. */
  backgroundIntensity: number;
  toneMapping: 'None' | 'Linear' | 'Reinhard' | 'Cineon' | 'ACES Filmic';
  exposure: number;
  punctualLights: boolean;
  ambientIntensity: number;
  ambientColor: string;
  directIntensity: number;
  directColor: string;
};

export type ViewerState = {
  display: ViewerDisplay;
  lighting: ViewerLighting;
  floorReflectivity: number;
  /** 0 = uniform wet film, 1 = strong puddle contrast on the concrete. */
  floorPuddles: number;
};

export const DEFAULT_VIEWER_STATE: ViewerState = {
  display: {
    background: true,
    autoRotate: false,
    wireframe: false,
    grid: false,
    bgColor: '#000000',
  },
  lighting: {
    // Softbox HDRI for paint reflections; keep void background
    environment: 'Studio Small',
    environmentIntensity: 0.55,
    envMapIntensity: 0.32,
    envAsBackground: false,
    backgroundBlurriness: 0.45,
    backgroundIntensity: 0.35,
    toneMapping: 'ACES Filmic',
    exposure: 0.26,
    punctualLights: true,
    ambientIntensity: 0.05,
    ambientColor: '#6a8098',
    directIntensity: 0.4,
    directColor: '#9eb6d4',
  },
  floorReflectivity: 0.82,
  floorPuddles: 0.55,
};

const DEFAULT_MODEL = '/models/bmw-m-hybrid-v8-15-wrt.glb';

const HDR_URLS: Partial<Record<EnvironmentPreset, string>> = {
  'Footprint Court':
    'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/footprint_court_1k.hdr',
  'Studio Small':
    'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_03_1k.hdr',
  'Empty Warehouse':
    'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/empty_warehouse_01_1k.hdr',
};

const TONE_MAP: Record<ViewerLighting['toneMapping'], THREE.ToneMapping> = {
  None: THREE.NoToneMapping,
  Linear: THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping,
  'ACES Filmic': THREE.ACESFilmicToneMapping,
};

type HdrCacheEntry = {
  equirect: THREE.Texture;
  pmrem: THREE.Texture;
};

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly state: ViewerState;

  ground!: GroundHandle;
  logo!: WrtLogoHandle;
  dotGrid!: DottedWrtScreenHandle;
  effects!: EffectsHandle;
  customLights!: CustomLightsHandle;
  carLights!: CarLightsHandle;
  ambientShadows!: AmbientShadowsHandle;
  carMaterials!: CarMaterialsHandle;
  softboxes!: SoftboxesHandle;
  roofStrobe!: RoofStrobeHandle;
  airflow!: AirflowHandle;

  private container: HTMLElement;
  private modelRoot = new THREE.Group();
  private ambientLight: THREE.AmbientLight;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;
  private gridHelper: THREE.GridHelper;
  private pmrem: THREE.PMREMGenerator;
  private studioEnv: THREE.Texture | null = null;
  private hdrCache = new Map<EnvironmentPreset, HdrCacheEntry>();
  private activeHdr: HdrCacheEntry | null = null;
  private clock = new THREE.Clock();
  private contentCenter = new THREE.Vector3();
  private contentRadius = 3;
  private onStatus?: (msg: string) => void;
  private disposed = false;
  private externalTick: ((dt: number, elapsed: number) => void) | null = null;
  private postRender: (() => void) | null = null;
  private screenOverlay: ((renderer: THREE.WebGLRenderer) => void) | null = null;
  private extraShadowExcludes: THREE.Object3D[] = [];

  constructor(container: HTMLElement, onStatus?: (msg: string) => void) {
    this.container = container;
    this.onStatus = onStatus;

    this.state = structuredClone(DEFAULT_VIEWER_STATE);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.state.lighting.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.state.display.bgColor);

    this.camera = new THREE.PerspectiveCamera(
      32,
      container.clientWidth / container.clientHeight,
      0.05,
      200,
    );
    // Low frontal hero angle (refined after model load in frameObject)
    this.camera.position.set(0.15, 0.55, 6.8);
    // Gizmos draw in a post-tone-map overlay pass (see renderEditorOverlays).
    this.camera.layers.disable(EDITOR_OVERLAY_LAYER);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 0.45, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 28;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.6;

    this.ambientLight = new THREE.AmbientLight(0x6a8098, 0.06);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0x9eb6d4, 0.55);
    this.keyLight.position.set(2.5, 7, 5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.00015;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    // Tight ortho frustum around the car so the shadow map has detail
    const shadowCam = this.keyLight.shadow.camera;
    shadowCam.near = 0.5;
    shadowCam.far = 40;
    shadowCam.left = -8;
    shadowCam.right = 8;
    shadowCam.top = 8;
    shadowCam.bottom = -8;
    this.keyLight.target.position.set(0, 0.4, 0);
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0x7a90a8, 0.12);
    this.fillLight.position.set(-4, 3, -2);
    this.scene.add(this.fillLight);

    // Soft rim separates roof scoop / wing from crushed blacks
    this.rimLight = new THREE.DirectionalLight(0xc8d8f0, 0.45);
    this.rimLight.position.set(-1.2, 5.5, -6);
    this.rimLight.target.position.set(0, 0.7, 0);
    this.scene.add(this.rimLight);
    this.scene.add(this.rimLight.target);

    this.gridHelper = new THREE.GridHelper(30, 30, 0x333333, 0x1a1a1a);
    this.gridHelper.visible = false;
    this.scene.add(this.gridHelper);

    this.modelRoot.name = 'ModelRoot';
    this.scene.add(this.modelRoot);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.effects = createEffects(this.renderer, this.scene, this.camera);
    this.customLights = createCustomLights(
      this.scene,
      this.camera,
      this.renderer.domElement,
      this.controls,
    );
    this.carLights = createCarLights();
    this.carMaterials = createCarMaterials();
    this.softboxes = createSoftboxes();
    this.scene.add(this.softboxes.group);
    this.roofStrobe = createRoofStrobe();
    this.scene.add(this.roofStrobe.group);
    this.airflow = createAirflow();
    this.scene.add(this.airflow.group);

    window.addEventListener('resize', this.onResize);
  }

  async init() {
    this.setStatus('Loading concrete floor…');
    this.ground = await createGround(40, 40);
    this.scene.add(this.ground.group);
    this.ground.setReflectivity(this.state.floorReflectivity);
    this.ground.setPuddleStrength(this.state.floorPuddles);

    this.ambientShadows = createAmbientShadows(14);
    this.scene.add(this.ambientShadows.group);

    this.setStatus('Building studio environment…');
    const room = new RoomEnvironment();
    this.studioEnv = this.pmrem.fromScene(room, 0.04).texture;
    room.dispose();

    this.logo = await createWrtLogo('/brand/wrt-logo.png');
    this.scene.add(this.logo.group);
    this.logo.bindReflector(this.ground.reflector);

    this.dotGrid = await createDottedWrtScreen('/brand/wrt-logo.png');
    this.scene.add(this.dotGrid.group);

    await this.applyEnvironment();
    this.applyLighting();
    this.applyDisplay();

    this.setStatus('Loading BMW M Hybrid V8…');
    await this.loadModel(DEFAULT_MODEL);
    this.setStatus('Ready — orbit to frame, dial FX, then Record');
  }

  get canvas() {
    return this.renderer.domElement;
  }

  /** Show / hide the loaded car (and its attached light FX under modelRoot). */
  get carVisible() {
    return this.modelRoot.visible;
  }

  set carVisible(visible: boolean) {
    this.modelRoot.visible = visible;
    this.airflow?.setCarVisible(visible);
  }

  setCarVisible(visible: boolean) {
    this.carVisible = visible;
    this.carLights?.setCarVisible(visible);
    // Floor is independent of the car — force a readable concrete slab when
    // the vehicle (and its lights) are off so the viewport isn't a black void.
    this.ground?.setEmptyGarage(!visible);
    // Kill vignette / smoke / fog that crush the slab when looking at the WRT wall.
    this.effects?.setEmptyGarageFx(!visible);
  }

  setGuiVisible(visible: boolean) {
    // GUI lives outside; used to hide ground grid during record if needed
    void visible;
  }

  /** Hook for authoring timeline / editor updates each frame. */
  setExternalTick(fn: ((dt: number, elapsed: number) => void) | null) {
    this.externalTick = fn;
  }

  /** Called after the main frame is drawn (e.g. camera preview). */
  setPostRender(fn: (() => void) | null) {
    this.postRender = fn;
  }

  /**
   * Draw into the WebGL canvas after the beauty pass and editor gizmos,
   * before captureStream samples the frame.
   */
  setScreenOverlay(fn: ((renderer: THREE.WebGLRenderer) => void) | null) {
    this.screenOverlay = fn;
  }

  /** Objects excluded from ambient contact-shadow capture (planes, gizmos). */
  setShadowExcludes(objects: THREE.Object3D[]) {
    this.extraShadowExcludes = objects.filter(Boolean);
  }

  notifyResize() {
    this.onResize();
  }

  private setStatus(msg: string) {
    this.onStatus?.(msg);
  }

  async loadModel(source: string | File | ArrayBuffer, nameHint?: string) {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    loader.setDRACOLoader(draco);

    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/');
    ktx2.detectSupport(this.renderer);
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);

    let gltf;
    try {
      if (typeof source === 'string') {
        gltf = await loader.loadAsync(source);
      } else if (source instanceof File) {
        const buffer = await source.arrayBuffer();
        gltf = await loader.parseAsync(buffer, '');
        nameHint = source.name;
      } else {
        gltf = await loader.parseAsync(source, '');
      }
    } finally {
      draco.dispose();
      ktx2.dispose();
    }

    this.carLights.unbind();

    while (this.modelRoot.children.length) {
      const child = this.modelRoot.children[0];
      this.modelRoot.remove(child);
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
    }

    const root = gltf.scene;
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (
            mat instanceof THREE.MeshStandardMaterial ||
            mat instanceof THREE.MeshPhysicalMaterial
          ) {
            if (this.state.display.wireframe) mat.wireframe = true;
          }
        }
      }
    });

    this.modelRoot.add(root);
    // Clearcoat + selective env before lights bind (materials may be replaced).
    this.carMaterials.enhance(root);
    // Frame onto the floor first so ground-glow anchors sit correctly.
    this.frameObject(this.modelRoot);
    this.carLights.bind(root, this.scene);
    this.setStatus(`Loaded ${nameHint ?? 'model'}`);
  }

  private frameObject(object: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.contentCenter.copy(center);
    this.contentRadius = Math.max(size.x, size.y, size.z) * 0.5 || 2;

    // Sit on the floor
    const minY = box.min.y;
    object.position.y -= minY;
    box.setFromObject(object);
    box.getCenter(center);
    this.contentCenter.copy(center);

    // Low, near-frontal hero shot (cinematic wet-studio framing)
    const lookAt = center.clone();
    lookAt.y = Math.max(0.35, size.y * 0.28);
    this.controls.target.copy(lookAt);
    const dist = this.contentRadius * 3.15;
    this.camera.position.set(
      lookAt.x + dist * 0.04,
      Math.max(0.28, lookAt.y * 0.55),
      lookAt.z + dist,
    );
    this.controls.update();

    // Keep tuned DEFAULT_LOGO_PARAMS (scale/distance/height); do not auto-size from car bounds.
    if (this.logo) {
      this.logo.applyParams();
    }

    if (this.ambientShadows) {
      const span = Math.max(size.x, size.z) * 2.4;
      this.ambientShadows.setSize(
        THREE.MathUtils.clamp(span, 10, 22),
        THREE.MathUtils.clamp(span, 10, 22),
      );
      this.ambientShadows.setCenter(center.x, center.z);
    }

    this.softboxes?.setTarget(center, this.contentRadius);
    this.roofStrobe?.setFromCarBounds(box);
    this.airflow?.setFromCarBounds(box);
    this.airflow?.update(0, this.camera);
  }

  applyDisplay() {
    const { display } = this.state;
    this.syncBackground();
    this.controls.autoRotate = display.autoRotate;
    this.gridHelper.visible = display.grid;
    this.modelRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if ('wireframe' in mat) {
            (mat as THREE.MeshStandardMaterial).wireframe = display.wireframe;
          }
        }
      }
    });
  }

  applyLighting() {
    const { lighting } = this.state;
    this.renderer.toneMapping = TONE_MAP[lighting.toneMapping];
    this.renderer.toneMappingExposure = lighting.exposure;

    this.ambientLight.color.set(lighting.ambientColor);
    this.ambientLight.intensity = lighting.ambientIntensity;

    this.keyLight.color.set(lighting.directColor);
    this.keyLight.intensity = lighting.punctualLights ? lighting.directIntensity : 0;
    this.fillLight.intensity = lighting.punctualLights
      ? lighting.directIntensity * 0.22
      : 0;
    this.rimLight.intensity = lighting.punctualLights
      ? Math.max(0.15, lighting.directIntensity * 0.45)
      : 0;

    this.applyEnvironmentTuning();

    // Softboxes + custom accents stay independent of the key/fill/rim trio
    this.softboxes?.applyParams();
    this.customLights?.applyAll();
  }

  /** IBL intensity + optional HDR background blur / brightness. */
  applyEnvironmentTuning() {
    const { lighting } = this.state;
    this.scene.environmentIntensity = lighting.environmentIntensity;
    this.syncBackground();
    this.applyEnvMapIntensity();
  }

  applyEnvMapIntensity() {
    // Lighting GUI "matEnvMap" drives the non-paint fallback; paint/carbon/tire
    // keep their selective values from carMaterials.
    this.carMaterials.setOtherEnv(this.state.lighting.envMapIntensity);
  }

  private syncBackground() {
    const { display, lighting } = this.state;
    const useEnvBg =
      lighting.envAsBackground &&
      lighting.environment !== 'None' &&
      this.scene.environment != null;

    if (useEnvBg) {
      // Prefer sharp equirect for blur control; fall back to PMREM / studio.
      this.scene.background =
        this.activeHdr?.equirect ?? this.scene.environment;
      this.scene.backgroundBlurriness = lighting.backgroundBlurriness;
      this.scene.backgroundIntensity = lighting.backgroundIntensity;
      return;
    }

    this.scene.background = display.background
      ? new THREE.Color(display.bgColor)
      : null;
    this.scene.backgroundBlurriness = 0;
    this.scene.backgroundIntensity = 1;
  }

  async applyEnvironment() {
    const mode = this.state.lighting.environment;
    this.activeHdr = null;

    if (mode === 'None') {
      this.scene.environment = null;
      this.applyEnvironmentTuning();
      return;
    }

    if (mode === 'Studio') {
      this.scene.environment = this.studioEnv;
      this.applyEnvironmentTuning();
      return;
    }

    const url = HDR_URLS[mode];
    if (!url) {
      this.scene.environment = this.studioEnv;
      this.applyEnvironmentTuning();
      return;
    }

    let entry = this.hdrCache.get(mode);
    if (!entry) {
      try {
        this.setStatus(`Loading ${mode} HDR…`);
        const equirect = await new RGBELoader().loadAsync(url);
        equirect.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = this.pmrem.fromEquirectangular(equirect).texture;
        entry = { equirect, pmrem };
        this.hdrCache.set(mode, entry);
        this.setStatus('Ready');
      } catch (err) {
        console.warn(`HDR load failed (${mode}), falling back to Studio`, err);
        this.state.lighting.environment = 'Studio';
        this.scene.environment = this.studioEnv;
        this.applyEnvironmentTuning();
        this.setStatus('HDR unavailable — using Studio');
        return;
      }
    }

    this.activeHdr = entry;
    this.scene.environment = entry.pmrem;
    this.applyEnvironmentTuning();
  }

  setFloorReflectivity(value: number) {
    this.state.floorReflectivity = value;
    this.ground.setReflectivity(value);
  }

  setFloorPuddles(value: number) {
    this.state.floorPuddles = value;
    this.ground.setPuddleStrength(value);
  }

  setGridVisible(visible: boolean) {
    this.state.display.grid = visible;
    this.gridHelper.visible = visible;
  }

  /** Point the free camera at the dotted WRT wall screen. */
  frameDotGridScreen() {
    if (!this.dotGrid) return;
    // Ensure latest placement/visibility before framing.
    this.dotGrid.params.enabled = true;
    this.dotGrid.applyParams();
    const center = this.dotGrid.getWorldCenter();
    const p = this.dotGrid.params;
    const halfH = (p.heightWorld * Math.max(0.05, p.scale)) * 0.5;
    const dist = Math.max(
      5,
      halfH / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.38)),
    );
    this.controls.target.copy(center);
    // Stand in front of the wall (positive Z), looking toward -Z.
    this.camera.position.set(center.x, center.y, center.z + dist);
    this.camera.up.set(0, 1, 0);
    this.camera.near = 0.05;
    this.camera.far = 200;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(center);
    this.controls.update();
  }

  private onResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.effects.resize(w, h);
  };

  startLoop() {
    const tick = () => {
      if (this.disposed) return;
      requestAnimationFrame(tick);
      const dt = this.clock.getDelta();
      const elapsed = this.clock.elapsedTime;
      this.externalTick?.(dt, elapsed);
      this.controls.update();
      this.customLights?.update();
      this.logo?.update(elapsed);
      this.dotGrid?.update(dt, elapsed);
      this.roofStrobe?.update(dt);
      this.airflow?.update(dt, this.camera);
      this.effects.update(dt, elapsed);
      if (this.carVisible) {
        this.ambientShadows?.update(this.renderer, this.scene, [
          // Ground stays visible — hiding it during capture could stick it off.
          this.logo?.group,
          this.dotGrid?.group,
          this.effects?.smoke,
          this.effects?.fogPlanes,
          this.effects?.flashLight,
          this.softboxes?.group,
          this.roofStrobe?.group,
          this.airflow?.group,
          this.gridHelper,
          ...this.extraShadowExcludes,
        ].filter(Boolean) as THREE.Object3D[]);
      } else if (this.ground) {
        // Contact-shadow pass temporarily hides the ground — if the car was
        // toggled off mid-pass (or a restore was skipped), force the slab back.
        this.ambientShadows && (this.ambientShadows.group.visible = false);
        this.ground.group.visible = true;
        this.ground.setEmptyGarage(true);
        this.effects?.setEmptyGarageFx(true);
      }
      this.effects.render();
      // Camera / transform / light helpers — after ACES so dark looks stay readable.
      renderEditorOverlays(this.renderer, this.scene, this.camera);
      this.screenOverlay?.(this.renderer);
      this.postRender?.();
    };
    tick();
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.ambientShadows?.dispose();
    this.customLights?.dispose();
    this.carLights?.dispose();
    this.softboxes?.dispose();
    this.roofStrobe?.dispose();
    this.airflow?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    for (const entry of this.hdrCache.values()) {
      entry.equirect.dispose();
      entry.pmrem.dispose();
    }
    this.hdrCache.clear();
    this.studioEnv?.dispose();
    this.pmrem.dispose();
  }
}
