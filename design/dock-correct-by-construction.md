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

## Remaining (recommended; each its own reviewed commit, ideally after the
current work is committed so there's a clean bisect checkpoint)

- **#3a WindowHeight tagged union.** Replace `FloatingWindow.height?: number`
  (overloads auto=undefined vs pinned=number -- the source of the pin-trap) with
  `{ mode: "auto" } | { mode: "pinned"; px: number }`. Makes the pin-trap and the
  `undefined`-ambiguity unrepresentable; "revert to auto when dragged to content"
  becomes the one named transition. Touch points (~10 production): FloatingWindowView
  render (`fixedHeight`/`renderedHeight`/FLIP baseline), `resizeWindowHeight`,
  `snapToWindowStack` height adoption, `applyPanelPlacement` size section,
  `cappedWindowHeight`, DockManager height reads; plus ~15 test assertions that
  read `win.height` as a number. No drag/hit-test coupling -> lower risk than #3b.

- **#3b FloatPlacement tagged union (the bigger one).** Replace `x/y` +
  `requestedX?/requestedY?` with `placement: { kind: "anchored"; anchorX; anchorY }
  | { kind: "user"; x; y }`. Makes "requested vs resolved drift" and "half-set
  ownership" unrepresentable: committing `{kind:"user"}` IS the release, so
  `markWindowUserOwned`/`releaseRequestedCoords` disappear and resize can't forget
  to release. Resolver branches on `kind`. Reaches into the gesture layer
  (grab-offset, left/top-grip resize read x/y) -- the most delicate, e2e-only
  code -- so it's the highest-churn item. Do it last, on its own.

- **Deferred / only-if-it-bites (from the studies, not part of #1-#3):**
  - Full render-time position resolution (drop stored x/y entirely): study judged
    the incremental win guards code that #3b already makes single-writer, at
    150+ lines of gesture-layer churn. Not worth it unless a post-#3b bug demands.
  - Move panel-placement sync from React effects to one out-of-React store
    subscription + a pure `reconcilePanel(layout, panel, record) -> layout`
    (study 3). High value for killing the dep-array fragility, but medium risk
    (control-panel width/theme/reset interplay). Extract the pure `reconcilePanel`
    + unit-test it first; do the subscription move only after that's stable.
