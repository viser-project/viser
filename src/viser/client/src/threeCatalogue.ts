/** Three.js classes viser renders as R3F JSX intrinsics.
 *
 * Production builds patch out R3F's automatic `extend(THREE)` (see the
 * fiber-no-auto-extend plugin in vite.config.mts) so that three can be
 * tree-shaken; every lowercase JSX intrinsic must therefore be listed here.
 * r3f-extend.ts feeds these to `extend()`; threeCatalogue.test.ts scans the
 * JSX in src/ and fails if an intrinsic is missing from this module.
 *
 * Kept free of R3F imports so the test can load it in Node.
 */
import * as THREE from "three";

/** Rendered by viser's own components (<mesh />, <group />, ...). */
export const viserThreeCatalogue = {
  AmbientLight: THREE.AmbientLight,
  BoxGeometry: THREE.BoxGeometry,
  BufferGeometry: THREE.BufferGeometry,
  CylinderGeometry: THREE.CylinderGeometry,
  DirectionalLight: THREE.DirectionalLight,
  Fog: THREE.Fog,
  Group: THREE.Group,
  HemisphereLight: THREE.HemisphereLight,
  InstancedMesh: THREE.InstancedMesh,
  Mesh: THREE.Mesh,
  MeshBasicMaterial: THREE.MeshBasicMaterial,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  MeshToonMaterial: THREE.MeshToonMaterial,
  Object3D: THREE.Object3D,
  PlaneGeometry: THREE.PlaneGeometry,
  PointLight: THREE.PointLight,
  Points: THREE.Points,
  RectAreaLight: THREE.RectAreaLight,
  ShadowMaterial: THREE.ShadowMaterial,
  SkinnedMesh: THREE.SkinnedMesh,
  SphereGeometry: THREE.SphereGeometry,
  SpotLight: THREE.SpotLight,
};

/** Rendered by the drei components viser uses, found by scanning their dist
 * code for JSX string literals: PivotControls (coneGeometry,
 * cylinderGeometry, sphereGeometry, planeGeometry, mesh, group), Html
 * (shaderMaterial, planeGeometry, mesh, group), and Instances
 * (instancedBufferAttribute, instancedMesh, group; drei extends its own
 * PositionMesh). */
export const dreiThreeCatalogue = {
  ConeGeometry: THREE.ConeGeometry,
  InstancedBufferAttribute: THREE.InstancedBufferAttribute,
  ShaderMaterial: THREE.ShaderMaterial,
};
