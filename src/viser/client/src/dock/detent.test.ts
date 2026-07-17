// Pins for the content-height detent (detent.ts, spec section 6 / D56):
// snapToDetent's pure math (in-band snaps, out-of-band pass-through, nearest
// detent wins, exact landings, the inclusive band edge the window grip's
// original magnet used) and measureNaturalHeight's viewport accounting --
// the latter over a micro-DOM stub of exactly the traversal surface the
// helper touches, so the nested-ScrollArea rule is pinned without a DOM
// test environment.

import { describe, expect, it } from "vitest";
import { measureNaturalHeight, snapToDetent } from "./detent";

const BAND = 12;

describe("snapToDetent", () => {
  it("snaps a value inside the band onto the detent", () => {
    expect(snapToDetent(105, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(95, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
  });

  it("passes an out-of-band value through unchanged", () => {
    expect(snapToDetent(113, [100], BAND)).toEqual({
      value: 113,
      snapped: false,
    });
    expect(snapToDetent(80, [100], BAND)).toEqual({
      value: 80,
      snapped: false,
    });
  });

  it("band edge is inclusive (distance == band snaps; the grip's <=)", () => {
    expect(snapToDetent(112, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(88, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(112.01, [100], BAND).snapped).toBe(false);
  });

  it("nearest detent wins when both flanks are in band", () => {
    // Both detents within 12 of value 6: |6-0|=6, |6-10|=4 -> 10 wins.
    expect(snapToDetent(6, [0, 10], BAND)).toEqual({
      value: 10,
      snapped: true,
    });
    // Mirrored: 4 is nearer 0.
    expect(snapToDetent(4, [0, 10], BAND)).toEqual({ value: 0, snapped: true });
  });

  it("exact tie goes to the earlier-listed detent", () => {
    expect(snapToDetent(5, [0, 10], BAND)).toEqual({ value: 0, snapped: true });
    expect(snapToDetent(5, [10, 0], BAND)).toEqual({
      value: 10,
      snapped: true,
    });
  });

  it("exact landing on a detent reports snapped", () => {
    expect(snapToDetent(100, [100], BAND)).toEqual({
      value: 100,
      snapped: true,
    });
    expect(snapToDetent(0, [0], BAND)).toEqual({ value: 0, snapped: true });
  });

  it("works on negative deltas (divider dragged up)", () => {
    expect(snapToDetent(-178, [-185], BAND)).toEqual({
      value: -185,
      snapped: true,
    });
    expect(snapToDetent(-193, [-185], BAND)).toEqual({
      value: -185,
      snapped: true,
    });
    expect(snapToDetent(-220, [-185], BAND).snapped).toBe(false);
  });

  it("no detents -> never snaps", () => {
    expect(snapToDetent(3, [], BAND)).toEqual({ value: 3, snapped: false });
  });
});

// ---------------------------------------------------------------------------
// measureNaturalHeight over a micro-DOM: fake nodes implementing the exact
// members the helper uses (querySelectorAll/querySelector by class selector,
// parentElement, closest, contains, offset/client/scrollHeight). Layout
// numbers are stubbed, so each case states its arithmetic inline.
// ---------------------------------------------------------------------------

const VIEWPORT = "mantine-ScrollArea-viewport";
const CONTENT = "mantine-ScrollArea-content";

interface FakeEl {
  cls: string;
  offsetHeight: number;
  clientHeight: number;
  scrollHeight: number;
  children: FakeEl[];
  parentElement: FakeEl | null;
  querySelectorAll: (sel: string) => FakeEl[];
  querySelector: (sel: string) => FakeEl | null;
  closest: (sel: string) => FakeEl | null;
  contains: (n: FakeEl) => boolean;
}

function descendantsOf(root: FakeEl, cls: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl) =>
    n.children.forEach((c) => {
      if (c.cls === cls) out.push(c);
      walk(c);
    });
  walk(root);
  return out;
}

function el(
  cls: string,
  heights: { offset?: number; client?: number; scroll?: number },
  children: FakeEl[] = [],
): FakeEl {
  const node: FakeEl = {
    cls,
    offsetHeight: heights.offset ?? 0,
    clientHeight: heights.client ?? 0,
    scrollHeight: heights.scroll ?? 0,
    children,
    parentElement: null,
    querySelectorAll: (sel) => descendantsOf(node, sel.slice(1)),
    querySelector: (sel) => descendantsOf(node, sel.slice(1))[0] ?? null,
    closest: (sel) => {
      let n: FakeEl | null = node;
      while (n !== null && n.cls !== sel.slice(1)) n = n.parentElement;
      return n;
    },
    contains: (n) => {
      let m: FakeEl | null = n;
      while (m !== null && m !== node) m = m.parentElement;
      return m === node;
    },
  };
  children.forEach((c) => (c.parentElement = node));
  return node;
}

const measure = (n: FakeEl) =>
  measureNaturalHeight(n as unknown as HTMLElement);

describe("measureNaturalHeight", () => {
  it("flat cell: el chrome + content wrapper height", () => {
    // 300 (el) - 200 (viewport client) + 250 (content) = 350.
    const cell = el("cell", { offset: 300 }, [
      el(VIEWPORT, { client: 200 }, [el(CONTENT, { offset: 250 })]),
    ]);
    expect(measure(cell)).toBe(350);
  });

  it("nested OVERFLOWING scroll area is not double-counted", () => {
    // A DockArea-in-panel-body shape (TabGroup): the inner viewport's
    // +60 overflow delta already lives inside the outer content's 250.
    // All-descendants summing would give 300 - (200+80) + (250+140) = 410;
    // top-level-only gives the true 300 - 200 + 250 = 350.
    const inner = el(VIEWPORT, { client: 80 }, [el(CONTENT, { offset: 140 })]);
    const cell = el("cell", { offset: 300 }, [
      el(VIEWPORT, { client: 200 }, [el(CONTENT, { offset: 250 }, [inner])]),
    ]);
    expect(measure(cell)).toBe(350);
  });

  it("nested FITTING scroll area is not double-counted either", () => {
    // Inner fits (client 100 > content 60): its -40 free-space delta would
    // wrongly SHRINK the measure (300 - 300 + 310 = 310) if summed.
    const inner = el(VIEWPORT, { client: 100 }, [el(CONTENT, { offset: 60 })]);
    const cell = el("cell", { offset: 300 }, [
      el(VIEWPORT, { client: 200 }, [el(CONTENT, { offset: 250 }, [inner])]),
    ]);
    expect(measure(cell)).toBe(350);
  });

  it("an enclosing viewport OUTSIDE el does not suppress el's own", () => {
    // The measured cell may itself live inside some host scroll area (a
    // docked leaf in a scrolling column). Its viewport is top-level WITHIN
    // el and must still count.
    const cell = el("cell", { offset: 300 }, [
      el(VIEWPORT, { client: 200 }, [el(CONTENT, { offset: 250 })]),
    ]);
    el("root", { offset: 1000 }, [
      el(VIEWPORT, { client: 500 }, [el(CONTENT, { offset: 900 }, [cell])]),
    ]);
    expect(measure(cell)).toBe(350);
  });

  it("no scroll viewport: the element's own height", () => {
    expect(measure(el("cell", { offset: 123 }))).toBe(123);
  });

  it("viewport without a content wrapper falls back to scrollHeight", () => {
    // 300 - 200 + 260 (scrollHeight) = 360.
    const cell = el("cell", { offset: 300 }, [
      el(VIEWPORT, { client: 200, scroll: 260 }),
    ]);
    expect(measure(cell)).toBe(360);
  });
});
