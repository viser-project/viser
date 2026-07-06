# Dock UX specification

Status: DRAFT for iteration. This is the *normative* companion to
`dock-correct-by-construction.md` (which covers the model and invariants).
That doc says what states are representable; this one says how the dock must
FEEL — what every gesture does, what every drop means, and why. Where the
implementation disagrees with this document, one of them is wrong, and we
decide which on paper before touching code.

The system in one paragraph: panels dock into a four-level tree on the
left or right screen edge — a **region** stacks **bands**, a band holds
**columns** side by side, a column stacks **cells**, and each cell is one
tab **group** — or they float as windows, each a vertical stack of the
same cells. A cell minimizes IN PLACE to a 26px **bar**. Separately, an
explicit collapse packs a whole region, or one column of a multi-column
band, into a 36px vertical **rail**. §2 defines every term.

Reading map: §1–§9 are normative (principles, vocabulary, surfaces,
gestures, drops, sizing, minimize/expand, server placement, edge cases).
§10 is the cross-check protocol and its audit record. §11 is the decision
history behind the normative text; D-numbers cite it.

How to use it:

1. Iterate on this document until the principles and tables read as "yes,
   that's the product we want".
2. Cross-check phase: walk §10's checklist against the implementation
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
an explicit server command (position/size only — there is no server collapse
command, D31), or (c) a structural necessity spelled out in this
doc (§7). Minimized forms are *wayfinding chrome*: dimmed labels, compact
geometry, no content preview, no attention-seeking styling. Active-tab
highlighting exists only on expanded tab strips — a minimized group has no
"active" emphasis because nothing is shown.

**P4 — Deterministic core; motion is pure presentation.** The MODEL
commits instantly: no timers, no settle states, no logic gated on an
animation finishing. Every gesture's effect is in the layout the same
frame it commits. Minimize/expand MAY animate, but only as presentation:
a single CSS transition (`collapseAnim`, 160ms) eases the cell/band
wrappers' flex properties between committed values. The transition
honors prefers-reduced-motion (instant) and is suppressed under an
active divider drag (`[data-dock-resizing]`), where per-frame weight
writes must not ease-lag the cursor. Drag hit-testing re-reads geometry
on `transitionend`, filtered to the eased flex properties so unrelated
hover-color transitions don't thrash the cache; cached rects therefore
never lag the visible surface. Rail collapse stays instant. History: the
first animation experiment was reverted because motion was entangled
with logic; this split keeps the determinism while restoring the
comprehension cue of continuous size change.

**P5 — No dead ends.** Every reachable state offers a visible way out:
a minimized group can always be expanded (click) and moved (drag); an
all-minimized region can still accept docks and be torn apart; a hidden
panel can be revived by the server. Corollary: every visible surface of a
draggable unit is a drag handle for *something* — there are no inert pixels
inside a panel's chrome.

**P6 — The user owns the layout; the server owns intent.** Placement is
write-only from the server (per-axis messages; the server never reads layout
back). A *new* server command always applies — `dock_left()` always docks
left, `set_width()` always sizes. A *replayed/stale* command never
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
adjacent siblings (cells in a rail, segments in a bar, a tab strip from
its body, two stacked panels). A line may never OUTLINE a thing: no boxed
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
is worse than none, because it converts intent into misfires. D4 applied
this: sub-minimum zones were removed outright, and the floating bar's
snap zones were sized in thirds so all three clear the floor (§5.4 is
the normative geometry). A control's backing may come from its HOST
SURFACE: the ~14–16px chrome toggles on grip bars, bars, and unmergeable
headers satisfy the minimum because a motionless click anywhere on that
surface performs the same action (D6) — the full surface is the unmarked
hit area.

**P12 — Granularity nests.** Interactive surfaces compose by containment:
the SMALLEST interactive unit under the pointer owns the press (label →
pane, cap → group, bar background → group, grip handle → window), and each
enclosing unit gets exactly the surface its children don't claim. New
surfaces inherit this arbitration instead of re-deriving it; a press must
never arm two levels at once.

**P13 — Minimize keeps the chrome.** A minimized panel is its expanded
chrome with the body removed. The header's SURFACE stays: the same
grip-bar gray, at the same position and width. That surface is what
bounds the bar against adjacent white panel bodies (P10
enclosure-by-surface); a body-colored bar between two panels would read
as a stray label inside them. What the surface retains (D14/D18/D19):
ONE wayfinding title — the active tab's, dimmed — or the pane's
minimized face in its place; the `+N` badge naming the rest; and the
minimize/expand toggle in the SAME position. The `−` at the top-right of
the expanded header becomes `+` at the right end of the bar, so the
toggle is spatially stable and a mis-click is undone without moving the
mouse. NO grip pill on the bar (D18): the whole bar is the handle, and a
pill inside a surface that is entirely handle would be a redundant
signifier. Pills belong to EXPANDED headers, where the handle is a slice
of a larger surface — and there the pill TRUE-CENTERS in the header's
full width, so grip bars, parent handles, and the floating window header
share one centerline (P7). The right-end toggle is the bar's only
control, and the pill clears it at the layout's minimum widths. Bars are
not a separate chrome language; they are headers. One deliberate
exception: the rail (an explicitly collapsed region or column) exists to
reclaim canvas WIDTH, which "keep the header in place" cannot do — it
stays the rotated form, with the `+` on its header at the top (the
analog of the expanded header's top edge).

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
| **Bar** | THE one minimized form (D20): a group collapsed to its 26px handle, rendered **in place** in its cell — docked, zipped-grid, or floating-stack alike. |
| **Region collapse** | The explicit per-edge flag (D21), toggled by the region chevron / rail header. While set, the whole region renders as the rail; per-cell collapse states are untouched underneath. Its per-COLUMN analog is `DockColumn.railed` (D28). |
| **Rail** | THE explicitly collapsed form, at two scopes: a whole region (D21) or one column of a multi-column band (D28), packed into a 36px-wide vertical strip of spine rows. Never appears emergently. |
| **Area** | A nested dockable surface inside a panel body (flat tab group; no splits). |
| **Main panel** | The control panel: an ordinary group in the MODEL (docks, stacks, floats, minimizes like any other) that opts into `unmergeable` and a titleNode header (the connection-status row; minimized face per D19). |
| **Unmergeable panel** | A panel that may never become a tab of another group (and vice versa). It renders a full-width header instead of a tab strip; drops on it offer splits/snaps only, never merge/insert. |

Chrome anatomy referenced throughout:

| Term | Meaning |
|---|---|
| **Grip bar** | The gray chrome row atop an expanded cell: drag handle for the group; hosts the `−` toggle where the cell is its whole stack (D30). Unmergeable panels render their full-width header in its place. |
| **Tab strip** | The row(s) of tabs below a grip bar; wraps to multiple rows. |
| **Pill** | The centered grip mark on a handle surface (grip bars, parent handles, window headers, rail caps). A signifier only — the whole surface drags. |
| **Chevron** | The « / » collapse control at the right end of a parent handle; the rail's entry point. |
| **Parent handle** | The slim stack-scope handle bar above a docked scope's cells, at region scope (single-visual-column region, D26/D27) or column scope (each column of a multi-column band, D27). Drag floats the scope. |
| **Rail header** | The narrow handle atop a rail — the parent handle's collapsed mirror. Drag floats the scope; click or `+` expands it. |
| **Cap** | The gray top segment of one rail cell; drags that group. Always a quiet pill (D25). |
| **Spine row** | One tab's row inside a rail cell: upright icon above rotated title. |
| **Face** | Pane-provided content rendered in place of a bar's default icon+title (D19). |

---

## 3. Surface inventory

Every visual state a group can be in, its anatomy, and its affordances.
Anatomy is listed top-to-bottom / left-to-right. There are exactly FOUR
forms: the expanded cell (§3.1), the bar (§3.2), the rail (§3.3), and
the floating window (§3.4).

### Parent handles (stack-scope chrome, D26/D27)

Cell chrome acts on CELLS; stack-scope actions live on a stack-scope
parent handle (P12). The handle has two placements:

**Region scope (D26).** A docked region that is a single VISUAL COLUMN —
every band has one column (D27) — renders a slim full-width
StackHandleBar above all of its cells, single-panel regions included.
Dragging its centered pill floats the WHOLE stack as one window — the
same gesture as the rail header it mirrors (P7), and honest here because
the float preserves the stack exactly (P1/P8). The region-collapse
chevron « / » sits at the handle's right end, the same spot as the rail
header's `+` (P13 position constancy); a motionless click anywhere on
the handle also collapses (unmarked backing surface, P9). The handle
spans the region's full width because everything it acts on — the one
visual column it floats, the edge it rails — IS that full width: the
handle covers exactly what it acts on. It renders only while the region
is EXPANDED. While railed, the rail's own header is the parent handle —
a second chevron above the rail would duplicate the signifier (P9).
Expanded region handle and collapsed rail header are mirrors: drag
floats either; « collapses, `+` expands.

**Column scope (D27).** A region holding any MULTI-COLUMN band
suppresses the region-scope handle: it would span independent visual
columns while its drag flattened them into one stack — a hint promising
less than the drop delivers (P1), and a stack-scope control over things
that aren't one stack (P12). Instead EVERY column of EVERY band renders
its own parent handle at its top: the same slim StackHandleBar
(`data-dock-column-handle`). Dragging it floats THAT column as a stacked
window (the floatColumn op; leaf order and height ratios preserved, P8).
When the column's band has SIBLING columns, the handle's right end
carries the same « / » chevron (D28), collapsing exactly what the handle
owns: that one column rails to a 36px rail IN PLACE (§3.3) while its
band siblings stay put, and a motionless click on the handle backs the
chevron (unmarked backing surface, P9 — same rule as the region handle).
A LONE column (a single-column band inside a mixed region) keeps a
pill-only handle with no click action — railing it would strand dead
space across its full-width band. The whole-REGION rail remains the
single-visual-column form: railing N stacked bands per-column would
render broken stacked strips, so the region chevron lives only on the
region-scope handle. Dragging a column out of a 2-column region leaves a
single-column region whose region-scope handle, chevron included,
reappears automatically.

### 3.1 Expanded cell (docked or floating-stacked)
- Grip bar (gray, ~0.9em): drag moves the group. Where the cell IS its
  whole stack it holds the minimize (−) button, and a motionless click
  anywhere on the grip bar ALSO toggles minimize (D6): the `−` stays
  the only visible signifier, and the grip-bar surface is unmarked
  backing for the same action (P9's hit-area rule, P11 backing for the
  sub-20px toggle, P7 symmetry with the bar's click-to-expand).
- The (−) renders ONLY where the cell is its whole VISUAL column
  (D30): the sole panel of a single-visual-column region, a 1-leaf
  column of a zipped band, or a single-group floating window — a
  plain docked stack is one visual column, so its cells carry none. A STACKED cell has no
  cell-level minimize — its collapse control is the stack's, on the
  stack's nearest handle: the parent handle's chevron (docked) or the
  window header's toggle-all (floating); its grip bar is drag-only
  (no `−`, no backing click). One collapse control per scope (P12); no
  cell-level control ever collapses a whole column (D22). Column-SCOPE
  actions live on the column parent handle where one renders
  (multi-column regions: drag floats the column, its chevron rails
  it); elsewhere floating a column remains a chrome-less op.
- Tab strip: one tab per pane; wraps to multiple rows; the empty strip
  area drags the group; the active tab is underlined in accent color.
- Body: panel content; scrolls internally; never a drag surface.
- The (−) button is drag-through: dragging it moves the panel (P5 — no
  inert pixels); a motionless click minimizes.
- UNMERGEABLE panels render no grip bar. The full-width header — plain
  title or panel-provided titleNode alike — IS the drag handle, and,
  where the panel is its whole stack, a motionless click on its
  background toggles minimize (same backing rule as the grip bar). Its
  right end then carries the `−`/`+` ChromeToggle for BOTH title
  forms; a plain-title header without the toggle would be a
  zero-signifier action (P9: one signifier, not zero). Stacked, the
  header follows the grip-bar rule (D30): drag-only, no toggle, no
  backing click. The toggle
  is the COMPACT ChromeToggle variant (1.2em wide, 10px icon, D29): the
  whole header is the click target, so the toggle is a pure signifier
  and shrinks without hit-area cost (P11's backing rule) instead of
  sitting full-size and heavy beside the panel's own action icons. A
  DOCKED titleNode header additionally always draws the gray top rule —
  the separator between the parent handle above it and the panel's own
  header. Floating keeps the rule only when stacked; a lone window has
  nothing above the header.

### 3.2 The bar (THE minimized form, D20)
- A group collapsed to its handle: 26px tall (`MINIMIZED_BAR_PX`),
  grip-bar gray, rendered IN PLACE wherever the group lives — a docked
  cell, a zipped-grid cell, or a floating stack cell — at its cell's
  width. Expanded siblings absorb the freed height by ordinary flex
  (edge case 16); a fully-minimized band shrinks to bar height the same
  way. Accepted honest geometry (D20): a fully-minimized COLUMN beside
  expanded siblings shows its bars at the top with empty column space
  below — the column holds its width; heights are content.
- Anatomy (P13: the expanded header kept in place): ONE dimmed
  icon+title — the active tab's — with a `+N` badge naming the other
  tabs on hover (D14); then slack; then the `+` toggle at the RIGHT
  end, exactly where the expanded header's `−` sat. The `+` renders on
  EVERY bar, stacked cells included — expand is never gated (D30, P5)
  — even though a stacked cell's expanded header carries no `−`. On a
  STACKED bar the `+` expands the WHOLE stack (D31; aria label "Expand
  panels"): collapse is stack-scoped in both directions, so one bar of
  a minimized stack never expands alone. NO
  grip pill (D18):
  the whole bar IS the handle, and a pill inside a surface that is
  entirely handle would be a redundant signifier. Pills remain on
  expanded headers, where the handle is a slice of a larger surface.
- Face (D19): a single-pane group whose pane provides a minimized face
  renders it in place of the default icon+title, inside the same hit
  surface (gestures and keyboard behavior unchanged) — at the
  unmergeable header's own 2.75em height, so minimizing never moves or
  shrinks the label row. All bars sit on the panel's body surface
  (light or dark scheme), not chrome gray. The MAIN PANEL's face is
  its connection-status row (action icons hidden) — old-viser
  continuity via a general mechanism, not a special case.
- Gestures: a title/face click expands to that tab; a title/face drag
  tears the active pane out, still minimized (a single-pane group
  floats wholesale, ids stable). A `+` click expands the group; the `+`
  is drag-through. Any other press — background, right slack — drags
  the whole group; a motionless click there expands. Every expand
  above is STACK-scoped when the bar is stacked (D31): the `+`, the
  background click, and the title click all reveal the whole visual
  column (the title path still activates its tab); a lone bar expands
  just itself. Per-tab
  affordances beyond the active pane live in the rail and the expanded
  tab strip (D14): the active pane is reachable directly, the rest via
  one expand.

### 3.3 The rail (explicit collapse only: whole region D21, one column D28)
- One form, two scopes. The rail never appears emergently: minimizing a
  region's last panel leaves its bars in place at full region width.
  The only entries are the collapse chevrons. The REGION scope
  (`regionCollapsed[edge]`, single-visual-column regions only) renders
  the whole region as ONE packed 36px rail holding every leaf across
  every band, contiguous — the canvas gets the region's width back, no
  dead gaps. The COLUMN scope (`DockColumn.railed`, columns of
  multi-column bands) renders THAT column as the same 36px rail IN
  PLACE, its band siblings unaffected. Either way the structure and
  per-cell collapse states stay in the MODEL and return intact on
  expand — the rail is a view over the model. The expanded width is
  remembered (P8): the region rail remembers `regionWidth`; the column
  rail preserves the column's width weight.
- Rail header (narrow, on top — the analog of the expanded header's top
  edge, and the collapsed mirror of the scope's parent handle): drag
  floats the SCOPE — the whole region, or that one column — as one
  stacked window; click or its `+` expands the scope, clearing ONLY the
  rail flag (cells keep their own collapse states). Toggle aria-labels
  are honest: "Expand panel area" / "Expand column", never "Expand all
  panes". After a keyboard-driven expand, focus lands on the first
  revealed cell's active tab, never on `<body>`.
- Per cell (identical in both scopes): a gray cap — ALWAYS a quiet grip
  pill (D25; P9 signifier budget: exactly ONE `+` per rail, on the rail
  header — three `+`s in a 36px rail read as three different
  mysteries); then one spine row per tab (upright icon above rotated
  title), dimmed; hairline dividers between cells. When the rail holds
  a SINGLE cell, a motionless click on the cap or cell background still
  expands scope + group — unmarked backing surface for the rail
  header's action (P9's hit-area rule). With 2+ cells a background
  click is inert: which cell would it mean?
- Clicking a spine row expands the scope AND that panel *to that tab*
  (expand ops clear the flags at the op level, §7). Dragging any spine
  row tears out just that pane, still minimized; dragging the cap or
  cell background moves the whole group.
- Collapse chevrons (the rail's entry surfaces): « on the left edge, »
  on the right, always at the right end of a PARENT HANDLE — a
  stack-scope control on a stack-scope surface (P12), never on any
  cell's chrome (D26, superseding D23's inline placement). The REGION
  chevron sits on the region-scope handle and sets the region flag; the
  COLUMN chevron (D28) sits on a column-scope handle whose band has
  sibling columns and rails exactly that column. A chevron is NOT
  drag-through: a press on it stays click-only. The handle's own
  motionless click is its chevron's unmarked backing surface (P9's
  hit-area rule — same action, one signifier). A keyboard-driven
  collapse hands focus to the rail header that replaces the chevron
  (edge case 14). Chevrons render only while their scope is expanded;
  while railed, the expand affordance is the rail's own header (P9: one
  signifier per action).

### 3.4 Floating window
- Multi-group: a window header on top. Drag moves the window; its
  toggle minimizes all cells, flipping to expand-all when every cell is
  a bar — the stack's one collapse control (D16/D30: stacked cells
  carry no per-cell `−`). The
  header is ALWAYS present for a multi-group stack, even when every
  cell is a bar (D17): a fully-minimized window is the same stack of
  cells, all 26px, at full `win.width` (P8 — no fit-content jump, no
  separate chip-bar form). Single-group windows have no header; the
  group's own grip bar moves the window (and, being its whole stack,
  keeps its `−`, D30).
- Each cell renders as §3.1 without the docked context, or as its bar
  (§3.2) when collapsed — expanded and minimized cells may still mix
  (mixes arise only from structural composition now: docking or
  dropping beside bars, no adoption — D16/D31; the UI minimizes AND
  expands stacked cells only all-at-once, D30/D31).
- Side grips resize width; top/bottom/corner grips resize height (pin),
  with a detent that snaps back to auto-height at the content height. A
  fully-minimized window keeps its WIDTH grips (D15 — the bars hold
  `win.width`, and that width stays user-adjustable in either state) and
  hides the vertical/corner grips (nothing to size).

### 3.5 Floating z-order and multi-client
- Any press anywhere on a floating window raises it to the front (capture
  phase; does not consume the press). Front order is paint order only —
  raising never reorders the DOM (in-flight clicks survive).
- Overlapping windows resolve drops back-to-front: the topmost target under
  the pointer wins. Drop targets are collected in front-order (window
  z-order, not DOM order), and a nested area's targets rank immediately
  above their HOST window — above the host's own cells, below any window
  stacked in front — never above unrelated floating windows.
- Ownership is by the window's whole PAPER rect (its full visible
  rectangle), not its cell rects: the frontmost floating window whose
  rect contains the pointer OWNS it, and only that window's targets —
  its cells and its hosted areas — are eligible. A pointer on its
  header, divider gaps, or padding must never resolve to an occluded
  docked panel or a lower window's cell. (History: cell rects alone
  left chrome slivers where the masking blinked off mid-drag.) Seam
  dead-spot recovery is scoped the same way: the owning window's own
  seams, never a back window's.
- Region-edge bands yield while the pointer is over a floating window
  (the same paper-rect rule): a drop there targets the float, never docks
  a column THROUGH it into the region underneath.
- Multi-client: layout is per-client state; server placement commands fan
  out to every client and each client's gate arbitrates against its own
  user's touches (P6). Clients never sync layouts with each other.

### 3.6 Nested area
- A flat tab strip + body inside a host panel. Drops: insert-at-tab-position
  over its tab strip, merge elsewhere. Never splits, never minimizes
  separately.
- A frame of the host panel around the area stays hot for the HOST's zones,
  so a full-bleed area doesn't make the host undockable-beside (P5).

---

## 4. Gesture reference

Threshold: a press becomes a drag at ≥3px of motion; below that, release is
a click. One active gesture at a time; extra pointers are ignored.

| Grabbed surface | Drag moves | Motionless click |
|---|---|---|
| Grip bar (expanded, cell = its whole stack) | that group | toggle minimize (unmarked backing for the `−`, D6) |
| Grip bar (expanded, stacked cell) | that group | — (no cell-level minimize, D30) |
| Tab strip background (expanded) | that group | — |
| Unmergeable header (full width, either title form) | that group | toggle minimize (lone-in-stack only, D30; drag-only when stacked) |
| (−) minimize button (lone-in-stack cells only, D30) | that group (drag-through) | minimize group |
| Tab | that pane (tear out / reorder) | activate tab |
| Window header (floating multi-group) | whole window | minimize all (expand all when every cell is a bar) |
| Bar background (incl. right slack) | that group (still minimized) | expand — the whole stack when stacked (D31), else that group |
| Bar title / face | the active pane (tear out, still minimized) | expand to that tab — the whole stack when stacked (D31) |
| Bar `+` (right end) | that group (drag-through) | expand — the whole stack when stacked (D31, "Expand panels"), else that group |
| Region parent handle — pill / background (expanded single-visual-column region, D26/D27) | whole region (as one stacked window) | collapse region to the rail (unmarked backing for its chevron) |
| Region-collapse chevron (right end of the region parent handle) | — (click-only; NOT drag-through) | collapse region to the rail; keyboard collapse hands focus to the rail header |
| Column parent handle — pill / background (each column of every band in a multi-column region, D27) | that visual column (as one stacked window, height ratios preserved) | rail that column when the handle hosts a chevron (unmarked backing for it, P9); no action on a pill-only handle |
| Column-collapse chevron (right end of a column handle whose band has sibling columns, D28) | — (click-only; NOT drag-through) | rail that column (36px rail in place); keyboard collapse hands focus to the column rail's header |
| Rail header (region or column scope) | that scope (as one stacked window, still minimized — cells stamped, §7) | expand the scope (cells keep their states; labels "Expand panel area" / "Expand column") |
| Rail cell cap / background (quiet pill) | whole group (still minimized) | expand scope + group (lone cell only; inert with 2+ cells) |
| Rail spine row | that pane (still minimized) | expand scope to that tab |
| Region resize divider | region width (expanded columns only; railed columns ride as fixed chrome, §6) | — |
| Column (width) divider inside a band | neighboring columns' widths (inert only when a RAILED column flanks it — fixed 36px chrome, D28; bars never make it inert, they hold their column's width, D20/D24) | — |
| Height divider (docked or floating stack; expanded cell on each side) | neighboring cells' heights | — |
| Height divider (a side all-minimized) | — (INERT, D24: no resize cursor, no gesture) | — |
| Window edge/bottom grips | window size | — |

Escape during any of the above restores the exact pre-gesture layout,
including region widths and collapse states. Escape after an expand-on-drag
restores the minimized state.

Keyboard: every click target above is focusable (visible focus ring),
with Enter/Space performing its motionless click. Tab strips and rails
are `tablist`s with arrow-key traversal: Left/Right on tab strips,
Up/Down on rails. A bar is a one-tab `tablist` (its single title is a
`tab`), so the pattern stays valid for screen readers across the
minimize round-trip. Focus never falls to `<body>` in EITHER direction.
After a keyboard-driven expand, focus lands on the expanded tab strip's
tab. After a keyboard-driven MINIMIZE or RAIL COLLAPSE (region or
column), whose activated control unmounts with its host surface, focus
hands off to the control that replaced it — the bar's `+` toggle, the
rail's header — i.e. the same-spot control that undoes the action.

Touch: all drag surfaces set `touch-action: none`; a browser-cancelled
pointer aborts like Escape (P2).

---

## 5. Drop system

### 5.1 Zone taxonomy, outermost to innermost

Priority is resolution order: the first zone that matches the pointer wins.
Pixel values are the intended geometry; they are constants in `hitTest.ts`
and changing one is a spec change.

1. **Empty screen edge** (48px at a screen edge with no region): docks
   as the region's first content, full height. Active even past the
   screen edge (slam gestures).
2. **Insertable tab strip** (override): a pointer over a tab strip where
   a tab insert would resolve always beats region-level bands — specific
   intent beats broad intent.
3. **Region edge bands** (occupied edge): the 8px top/bottom bands
   insert a full-span band above/below everything; the 40px outer/inner
   side bands dock a full-height column beside everything. Each side
   band is capped to a third of the region width, so the two together
   always leave a middle third for the per-cell zones underneath. For a
   canonical stack (all bands single-column) the side drop ZIPS the
   bands into one nested column, so "beside everything" is literal. A
   region containing a multi-column band cannot be zipped (rows can't
   nest); there the drop joins the first band and the hint spans only
   that band. Either way the hint spans the true affected extent (P1).
   The bands are suppressed where they would duplicate a per-cell split
   (a single leaf edge-wise), and while the pointer is inside a floating
   window's paper rect (§3.5: the owning window claims the pointer).
   Over a railed or all-minimized region's EMPTY area, the side bands
   widen to the area's left/right HALVES — no dead center stripe, each
   side dockable from its own half. (History: a full-width band made
   side `right` unreachable — the left check ran first and matched every
   x.) A seam band-insert takes an EQUAL SHARE of the region height (the
   mean of the existing bands' weights) — never a fixed weight, which a
   px-scale region would render as a 0px sliver.
4. **Cross-band seams**: the divider between two bands inserts a new
   full-width band at that index.
5. **Per-target zones**: the cell-, rail-, and bar-level zones of
   §5.2–5.4.
6. **Anywhere else**: no drop; release floats the dragged stack at the
   pointer.

### 5.2 Expanded docked cell zones
- Above the tab strip (the grip bar): split above this cell.
- Over the tab strip: insert at that tab position (2D nearest-tab, works
  with wrapped rows).
- Content side bands (30% of width, ≤120px): split left/right of this cell.
  If the cell's column is the band's only column, the drop *band-splits* so
  the new panel sits beside just this cell; otherwise the new column spans
  the band and the hint is drawn band-tall (P1).
- Content top/bottom bands (25%, ≤100px): split above/below this cell.
  The content-TOP band splits ABOVE: it repeats the grip bar's intent
  from just below the tab strip, so merge stays reachable only in the
  middle (an accidental merge is the one destructive gesture D1's
  generous bands exist to prevent).
- Content center — roughly the middle third each way — merges (become a
  tab). Splits are the easy default; merging requires clearer aim (D1).
  Suppressed for unmergeable panels.

### 5.3 Rail cell zones (§5.2 rotated; identical in region and column rails, §3.3)
- 8px outer/inner side slivers: dock a column beside.
- 8px top/bottom edges (`MINIMIZED_EDGE_BAND_PX` — P11's zone floor):
  stack a cell above/below.
- Over a spine row: insert at that tab position.
- The rest, cap included: merge into that group, staying minimized.

### 5.4 Bar zones (in-place minimized cells)
- A bar's whole 26px slot is a drop target: drop merges into that
  group, staying minimized. Insertion at a tab position aims at the
  bar's single title label (the active tab's one label rect, D14); a
  drop anywhere else on the bar appends.
- Docked bars keep thin side slivers (split a column beside, per §5.3's
  side logic) and have NO top/bottom zones. D4's reasoning survives the
  D20 migration: the cell and band seams immediately adjacent already
  express "insert above/below", and thin zones inside a 26px bar would
  be unhittable (P11: removed, not shrunk).
- Floating bars are ordinary stack cells (D17): top/bottom snap zones
  of `min(10px, barHeight/3)` — ≈8.67px on the 26px bar — insert into
  the window's stack at that seam; no alternative affordance exists for
  snapping between two bars. D4's flat 10px remedy is unsatisfiable on
  a 26px bar, where two 10px zones would leave a sub-8px middle merge
  zone; thirds keep all three zones at or above P11's 8px floor.

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
  visible geometry. A floating window growing MID-DRAG (auto-height
  content) also marks the cached target rects stale — size changes with
  no layout commit are still geometry changes.
- Divider gaps are never dead spots: a pointer over the gap between two
  stacked docked panels maps to the seam split it sits in the middle of,
  and the divider gap inside a floating stack has the same recovery —
  it maps to the snap at that index — so the hint never flickers to
  "no drop" while crossing a seam.

There are no adoption rules — a dropped panel never inherits its
neighbors' collapse state. Collapse changes ONLY by user gesture
(P3 without exceptions, D16/D31). The one structural
survivor: panes merged INTO a group become tabs of it and so share its
collapsed flag — dropping into a minimized group never expands it (§9
item 1).

---

## 6. Sizing model

- **Region width**: expanded columns of the width-determining band (the
  widest band) carry pixel widths; the region's width is their sum.
  Docking a new column *grows* the region by the newcomer's width —
  DECIDED (D3): existing panels never shrink because something arrived
  (P3 outranks canvas preservation; the resizer is the recovery). This
  applies to per-cell splits and region-edge docks alike. A RAILED
  column (D28) renders at the fixed 36px rail width while its stored
  weight is preserved for restore (P8): the region's rendered width
  swaps that column's share out for the rail; the region resizer
  redistributes over EXPANDED columns only (railed columns ride as
  fixed chrome, weights untouched); and the region stops being
  width-resizable when it is railed or every width-determining column
  is (all fixed chrome).
- **Minimums**: expanded columns / regions / windows ≥ 96px grab-width
  minimum (`MIN_REGION_GRAB_PX`; the ~220px CONTENT minimum is the body's —
  below it the panel scrolls horizontally rather than squeezing); cells ≥
  ~50px; windows ≥ 50px height (floored at the content height when the
  content is shorter, so a short panel can shrink to its natural size).
  Resizes clamp; they never squeeze a cell below its header. The cell
  minimum is also a RENDER floor on expanded docked leaves (mirroring
  the floating stack's, P7): repeated same-target splits halve weights
  geometrically, and without the floor the smallest cell clips its own
  grip bar + tab strip. RAILED columns don't raise their band's height
  floor (a rail scrolls at any height); a band whose every column is
  railed floors at a usable ~60px grab height instead of a per-leaf
  sum.
- **Split defaults**: a top/bottom leaf drop and a left/right column
  drop both default the two sides to HALF the target's current weight.
  Sibling weights may be on any scale (divider drags write px values),
  so a fixed default weight could render as a 0px sliver; half-the-
  target is scale-invariant and keeps the hint's 50/50 promise (P1).
  A multi-group stack dropped top/bottom takes that half as a WHOLE and
  divides it among its leaves by the stack's preserved height ratios
  (P8 round-trip — the same rule the left/right branch's column build
  uses), not equally.
- **Dividers** (D24): a divider is INERT — no resize cursor, no armed
  gesture, no height-pin side effect — unless something tradeable sits
  on EACH side (a resize cursor that no-ops lies). For HEIGHT-trading
  dividers (docked stacks, floating stacks) that means an expanded cell
  each side: bars are fixed 26px. For COLUMN (width) dividers a BAR is
  never inert-making — it carries its column's WIDTH (D20) — but a
  RAILED column is (fixed 36px chrome, D28), so the divider needs an
  un-railed column on each side. When resizable, a height drag walks
  PAST minimized bars to the nearest expanded neighbor on each side
  (cascadeResize), so a seam adjacent to a bar still resizes instead of
  dead-ending. Floating stack dividers carry the same ~12px invisible
  grab overlay as docked ones (P11) — only while resizable.
- **Stack grow normalization**: flex-grow factors are normalized per
  site (edge case 16) over EXPANDED cells only — minimized cells render
  flexGrow 0 and are excluded from the total, so a pinned window with a
  minimized cell never strands the freed height as dead space.
- **Round-trips** (P8): float→dock carries the stack's height ratios into
  the column; dock→float restores the remembered window size; minimize→
  expand holds width by construction (the bar renders in place, D20);
  rail→expand restores the pre-collapse width at either scope (the rail
  reserves 36px, remembers the rest); a railed column dragged out
  floats at its preserved expanded width, not the rail width;
  reconnects replay the same sizes.
- **Windows**: auto-height tracks content up to the container; pinned height
  is user-set via the bottom grip; the content-height detent un-pins.
  A fully-minimized window ignores pinned height (nothing to size).

---

## 7. Minimize / expand semantics

- Collapse is per-GROUP in the MODEL, period (D16). Any cell — in a
  docked column, a zipped grid, or a floating stack — holds its own
  flag; mixed stacks are legal and coherent: a collapsed cell renders
  as its 26px bar IN PLACE (grow 0, D20) and expanded siblings absorb
  the freed space (edge case 16). The uniform-collapse invariant is
  deleted; nothing normalizes collapse states at commit. Since D31,
  mixes are reached only STRUCTURALLY (docking/dropping beside bars —
  no adoption, D16) — the collapse OPS themselves act per whole stack,
  so a stack minimized together stays uniform.
- BOTH collapse directions are scoped (D30/D31): one collapse control
  per scope, on that scope's nearest handle. The per-cell `−` renders
  only where the cell IS its whole stack (a lone docked cell, a
  single-group window); a 2+ stack collapses via its stack's control —
  the parent handle's chevron (docked) or the window header's
  toggle-all (floating). EXPAND is never gated — every bar keeps its
  `+` and click-to-expand (P5) — but it is scoped the same way (D31):
  a stacked bar's every expand affordance (`+`, background click,
  title click) expands the WHOLE stack — its visual column: the
  window's stack, all bands of a single-visual-column region, or the
  model column of a zipped band — routing every member through the
  shared expand op, so the rail flags clear too. P5's way out of a
  structurally-composed mixed stack IS the stack-scope expand. There
  is no server collapse command (D31): collapse changes only by user
  gesture.
- Exactly two minimized forms exist: the BAR (per-cell, in place, §3.2)
  and the RAIL (explicit, at region or column scope, §3.3). Neither
  appears emergently: an all-bars region is still an all-bars region at
  full width — a state-dependent form flip would move chrome the user
  didn't touch (P3).
- Bulk toggles live in exactly two places (D16): the multi-group
  window header's toggle (minimize-all, flipping to expand-all when every
  cell is a bar) and the rail. Everything else is per-cell — expand
  everywhere, minimize where the cell is its stack (D30).
- Rail collapse is explicit (D21/D28): the region chevron sets
  `regionCollapsed[edge]`, the column chevron sets its column's
  `railed`; while set, that scope renders as the packed 36px rail
  REGARDLESS of per-cell collapse states — the rail is a VIEW over the
  model; structure and per-cell flags stay put and return intact on
  expand. Collapsing a missing scope is a no-op; clearing is always
  legal. Chevron and rail-header gestures commit as USER ops, and both
  flags join every resident's docked ownership signature (P6): a user's
  rail toggle marks those panels touched, or a stale single-axis server
  replay could silently re-flip a rail the user just set.
- The scopes convert rather than stack: any op that ADDS a side-by-side
  column to a region-railed region CONVERTS the rail first — clears the
  region flag and rails every PRE-EXISTING column individually — so the
  old content stays railed in place while the newcomer lands expanded
  and visible (P5; D28's user-requested outcome). This covers edge
  docks, region-edge docks, and per-cell side drops, including the zip
  path (the zipped stack stays railed — every zipped half was). Where
  both flags do exist, the region scope takes render precedence (the
  region rail is drawn; column flags wait underneath).
- Structural ops carry the column flag like any other geometry: a D12
  band split leaves every fragment of a railed column railed (the same
  picture re-expressed, P14); a D13 zip-merge keeps the flag only when
  BOTH halves carried it (a half-railed merge must reveal the expanded
  half's content).
- Orphaned column rails degrade at canonicalization (adjudicated in
  §10; pinned in unit tests): when a railed column ends up alone in its
  band, the railed form is no longer legal — a 36px rail inside a
  full-width band strands dead space. If the whole region is
  single-column and every column is railed, it PROMOTES to the region
  rail (the add-conversion's inverse). A lone railed column among
  expanded bands clears its flag and its groups minimize to in-place
  bars — the user's "minimized" intent survives in the legal form for
  the new geometry.
- Expand ops clear the flags (D21/D28): every op that expands a docked
  panel (expand-group, expand-to-tab, a toggle landing on expanded)
  also clears its region's collapse flag AND its containing column's
  railed flag — an "expanded" panel hidden behind a rail would be a
  dead end (P5). The rail header's click/`+` clears ONLY its scope's
  flag (cells keep their own collapse states); a spine-row click
  expands the scope AND that panel to that tab.
- Expand targets: a bar's title/face click expands to the active tab; a
  bar's `+` or background click expands on the previous active tab; each
  acts on the whole stack when the bar is stacked (D31); the window
  header's toggle expands everything it owns.
- Tearing a pane out of a minimized group floats it STILL minimized
  (expanding is exclusively a click; drags never change collapse — P2).
- Dragging a cell (spine row or cap) out of ANY rail floats it still
  minimized too. The cell's own flag is usually false (the rail is a
  view over the model), so the drag COMMIT stamps `collapsed: true`
  onto the floated group — the user was dragging a minimized bar, and
  floating it full-size would pop a window mid-drag (P2). Dragging a
  whole rail out by its header — region or column scope — floats a
  window of minimized bars the same way (every stack cell stamped).
  Server float commands never stamp: the server has no collapse axis
  (D31); `float()` moves the group and leaves its collapse state alone.
- A railed region reserves exactly 36px; it is still a full drop target
  and still hosts region-edge docking on its outer side. A railed
  column reserves the same 36px inside its band.

---

## 8. Server placement semantics

- Three independent write-only axes per panel: position, width, height
  (there is no collapse axis — minimize/expand is a client-side gesture
  only, D31). A message carries exactly one axis; applying one axis can
  never disturb another (no yank by construction).
- Fresh vs stale: each panel has a monotonically increasing layout counter
  per server run. An arriving axis message applies iff the user hasn't
  touched that panel since the message's stamp (gate open), or the stamp is
  provably newer than the last applied one. Late joiners replay the latest
  message per axis and reconstruct the same placement.
- When several axes of one panel apply together (a replay bundle), the
  order is position first, then size — size ops resolve against the
  panel's FINAL location (region width when docked, window size when
  floating).
- Split placements (`dock_below(anchor)` etc.) defer until the anchor is
  actually docked; if the anchor can never dock (hidden, emptied, cyclic),
  the placement falls back to a right-edge dock rather than hanging (P5).
- `visible = False` removes the panel from the dock without destroying it;
  `True` re-places it via its stored placement axes.

---

## 9. Edge-case catalog

Behaviors that MUST hold (each is or should be pinned by a test):

1. Drop on a minimized group merges *without expanding it*; and a drop
   beside minimized neighbors never minimizes the dropped stack (no
   adoption, D16 — collapse changes only by user gesture, D31).
2. Escape after expand-on-drag restores the minimized state.
3. Dragging a (−)/(+) button never toggles; a motionless click never moves.
4. A viewport resize between press and drag-threshold doesn't teleport the
   window (grab offsets resolve against the current model position).
5. Undocking a minimized panel then expanding restores its docked width, not
   the 36px rail width.
6. A pinned-height window expands from minimized at its pinned height.
7. The last panel leaving an edge nulls the region; the next dock recreates
   it at the remembered width.
8. An emptied-then-revived docked panel reappears (no orphan group).
9. Same-batch and reversed-order anchor splits both resolve (no race, no
   hang); never-dockable anchors fall back.
10. Wheel-scrolling a tall rail mid-drag doesn't desync drop targets.
11. A drop into a wrapped tab strip's second row lands at that row's index.
12. An all-minimized (per-cell) region renders its bars in place at full
    region width; ONLY the explicit collapse flags produce 36px rails
    (region D21, column D28), and expanding any panel from a rail
    clears the owning flag.
13. Region-edge docking beside a railed region stays reachable from the
    outer half of the rail.
14. Bar/rail keyboard expand moves focus onto the revealed tab strip;
    keyboard minimize/collapse moves it onto the replacement control (the
    bar's toggle / the rail's header). Neither direction drops focus to
    `<body>`.
15. Left/right mirrored layouts resolve mirrored drops everywhere (swept).
16. Expanded panels absorb ALL space freed by minimized siblings — a band/
    column/cell/stack-cell may never strand dead area because fractional
    weights summed below 1 (flex-grow factors are normalized per site,
    over EXPANDED cells only — minimized cells render flexGrow 0 and
    are excluded from the total, §6; railed columns are excluded the
    same way).
17. Docking a column beside a region-railed region converts the rail
    (§7): the pre-existing columns rail individually — through the zip
    path too — and the newcomer lands expanded.

---

## 10. Cross-check protocol (phase 2)

For each table row and catalog item above: find the implementing code and
the pinning test; record `OK` / `DIFFERS (code)` / `DIFFERS (spec)` /
`UNTESTED`. Differences get resolved in review — the record of "spec
changed because X" lives in §11 and in git history. The suites: `hitTest*`
(zones, sweep, mirror), `layoutOps*` (ops, fuzz, lifecycle),
`panelPlacement` (gating), `tests/e2e/test_dock_playground_*` (gestures),
`tests/e2e/test_panels.py` (server round-trips).

Prior passes, one line each (full fix lists live in git history):

- 2026-07-03 — full pass post D1–D9: 0 DIFFERS; the one real coverage
  gap (edge case 10) pinned.
- 2026-07-03, end of day — D10–D13 implemented and verified (452 unit
  tests incl. the canonicalizer suite; e2e battery green; CI 23/23).
- 2026-07-04 — normative re-sync to D16–D22 after the minimize
  redesign.
- 2026-07-04, stability-loop iterations 2–5 — hit-box/display/UX audits
  plus a real-example pass drove D23–D25 and the D4/D6/D19 amendments,
  and a series of code fixes (placement-axis ordering, owning-window
  drop mask, P6 user-op commits + rail placement signatures, keyboard
  focus handoffs, band minimums + squeezed-column scrolling, and the
  content-top band's silently-widened merge zone restored to
  split-above).
- 2026-07-04 — D26 (region parent handle) landed and was re-audited.

**Latest full-pass record — 2026-07-04 (§10 protocol, post stability
loop + D26):** one audit walked every normative section against
`src/viser/client/src/dock/*`, `ControlPanelDock.tsx`, and
`tests/e2e/conftest.py`. Per-section verdicts (claims checked → DIFFERS/
STALE found; all resolved as SPEC fixes, no code changed):

- **§1 principles** (~40): 1 — P13's pill clause predated D26 (pills
  true-center again, sharing the parent handle's and window header's
  centerline). P4 as amended verified end to end: `collapseAnim` eases
  flex properties at 160ms, `prefers-reduced-motion` → none,
  `[data-dock-resizing]` set by both divider kinds, e2e runs
  `reduced_motion="reduce"`, and the `transitionend` re-read is
  propertyName-gated.
- **§2 vocabulary** (13 rows): 1 — the Main panel row predated the
  shipped unmergeable titleNode panel; rewritten (D8 amended to match).
- **§3 surfaces** (~55): 0 DIFFERS — the D26 parent handle matches code
  exactly (`data-dock-region-handle` StackHandleBar, chevron as
  `endControl`, bar click = collapse backing, chevron click-only with
  focus handoff); the no-handle-while-railed gate was implicit and is
  now stated in the §3 intro. Bars/rail/floating anatomy all verified.
- **§4 gestures** (18 rows + keyboard/touch): 0 — every row traced to
  its handler, Escape restores incl. rail drag-out stamping.
- **§5 drop system** (~35): 1 — item 3's 40px side bands are CAPPED at
  a third of the region width; cap recorded. All zone geometry, seam
  recoveries, owning-window mask, and mean-weight band inserts match.
- **§6 sizing** (~20): 1 — stale minimums updated (grab minimum 96px
  `MIN_REGION_GRAB_PX`; window height floor 50px).
- **§7 minimize/expand** (~15): 0 — expand ops clear the rail flag at
  the op level, collapseRegion commits as a USER op, drag-outs stamp,
  server floats never do.
- **§8 server placement** (12): 0 — position → collapsed → size
  ordering; placement signatures carry the rail flag and region width.
- **§9 edge cases** (16): 0. **§10 records**: 1 — the accepted-trade
  note predated the two-strip straddle; re-verified below.

D27 (per-column handles) landed immediately after this pass with §3/§4/
§7 re-synced; D28/D29 (2026-07-05, working tree) landed after that with
their sections re-synced and new `layoutOps` pins (rail round-trip,
effective collapse, region→column conversion incl. the zip path, D13
zip-keep, D12 split-carry). D30 (2026-07-05, working tree) rescoped the
per-cell `−` to lone-in-stack cells, with §2–§4/§7 re-synced and an e2e
pin added (stacked cells bare, lone cell `−`, stacked bar keeps `+`).
D31 (2026-07-05, working tree) made collapse stack-scoped in BOTH
directions and deleted the server collapse axis, with §3/§4/§7/§8
re-synced, new `layoutOps` pins (expandStackOf: floating stack, plain
docked stack, zipped column, flag clearing), and the e2e suites
reworked (UI-gesture minimize seeding; a stacked bar's `+` expands the
stack). The §8 ordering finding above ("position → collapsed → size")
is historical: the bundle is position → size since D31.
The next full protocol pass is owed on D27–D31.

Accepted trade (re-verified 2026-07-04): on a LEFT region squeezed into
the scrolling state, the RegionResizer's 5px over-the-panel strip (the
inner of its two strips, below the 48px chrome clearance) overlaps the
column scrollbar's outer edge. The scrollbar's remaining width still
scrolls, and narrowing the straddle would cost the region-resize grab
everywhere for a rare degenerate state.

Code-side observations, report-only:

- `RegionCollapseChevron`'s focus handoff to the rail header runs on
  POINTER activation too, not just keyboard — harmless (the ring is
  :focus-visible-only) but inconsistent with `gestures.ts`'s stated
  keyboard-only-focus policy. `ColumnCollapseChevron` inherits the same
  pattern. Accepted: the activated control unmounts, so even pointer
  users are better served by focus landing on the replacement control
  than on <body>.

Adjudicated same-day (both implemented; normative text in §4 and §7):

- The column parent handle's bar click now BACKS its chevron when one
  is hosted (rail this column), matching the region handle (P9).
- Orphaned column rails degrade at canonicalization: when a railed
  column ends up alone in its band, the railed form is no longer legal
  (a 36px strip inside a full-width band strands dead space). If the
  whole region is single-column and every column railed, it PROMOTES
  to the region rail (the add-conversion's inverse); a lone railed
  column among expanded bands clears its flag and its groups minimize
  to in-place bars — the user's "minimized" intent survives in the
  legal form for the new geometry. Composed consequence, pinned in
  unit tests: D12-splitting a railed lone multi-leaf column yields the
  region rail, not flag-carrying fragments.

---

## 11. Decision record

Former open questions, decided with the maintainer. The normative
sections above are the single statement of current behavior; these
records preserve each decision's rationale, with amendment history
folded into final text (the play-by-play lives in git history).

- **D1 (merge zone, 2026-07-03):** per-cell split bands are generous
  (30% sides ≤120px, 25% top/bottom ≤100px) so center-merge is roughly
  the middle third: splits are the casual-drop default, merging
  requires aim. No dwell timers (P4).
- **D2 (band-bar background drag, 2026-07-03):** the band bar's
  background dragged the whole band as one stack. Retired with the band
  bar itself (D20); bands move via their cells or the parent handles.
- **D3 (region growth, 2026-07-03):** side-docking always GROWS the
  region by the newcomer's width. Existing panels never shrink because
  something arrived; the canvas cost is accepted and the resizer is the
  recovery.
- **D4 (thin zones, 2026-07-03; final 2026-07-04):** sub-minimum drop
  zones are REMOVED, not shrunk (P11): band-bar segments lost their 6px
  top/bottom zones (the seams next door already express the intent —
  reasoning D20's in-place bars inherit, §5.4), and the floating bar's
  snap zones are `min(10px, barHeight/3)` — a flat 10px is
  unsatisfiable on the 26px bar, where two 10px zones would leave a
  sub-8px middle merge zone.
- **D5 (tear-out granularity, 2026-07-03):** resolved by D9, rescoped
  by D14 — per-tab tear-out lives where per-tab labels live (rail spine
  rows, expanded strips); a bar tears out its active pane.
- **D6 (minimize gesture, 2026-07-03; final 2026-07-04):** the `−`
  stays the only visible minimize SIGNIFIER; a motionless click on its
  host row (grip bar, unmergeable header) is unmarked backing for the
  same action (P9's hit-area rule, P11 backing for the small toggle, P7
  symmetry with the bar's click-to-expand). Double-click rejected: it
  would extend the P2 grammar globally for one shortcut. Scoped by D30:
  the `−` and its backing click exist only where the cell is its whole
  stack; a stacked cell's row is drag-only.
- **D7 (release over nothing, 2026-07-03):** always float at the
  pointer. Motion means move; Escape is the abort.
- **D8 (main panel, 2026-07-03, amended):** ordinary in the MODEL —
  docks, stacks, floats, minimizes like any group. The shipped panel
  opts into `unmergeable` with a titleNode header; unmergeability is a
  per-pane property any panel may set, not main-panel special-casing.
  §2's Main panel row is the normative statement.
- **D9 (segment anatomy, 2026-07-03):** one label per tab on minimized
  surfaces (click = expand to that tab, drag = tear the pane out).
  Superseded on horizontal bars by D14's single title; survives as the
  rail's spine rows.
- **D10 (minimize keeps the chrome — P13 adopted, 2026-07-03):**
  minimized bars are the expanded header kept in place: title left, one
  toggle at the RIGHT where the `−` was, width unchanged (floating bars
  keep `win.width` — no fit-content jump). Fixed the multi-stack bar's
  missing expand signifier. The rail is the documented exception
  (reclaims width; `+` cap on top).
- **D11 (keep the 4-level model, 2026-07-03):** single-group columns
  were considered and REJECTED: they would make any vertical stacking
  narrower than the region unrepresentable — including "dock below just
  A beside B", a working, common operation — and would break floating
  stacks' side-docking. Confusion is addressed by canonical form
  (D12/D13) instead of by amputation.
- **D12 (canonical form: bands for full-width stacks, 2026-07-03):** a
  multi-leaf column may exist only when its band has sibling columns;
  lone multi-leaf columns normalize into consecutive bands (heights
  preserved) at every structural commit. Plain docked stacks thereby
  gained independent per-panel minimize.
- **D13 (zip-merge aligned neighbors, 2026-07-03):** adjacent bands
  with the same multi-column partition (equal widths within ~2px) merge
  by zipping corresponding columns — one seam, one set of handles, no
  double chrome for a 2×2 grid. Runs on structural commits ONLY (never
  during pure weight changes, so a resize cannot restructure
  mid-gesture).
- **D14 (single-title bars, 2026-07-04):** bars show ONE title (active
  tab + `+N` badge), not a label per tab — hands-on review found
  per-tab labels busy against real content — and drop to grip-bar scale
  (26px, P11 floor respected): a minimized panel reads as "the panel
  collapsed to its handle", `−`→`+` swapped in place. Per-tab
  affordances live in the rail and the expanded strip; from a bar the
  active pane is direct and the rest are one expand away. The rail is
  confirmed KEPT (width reclaim).
- **D15 (minimized windows stay width-resizable, 2026-07-04):** a
  fully-minimized floating window keeps its side (width) grips — the
  bars hold `win.width` (P8) and it stays user-adjustable in either
  state; only vertical/corner grips hide (nothing to size). Same round:
  pill position constancy folded into P13, and edge case 16 added after
  the fractional flex-grow bug (CSS distributes only sum(grow) of the
  free space when the sum is < 1; weight-driven grow factors are
  normalized to sum to 1).
- **D16 (per-cell minimize everywhere, 2026-07-04):** the
  uniform-collapse invariant is DELETED. Any cell — docked column,
  zipped grid, floating stack — minimizes individually; mixed stacks
  are legal and coherent. With it died normalizeStackCollapseInPlace,
  invariant #14, and the adoption rules (dropping an expanded panel
  beside minimized ones no longer infects it — collapse changes only by
  user gesture or server command, P3 with no exceptions; the server
  half has since been deleted, D31). Bulk toggles
  survive only as the multi-group window header's toggle and the rail.
  Amended by D30: the MODEL keeps per-cell collapse, but the UI's
  minimize CONTROL now renders only where the cell is its whole stack.
  Amended by D31: the stacked bar's EXPAND is stack-scoped too, and the
  server collapse API is gone — per-cell collapse survives in the model
  (bar rendering, lone-cell toggles, rail drag-out stamping).
- **D17 (minimized floating stacks are stacked rows, 2026-07-04):** a
  floating window is ALWAYS a vertical stack of cells, each an expanded
  panel or a bar. The special all-minimized "chip bar" mode is deleted
  (with it: inline segments, the window-level right-end `+`, chip-cell
  drop wrappers, the window pill). Inserting into a minimized stack
  uses the ordinary stack seams.
- **D18 (no pills on minimized bars, 2026-07-04):** a minimized bar IS
  a handle in its entirety (gray chrome, grab cursor); a pill inside it
  is a redundant signifier. Pills remain on expanded headers, where the
  handle is a slice of a larger surface. The `strong` pill variant died
  with the window pill.
- **D19 (pane-provided minimized face; height and surface restored,
  2026-07-06):** a pane may provide a custom face for its bar (default:
  icon+title+N). A face-bearing lone pane's bar renders at the
  unmergeable header's OWN height (FACE_BAR_PX = the 2.75em header) on
  the panel's body surface: minimizing removes the content but never
  moves, shrinks, or recolors the label row. All other bars are the
  compact MINIMIZED_BAR_PX form, also body-surfaced (user-directed,
  2026-07-06: "a bar IS the panel, sleeping" — the earlier gray-surface
  uniformity traded this away and both trades were reversed on use).
  The MAIN PANEL's face is its connection-status row (action icons
  hidden) — old-viser continuity via a general mechanism, not a special
  case. Layout sites that reserve bar space (flex bases, band floors)
  agree with the bar's rendered height through one helper
  (`minimizedBarPx`).
- **D20 (band bar deleted; bars render in place, 2026-07-04):** the
  segmented HorizontalMinimizedBand form is deleted. A minimized cell
  renders as its bar IN PLACE at its column's width; a fully-minimized
  band is its cells' bars side by side and shrinks to bar height by
  ordinary flex. Retires D2's band-background drag. Accepted: a
  fully-minimized COLUMN beside expanded siblings shows its bars at the
  top with empty space below — honest geometry (the column holds its
  width; heights are content).
- **D21 (region collapse is an explicit action, 2026-07-04):** the rail
  never appears emergently when the last panel minimizes (a
  state-dependent form flip). An explicit chevron toggles
  `regionCollapsed[edge]`: collapsed → the 36px rail; expanded → normal
  layout, whatever the per-cell states. Expanding a panel FROM the rail
  un-collapses the region. Chevron placement is per D26; no chevron
  renders while collapsed (the rail's own header is the expand
  affordance). Generalized to column scope by D28.
- **D22 (nested-column stack handle deleted, 2026-07-04):** its old
  justification ("the handle signals coupled collapse") died with D16,
  so the sometimes-there column handle was removed and nested-stack
  cells move individually. Partially superseded by D27: multi-column
  regions render a per-column parent handle whose drag IS floatColumn —
  justified by scope honesty (P1/P12), not the coupled-collapse signal.
  Single-visual-column regions still have no column-level chrome.
- **D23 (inline region-collapse chevron, 2026-07-04; superseded by
  D26 on placement):** moved the chevron from a positioned overlay at
  the region's top corner into the top-right cell's chrome row, because
  an overlay cannot know how far panel-provided header content extends
  (it occluded the docked main panel's settings icon). Its surviving
  clauses — chevron is click-only, never drag-through; no chevron while
  collapsed — carried into D26/D28.
- **D24 (inert dividers, 2026-07-04):** a
  divider with nothing tradeable on one side is INERT — no resize
  cursor, no armed gesture, no height-pin side effect (a resize cursor
  that no-ops lies). Scope: height-trading dividers need an expanded
  cell on each side (bars are fixed 26px); width dividers are never
  made inert by bars (a bar carries its column's width, D20) but are by
  RAILED columns (fixed 36px chrome — D28 extension). When resizable, a
  height drag walks PAST bars to the nearest expanded neighbor
  (cascadeResize). Floating stack dividers carry the same ~12px grab
  overlay as docked ones (P11), only while resizable.
- **D25 (one `+` per rail; caps are always quiet pills, 2026-07-04):**
  the rail cell cap no longer flips between a `+` button (lone cell)
  and a pill (stacked): it is ALWAYS a quiet grip pill, and the rail's
  ONE visible expand signifier lives on the parent handle (P9). For a
  LONE cell, a motionless cap/background click still expands scope +
  group — unmarked backing surface (P9's hit-area rule); with 2+ cells
  a background click is inert (ambiguous target). Honest toggle labels
  (the flag-only expand must not claim "Expand all panes"); keyboard
  expand lands focus on the first revealed cell's active tab.
- **D26 (region parent handle, 2026-07-04; supersedes D23's
  placement):** user-directed redesign. A docked region renders a
  PARENT HANDLE: a slim full-width StackHandleBar above all its cells —
  single-panel regions included. Pill drag floats the whole stack as
  one window (the same gesture as the rail header it mirrors, P7); the
  region-collapse chevron sits at the bar's right end (the rail
  header's `+` spot, P13 position constancy); a motionless bar click
  also collapses (unmarked backing, P9). Rationale, in the user's
  words: the chevron on the top-right CELL's chrome row "appears on the
  first panel in a docked stack, but it really applies to all panels in
  the stack" — a P12 violation (cell chrome must act on cells;
  stack-scope actions belong on a stack-scope handle). Deleted with the
  move: the per-cell chevron slots, `regionChevronEdge`, the ~24px
  grip-bar hit-box overhang, and the tab strip's corner reservation.
  Scoped by D27: the region-wide handle holds only while the region is
  one VISUAL column.
- **D27 (parent-handle scope is a VISUAL COLUMN, 2026-07-04):**
  user-directed. With `[A][B]` zipped over `[A][C]`, in the user's
  words: "there are two columns. So there should be two separate parent
  handles. There's some weirdness right now where there's only one
  parent handle, and dragging it out produces [A]/[B]/[C]" — the
  region-wide handle covered two independent visual columns while its
  drag FLATTENED them into one stack (P1: the handle promised the
  region as one unit while the drop destroyed its structure; P8: the
  round-trip lost the shape; P12: one control spanning things that
  aren't one stack). As implemented: (a) a region where EVERY band has
  one column is one visual column — the region-level handle renders,
  drag floats the whole region (honest: the float preserves the stack);
  (b) any multi-column band suppresses the region handle, and each
  column of each band renders its own handle (`data-dock-column-handle`)
  whose drag floats THAT column via the existing floatColumn op (leaf
  order + height ratios preserved). D27 initially left column handles
  chevron-free — at the time no per-column collapsed form existed for a
  chevron to honestly promise — which D28 superseded by building one.
  Nice property: dragging a column out of a 2-column zip leaves a
  single-column region, so the region handle (chevron included)
  reappears automatically.
- **D28 (per-column rail — a chevron on every parent handle,
  2026-07-05):** user-directed. D21's rail state generalizes to the
  HANDLE'S SCOPE: `DockColumn.railed` renders that column as the 36px
  spine strip IN PLACE (ColumnRail: narrow header = the handle's
  collapsed mirror, spine cells below; width weight preserved for
  restore, P8), and column handles in multi-column bands carry the
  « / » chevron (ColumnCollapseChevron), collapsing exactly what the
  handle owns. The whole-region rail remains the single-column-region
  form: railing N stacked bands per-column would render broken stacked
  strips. CONVERSION rule, from the user's request — "if we dock a new
  column next to it we should end up with the new column still expanded
  and the original rail still minimized as a rail" — any op adding a
  side-by-side column to a region-railed region clears the region flag
  and rails the pre-existing columns individually, so docking next to a
  rail leaves the rail railed and the newcomer expanded (P5: the drop's
  result is visible). Everything that knew the region flag extends to
  the column flag: effectively-collapsed classification, rail drag-out
  stamping, float-width restoration, ownership signatures (`:r` term
  beside the region's `:R`, P6), every expand path (toggle,
  expandToTab, server `collapsed: false` — P5/P6), D12 band splits
  (fragments stay railed), and D13 zips (railed only when BOTH halves
  were). Lone columns in mixed regions keep pill-only handles — a
  railed lone column inside a full-width band would strand dead space —
  and width dividers flanked by a railed column go inert (D24).
- **D29 (unmergeable header chrome, 2026-07-05):** the DOCKED titleNode
  header always draws the gray top rule — the separator from the parent
  handle above it (floating keeps the stacked-only rule; a lone window
  has nothing above the header) — and the unmergeable header's minimize
  toggle is the COMPACT ChromeToggle (1.2em, 10px icon) for both title
  forms: the whole header is the click target (D6), so the toggle is a
  pure signifier and can shrink without hit-area cost (P11's
  backing-surface rule). The user judged the full-size form visually
  heavy beside the panel's own action icons.
- **D30 (one collapse control per scope, 2026-07-05; amends D16 and
  scopes D6):** user-directed. In the user's words: "Either all panels
  are minimized or none of them are. This would be simpler." The
  granularity story: one collapse control per scope, sitting on that
  scope's nearest handle. The cell-level `−` — the grip bar's toggle
  with its bar-click backing, and the unmergeable header's compact
  toggle with its header-click — renders only where the cell IS its
  whole VISUAL column (D27's scope; `isLoneInVisualColumn`): a docked
  panel with no other leaf in its visual column — the sole panel of a
  single-visual-column region, or a 1-leaf column of a zipped band —
  or a single-group floating window. A plain docked stack is ONE
  visual column, so none of its cells is lone (the model-column count
  would say otherwise: D12 canonicalizes plain stacks into single-leaf
  columns). A 2+ stack's collapse control is the stack's: the parent
  handle's chevron (docked; rails the scope) or the window header's
  toggle-all (floating) — a stacked cell offers NO cell-level minimize
  from the UI. EXPAND is deliberately ungated everywhere: every bar
  keeps its right-end `+` and click-to-expand, rails their spine rows
  (P5). D30 originally left that per-cell expand PER-CELL — "expanding
  one bar of an all-minimized stack remains legal, so mixed stacks are
  still reachable in the expand direction" — and kept the server's
  per-panel collapse axis (`panel.minimize()`); BOTH clauses are
  superseded by D31 (a stacked bar's expand is stack-scoped; the
  server axis is deleted). Still standing from D30: the control
  scoping itself, the model's per-cell flag (a collapsed group renders
  its bar wherever it lives), and the main panel's minimized face.
- **D31 (collapse is stack-scoped in BOTH directions; no server
  collapse axis, 2026-07-05):** user-directed, twice. On the server
  API: "Perhaps we should get rid of the `.minimize()` method in
  Python? it would be simpler that way." — `minimize()`/`expand()` and
  `GuiSetPanelCollapsedMessage` are DELETED; panel placement is
  position/width/height only (§8), and collapse changes only by user
  gesture (P3/P6 simplify: no collapse command to arbitrate, no
  collapsed replay bundle, no position→collapsed ordering rule). On
  the UI: "It's strange that panels in a stack can still be
  individually expanded after they're all minimized together." — D30
  had scoped only the MINIMIZE direction; D31 scopes expand the same
  way. A stacked bar's every expand affordance (`+` — labeled "Expand
  panels" — background click, title click) routes through
  `expandStackOf`: every group of the bar's VISUAL column (the
  floating window's stack; all bands of a single-visual-column region;
  the model column of a zipped band) expands through the shared expand
  internals, rail flags clearing too. Lone bars keep per-group
  behavior. Consequence: COLLAPSE ops can no longer produce or
  preserve a mixed stack — a stack minimized together expands together,
  so its bars stay uniform; the only remaining mixed-stack sources are
  structural composition (docking/dropping beside bars — no adoption,
  D16) and degradation, and P5's way out of those is exactly the
  stack-scope expand. The model keeps the per-cell flag (lone-cell
  minimize, rail drag-out stamping, bar rendering are unchanged).
