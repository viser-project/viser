import { describe, it, expect } from "vitest";
import { finiteNumberOrNull } from "./numberInputUtils";

describe("finiteNumberOrNull", () => {
  it("passes through finite numbers", () => {
    expect(finiteNumberOrNull(0)).toBe(0);
    expect(finiteNumberOrNull(-5)).toBe(-5);
    expect(finiteNumberOrNull(1.5)).toBe(1.5);
  });

  it("parses finite numeric strings", () => {
    expect(finiteNumberOrNull("42")).toBe(42);
    expect(finiteNumberOrNull("-3.5")).toBe(-3.5);
    expect(finiteNumberOrNull("1e3")).toBe(1000);
  });

  it("returns null for empty input", () => {
    expect(finiteNumberOrNull("")).toBeNull();
  });

  it("returns null for partial / invalid input Mantine emits while typing", () => {
    // These are the intermediate strings that previously leaked NaN / raw
    // strings to the server.
    for (const v of ["-", ".", "1e", "1.2.3", "abc", "-."]) {
      expect(finiteNumberOrNull(v), v).toBeNull();
    }
  });

  it("commits valid intermediate values that JS parses to a number", () => {
    // e.g. "1." parses to 1 -- a real number, so it's committed (unchanged
    // from the prior Number() behavior; the fix only blocks NaN/strings).
    expect(finiteNumberOrNull("1.")).toBe(1);
  });

  it("returns null for non-finite numbers", () => {
    expect(finiteNumberOrNull(NaN)).toBeNull();
    expect(finiteNumberOrNull(Infinity)).toBeNull();
    expect(finiteNumberOrNull(-Infinity)).toBeNull();
  });
});
