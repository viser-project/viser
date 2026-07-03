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

### 3.2 Vertical rail (lone minimized column)
- Per cell: gray cap — a `+` button when the cell is alone, a small grip pill
  when stacked (the parent rail owns expand-all); then one **spine row per
  tab** (upright icon above rotated title), dimmed.
- Hairline divider between cells.
- Clicking a spine row expands the column *to that tab*. Clicking the `+`
  expands in place. Dragging any row tears out just that pane (still
  minimized); dragging the cap moves the whole group.
- The rail preserves the column's expanded width for its return (P8).

### 3.3 Band bar (minimized band among expanded bands)
- One segment per group, tiling the full width edge-to-edge; hairline
  dividers between segments.
- Segment anatomy = rail cell rotated 90°: gray `+` cap on the leading edge,
  then dimmed icon+title of the active tab.
- Segment click expands that group; segment drag moves that group. Each
  segment's `+` is a DISTINCT action (P9-legal): expanding one group leaves
  its siblings minimized as narrow rail columns beside it (each group sits
  in its own column, so uniform-collapse does not couple them).
- Bar area not covered by a segment's visuals (segments are content-sized
  inside full-width slots): motionless click expands the whole band; drag
  moves ~the band~ → **OPEN QUESTION Q2** (today: drags the *first column*).

### 3.4 Chip bar (fully-minimized floating window)
- Multi-group: leading grip segment (whole-window handle) + one segment per
  group with dividers. Single-group: just the one segment (the group IS the
  window).
- Uniform-collapse (§7) makes per-group expand IMPOSSIBLE in a floating
  stack: any expand expands the whole window. Therefore (P9) the expand
  signifier lives on the window-level handle ONLY — multi-group chips carry
  NO `+` glyph. Chips remain fully clickable (hit area for the same expand)
  and draggable (tear their group out, still minimized). A single-group
  bar's one chip keeps its `+`: there the chip IS the window and the action
  is singular.
- The bar is fit-content wide; the window's expanded width is preserved in
  the model for its return (P8).

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
| Band-bar segment | that group (still minimized) | expand that group (siblings stay minimized) |
| Chip-bar segment | that group (still minimized) | expand the whole window (uniform-collapse; no `+` glyph on multi-group chips, P9) |
| Chip-bar grip segment | whole window | expand all |
| Band-bar background | see Q2 | expand whole band |
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
   everything. Suppressed where they'd duplicate a per-cell split (single
   leaf edge-wise). Hints span the full affected extent (P1).
4. **Cross-band seams**: the divider between two bands inserts a new
   full-width band at that index.
5. **Per-target zones** (§5.2–5.4).
6. Anywhere else: no drop; release floats the dragged stack at the pointer.

### 5.2 Expanded docked cell zones
- Above the strip (grip bar): split above this cell.
- Over the strip: insert at that tab position (2D nearest-tab, works with
  wrapped rows).
- Content side bands (22% of width, ≤70px): split left/right of this cell.
  If the cell's column is the band's only column, the drop *band-splits* so
  the new panel sits beside just this cell; otherwise the new column spans
  the band and the hint is drawn band-tall (P1).
- Content top/bottom bands (15%, ≤70px): split above/below this cell.
- Content center: merge (become a tab). Suppressed for unmergeable panels.

### 5.3 Minimized rail cell zones (rotated §5.2)
- 8px outer/inner side slivers: dock a column beside.
- 6px top/bottom edges: stack a cell above/below (docked) or snap (floating).
- Over a spine row: insert at that tab position.
- Rest (the cap): merge, staying minimized.

### 5.4 Segments (band bar / chip bar)
- A segment is one visual unit: its whole slot (full bar height) is a drop
  target; drop = merge into that group, staying minimized. No positional
  insert (there are no per-tab rows to aim at).
- Thin edge bands on the slot: band bar → split above/below the band; chip
  bar → snap into the window's stack above/below that group.

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
  *grows* the region by the newcomer's width (existing panels never shrink
  because something arrived — P3); the region resizer then redistributes.
  → **OPEN QUESTION Q3** on growth vs share-in-place.
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
changed because X" lives in this file's history. The existing suites to map
against: `hitTest*.test.ts` (zones, sweep, mirror), `layoutOps*.test.ts`
(ops, fuzz, lifecycle), `panelPlacement.test.ts` (gating),
`tests/e2e/test_dock_playground_*` (gestures), `tests/e2e/test_panels.py`
(server round-trips).

---

## 11. Open questions — the "rough" list

Positions proposed; each needs a decision, then a spec edit + cross-check.

**Q1 — Merge is too easy.** The entire content center of an expanded cell is
a merge zone. Users aiming for "put it near here" get tab-merged panels they
then have to tear apart. *Proposal:* keep merge on center but shrink it —
grow the four split bands from 22%/15% toward a Windows-style layout where
center-merge is roughly the middle ninth; alternatively require a brief
hover (dwell) before the merge zone arms. Leaning: bigger split bands, no
dwell (dwell violates P4).

**Q2 — Band-bar background drag target.** Today a drag from the bar's
background moves the band's *first column* — surprising when the bar has 3
segments and you grabbed the far right. *Proposal:* background drag moves
the WHOLE band (there's a band-level op already: bandInsert); segment drags
remain per-group. Click-to-expand-all stays.

**Q3 — Region growth on side-drop.** Docking a 300px panel beside a 300px
region makes a 600px region — half the canvas vanishes in one drop.
*Proposal:* per-cell/side splits SHARE the existing region width (newcomer
takes half the target column's width, clamped to minimums); only explicit
region-edge docks (the 40px outer bands, the empty-edge zone) grow the
region. This matches VS Code and keeps P3 (canvas is content too).

**Q4 — 6px snap bands on chips.** The top/bottom snap/split bands on
minimized segments are 6px — nearly unhittable, and the band bar already has
band-level seams nearby. *Proposal:* drop the per-segment top/bottom bands
in band bars (seams + region bands cover the intent); keep them at 8–10px on
chip bars where no alternative exists.

**Q5 — Tear-out granularity from segments.** A chip drag moves the whole
group; per-tab tear-out exists only on rail rows. Is a multi-tab group
minimized into a chip a dead end for extracting one tab? Currently: expand
first, then tear. *Proposal:* accept (expanding is one click; per-tab
affordances on a 24px chip would be noise) — but the spec should say so
explicitly.

**Q6 — Discoverability of minimize.** Expanded panels minimize via a small
(−) button; minimized ones expand via whole-surface click. Asymmetric.
*Proposal:* accept the asymmetry (a whole-surface "minimize" on an expanded
panel is impossible), but consider double-click-on-grip-bar as minimize
toggle, mirroring double-click-to-restore conventions. Needs a decision.

**Q7 — Where do torn-out panels land by default?** Release over "nothing"
floats the stack at the pointer. Should releasing within N px of the
original position instead snap back (treat as aborted)? Today: it floats.
Leaning: keep floating (P2: motion means move), but worth confirming.

**Q8 — Main panel specialness.** The main panel currently behaves like any
panel plus a stable key and icon. Should it resist merging (stay its own
group), or being minimized-by-adoption? Today it participates fully.
Needs a product decision.

**Q9 — Hidden tab labels in segments.** A multi-tab group minimized into a
band bar or chip bar shows only its ACTIVE tab's label; the other tabs are
invisible and undiscoverable until expand (the rail, by contrast, lists
every tab). Violates the spirit of P7 (the bars claim to be "the rail
rotated"). Options: (A) one label per tab inside each segment — the true
rail analog; label click expands to that tab, label drag tears that pane
out (also resolves Q5); (B) active label + count badge ("Controls +1");
(C) joined titles with ellipsis. *Recommendation: A*, with B's badge as the
overflow degradation when the bar runs out of width.
