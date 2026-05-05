import * as THREE from "three";
// @ts-ignore - troika-three-text doesn't have type definitions
import { BatchedText } from "troika-three-text";

// Import font as asset for proper bundling.
import interFont from "./assets/Inter-VariableFont_slnt,wght.ttf";

/**
 * Shared configuration for label text styling.
 */
export const LABEL_FONT = interFont;
export const LABEL_TEXT_COLOR = 0x000000; // Black
export const LABEL_SDF_GLYPH_SIZE = 32;

/**
 * Shared configuration for label backgrounds.
 */
export const LABEL_BACKGROUND_COLOR = 0xffffff; // White
export const LABEL_BACKGROUND_OPACITY = 0.85;
export const LABEL_BACKGROUND_PADDING_X = 0.2;
export const LABEL_BACKGROUND_PADDING_Y = 0.2;

/**
 * Set material properties on a BatchedText instance.
 * This must be called in useFrame after the material is created.
 */
export function setupBatchedTextMaterial(
  batchedText: BatchedText,
  depthTest: boolean,
): boolean {
  const material = batchedText.material;
  if (!material) return false;

  // Material can be an array [outlineMaterial, mainMaterial] or a single material.
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((mat) => {
    // Set depth test based on setting.
    mat.depthTest = depthTest;
    // Always disable depthWrite to avoid z-fighting between outline and fill.
    mat.depthWrite = false;
    // Mark as transparent for proper alpha blending and depth sorting.
    mat.transparent = true;
    mat.needsUpdate = true;
  });

  batchedText.renderOrder = 10_000;
  return true;
}

/**
 * Calculate billboard rotation for a group, accounting for parent transforms.
 * Returns the quaternion that should be applied to text objects for billboarding.
 */
export function calculateBillboardRotation(
  group: THREE.Group,
  camera: THREE.Camera,
  groupQuaternionOut: THREE.Quaternion,
  billboardQuaternionOut: THREE.Quaternion,
): THREE.Quaternion {
  group.updateMatrix();
  group.updateWorldMatrix(false, false);
  group.getWorldQuaternion(groupQuaternionOut);

  camera
    .getWorldQuaternion(billboardQuaternionOut)
    .premultiply(groupQuaternionOut.invert());

  return billboardQuaternionOut;
}

/**
 * Calculate base font size from sizing mode and parameters.
 */
export function calculateBaseFontSize(
  mode: "screen" | "scene",
  screenScale: number,
  sceneHeight: number,
): number {
  return mode === "screen" ? 0.3 * screenScale : sceneHeight;
}

/**
 * Reference viewport height for screen-space label sizing.
 * Labels maintain consistent pixel size by scaling relative to this reference.
 */
const REFERENCE_VIEWPORT_HEIGHT = 800;

/**
 * Calculate screen-space scale factor for labels.
 * Returns scale factor to apply to base font size.
 * Accounts for camera distance, FOV, and viewport size to maintain constant pixel size.
 */
export function calculateScreenSpaceScale(
  camera: THREE.Camera,
  worldPosition: THREE.Vector3,
  tempCameraSpacePos: THREE.Vector3,
  viewportHeight: number,
): number {
  if ("fov" in camera && typeof camera.fov === "number") {
    // PerspectiveCamera: use Z-coordinate in camera space (not Euclidean distance).
    // Transform world position to camera space (reuse temp vector to avoid allocation).
    tempCameraSpacePos.copy(worldPosition);
    tempCameraSpacePos.applyMatrix4(camera.matrixWorldInverse);
    const depth = -tempCameraSpacePos.z; // Negative because camera looks down -Z axis.

    const fovScale = Math.tan(
      ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360,
    );
    // Reference depth is 10 units (baseFontSize is calibrated for this).
    // Scale by reference/actual viewport height to maintain constant pixel size.
    return (
      (depth / 10.0) * fovScale * (REFERENCE_VIEWPORT_HEIGHT / viewportHeight)
    );
  } else {
    // OrthographicCamera: scale based on viewport height only.
    return REFERENCE_VIEWPORT_HEIGHT / viewportHeight;
  }
}
