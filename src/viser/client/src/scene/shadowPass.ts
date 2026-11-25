import * as THREE from "three";

/** Collect the topmost visible shadow casters under an object. Exported for
 * tests. */
export function collectShadowCasters(
  object: THREE.Object3D,
  out: THREE.Object3D[],
): void {
  if (!object.visible) return;
  if (
    object.castShadow &&
    ((object as THREE.Mesh).isMesh ||
      (object as THREE.Line).isLine ||
      (object as THREE.Points).isPoints)
  ) {
    // Descendants are handled by the shadow pass.
    out.push(object);
    return;
  }
  const children = object.children;
  for (let i = 0; i < children.length; i++) {
    collectShadowCasters(children[i], out);
  }
}

/** Make the shadow pass cheaper for large scenes.
 *
 * three.js walks the entire scene graph once per shadow map (and six times for
 * point lights). The default lights have three of them, so in scenes with a lot
 * of objects these walks were more expensive than everything else combined,
 * even with nothing in the scene casting shadows. Instead, we walk the scene
 * once per frame to find shadow casters, and skip the pass when there are none.
 */
export function installFastShadowPass(gl: THREE.WebGLRenderer): void {
  const shadowMap = gl.shadowMap;
  const originalRender = shadowMap.render;
  // Lights whose shadow maps are known to be empty.
  let emptyLights: THREE.Light[] = [];
  const casters: THREE.Object3D[] = [];

  shadowMap.render = function (
    lights: THREE.Light[],
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    if (
      !shadowMap.enabled ||
      lights.length === 0 ||
      // This type also draws objects that only receive shadows.
      shadowMap.type === THREE.VSMShadowMap
    ) {
      emptyLights = [];
      return originalRender.call(shadowMap, lights, scene, camera);
    }

    casters.length = 0;
    collectShadowCasters(scene, casters);
    if (casters.length === 0) {
      // Still runs the pass once, which clears the shadow maps.
      if (
        emptyLights.length === lights.length &&
        lights.every(
          (light, i) =>
            emptyLights[i] === light &&
            (light as THREE.DirectionalLight).shadow?.map != null,
        )
      )
        return;
      emptyLights = [...lights];
    } else {
      emptyLights = [];
    }

    // The scene argument is only used for walking over objects.
    originalRender.call(
      shadowMap,
      lights,
      {
        visible: true,
        layers: scene.layers,
        children: casters,
        traverse: (callback: (object: THREE.Object3D) => void) =>
          scene.traverse(callback),
      } as unknown as THREE.Scene,
      camera,
    );
    casters.length = 0;
  };
}
