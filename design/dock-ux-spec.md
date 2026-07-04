# Dock UX specification

Status: DRAFT for iteration. This is the *normative* companion to
`dock-correct-by-construction.md` (which covers the model and invariants).
That doc says what states are representable; this one says how the dock must
FEEL — what every gesture does, what every drop means, and why. Where the
implementation disagrees with this document, one of them is wrong, and we
decide which on paper before touching code.

How to use it:

1. Iterate on this document until the principles and tables read as "yes,
   that's the product we want".
2. Cross-check phase: walk section 10's checklist against the implementation
   and the e2e suite; every mismatch becomes either a code fix or a spec
   amendment (with the reason recorded here).
3. New behavior questions get answered by the principles FIRST, then encoded
   in the tables. If the principles can't answer a question, the principles
   are incomplete — fix them, don't special-case.

---

## 1. First principles

**P1 — Honest hints.** During a drag, the hint shows *exactly* what the drop
will do: the insertion line sits where the panel's edge will land, a merge
highlight covers exactly the group being joined, and the affected extent
(one cell vs a whole band) is the extent drawn. A hint may never promise a
smaller or larger effect than the drop delivers. (This principle drove the
band-split fix: the cell-height line promised "beside this cell", so the op
was changed to deliver it — not the other way around.)

**P2 — One gesture grammar.** Everywhere in the dock:

- *press + move ≥ 3px* = move the thing under the grip;
- *press + release, motionless* = the surface's primary action (activate a
  tab, expand a minimized group, toggle a button);
- *Escape mid-drag* = "never mind": layout, sizes, and collapse states return
  to their pre-drag values;
- *Enter/Space on a focused element* = its motionless click.

No surface may bind these differently. A surface that can't support one of
them (e.g. nothing to drag) simply doesn't respond, it never reinterprets.

**P3 — Content is sacred, chrome is quiet.** Panels never move, resize, or
change collapse state except as the direct result of (a) a user gesture, (b)
an explicit server command, or (c) a structural necessity spelled out in this
doc (the adoption rules, §7). Minimized representations are *wayfinding
chrome*: dimmed labels, compact geometry, no content preview, no attention-
seeking styling. Active-tab highlighting exists only on expanded strips —
a minimized group has no "active" emphasis because nothing is shown.

**P4 — Deterministic, instant feedback.** No animations, no timers, no
settle states. Every gesture's effect is visible in the same frame it
commits. (Decided this session after the animation experiment: motion added
failure modes without adding comprehension.)

**P5 — No dead ends.** Every reachable state offers a visible way out:
a minimized group can always be expanded (click) and moved (drag); an
all-minimized region can still accept docks and be torn apart; a hidden
panel can be revived by the server. Corollary: every visible surface of a
draggable unit is a drag handle for *something* — there are no inert pixels
inside a panel's chrome.

**P6 — The user owns the layout; the server owns intent.** Placement is
write-only from the server (per-axis messages; the server never reads layout
back). A *new* server command always applies — `minimize()` always
minimizes, `dock_left()` always docks left. A *replayed/stale* command never
overrides what the user has touched since. The counter/run-id stamps exist
to make "new vs stale" decidable; there is no other arbitration.

**P7 — Symmetry and analogy.** Left/right are exact mirrors. Docked and
floating are analogs: a floating stack is a docked column that happens to
float; minimizing either produces the same visual language rotated to fit
(vertical rail ↔ horizontal bar). A user who learns one surface has learned
them all.

**P8 — Sizes are sticky.** A panel keeps its width and height across every
move, minimize/expand round-trip, float/dock round-trip, and reconnect,
until the user resizes it or space constraints force a clamp. Defaults
(300px width) appear only for panels that have never had a size.

**P9 — One signifier per action.** Every distinct action gets exactly one
visual signifier (icon/button) per view; an icon never appears twice for the
same action. Enlarging an action's *hit area* with unmarked surface is
encouraged — duplicating its *iconography* is forbidden (a repeated icon
reads as a different action and lies about granularity). Litmus test: if
uniform-collapse or any other invariant makes two controls equivalent, they
must merge into one signifier.

**P10 — Borders divide, they never enclose.** A 1px line may separate two
adjacent siblings (cells in a rail, segments in a bar, a strip from its
body, two stacked panels). A line may never OUTLINE a thing: no boxed
pills, no framed chips, no stroked panels. Enclosure is expressed by
surface contrast (body color vs the gray chrome color) and, for floating
surfaces, elevation (shadow) — never by drawing the boundary. Exemptions,
both state (not structure): the keyboard focus ring, and the accent
underline on an active tab. History: the bordered-pill minimized chips
violated this and read as clutter; the rail aesthetic that replaced them is
this principle applied. Corollary for theming: every divider and surface
color is a theme variable — light/dark parity is a requirement, and a
divider that disappears in one scheme is a bug.

**P11 — Minimum hit targets.** Every distinct drop zone is at least 8px in
its narrow dimension; every clickable control is at least 20px in each
dimension or backed by a larger unmarked hit surface. A zone that cannot
afford its minimum in context is REMOVED, not shrunk — a sub-minimum zone
is worse than none, because it converts intent into misfires. (D4 applied
this: the band bar's 6px zones were removed outright, the chip bar's
widened to 10px.)

**P12 — Granularity nests.** Interactive surfaces compose by containment:
the SMALLEST interactive unit under the pointer owns the press (label →
pane, cap → group, bar background → band, grip handle → window), and each
enclosing unit gets exactly the surface its children don't claim. New
surfaces inherit this arbitration instead of re-deriving it; a press must
never arm two levels at once.

**P13 — Minimize keeps the chrome.** A minimized panel is its expanded
chrome with the body removed: the grip surface stays — INCLUDING its
grip-bar gray, which is what bounds the bar against adjacent white panel
bodies (P10 enclosure-by-surface; a body-colored bar between two panels
reads as a stray label inside them) — the tab labels stay in place
(restyled to dimmed wayfinding), the width stays, the header's GRIP PILL
stays (the visible drag signifier — an unmarked drag surface is not kept
chrome), and the minimize/expand toggle stays in the SAME position — `−` at the top-right of
the expanded header becomes `+` at the right end of the minimized bar, so
the toggle is spatially stable and a mis-click is undone without moving the
mouse. Minimized bars are not a separate chrome language; they are headers.
One deliberate exception: the vertical rail (a lone minimized docked
column) exists to reclaim canvas WIDTH, which "keep the header in place"
cannot do — it stays the rotated form, `+` cap at the top (the analog of
the header's top edge).

**P14 — One structure per picture.** Two layouts that render identically
must be the same model value: the layout has a canonical form, enforced by
normalization at every structural commit (drops, docks, removals — not
pure weight changes, so a resize can never restructure mid-gesture).
Concretely: (a) full-width vertical stacking is expressed as BANDS — a
multi-leaf column may exist only when its band has sibling columns, i.e.
only where nesting is the only way to express the shape; (b) adjacent
bands with the same multi-column partition (equal widths within tolerance)
zip-merge into one band of stacked columns — one seam, one set of handles.
Redundant representations are where confusion lives: identical pictures
with different gestures are indistinguishable bugs.

### Non-goals (decided 2026-07-03)

- **Keyboard layout rearrangement.** The existing click-level keyboard
  parity stays (focusable targets, Enter/Space, arrow traversal, Escape,
  focus restoration after expand — it is built, tested, and cheap). But no
  keyboard path for dock/split/merge/reorder will be added: layout
  rearrangement is pointer-only by decision.
- **Undo after commit.** Escape aborts an in-flight gesture; once a drop
  commits there is no undo. Mitigation is prevention: the D1 zone rebalance
  makes destructive-by-accident drops (unwanted merges) hard to trigger.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Region** | The docked container on the `left` or `right` screen edge. Vertical stack of **bands**. |
| **Band** (row) | A full-region-width horizontal slice of a region. Holds ≥1 **columns** side by side. |
| **Column** | A vertical stack of ≥1 **cells** inside a band. Column widths divide the band. |
| **Cell** (leaf) | One tab **group** at a dock position. Cell heights divide the column. |
| **Group** | An ordered set of ≥1 panes (tabs) with one active tab, plus a collapsed flag. |
| **Floating window** | A free box holding a vertical **stack** of ≥1 groups. |
| **Rail** | A fully-minimized *lone* column/region: ~36px-wide vertical strip. |
| **Band bar** | A fully-minimized band among expanded sibling bands: 36px-tall full-width strip. |
| **Chip bar** | A fully-minimized floating window: 36px-tall fit-content strip of segments. |
| **Segment / chip** | One minimized group inside a band bar or chip bar. |
| **Area** | A nested dockable surface inside a panel body (flat tab group; no splits). |
| **Main panel** | The control panel; a normal group with a stable identity and the viser icon. |
| **Unmergeable panel** | A panel that may never become a tab of another group (and vice versa). It renders a full-width header instead of a tab strip; drops on it offer splits/snaps only, never merge/insert. |

---

## 3. Surface inventory

Every visual state a group can be in, its anatomy, and its affordances.
Anatomy is listed top-to-bottom / left-to-right.

### 3.1 Expanded docked cell
- Grip bar (gray, ~0.9em): drag = move group; holds the minimize (−) button.
- Tab strip: one tab per pane; wraps to multiple rows; empty strip area drags
  the group; active tab underlined in accent color.
- Body: panel content; scrolls internally; never a drag surface.
- The (−) button is drag-through: dragging it moves the panel (P5 — no inert
  pixels); motionless click minimizes.

### 3.1b Nested stack handle (coupled stacks only)
- A multi-leaf column (which, post-D12, exists only BESIDE sibling columns
  or via zip-merge) carries a slim column handle above its cells: drag
  floats the whole stack, its `−`/`+` toggles all members.
- Plain stacked BANDS deliberately have NO collective handle: they are
  independent panels (D12), and the handle's presence is the SIGNAL that a
  stack is coupled (uniform-collapse applies to it). `[A | B-over-C]`
  shows a handle on the B/C stack; `B-over-C` alone does not — that
  asymmetry is the coupling made visible, not an oversight.

### 3.2 Vertical rail (the P13 exception: reclaims width, not height)
- Per cell: gray cap — a `+` button when the cell is alone, a small grip pill
  when stacked; then one **spine row per tab** (upright icon above rotated
  title), dimmed. (Post-D12, stacked rail cells occur only for an
  all-minimized REGION; plain stacks are bands.)
- Signifier budget in a stacked rail (P9, learned from the real example):
  exactly ONE `+` — on the region rail's parent handle (expand-all). Cells
  show pills; expanding a single band is the spine ROW's click
  (expand-to-tab), which needs no icon. Three `+`s in a 36px strip read as
  three different mysteries.
- Hairline divider between cells.
- Clicking a spine row expands the column *to that tab*. Clicking the `+`
  expands in place. Dragging any row tears out just that pane (still
  minimized); dragging the cap moves the whole group.
- The rail preserves the column's expanded width for its return (P8).

### 3.3 Band bar (minimized band among expanded bands)
- One segment per group, tiling the full width edge-to-edge; hairline
  dividers between segments.
- Segment anatomy (P13) = the group's HEADER kept in place: a small grip
  pill on the leading edge (the drag signifier), then dimmed icon+title
  **label per tab** (D9) laid out from the left — literal
  cousins of the expanded tab strip — and the `+` toggle at the segment's
  RIGHT end, exactly where the expanded grip bar's `−` sat. No leading
  caps. Labels are separated by spacing, not outlines (P10); when width
  runs out, labels degrade to `ActiveTitle +N`.
- `+` click expands that group (a DISTINCT action, P9-legal: siblings stay
  minimized beside it). Label click expands to THAT tab; label drag tears
  that pane out, still minimized (per-tab tear-out exists on every
  minimized surface, D5). Segment background drag moves the whole group.
- Bar background (area not covered by segments): motionless click expands
  the whole band; drag moves the WHOLE BAND as one unit (D2) — re-dock as a
  band elsewhere, or float as one stack.

### 3.4 Chip bar (fully-minimized floating window)
- The bar IS the window's header row kept in place (P13): full `win.width`
  wide (no fit-content jump — the width is part of the window's identity,
  P8), a leading grip pill (the window-drag signifier), group label runs
  laid out from the left with hairline dividers between groups, and ONE
  `+` toggle at the bar's right end — where the expanded header's `−` sat.
- Uniform-collapse (§7) makes per-group expand IMPOSSIBLE in a floating
  stack: any expand expands the whole window. Therefore (P9) the single
  right-end `+` is the expand signifier for the whole bar; group segments
  carry no toggles at all.
- Labels behave as in §3.3: label click expands (the whole window —
  uniform-collapse — landing on that tab); label drag tears that pane out,
  still minimized. Bar background (including the slack right of the labels)
  drags the whole window; a motionless background click expands all.

### 3.5 Expanded floating window
- Multi-group: stack handle bar on top (drag = move window; (−) toggles all).
- Each group renders as §3.1 without the docked context.
- Edge grips resize width; bottom grip resizes height (pin), with a detent
  that snaps back to auto-height at the content height.

### 3.6 Floating z-order and multi-client
- Any press anywhere on a floating window raises it to the front (capture
  phase; does not consume the press). Front order is paint order only —
  raising never reorders the DOM (in-flight clicks survive).
- Overlapping windows resolve drops back-to-front: the topmost target under
  the pointer wins.
- Multi-client: layout is per-client state; server placement commands fan
  out to every client and each client's gate arbitrates against its own
  user's touches (P6). Clients never sync layouts with each other.

### 3.7 Nested area
- A flat tab strip + body inside a host panel. Drops: insert-at-tab-position
  over the strip, merge elsewhere. Never splits, never minimizes separately.
- A frame of the host panel around the area stays hot for the HOST's zones,
  so a full-bleed area doesn't make the host undockable-beside (P5).

---

## 4. Gesture reference

Threshold: a press becomes a drag at ≥3px of motion; below that, release is
a click. One active gesture at a time; extra pointers are ignored.

| Grabbed surface | Drag moves | Motionless click |
|---|---|---|
| Grip bar / strip background (expanded) | that group | — |
| (−) minimize button | that group (drag-through) | minimize group |
| Tab | that pane (tear out / reorder) | activate tab |
| Stack handle bar (floating multi) | whole window | toggle all collapse |
| Rail cell cap (`+` / pill) | whole group (still minimized) | expand (lone cell only) |
| Rail spine row | that pane (still minimized) | expand to that tab |
| Band-bar segment `+` (right end) | that group (drag-through) | expand that group |
| Segment tab label (band/chip bar) | that pane (still minimized) | expand to that tab (chip bar: expands whole window, lands on that tab) |
| Band-bar segment background | that group (still minimized) | expand that group |
| Chip-bar `+` (bar's right end) | whole window (drag-through) | expand all |
| Chip-bar bar background | whole window | expand all |
| Band-bar background | whole band (as one stack) | expand whole band |
| Region resize divider | region width | — |
| Split divider | neighboring cells/columns | — |
| Window edge/bottom grips | window size | — |

Escape during any of the above restores the exact pre-gesture layout,
including region widths and collapse states. Escape after an expand-on-drag
restores the minimized state.

Keyboard: every click target above is focusable (visible focus ring), with
Enter/Space = its motionless click. Tab strips and rails are `tablist`s with
arrow-key traversal (Left/Right on strips, Up/Down on rails). After a
keyboard-driven expand, focus lands on the expanded strip's tab — never on
`<body>`.

Touch: all drag surfaces set `touch-action: none`; a browser-cancelled
pointer aborts like Escape (P2).

---

## 5. Drop system

### 5.1 Zone taxonomy, outermost to innermost

Priority is resolution order: the first zone that matches the pointer wins.
Pixel values are the intended geometry; they are constants in `hitTest.ts`
and changing one is a spec change.

1. **Empty screen edge** (48px at a screen edge with no region): dock as the
   region's first content, full height. Active even past the screen edge
   (slam gestures).
2. **Insertable tab strip** override: a pointer over a strip where a tab
   insert would resolve always beats region-level bands (specific intent
   beats broad intent).
3. **Region edge bands** (occupied edge): 8px top/bottom = full-span band
   above/below everything; 40px outer/inner side = full-height column beside
   everything — for a canonical stack (all bands single-column) the op ZIPS
   the bands into one nested column so "beside everything" is literal; a
   region containing a multi-column band cannot be zipped (rows can't
   nest), so the drop joins the first band and the hint spans only that
   band. Suppressed where they'd duplicate a per-cell split (single leaf
   edge-wise). Hints span the true affected extent either way (P1).
   A seam band-insert takes an EQUAL SHARE of the region height (the mean
   of the existing bands' weights) — never a fixed weight that a px-scale
   region would render as a 0px sliver.
4. **Cross-band seams**: the divider between two bands inserts a new
   full-width band at that index.
5. **Per-target zones** (§5.2–5.4).
6. Anywhere else: no drop; release floats the dragged stack at the pointer.

### 5.2 Expanded docked cell zones
- Above the strip (grip bar): split above this cell.
- Over the strip: insert at that tab position (2D nearest-tab, works with
  wrapped rows).
- Content side bands (30% of width, ≤120px): split left/right of this cell.
  If the cell's column is the band's only column, the drop *band-splits* so
  the new panel sits beside just this cell; otherwise the new column spans
  the band and the hint is drawn band-tall (P1).
- Content top/bottom bands (25%, ≤100px): split above/below this cell.
- Content center — roughly the middle third each way — merges (become a
  tab). Splits are the easy default; merging requires clearer aim (D1).
  Suppressed for unmergeable panels.

### 5.3 Minimized rail cell zones (rotated §5.2)
- 8px outer/inner side slivers: dock a column beside.
- 6px top/bottom edges: stack a cell above/below (docked) or snap (floating).
- Over a spine row: insert at that tab position.
- Rest (the cap): merge, staying minimized.

### 5.4 Segments (band bar / chip bar)
- A segment's whole slot (full bar height) is a drop target; drop = merge
  into that group, staying minimized. Insertion at a tab position aims at
  the per-tab labels (D9), mirroring rail rows.
- Band bar slots have NO per-segment top/bottom zones (D4): the band seams
  and region-edge bands immediately adjacent already express "insert a band
  above/below", and 6px zones inside a 36px bar were unhittable.
- Chip bar slots keep top/bottom snap zones at ~10px (D4): no alternative
  affordance exists for snapping into a minimized window's stack.

### 5.5 Hints and previews
- **Line** = an insertion boundary (3px bar), drawn at the true landing
  edge, spanning the true affected extent.
- **Merge highlight** = the whole group being joined.
- **Fill** = a translucent block for empty-edge docks (there is no boundary
  to point at).
- Top/bottom splits additionally shrink the target cell live to vacate the
  space (contents scroll; no distortion). Left/right splits show only the
  line — widths don't change until drop. Collapsed targets never shrink.
- Drop targets are snapshotted at drag start and refreshed on any layout
  change, container scroll, or window resize; hints therefore never lag the
  visible geometry.

### 5.6 Adoption rules (collapse infection)
- Dropping a stack as a NEW cell beside / snap-adjacent to an all-minimized
  neighbor minimizes the dropped stack too (a minimized container stays
  uniformly minimized; P3's "structural necessity").
- Merging INTO a group inherits that group's collapsed flag (dropping into a
  minimized group never expands it).
- Everything else keeps the dragged stack's current collapse state.

---

## 6. Sizing model

- **Region width**: expanded columns of the width-determining band carry
  pixel widths; the region's width is their sum. Docking a new column
  *grows* the region by the newcomer's width — DECIDED (D3): existing
  panels never shrink because something arrived (P3 outranks canvas
  preservation; the resizer is the recovery). Applies to per-cell splits
  and region-edge docks alike.
- **Minimums**: expanded columns ≥ ~120px grab minimum; cells ≥ ~50px;
  windows ≥ 100px height. Resizes clamp; they never squeeze a cell below
  its header.
- **Round-trips** (P8): float→dock carries the stack's height ratios into
  the column; dock→float restores the remembered window size; minimize→
  expand restores the pre-minimize width (rail reserves 36px, remembers the
  rest); reconnects replay the same sizes.
- **Windows**: auto-height tracks content up to the container; pinned height
  is user-set via the bottom grip; the content-height detent un-pins.
  A fully-minimized window ignores pinned height (nothing to size).

---

## 7. Minimize / expand semantics

- Collapse is per-GROUP, but any stack of ≥2 groups (docked column, floating
  stack) is **uniform**: mixed states normalize to all-expanded at the next
  commit. Rationale: a half-minimized stack has no coherent geometry, and
  "expand" is the safe direction (nothing hides).
- The visible asymmetry between the two horizontal bars follows from this
  and is NOT a P7 violation: a band bar's segments are groups in separate
  COLUMNS (independent stacks — expanding one leaves siblings minimized),
  while a chip bar's segments share ONE window stack (uniform — expanding
  any expands all). The chip bar's structural analog is the RAIL (also one
  stack, with the same expand-all behavior), not the band bar it visually
  resembles. Same rule, different structures; do not "fix" the asymmetry.
- Canonical form (P14/D12) makes this bite rarely in docked regions: plain
  full-width stacks are BANDS, which minimize independently (per-band band
  bars). Docked uniform-collapse coupling survives only inside zip-merged
  grids (D13) and nested columns-with-siblings — where minimizing the BAND
  is the natural unit anyway.
- A lone minimized column renders as the rail; a minimized band with
  expanded siblings renders as the band bar; a fully-minimized floating
  window renders as the chip bar. There is no fourth form.
- Expand targets: rail spine-row click expands *to that tab* (in a stacked
  rail, uniform-collapse expands the whole column either way — the rows'
  REAL difference is which tab becomes active, and the spec accepts that
  subtlety); band-bar segment click expands that group with its previous
  active tab; chip-bar clicks expand the whole window; parent handles expand
  everything they own.
- Tearing a pane out of a minimized group floats it STILL minimized
  (expanding is exclusively a click; drags never change collapse — P2).
- An all-minimized region reserves exactly 36px; it is still a full drop
  target and still hosts region-edge docking on its outer side.

---

## 8. Server placement semantics

- Four independent write-only axes per panel: position, width, height,
  collapsed. A message carries exactly one axis; applying one axis can never
  disturb another (no yank by construction).
- Fresh vs stale: each panel has a monotonically increasing layout counter
  per server run. An arriving axis message applies iff the user hasn't
  touched that panel since the message's stamp (gate open), or the stamp is
  provably newer than the last applied one. Late joiners replay the latest
  message per axis and reconstruct the same placement.
- Split placements (`dock_below(anchor)` etc.) defer until the anchor is
  actually docked; if the anchor can never dock (hidden, emptied, cyclic),
  the placement falls back to a right-edge dock rather than hanging (P5).
- `visible = False` removes the panel from the dock without destroying it;
  `True` re-places it via its stored placement axes.

---

## 9. Edge-case catalog

Behaviors that MUST hold (each is or should be pinned by a test):

1. Drop on a minimized group merges *without expanding it*.
2. Escape after expand-on-drag restores the minimized state.
3. Dragging a (−)/(+) button never toggles; a motionless click never moves.
4. A viewport resize between press and drag-threshold doesn't teleport the
   window (grab offsets resolve against the current model position).
5. Undocking a minimized panel then expanding restores its docked width, not
   the 36px strip width.
6. A pinned-height window expands from minimized at its pinned height.
7. The last panel leaving an edge nulls the region; the next dock recreates
   it at the remembered width.
8. An emptied-then-revived docked panel reappears (no orphan group).
9. Same-batch and reversed-order anchor splits both resolve (no race, no
   hang); never-dockable anchors fall back.
10. Wheel-scrolling a tall rail mid-drag doesn't desync drop targets.
11. A drop into a wrapped tab strip's second row lands at that row's index.
12. All-minimized multi-band regions render as stacked bars, not 36×36
    squares.
13. Region-edge docking beside an all-minimized region stays reachable from
    the outer half of the strip.
14. Chip/segment keyboard expand moves focus onto the revealed strip.
15. Left/right mirrored layouts resolve mirrored drops everywhere (swept).

---

## 10. Cross-check protocol (phase 2)

For each table row and catalog item above: find the implementing code and
the pinning test; record `OK` / `DIFFERS (code)` / `DIFFERS (spec)` /
`UNTESTED`. Differences get resolved in review — the record of "spec
changed because X" lives in this file's history. The suites: `hitTest*`
(zones, sweep, mirror), `layoutOps*` (ops, fuzz, lifecycle),
`panelPlacement` (gating), `tests/e2e/test_dock_playground_*` (gestures),
`tests/e2e/test_panels.py` (server round-trips).

**Cross-check record — 2026-07-03 (post D1–D9 implementation):** four
independent audits walked §3+§4 (104 claims), §5 (33), §6+§7+§9 (18+15
catalog items), and §8 (12). Verdict: **0 DIFFERS** in either direction.
Alleged coverage gaps were re-verified by hand: the anchor-cycle fallback,
region-edge-beside-minimized, wrapped-row insertion, and the D4 zone split
all had existing pins the auditors missed; the one REAL gap — edge case 10
(mid-drag rect movement without a layout change) — is now pinned by
`test_viewport_resize_mid_drag_keeps_drop_targets_fresh`, which exercises
the shared staleness flag via its resize trigger.

**Update (2026-07-03, end of day):** D10–D13 are now IMPLEMENTED and
verified (452 unit tests incl. the canonicalizer suite; full e2e battery
green with seven pins rewritten to the decided behavior; CI 23/23). The
spec and implementation are aligned again. Remaining documentation debt:
the gap sections listed in review — off-screen window recovery, overflow
rules, reorder-vs-tear boundary, persistence statement, degraded/empty
states, small viewports.

---

## 11. Resolved decisions (2026-07-03)

Former open questions, decided with the maintainer. Normative sections above
already reflect them; this list preserves the rationale.

- **D1 (merge zone):** grow the per-cell split bands (30% sides ≤120px, 25%
  top/bottom ≤100px) so center-merge is roughly the middle third. Splits
  are the casual-drop default; merging requires aim. No dwell timers (P4).
- **D2 (band-bar background drag):** drags the WHOLE band as one stack;
  motionless click still expands all. Segments remain per-group/per-tab
  handles. (Replaces the old first-column drag.)
- **D3 (region growth):** side-docking always GROWS the region by the
  newcomer's width. Existing panels never shrink because something arrived;
  the canvas cost is accepted and the resizer is the recovery.
- **D4 (thin zones):** band-bar segments lose their 6px top/bottom zones
  (seams next door cover the intent); chip-bar segments keep snap zones,
  widened to ~10px.
- **D5 (tear-out granularity):** resolved by D9 — per-tab labels give
  per-tab tear-out on every minimized surface.
- **D6 (minimize gesture):** the (−) button stays the only minimize
  affordance. Double-click rejected: it would extend the P2 grammar
  globally for one shortcut.
- **D7 (release over nothing):** always float at the pointer. Motion means
  move; Escape is the abort.
- **D8 (main panel):** fully ordinary — merges, stacks, minimizes like any
  group. Its specialness is identity + icon only.
- **D9 (segment anatomy):** one label per tab inside band/chip-bar
  segments (rail analog; click = expand to tab, drag = tear pane out),
  degrading to `ActiveTitle +N` when width runs out. *Partially superseded
  by D10: the labels stay; the leading `+` caps are replaced by
  right-end toggles.*
- **D10 (minimize keeps the chrome — P13 adopted):** minimized bars are
  the expanded header kept in place: labels left, one `+` toggle at the
  RIGHT where the `−` was (spatially stable toggle), width unchanged
  (floating bars keep `win.width` — no fit-content jump). The rail is the
  documented exception (reclaims width; `+` cap on top). Fixes the
  multi-stack bar's missing expand signifier.
- **D11 (keep the 4-level model):** single-group columns were considered
  and REJECTED: they would make any vertical stacking narrower than the
  region unrepresentable — including "dock below just A beside B", a
  working, common operation — and would break floating stacks' side-
  docking. Confusion is addressed by canonical form (D12/D13) instead of
  by amputation.
- **D12 (canonical form: bands for full-width stacks):** a multi-leaf
  column may exist only when its band has sibling columns. Lone multi-leaf
  columns normalize into consecutive bands (heights preserved) at every
  structural commit. Plain docked stacks thereby gain independent
  per-panel minimize (band bars) — docked uniform-collapse coupling no
  longer applies to them.
- **D13 (zip-merge aligned neighbors):** adjacent bands with the same
  multi-column partition (equal widths within ~2px) merge by zipping
  corresponding columns — one seam, one set of handles, no double chrome
  for a 2×2 grid. Runs on structural commits ONLY (never during pure
  weight changes, so a resize cannot restructure mid-gesture). Accepted
  consequence: zipped columns are stacks — shared seam, band-level
  minimize (per-cell minimize inside a zipped grid is not offered; the
  future relaxation would be mixed-collapse docked columns rendering a
  36px strip cell).
