/**
 * Shader fixes for three-stdlib's LineMaterial, applied to EVERY instance
 * via a prototype accessor.
 *
 * We can't fix LineMaterial with a one-off material patch: drei's <Line>
 * (used for camera frustums, Catmull-Rom / cubic Bezier splines, and
 * internally by PivotControls) constructs its own LineMaterial instances
 * that we never see. Instead we intercept `vertexShader` on
 * LineMaterial.prototype: the ShaderMaterial constructor assigns the shader
 * source with a plain `this.vertexShader = ...`, which invokes this
 * inherited setter, so every instance is rewritten at construction time.
 * Each replacement is a no-op for shader sources that don't contain its
 * anchor (idempotent for clone()/copy(), and safe if three-stdlib ships its
 * own fix). Two fixes are applied:
 *
 * 1. Reversed-depth near-plane estimate. The vertex shader trims line
 *    segments that cross the camera plane back to a near-plane estimate
 *    derived from the projection matrix:
 *
 *      float nearEstimate = - 0.5 * b / a;
 *
 *    That formula assumes a standard depth projection. Under the reversed
 *    depth buffer we enable in App.tsx, a = near / (far - near) and
 *    b = far * near / (far - near), so it evaluates to -far / 2 -- segments
 *    that cross the camera plane get extrapolated hundreds of units into
 *    the scene and smear across the screen whenever the camera gets close
 *    to a line. The reversed-depth-safe estimate is -b / (1 + a) = -near
 *    exactly; we switch on sign(a), which distinguishes the two projection
 *    forms. three.js fixed its bundled copy of this shader for r185
 *    (https://github.com/mrdoob/three.js/pull/33572), but drei and our Line
 *    component use the fork in three-stdlib, which carries its own copy of
 *    the shader -- so this fix is needed until three-stdlib ships the
 *    equivalent, independent of the three version we build against.
 *
 * 2. Antialiasing pad for world-unit widths. With WORLD_UNITS, the
 *    fragment shader computes an analytic distance from the view ray to
 *    the line segment, and with USE_ALPHA_TO_COVERAGE turns it into a
 *    smooth fwidth()-based edge falloff -- including a graceful fade for
 *    lines whose projected width drops below a pixel. But the quad
 *    geometry is only `linewidth` wide, so there is no room to draw that
 *    falloff: edges get clipped and sub-pixel lines rasterize as broken
 *    stipple (an opaque quad thinner than a pixel either hits a sample or
 *    it doesn't, MSAA or not). We widen the quad by ~1 screen pixel per
 *    side (in world units, derived from the projected pixel size at the
 *    vertex) so the analytic falloff always has room. The pad is
 *    fragment-alpha'd back down by the existing falloff, so the rendered
 *    width is unchanged; it only applies under
 *    USE_ALPHA_TO_COVERAGE (without it the extra area would be discarded
 *    anyway, i.e. pure overdraw) and not for dashes (whose width comes
 *    from the quad itself, so padding would fatten them).
 */
import { LineMaterial } from "three-stdlib";

const BROKEN_NEAR_ESTIMATE = "float nearEstimate = - 0.5 * b / a;";
const FIXED_NEAR_ESTIMATE =
  "float nearEstimate = ( a > 0.0 ) ? ( - b / ( 1.0 + a ) ) : ( - 0.5 * b / a );";

// Anchors in the WORLD_UNITS branch of the vertex shader. `renderWidth` is
// injected just before the first anchor and replaces `linewidth` in the
// quad-sizing expressions (the fragment shader's analytic falloff keeps
// using the true `linewidth` uniform).
const WORLD_DIR_ANCHOR = "vec3 worldDir = normalize( end.xyz - start.xyz );";
const RENDER_WIDTH_INJECTION = `float renderWidth = linewidth;
						#if defined( USE_ALPHA_TO_COVERAGE ) && !defined( USE_DASH )
							float aaClipW = ( position.y < 0.5 ) ? clipStart.w : clipEnd.w;
							float aaWorldPerPixel = 2.0 * max( aaClipW, 1e-4 ) / ( projectionMatrix[ 1 ][ 1 ] * resolution.y );
							renderWidth = linewidth + 2.0 * aaWorldPerPixel;
						#endif
						${WORLD_DIR_ANCHOR}`;
const QUAD_SIZING_REPLACEMENTS: Array<[string, string]> = [
  [WORLD_DIR_ANCHOR, RENDER_WIDTH_INJECTION],
  [
    "start.xyz += - worldDir * linewidth * 0.5;",
    "start.xyz += - worldDir * renderWidth * 0.5;",
  ],
  [
    "end.xyz += worldDir * linewidth * 0.5;",
    "end.xyz += worldDir * renderWidth * 0.5;",
  ],
  ["offset *= linewidth * 0.5;", "offset *= renderWidth * 0.5;"],
];

function patchVertexShader(source: string): string {
  source = source.replace(BROKEN_NEAR_ESTIMATE, FIXED_NEAR_ESTIMATE);
  // Only apply the quad pad to the pristine shader (idempotence: clone()
  // re-assigns an already-patched source, which no longer contains the
  // plain WORLD_DIR_ANCHOR context... but the anchor itself survives inside
  // the injection, so gate on the injected marker instead).
  if (!source.includes("renderWidth")) {
    for (const [from, to] of QUAD_SIZING_REPLACEMENTS) {
      source = source.replace(from, to);
    }
  }
  return source;
}

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
      typeof source === "string" ? patchVertexShader(source) : source;
  },
});

export { BROKEN_NEAR_ESTIMATE, FIXED_NEAR_ESTIMATE };
