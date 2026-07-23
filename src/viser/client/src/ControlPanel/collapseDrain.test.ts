// Ordering rules for the coordinator's HELD collapse queue (D50). Collapse is
// container state, so when stacked panels' collapse axes conflict, the order
// they apply in decides the container's final state -- and a held queue must
// reproduce command order, not queue-bookkeeping order. The user-overtake
// filter is scoped per PANEL: only a gesture on the target panel's own
// container kills its queued command (P6), never an unrelated gesture.

import { describe, expect, it } from "vitest";
import { orderCollapseDrain, type QueuedCollapse } from "./collapseDrain";

/** Queue entry shorthand; `paneStamp` defaults to 0 (no user gesture had
 * touched the panel's container when queued). */
function q(
  panel: string,
  collapsed: boolean,
  counter: number,
  runId: string,
  seq: number,
  paneStamp = 0,
): QueuedCollapse {
  return { tabIds: [panel], collapsed, counter, runId, seq, paneStamp };
}

const panels = (out: QueuedCollapse[]) => out.map((c) => c.tabIds[0]);
/** stampNow from a static per-panel map (panels absent = never touched). */
const stamps =
  (m: Record<string, number>) =>
  (tabIds: string[]): number =>
    Math.max(0, ...tabIds.map((t) => m[t] ?? 0));

describe("orderCollapseDrain", () => {
  it("sorts by the global counter within a run (D50)", () => {
    // The canonical divergence: "B.expand() then A.minimize()" must end with
    // A's minimize LAST regardless of queue order, so the shared column ends
    // collapsed exactly like a live client's.
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 2), q("B", false, 3, "run-s", 1)],
      stamps({}),
    );
    expect(panels(out)).toEqual(["B", "A"]);
    expect(out[out.length - 1].collapsed).toBe(true);
  });

  it("queue order does not override the counter", () => {
    // Same commands, opposite queue order (a split-anchored panel queues its
    // collapse a pass later than its neighbor): the result must not change.
    const out = orderCollapseDrain(
      [q("B", false, 3, "run-s", 9), q("A", true, 4, "run-s", 1)],
      stamps({}),
    );
    expect(panels(out)).toEqual(["B", "A"]);
  });

  it("orders runs by arrival, not by a replaced entry's old position", () => {
    // Counters are only comparable within a run. main's run-s command is
    // superseded by a later run-c one; the run-c command arrived LAST, so it
    // must apply last -- even though main was queued first (a Map keyed by
    // panel keeps the original insertion slot on replace).
    const out = orderCollapseDrain(
      [
        q("B", true, 7, "run-s", 2),
        // main's entry: replaced, so it carries the NEW seq (3), not its
        // original slot (1).
        q("main", false, 1, "run-c", 3),
      ],
      stamps({}),
    );
    expect(panels(out)).toEqual(["B", "main"]);
    expect(out[out.length - 1].collapsed).toBe(false);
  });

  it("drops a command whose OWN panel the user touched during the hold", () => {
    // P6: a user gesture on the target container during the hold wins -- the
    // immediate path would have let it, so deferral must not resurrect the
    // older server intent.
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 1, /* stamp at queue */ 0)],
      stamps({ A: 1 }), // the user touched A's container after queuing
    );
    expect(out).toEqual([]);
  });

  it("an UNRELATED panel's gesture never drops a queued command", () => {
    // Regression: a global user-gesture signal discarded A's legitimate
    // queued collapse when the user merely rearranged some other panel B.
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 1, 0)],
      stamps({ B: 7 }), // B was touched; A was not
    );
    expect(panels(out)).toEqual(["A"]);
  });

  it("keeps a command queued AFTER the user's gesture on the same panel", () => {
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 1, /* stamp at queue */ 2)],
      stamps({ A: 2 }), // no NEW gesture since queuing
    );
    expect(panels(out)).toEqual(["A"]);
  });

  it("drops only the overtaken entries, keeping the rest in order", () => {
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 1, 0), q("B", false, 5, "run-s", 2, 0)],
      stamps({ A: 3 }),
    );
    expect(panels(out)).toEqual(["B"]);
  });
});
