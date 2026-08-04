import { describe, expect, it } from "vitest";
import { LineMaterial } from "three-stdlib";

import { BROKEN_NEAR_ESTIMATE, FIXED_NEAR_ESTIMATE } from "./patchLineMaterial";

describe("patchLineMaterial", () => {
  it("rewrites the near-plane estimate on every new LineMaterial", () => {
    // Constructing directly mirrors what drei's <Line> does internally; the
    // patch must apply without any per-instance setup.
    const mat = new LineMaterial();
    expect(mat.vertexShader).not.toContain(BROKEN_NEAR_ESTIMATE);
    expect(mat.vertexShader).toContain(FIXED_NEAR_ESTIMATE);
  });

  it("pads the world-units quad for alpha-to-coverage antialiasing", () => {
    const mat = new LineMaterial();
    // The pad is compiled in only under USE_ALPHA_TO_COVERAGE, so the
    // rewritten source must gate on it and stop sizing the quad with the
    // raw linewidth.
    expect(mat.vertexShader).toContain("renderWidth");
    expect(mat.vertexShader).toContain("USE_ALPHA_TO_COVERAGE");
    expect(mat.vertexShader).toContain("offset *= renderWidth * 0.5;");
    expect(mat.vertexShader).not.toContain("offset *= linewidth * 0.5;");
  });

  it("survives clone() without double-applying", () => {
    const mat = new LineMaterial();
    const cloned = mat.clone();
    expect(cloned.vertexShader).toBe(mat.vertexShader);
    // Exactly one occurrence of each rewritten expression.
    expect(cloned.vertexShader.split(FIXED_NEAR_ESTIMATE).length - 1).toBe(1);
    expect(
      cloned.vertexShader.split("offset *= renderWidth * 0.5;").length - 1,
    ).toBe(1);
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
