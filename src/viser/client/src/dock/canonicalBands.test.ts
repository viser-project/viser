// Canonical band form (spec P14, D12+D13): one structure per picture.

import { describe, it, expect } from "vitest";
import {
  canonicalViolations,
  normalizeCanonicalBandsInPlace,
  structureSignature,
} from "./layoutOps";
import { DockLayout } from "./types";
import { col, group, leaf, makeLayout, row, rows } from "./testUtils";

const bandsOf = (l: DockLayout, edge: "left" | "right") =>
  l.docked[edge]!.rows.map((rw) =>
    rw.columns.map((c) => c.leaves.map((lf) => lf.group)),
  );

describe("normalizeCanonicalBandsInPlace", () => {
  it("D12: a lone multi-leaf column splits into bands, heights preserved", () => {
    const l = makeLayout({ left: col([leaf("a", 2), leaf("b", 1), leaf("c", 1)]) });
    const band0 = l.docked.left!.rows[0];
    const keepBandId = band0.id;
    const keepColId = band0.columns[0].id;
    const leafIds = band0.columns[0].leaves.map((lf) => lf.id);
    expect(normalizeCanonicalBandsInPlace(l)).toBe(true);
    expect(bandsOf(l, "left")).toEqual([[["a"]], [["b"]], [["c"]]]);
    const out = l.docked.left!.rows;
    // Band weights carve the original band's weight by leaf shares (2:1:1).
    expect(out[0].weight / out[1].weight).toBeCloseTo(2);
    expect(out[1].weight / out[2].weight).toBeCloseTo(1);
    // Id stability: first fragment keeps the band + column ids; all leaf
    // ids survive.
    expect(out[0].id).toBe(keepBandId);
    expect(out[0].columns[0].id).toBe(keepColId);
    expect(out.map((r) => r.columns[0].leaves[0].id)).toEqual(leafIds);
    expect(canonicalViolations(l)).toEqual([]);
  });

  it("D12 does NOT split a multi-leaf column that has band siblings", () => {
    const l = makeLayout({ left: row([leaf("x"), col([leaf("a"), leaf("b")])]) });
    expect(normalizeCanonicalBandsInPlace(l)).toBe(false);
    expect(bandsOf(l, "left")).toEqual([[["x"], ["a", "b"]]]);
  });

  it("D13: aligned multi-column neighbors zip into one band", () => {
    const l = makeLayout({
      left: rows([row([leaf("a"), leaf("b")]), row([leaf("c"), leaf("d")])]),
    });
    // Equal column weights (1,1)/(1,1): fractions align exactly.
    expect(normalizeCanonicalBandsInPlace(l)).toBe(true);
    expect(bandsOf(l, "left")).toEqual([[["a", "c"], ["b", "d"]]]);
    // Leaf weights inside each zipped column reflect the source band
    // heights (both bands weight 1 -> equal shares).
    const colA = l.docked.left!.rows[0].columns[0];
    expect(colA.leaves[0].weight).toBeCloseTo(colA.leaves[1].weight);
  });

  it("D13 respects the alignment tolerance", () => {
    const l = makeLayout({
      left: rows([
        row([leaf("a", 150), leaf("b", 150)]),
        row([leaf("c", 200), leaf("d", 100)]),
      ]),
    });
    // 150/150 vs 200/100 on a 300px region: off by 50px >> 2px tolerance.
    expect(normalizeCanonicalBandsInPlace(l)).toBe(false);
    expect(bandsOf(l, "left")).toEqual([
      [["a"], ["b"]],
      [["c"], ["d"]],
    ]);
  });

  it("D13 never zips single-column bands (bands are canonical for stacks)", () => {
    const l = makeLayout({ left: rows([row([leaf("a")]), row([leaf("b")])]) });
    expect(normalizeCanonicalBandsInPlace(l)).toBe(false);
    expect(bandsOf(l, "left")).toEqual([[["a"]], [["b"]]]);
  });

  it("D13 chains: three aligned bands collapse into one", () => {
    const l = makeLayout({
      left: rows([
        row([leaf("a"), leaf("b")]),
        row([leaf("c"), leaf("d")]),
        row([leaf("e"), leaf("f")]),
      ]),
    });
    expect(normalizeCanonicalBandsInPlace(l)).toBe(true);
    expect(bandsOf(l, "left")).toEqual([[["a", "c", "e"], ["b", "d", "f"]]]);
  });

  it("is idempotent (fixpoint): a second run changes nothing", () => {
    const l = makeLayout({
      left: rows([
        row([leaf("x")]),
        row([leaf("a"), leaf("b")]),
        row([leaf("c"), leaf("d")]),
      ]),
    });
    expect(normalizeCanonicalBandsInPlace(l)).toBe(true);
    const sig = structureSignature(l);
    expect(normalizeCanonicalBandsInPlace(l)).toBe(false);
    expect(structureSignature(l)).toBe(sig);
    expect(canonicalViolations(l)).toEqual([]);
  });
});

describe("structureSignature", () => {
  it("ignores weights and collapse; tracks arrangement", () => {
    const l = makeLayout({ left: row([leaf("a"), leaf("b")]) });
    const sig = structureSignature(l);
    const l2 = structuredClone(l);
    l2.docked.left!.rows[0].columns[0].weight = 999;
    // Container collapse flags (D38) are excluded from the signature.
    l2.docked.left!.rows[0].columns[0].railed = true;
    l2.regionCollapsed = { left: true, right: false };
    expect(structureSignature(l2)).toBe(sig);
    const l3 = structuredClone(l);
    l3.docked.left!.rows[0].columns[0].leaves[0].group = "b2";
    expect(structureSignature(l3)).not.toBe(sig);
  });
});

import { dockToRegionEdge, dockBandAtIndex } from "./layoutOps";
import { floatingWindow } from "./testUtils";

describe("region-side dock beside a canonical stack (D12 follow-ups)", () => {
  it("zips single-column bands so the new panel lands beside EVERYTHING", () => {
    const l = makeLayout({
      // Band WEIGHTS 3:1 (the second arg of row(), not the leaf weight).
      left: rows([row([leaf("b")], 3), row([leaf("c")], 1)]),
    });
    l.floating = [floatingWindow({ id: "w", x: 0, y: 0, width: 200, stack: ["n"] })];
    l.groups["n"] = group("n");
    const out = dockToRegionEdge(l, ["n"], "left", "left");
    const rws = out.docked.left!.rows;
    expect(rws).toHaveLength(1);
    expect(rws[0].columns.map((c) => c.leaves.map((lf) => lf.group))).toEqual([
      ["n"],
      ["b", "c"],
    ]);
    // Zipped leaf weights preserve the bands' 3:1 height split.
    const zipped = rws[0].columns[1];
    expect(zipped.leaves[0].weight / zipped.leaves[1].weight).toBeCloseTo(3);
  });

  it("a seam band insert takes an equal share, not a ~0px sliver", () => {
    // BAND weights on a px scale (post band-divider resize).
    const l = makeLayout({
      left: rows([row([leaf("b")], 400), row([leaf("c")], 300)]),
    });
    l.floating = [floatingWindow({ id: "w", x: 0, y: 0, width: 200, stack: ["n"] })];
    l.groups["n"] = group("n");
    const out = dockBandAtIndex(l, ["n"], "left", 1);
    const rws = out.docked.left!.rows;
    expect(rws).toHaveLength(3);
    const total = rws.reduce((s, r) => s + r.weight, 0);
    const newBand = rws[1];
    // The new band's share is ~1/3 of the region (mean of the existing
    // weights), NOT 1/701.
    expect(newBand.weight / total).toBeGreaterThan(0.2);
  });
});
