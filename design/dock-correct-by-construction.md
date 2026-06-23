# Dock layout: correct-by-construction program

Status: in progress. From a multi-agent architecture study of the recurring
bug classes this session uncovered (duplicate panes, stale anchors, height
pin-trap, scattered-tab gather, the requestedX/Y re-resolve dance, the
three-effect `visible` coordination). The goal is to make those bug *classes*
unrepresentable / caught-at-commit, not just fixed case by case.

The studies' consistent verdict: the leverage is in a few targeted structural
changes plus a verification net -- NOT big renormalizations. Two options were
explicitly rejected: a normalized `paneLocation` index (moves the invariant into
an order+index pair that can still desync; triples serialization surface; tab
order is load-bearing so duplicates still aren't truly unrepresentable) and a
client-side command-log/seq-cursor (the wire is already a coalesced last-write-
wins snapshot, so a log would re-derive what the server already collapsed).

## Done

- **#1 Invariant checker in production + dev assert.** Extracted the fuzz test's
  `invariantViolations` into `dock/layoutInvariants.ts` (made area-aware: area
  groups are referenced via `areas`, so they must not be flagged as orphans --
  the one real difference from the fuzz original). `applyOp` asserts it on every
  commit under `import.meta.env.DEV` (console.error, not throw -- a bad commit
  shouldn't brick the UI). The fuzz suite imports the same function, so the app
  and the fuzzer agree on "what valid means." Unit-tested in
  `layoutInvariants.test.ts`. This catches the duplicate/orphan/double-reference
  classes the instant a gesture or op produces them.

- **#2 `movePaneInPlace` primitive (detach-first).** Added the missing
  pane-level analog of `detachInPlace` (the group-level choke point): detach the
  pane from wherever it lives, THEN insert into the destination, so a pane can
  never end up in two groups. `ensurePanelGroup`'s gather now moves stranger
  panes back via this primitive (replacing the ad-hoc detach loop from the
  drag-out-then-place fix). Validated by the fuzz suite + the re-gather op test.

- **Test factory (enabler).** Tests constructed FloatingWindow as ~100 raw
  literals, coupling the model to test literals -- the real reason union refactors
  were "expensive." Added `floatingWindow()` in testUtils as the one constructor;
  routed makeLayout/floatingLayout through it; migrated every literal. After this,
  #3a touched ZERO factory-routed literals (only ~4 stragglers + the assertions
  that genuinely changed contract). Proves the model is now cheap to evolve.

- **#3a WindowHeight tagged union (DONE).** `FloatingWindow.height` is now
  `{ mode: "auto" } | { mode: "pinned"; px: number }` (was `height?: number`).
  Pin-trap + sentinel-undefined ambiguity unrepresentable; "revert to auto" is the
  one named transition. The factory translates the terse `height?: number` test
  opt, so call sites stayed terse; production reads branch on `.mode`. Verified:
  403 vitest, 29 e2e, pin-trap re-confirmed end-to-end.

- **#3b float ownership as one `anchor` object (DONE -- lighter form).**
  Replaced the `requestedX?`/`requestedY?` PAIR with a single `anchor?: {x; y}`.
  PRESENCE is the ownership tag (anchored = re-resolves; absent = user-owned at
  its absolute x/y). Collapsing the pair into one object makes "half-set
  ownership" unrepresentable -- the exact hazard the study flagged (a resize that
  set one coord but not the other). `markWindowUserOwned` is now a single
  `delete win.anchor`. Stored absolute `x/y` are KEPT (hit-test/drag/render read
  them unchanged), so this deliberately stops short of the full
  `{kind:"anchored"}|{kind:"user"}` union with no stored x/y -- per the study,
  that fuller union's extra win guards code the single-resolver already makes
  single-writer, at 150+ lines of gesture-layer churn. The lighter form captures
  the correctness win without touching the delicate grab-offset/grip code.
  E2E seam: the Python `window()` helper in dock_helpers.py is the one place test
  layouts build floating windows -- updated it for the WindowHeight union too.

- **Deferred / only-if-it-bites (from the studies):**
  - Full `placement` tagged union (drop stored x/y; resolve at render): study
    judged the incremental win guards code the single resolver already makes
    single-writer, at 150+ lines of gesture-layer churn. Not worth it unless a
    concrete drift bug demands it.
  - Move panel-placement sync from React effects to one out-of-React store
    subscription + a pure `reconcilePanel(layout, panel, record) -> layout`
    (study 3). High value for killing the dep-array fragility, but medium risk
    (control-panel width/theme/reset interplay). Extract the pure `reconcilePanel`
    + unit-test it first; do the subscription move only after that's stable.
