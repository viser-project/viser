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

- **Hardening pass (July 2026).** A second round applied the same program to
  the layers above the model:
  - *Types*: flavored (weakly-branded) `PaneId`/`GroupId`/`WindowId`/`NodeId`/
    `AreaId` (the five id kinds are mutually unassignable; strings still flow
    in from wire/DOM/tests); `TabGroup.activeId: PaneId | null` retiring the
    `""` sentinel end to end; `makeGroup(NonEmpty<PaneId>)`;
    `mapNonEmpty`/`withInserted` replacing scattered `as NonEmpty` casts;
    exhaustive `DropResult`/position dispatches; `areas` no longer duplicate
    their key (invariant #13 retired -- unrepresentable).
  - *Single construction sites*: `planRegion` builds its parallel fields at
    ONE site; `patchFloatPositions` is the one sanctioned commit bypass and
    its patch type (`(w) => {x, y} | null`) makes the position-only claim
    hold by construction; `detachAllPreservingStackWeights` makes the
    capture-before-detach ordering unviolatable; `api.replace()` is the one
    wholesale-injection entry (seeds the fresh-id floor).
  - *Placement protocol*: per-axis `(counter, runId)` stamps + a single
    per-axis gate (`placementGate.ts`) shared by the main panel and
    standalone panels -- a `set_width` structurally cannot re-apply a stale
    dock position. Split placements DEFER on their anchor via a synchronous
    store predicate (`anchorDockPending`), with a timeout only as a
    stale-state tripwire.
  - *Verification net*: the invariant checker now also runs in production
    (time-throttled, warn-budgeted); dev checks every commit.

## Roadmap (next structural steps, in order)

1. **Server-provided stable panel key** (`add_panel(key=...)`, optional wire
   field): identity becomes an input instead of the label+order inference in
   `panelIdentity.ts`, capping its twin-panel re-bucketing edge case.
2. **Column weights are always px**: today `DockColumn.weight` decodes three
   ways (px in a multi-column widthRow; ignored for a lone column, whose px
   lives in `regionWidth`; flex share elsewhere). Normalizing every band's
   weights to rendered px on each commit retires the `prevPxOf` estimate and
   `dockedFloatWidth`'s magnitude heuristic, and deletes the stale
   height-weight caveats.
3. **Placement coordinator**: one ordered pass over the placement store
   applying per-panel reconciliation (the "study 3" item below), replacing
   the per-panel effect fan-out that has to re-derive stream ordering.

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
