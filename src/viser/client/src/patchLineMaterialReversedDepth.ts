/**
 * Reversed-depth fix for three-stdlib's LineMaterial, applied to EVERY
 * instance via a prototype accessor.
 *
 * LineMaterial's vertex shader trims line segments that cross the camera
 * plane back to a near-plane estimate derived from the projection matrix:
 *
 *   float nearEstimate = - 0.5 * b / a;
 *
 * That formula assumes a standard depth projection. Under the reversed
 * depth buffer we enable in App.tsx, a = near / (far - near) and
 * b = far * near / (far - near), so it evaluates to -far / 2 -- segments
 * that cross the camera plane get extrapolated hundreds of units into the
 * scene and smear across the screen whenever the camera gets close to a
 * line. The reversed-depth-safe estimate is -b / (1 + a) = -near exactly;
 * we switch on sign(a), which distinguishes the two projection forms.
 *
 * We can't fix this with a one-off material patch: drei's <Line> (used for
 * camera frustums, Catmull-Rom / cubic Bezier splines, and internally by
 * PivotControls) constructs its own LineMaterial instances that we never
 * see. Instead we intercept `vertexShader` on LineMaterial.prototype: the
 * ShaderMaterial constructor assigns the shader source with a plain
 * `this.vertexShader = ...`, which invokes this inherited setter, so every
 * instance is rewritten at construction time. The replacement is a no-op
 * for shader sources that don't contain the broken line (idempotent for
 * clone()/copy(), and safe if three-stdlib ships its own fix).
 *
 * three.js fixed its bundled copy of this shader for r185
 * (https://github.com/mrdoob/three.js/pull/33572), but drei and our Line
 * component use the fork in three-stdlib, which carries its own copy of
 * the shader -- so this patch is needed until three-stdlib ships the
 * equivalent fix, independent of the three version we build against.
 */
import { LineMaterial } from "three-stdlib";

const BROKEN_NEAR_ESTIMATE = "float nearEstimate = - 0.5 * b / a;";
const FIXED_NEAR_ESTIMATE =
  "float nearEstimate = ( a > 0.0 ) ? ( - b / ( 1.0 + a ) ) : ( - 0.5 * b / a );";

const STORAGE_KEY = "__viserPatchedVertexShader";

type PatchedMaterial = LineMaterial & { [STORAGE_KEY]?: string };

Object.defineProperty(LineMaterial.prototype, "vertexShader", {
  configurable: true,
  enumerable: true,
  get(this: PatchedMaterial) {
    return this[STORAGE_KEY];
  },
  set(this: PatchedMaterial, source: string) {
    this[STORAGE_KEY] =
      typeof source === "string"
        ? source.replace(BROKEN_NEAR_ESTIMATE, FIXED_NEAR_ESTIMATE)
        : source;
  },
});

export { BROKEN_NEAR_ESTIMATE, FIXED_NEAR_ESTIMATE };
