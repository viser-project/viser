import { describe, expect, it } from "vitest";
import { LineMaterial } from "three-stdlib";

import {
  BROKEN_NEAR_ESTIMATE,
  FIXED_NEAR_ESTIMATE,
  FRINGE_GUARD,
} from "./patchLineMaterial";

describe("patchLineMaterial", () => {
  it("rewrites the near-plane estimate on every new LineMaterial", () => {
    // Constructing directly mirrors what drei components do internally; the
    // patch must apply without any per-instance setup.
    const mat = new LineMaterial();
    expect(mat.vertexShader).not.toContain(BROKEN_NEAR_ESTIMATE);
    expect(mat.vertexShader).toContain(FIXED_NEAR_ESTIMATE);
  });

  it("pads the world-units quad only for the fringe pass", () => {
    const mat = new LineMaterial();
    expect(mat.vertexShader).toContain("renderWidth");
    expect(mat.vertexShader).toContain(
      "#if defined( VISER_LINE_FRINGE ) && !defined( USE_DASH )",
    );
    expect(mat.vertexShader).toContain("offset *= renderWidth * 0.5;");
    expect(mat.vertexShader).not.toContain("offset *= linewidth * 0.5;");
  });

  it("guards the smooth falloff on the fringe define, keeping the core discard", () => {
    const mat = new LineMaterial();
    // Falloff branch is selected by VISER_LINE_FRINGE, not alphaToCoverage
    // (alpha-to-coverage writes partial alpha without blending, which
    // composites additively with the page background through viser's
    // transparent canvas -- a white glow).
    expect(mat.fragmentShader).toContain(FRINGE_GUARD);
    expect(mat.fragmentShader).toContain(
      "alpha = opacity * ( 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm ) );",
    );
    expect(mat.fragmentShader).toContain("if ( alpha < 0.02 ) discard;");
    // The stock hard discard must survive for the depth-anchoring core pass.
    expect(mat.fragmentShader).toContain("if ( norm > 0.5 ) {");
  });

  it("survives clone() without double-applying", () => {
    const mat = new LineMaterial();
    const cloned = mat.clone();
    expect(cloned.vertexShader).toBe(mat.vertexShader);
    expect(cloned.fragmentShader).toBe(mat.fragmentShader);
    // Exactly one occurrence of each rewritten expression.
    expect(cloned.vertexShader.split(FIXED_NEAR_ESTIMATE).length - 1).toBe(1);
    expect(
      cloned.vertexShader.split("offset *= renderWidth * 0.5;").length - 1,
    ).toBe(1);
    expect(cloned.fragmentShader.split(FRINGE_GUARD).length - 1).toBe(1);
  });

  it("preserves three-stdlib's own onBeforeCompile hook", () => {
    // three-stdlib's LineMaterial assigns an onBeforeCompile that toggles
    // USE_LINE_COLOR_ALPHA for transparent materials. Our patch must not
    // replace it (the old per-instance patch did).
    const mat = new LineMaterial();
    mat.transparent = true;
    mat.onBeforeCompile(
      { vertexShader: "", fragmentShader: "" } as never,
      null as never,
    );
    expect(mat.defines.USE_LINE_COLOR_ALPHA).toBe("1");
  });
});
