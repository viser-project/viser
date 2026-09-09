/** Prime `camera.reversedDepth` before three sorts its render lists.
 *
 * We render with `reversedDepthBuffer: true` for depth precision. Under a
 * reversed depth buffer the projected `z` that three's default render-list
 * comparators sort on has the opposite sign, and since r186
 * (https://github.com/mrdoob/three.js/pull/33945) `WebGLRenderList.push()`
 * compensates by negating `z` whenever `camera.reversedDepth` is true. That
 * keeps `groupOrder`, `renderOrder`, and custom comparators intact, which is
 * why the r185-only compensating comparators that used to live here are gone.
 *
 * What r186 still gets wrong is *when* the flag is set. `camera.reversedDepth`
 * is initialized lazily in `setProgram()`, which runs after `projectObject()`
 * and `sort()`. A camera therefore renders its first frame with the flag still
 * false: `z` is not negated, and within one `renderOrder` tier opaque draws
 * far-to-near (an overdraw cost) and transparent draws near-to-far (wrong
 * blending for overlapping transparents). The live viewport camera is
 * long-lived so it is only wrong for one frame, but `get_render()` builds a
 * fresh `PerspectiveCamera` per request (see MessageHandler.tsx), so every
 * capture would sort with the stale sign.
 *
 * So we prime each camera's flag before it reaches `sort()`, which is what
 * three does for its own shadow cameras (`WebGLShadowMap` sets
 * `shadow.camera._reversedDepth` directly, for the same reason).
 */
import * as THREE from "three";

/**
 * Mark a camera as rendering with a reversed depth buffer, before three's
 * render list is built and sorted.
 *
 * This is the same assignment three makes lazily in `setProgram()`, and the
 * same one `WebGLShadowMap` makes eagerly for shadow cameras. `_reversedDepth`
 * is private (`reversedDepth` is a getter with no setter), so this is a cast.
 */
export function primeCamera(camera: THREE.Camera): void {
  if (camera.reversedDepth === true) return;
  (camera as THREE.Camera & { _reversedDepth: boolean })._reversedDepth = true;
  // The projection matrix has to be rebuilt for the flag to take effect; three
  // does this in the same breath.
  if ("updateProjectionMatrix" in camera) {
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
  }
}

/**
 * Prime every camera passed to `gl.render()`, if this renderer actually has a
 * reversed depth buffer.
 *
 * `capabilities.reversedDepthBuffer` is true only if we asked for a reversed
 * depth buffer *and* `EXT_clip_control` is available. Without it three never
 * negates `z`, and priming would build a reversed projection matrix for a
 * conventional depth buffer, so the gate is load-bearing.
 */
export function applyReversedDepthCameraPriming(gl: THREE.WebGLRenderer): void {
  if (!gl.capabilities.reversedDepthBuffer) return;

  // Wrap `render` rather than priming individual cameras: the fresh camera
  // get_render builds is not the only one we would have to remember.
  const render = gl.render.bind(gl);
  gl.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
    primeCamera(camera);
    render(scene, camera);
  };
}
