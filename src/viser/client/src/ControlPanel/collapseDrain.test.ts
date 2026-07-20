// Ordering rules for the coordinator's HELD collapse queue (D50). Collapse is
// container state, so when stacked panels' collapse axes conflict, the order
// they apply in decides the container's final state -- and a held queue must
// reproduce command order, not queue-bookkeeping order.

import { describe, expect, it } from "vitest";
import { orderCollapseDrain, type QueuedCollapse } from "./collapseDrain";

/** Queue entry shorthand; `userCommits` defaults to 0 (queued before any user
 * gesture). */
function q(
  panel: string,
  collapsed: boolean,
  counter: number,
  runId: string,
  seq: number,
  userCommits = 0,
): QueuedCollapse {
  return { tabIds: [panel], collapsed, counter, runId, seq, userCommits };
}

const panels = (out: QueuedCollapse[]) => out.map((c) => c.tabIds[0]);

describe("orderCollapseDrain", () => {
  it("sorts by the global counter within a run (D50)", () => {
    // The canonical divergence: "B.expand() then A.minimize()" must end with
    // A's minimize LAST regardless of queue order, so the shared column ends
    // collapsed exactly like a live client's.
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 2), q("B", false, 3, "run-s", 1)],
      0,
    );
    expect(panels(out)).toEqual(["B", "A"]);
    expect(out[out.length - 1].collapsed).toBe(true);
  });

  it("queue order does not override the counter", () => {
    // Same commands, opposite queue order (a split-anchored panel queues its
    // collapse a pass later than its neighbor): the result must not change.
    const out = orderCollapseDrain(
      [q("B", false, 3, "run-s", 9), q("A", true, 4, "run-s", 1)],
      0,
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
      0,
    );
    expect(panels(out)).toEqual(["B", "main"]);
    expect(out[out.length - 1].collapsed).toBe(false);
  });

  it("drops commands the user overtook while the queue was held", () => {
    // P6: a user gesture during the hold wins -- the immediate path would
    // have let it, so deferral must not resurrect the older server intent.
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 1, /* queued at */ 0)],
      /* user commits now */ 1,
    );
    expect(out).toEqual([]);
  });

  it("keeps commands queued after the user's last gesture", () => {
    const out = orderCollapseDrain([q("A", true, 4, "run-s", 1, 2)], 2);
    expect(panels(out)).toEqual(["A"]);
  });

  it("drops only the overtaken entries, keeping the rest in order", () => {
    const out = orderCollapseDrain(
      [q("A", true, 4, "run-s", 1, 0), q("B", false, 5, "run-s", 2, 3)],
      3,
    );
    expect(panels(out)).toEqual(["B"]);
  });
});
