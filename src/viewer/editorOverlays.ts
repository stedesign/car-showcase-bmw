import * as THREE from 'three';

/**
 * Authoring gizmos (cameras, transform arrows, light helpers) live on this
 * layer so they can be drawn in a second pass after tone mapping / bloom.
 * Otherwise ACES + low exposure crushes MeshBasicMaterial overlays even when
 * `toneMapped: false` — OutputPass re-maps the whole framebuffer.
 *
 * Must stay off layer 0 (default scene) and layer 1 (`GROUND_LIGHT_LAYER` in
 * carLights — floor pool lights + ground overlay).
 */
export const EDITOR_OVERLAY_LAYER = 2;

/** Tag an object tree as an editor overlay (layer + unlit/fog-immune materials). */
export function markEditorOverlay(root: THREE.Object3D) {
  root.traverse((obj) => {
    obj.layers.set(EDITOR_OVERLAY_LAYER);
    const mesh = obj as THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite;
    if (!('material' in mesh) || mesh.material == null) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const m = mat as THREE.Material & { fog?: boolean; toneMapped?: boolean };
      m.fog = false;
      if ('toneMapped' in m) m.toneMapped = false;
    }
  });
}

/**
 * TransformControls raycasts with its own Layers mask (default: only layer 0).
 * Overlay gizmos live on EDITOR_OVERLAY_LAYER, so picking must include that layer
 * or Move/Rotate arrows never receive pointer hits.
 */
export function enableEditorOverlayPicking(controls: {
  getRaycaster: () => THREE.Raycaster;
}) {
  controls.getRaycaster().layers.enable(EDITOR_OVERLAY_LAYER);
}

/**
 * Draw overlay-layer objects on top of an already-tonemapped frame.
 * Call after EffectComposer / main render; leaves depth cleared so gizmos
 * win over the car without fighting scene lighting.
 */
export function renderEditorOverlays(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const prevTone = renderer.toneMapping;
  const prevExposure = renderer.toneMappingExposure;
  const prevAutoClear = renderer.autoClear;
  const prevMask = camera.layers.mask;
  // Color / env backgrounds force a full clear inside WebGLBackground even when
  // autoClear is false — that would wipe the car / WRT pass we just drew.
  const prevBackground = scene.background;
  const prevFog = scene.fog;

  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.autoClear = false;
  scene.background = null;
  scene.fog = null;
  camera.layers.set(EDITOR_OVERLAY_LAYER);

  renderer.clearDepth();
  renderer.render(scene, camera);

  scene.background = prevBackground;
  scene.fog = prevFog;
  camera.layers.mask = prevMask;
  renderer.toneMapping = prevTone;
  renderer.toneMappingExposure = prevExposure;
  renderer.autoClear = prevAutoClear;
}
