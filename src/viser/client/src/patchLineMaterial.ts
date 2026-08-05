/**
 * Shader fixes for three-stdlib's LineMaterial, applied to EVERY instance
 * via prototype accessors.
 *
 * We can't fix LineMaterial with a one-off material patch: drei's
 * PivotControls (and, in general, any drei component) constructs its own
 * LineMaterial instances that we never see. Instead we intercept
 * `vertexShader` and `fragmentShader` on LineMaterial.prototype: the
 * ShaderMaterial constructor assigns the shader sources with plain
 * `this.vertexShader = ...` assignments, which invoke these inherited
 * setters, so every instance is rewritten at construction time. Each
 * replacement is a no-op for shader sources that don't contain its anchor
 * (idempotent for clone()/copy(), and safe if three-stdlib ships its own
 * fix). Two fixes are applied:
 *
 * 1. Reversed-depth near-plane estimate (vertex). The vertex shader trims
 *    line segments that cross the camera plane back to a near-plane
 *    estimate derived from the projection matrix:
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
 * 2. Antialiasing skirt for world-unit widths (vertex + fragment), enabled
 *    per-material with a VISER_LINE_FRINGE define. World-unit lines render
 *    in two passes (see Line.tsx):
 *
 *    - The CORE pass is the stock material: opaque, hard norm > 0.5
 *      discard, depth written. Nearer lines occlude farther ones per-pixel,
 *      identical to the pre-antialiasing rendering.
 *    - The FRINGE pass re-draws the line with VISER_LINE_FRINGE defined:
 *      the analytic ray-to-segment distance drives a smooth fwidth() edge
 *      falloff (upstream code normally compiled only under
 *      USE_ALPHA_TO_COVERAGE), the quad is padded by ~1 screen pixel per
 *      side so the falloff has room to draw, and the result is alpha
 *      blended in the transparent pass with depth WRITES off but depth
 *      TESTS on. Sub-pixel lines fade smoothly instead of rasterizing as
 *      broken stipple.
 *
 *    Why this shape: alpha-to-coverage writes partial alpha into the color
 *    buffer without blending, and viser's canvas is composited over the
 *    page with premultiplied alpha (the white/dark theme background is the
 *    page div behind a transparent canvas), so every partial-alpha pixel
 *    gained (1 - alpha) * page-background additively -- a white glow along
 *    every line. Blending fixes that, but a single blended pass can't
 *    handle depth: writing real depth from blended edges punches gaps at
 *    every polyline joint (overlapping segment quads depth-reject each
 *    other's cores), no depth writes loses line-over-line occlusion, and
 *    gl_FragDepth can't express "test near, write far" because a
 *    fragment's written depth is also its tested depth. The opaque core
 *    anchors depth; the fringe only ever adds color on top. Fringe
 *    fragments with near-zero alpha are discarded to skip pointless
 *    blending. Dashes never get a fringe (their width comes from the quad
 *    itself, so padding would fatten them).
 */
import { LineMaterial } from "three-stdlib";

const BROKEN_NEAR_ESTIMATE = "float nearEstimate = - 0.5 * b / a;";
const FIXED_NEAR_ESTIMATE =
  "float nearEstimate = ( a > 0.0 ) ? ( - b / ( 1.0 + a ) ) : ( - 0.5 * b / a );";

// Anchors in the WORLD_UNITS branch of the vertex shader. `renderWidth` is
// injected just before the first anchor and replaces `linewidth` in the
// quad-sizing expressions (the fragment shader's analytic falloff keeps
// using the true `linewidth` uniform), padding the fringe quad so the edge
// falloff has room; the core pass keeps the exact stock quad.
const WORLD_DIR_ANCHOR = "vec3 worldDir = normalize( end.xyz - start.xyz );";
const RENDER_WIDTH_INJECTION = `float renderWidth = linewidth;
						#if defined( VISER_LINE_FRINGE ) && !defined( USE_DASH )
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
  // Gate on the injected marker for idempotence (clone() re-assigns an
  // already-patched source; WORLD_DIR_ANCHOR itself survives inside the
  // injection, so it can't be the gate).
  if (!source.includes("renderWidth")) {
    for (const [from, to] of QUAD_SIZING_REPLACEMENTS) {
      source = source.replace(from, to);
    }
  }
  return source;
}

// Fragment: swap the smooth-falloff branch's guard from
// USE_ALPHA_TO_COVERAGE to our fringe define. `.replace` rewrites the
// FIRST `#ifdef USE_ALPHA_TO_COVERAGE`, which is the WORLD_UNITS one (the
// screen-space endcap ifdef comes later in the source); the `#else` hard
// discard stays in place for the core pass. The smoothstep line is unique
// to the world-units branch.
const FRINGE_GUARD = "#ifdef VISER_LINE_FRINGE // viser: blended AA skirt";
const FRAGMENT_REPLACEMENTS: Array<[string, string]> = [
  ["#ifdef USE_ALPHA_TO_COVERAGE", FRINGE_GUARD],
  [
    "alpha = 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm );",
    `alpha = opacity * ( 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm ) );
							if ( alpha < 0.02 ) discard;`,
  ],
];

function patchFragmentShader(source: string): string {
  if (!source.includes(FRINGE_GUARD)) {
    for (const [from, to] of FRAGMENT_REPLACEMENTS) {
      source = source.replace(from, to);
    }
  }
  return source;
}

const VERTEX_KEY = "__viserPatchedVertexShader";
const FRAGMENT_KEY = "__viserPatchedFragmentShader";

type PatchedMaterial = LineMaterial & {
  [VERTEX_KEY]?: string;
  [FRAGMENT_KEY]?: string;
};

Object.defineProperty(LineMaterial.prototype, "vertexShader", {
  configurable: true,
  enumerable: true,
  get(this: PatchedMaterial) {
    return this[VERTEX_KEY];
  },
  set(this: PatchedMaterial, source: string) {
    this[VERTEX_KEY] =
      typeof source === "string" ? patchVertexShader(source) : source;
  },
});

Object.defineProperty(LineMaterial.prototype, "fragmentShader", {
  configurable: true,
  enumerable: true,
  get(this: PatchedMaterial) {
    return this[FRAGMENT_KEY];
  },
  set(this: PatchedMaterial, source: string) {
    this[FRAGMENT_KEY] =
      typeof source === "string" ? patchFragmentShader(source) : source;
  },
});

export { BROKEN_NEAR_ESTIMATE, FIXED_NEAR_ESTIMATE, FRINGE_GUARD };
