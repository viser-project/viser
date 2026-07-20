// Ordering rules for the placement coordinator's HELD collapse queue (D50).
// Pure, so the rules are testable without mounting a dock.

/** One queued collapse application, held until every position has converged. */
export interface QueuedCollapse {
  tabIds: string[];
  collapsed: boolean;
  /** The server's global command counter -- command order WITHIN a run. */
  counter: number;
  runId: string;
  /** Monotonic queue order, refreshed whenever an entry is replaced. */
  seq: number;
  /** api.getUserCommitCount when queued. */
  userCommits: number;
}

/** Order a held collapse queue for draining, dropping commands the user
 * overtook. Pure, so the ordering rules are testable without a dock:
 *
 * - A command queued before a user gesture is DEAD (P6: the user's
 *   arrangement stands until the server re-asserts by sending). The
 *   immediate path would have let the later user gesture win; deferral
 *   must not resurrect the older intent.
 * - Runs drain in the arrival order of their earliest still-queued command.
 *   Counters order commands only within a run, and Map insertion order is
 *   not arrival order (replacing a key keeps its original position).
 * - Within a run, the global counter is command order (D50).
 */
export function orderCollapseDrain(
  queued: QueuedCollapse[],
  userCommitsNow: number,
): QueuedCollapse[] {
  const live = queued.filter((c) => c.userCommits >= userCommitsNow);
  const byRun = new Map<string, QueuedCollapse[]>();
  for (const c of live) {
    const bucket = byRun.get(c.runId);
    if (bucket === undefined) byRun.set(c.runId, [c]);
    else bucket.push(c);
  }
  return [...byRun.values()]
    .sort(
      (a, b) =>
        Math.min(...a.map((c) => c.seq)) - Math.min(...b.map((c) => c.seq)),
    )
    .flatMap((bucket) => [...bucket].sort((a, b) => a.counter - b.counter));
}
