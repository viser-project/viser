import { describe, it, expect } from "vitest";
import {
  toMantineColor,
  rgbToString,
  rgbaToString,
  parseToRgb,
  parseToRgba,
  rgbEqual,
  rgbaEqual,
} from "./colorUtils";

describe("toMantineColor", () => {
  it("returns undefined for null", () => {
    expect(toMantineColor(null)).toBeUndefined();
  });
  it("converts an RGB tuple to a zero-padded hex string", () => {
    expect(toMantineColor([255, 0, 16])).toBe("#ff0010");
  });
  it("passes through string color names unchanged", () => {
    expect(toMantineColor("red")).toBe("red");
  });
});

describe("rgbToString / rgbaToString", () => {
  it("rounds RGB components", () => {
    expect(rgbToString([0.4, 127.6, 255])).toBe("rgb(0, 128, 255)");
  });
  it("emits alpha in [0, 1] with 4 decimals", () => {
    expect(rgbaToString([10, 20, 30, 255])).toBe("rgba(10, 20, 30, 1.0000)");
    expect(rgbaToString([10, 20, 30, 0])).toBe("rgba(10, 20, 30, 0.0000)");
  });
});

describe("parseToRgb", () => {
  it("parses rgb() strings", () => {
    expect(parseToRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
  });
  it("parses #RGB shorthand hex", () => {
    expect(parseToRgb("#f00")).toEqual([255, 0, 0]);
  });
  it("parses #RRGGBB hex", () => {
    expect(parseToRgb("#0a141e")).toEqual([10, 20, 30]);
  });
  it("returns null for unparseable input", () => {
    expect(parseToRgb("not a color")).toBeNull();
  });
});

describe("parseToRgba", () => {
  it("parses rgba() strings and scales alpha to [0, 255]", () => {
    expect(parseToRgba("rgba(1, 2, 3, 1)")).toEqual([1, 2, 3, 255]);
    expect(parseToRgba("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 128]);
  });
  it("parses #RGBA shorthand hex", () => {
    expect(parseToRgba("#f00f")).toEqual([255, 0, 0, 255]);
  });
  it("parses #RRGGBBAA hex", () => {
    expect(parseToRgba("#0a141e80")).toEqual([10, 20, 30, 128]);
  });
  it("falls back to RGB parsing with full alpha", () => {
    expect(parseToRgba("rgb(1, 2, 3)")).toEqual([1, 2, 3, 255]);
    expect(parseToRgba("#f00")).toEqual([255, 0, 0, 255]);
  });
  it("returns null for unparseable input", () => {
    expect(parseToRgba("nope")).toBeNull();
  });
});

describe("rgbEqual / rgbaEqual", () => {
  it("compares element-wise", () => {
    expect(rgbEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(rgbEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(rgbaEqual([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true);
    expect(rgbaEqual([1, 2, 3, 4], [1, 2, 3, 5])).toBe(false);
  });
});
