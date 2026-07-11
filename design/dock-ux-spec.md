# Dock & panels: design specification

This is the single normative description of the dock system — the layout
model, every surface and gesture, the drop system, sizing, collapse, and
the server placement API. Where the implementation disagrees with this
document, one of them is wrong, and we decide which on paper before
touching code. Decision rationale and the design's evolution live in git
history; the decision index (§12) keeps one line per decision ID because
code and tests cite them.

The system in one paragraph: everything lives at one of three nested
scopes. A **panel** (one tab group) sits in a **stack** (the vertical run
of panels that reads as one column: a docked visual column, or a floating
window's stack), which sits in a **region** (a left/right screen edge) —
or floats. Each scope has exactly one **handle** that moves it and one
control that collapses it, and each scope collapses as a unit into the
form its geometry can honestly keep: a floating panel into a 26px
**bar**, a floating stack into a window of bars, and any docked scope
into a 36px **rail**. Collapse itself is ONE state stored on the
container (D38): bars and rail are two renderings of it, and moving a
collapsed thing between worlds converts the rendering, never the state.
Structurally a docked region is a four-level tree — region stacks
**bands**, a band holds **columns** side by side, a column stacks
**cells**, each cell one group — kept in a canonical form so one picture
has one representation.

How to use it: new behavior questions get answered by §1 FIRST, then
encoded in the tables — if §1 can't answer, §1 is incomplete: fix it,
don't special-case, and park underivable rules on §11's open questions.
After any behavior change, re-trace the touched claims here (normative
text, gesture table, decision index) — the doc and the code must never
drift.

---

## 1. First principles

### 1.1 The scope model

| Scope | Definition | Docked form | Floating form |
|---|---|---|---|
| **Panel** | One tab group: ≥1 panes, one active tab. Carries NO collapse state (D38). | A cell of the tree. | A cell of a window's stack. |
| **Stack** | A VISUAL COLUMN: the maximal vertical run of panels the eye reads as one column. Docked: the whole region when every band is single-column; otherwise each model column of each band (D27). Floating: the window's stack. | A docked column (possibly the whole region). | The window. |
| **Region** | One screen edge (`left`/`right`): a vertical stack of full-width bands. | The edge's whole tree. | — |

Panel ⊂ stack ⊂ region, and scopes coincide freely: a sole docked panel
is simultaneously its panel, its stack, and its region; a single-group
window is a panel that is its whole stack. Coincidence is where the open
questions live (§11).

Two laws generate most of this document.

### 1.2 The handle law

Every scope has exactly ONE handle: a slim full-width chrome sliver that
is a drag surface in its entirety. Its anatomy is fixed:

- A centered **pill** — a signifier only (the whole surface drags).
  *Press + drag moves the scope*: a panel handle moves the group, a stack
  handle floats the column/window, a region handle floats the whole
  region as one stacked window.
- ONE control at the **right end** — the scope's collapse (« » chevron or
  `−`) when expanded, its expand (`+`) when collapsed. Position-constant:
  the control that undoes an action appears where the action's control
  was, in the SAME form at the SAME inset across the round-trip (D33).
  Every `−`/`+`/«/» carries a real tooltip (D35). All right-end controls
  are drag-through: a press flows to the handle's drag arbitration, a
  motionless click performs the control's action.
- The rest of the surface is **unmarked backing** for that control: a
  motionless click anywhere on the handle performs the right-end action
  (D6; P9's hit-area rule; P11's backing rule).

Presence rules, derived:

- The right-end control renders iff collapsing that scope is legal and
  has an honest collapsed geometry. A STACKED cell's grip bar has no
  `−` and no backing click (collapse is stack-scoped, D30). EVERY column
  handle carries the chevron, a band's LONE column included (D42): its
  rail is the 36px strip with the rest of the band as plain band body —
  legal geometry, so nothing gates it.
- When scopes COINCIDE, the LARGEST coinciding scope owns the collapse
  control (D32, citing P15): a sole docked panel — panel = stack =
  region — collapses only via the region handle's », to the rail; its
  grip bar is drag-only. The panel-level `−` (and its backing click)
  renders ONLY on a single-group FLOATING window — docked panels never
  carry a panel-level collapse control.
- A collapsed scope's handle ALWAYS keeps its expand control (P5), and
  while collapsed it is the scope's only handle — the chevron never
  renders beside a rail header (P9).
- Cell chrome acts on cells; scope actions live on scope handles (P12):
  no cell-level control ever collapses a whole column (D22), no
  stack-scope control ever sits on a cell's chrome row (D26).
- On handle MULTIPLICITY at coinciding scopes: floating merges the
  handles outright (a single-group window has no window header; the
  panel's grip bar moves the window and carries the `−` — which sets
  `window.collapsed`, D38; a multi-group window's header toggle sets the
  same flag); docked keeps the parent handle above the grip bar for
  layout constancy, with only one collapse control between them (D32).

The handles by scope and state:

| Scope | Expanded handle | Collapsed handle |
|---|---|---|
| Panel | Grip bar (unmergeable panels: the full-width header); hosts the `−` only on a single-group floating window (D32) | The bar (floating); inside a rail: the cell cap (pill only — its scope's `+` is the rail header's) |
| Stack (docked) | Parent handle (region- or column-placed per §1.1's visual column) | Rail header |
| Stack (floating) | Window header (multi-group; single-group windows: the panel's grip bar) | Window header, unchanged (D17) |
| Region | The stack handle, when the region is one visual column; NO handle otherwise (§11) | Rail header |

### 1.3 The collapse law

Collapse is ONE state, at STACK scope, stored per CONTAINER (D38):

1. **One state, container-stored (P15).** The model stores exactly TWO
   collapse flags, one per container kind: `FloatingWindow.collapsed`
   and `DockColumn.railed` (D44 deleted the regionCollapsed store: the
   packed region rail is a DERIVED rendering -- every band
   single-column, every column railed -- not a third state). There is
   NO group-level flag, so a partially collapsed stack is
   unrepresentable by construction. Groups don't collapse; the thing
   that holds them does.
2. **Two renderings of the one state.** A collapsed FLOATING container
   renders as its window of stacked bars at full `win.width` (face bar
   for a lone main-panel window) — width kept, since width has no one to
   yield to (D17/D20). A collapsed DOCKED container renders as the 36px
   rail — width reclaimed for the canvas (D21/D28). Bars vs rail is
   presentation chosen by context, never a state difference; the `−`
   (floating) and the » (docked) set the SAME property at their scope.
3. **Transfers are identity, not conversion.** Docking a collapsed
   window rails the landing column (or joins/creates the region rail);
   floating a railed column or region yields a collapsed window; a
   container created by dragging OUT of a collapsed scope (a torn-out
   pane, a dragged rail cell) is born collapsed. No stamping, no
   adoption, no mixed-state normalization. Groups dropped INTO an
   expanded container simply render expanded: collapse belongs to the
   container they left, not to them. (The reverse — an expanded panel
   inserted into a collapsed window — is an open question, §11.)
4. **Expand is one gesture, one flag.** Any expand affordance on a
   collapsed container — a bar's `+`, background, or tab label; the rail
   header, a lone cap, a spine row — clears that container's single flag
   (label/spine paths also activate their tab). Expand is never gated
   (P5).
5. **No store migration exists (D42/D44).** A railed column left as its
   band's sole column simply STAYS railed — its band renders the 36px
   strip with plain band body beside it, a legal state. The packed
   region rail is not a second store to trade flags with: it is the
   DERIVED rendering of "every band single-column, every column railed"
   (isRegionPackedOn). The region chevron rails every column
   (railRegion); the packed header's `+` expands every column
   (expandRegionRail); a spine-row expand clears just ITS column's flag
   — granular by adjudication — and drops beside railed content simply
   land where they land (band structure is never rebuilt to preserve a
   packed look).
6. **Client-only, instant.** Server placement is position/width/height —
   no collapse axis (D31). Collapse changes only by user gesture (P3),
   never emerges from state, and the model commits instantly; motion is
   presentation (P4/D34).

### 1.4 Principles

Axioms are marked (A); rules that derive from §1.1–1.3 are marked (D)
and kept under their historical numbers because code and tests cite
them.

**P1 — Honest hints. (A)** During a drag, the hint shows *exactly* what
the drop will do: the insertion line sits where the panel's edge will
land, a merge highlight covers exactly the group being joined, the
affected extent drawn is the extent changed. A hint may never promise a
smaller or larger effect than the drop delivers. Corollary for handles:
a handle covers exactly what its drag moves (D27).

**P2 — One gesture grammar. (A)** Everywhere in the dock:

- *press + move > 3px* = move the thing under the grip;
- *press + release, motionless* = the surface's primary action (activate
  a tab, expand a minimized group, a handle's right-end action);
- *Escape mid-drag* = "never mind": layout, sizes, and collapse states
  return to their pre-drag values;
- *Enter/Space on a focused element* = its motionless click.

No surface may bind these differently. A surface that can't support one
of them simply doesn't respond, it never reinterprets. Drags never
change collapse state — expanding is exclusively a click. State rides
with the container you drag (a rail floats as a collapsed window), and
what you drag out of a collapsed container is born collapsed.

**P3 — Content is sacred, chrome is quiet. (A)** Panels never move,
resize, or change collapse state except by (a) a user gesture, (b) an
explicit server placement command (position/size only), or (c) a
structural necessity spelled out in §7. Minimized forms are wayfinding
chrome: dimmed labels, compact geometry, no content preview, no
attention-seeking styling.

**P4 — Deterministic core; motion is pure presentation. (A)** The MODEL
commits instantly: no timers, no settle states, no logic gated on an
animation finishing. Every collapse transition MAY animate (D34) — but
only as presentation: one CSS transition (`collapseAnim`, 160ms) between
committed values, honoring prefers-reduced-motion (instant) and
suppressed under an active divider drag (`[data-dock-resizing]`). Drag
hit-testing re-reads geometry on `transitionend`, filtered to the eased
properties, so cached rects never lag the visible surface.

**P5 — No dead ends. (A)** Every reachable state offers a visible way
out: a collapsed scope can always be expanded (one click) and moved (one
drag); an all-minimized region still accepts docks; a hidden panel can be
revived by the server. Corollary: every visible surface of a draggable
unit is a drag handle for *something* — no inert pixels inside chrome.

**P6 — The user owns the layout; the server owns intent. (A)** Placement
is write-only from the server. A *new* server command always applies; a
*replayed/stale* command never overrides what the user has touched since.
The counter/run-id stamps make "new vs stale" decidable; there is no
other arbitration.

**P7 — Symmetry and analogy. (A)** Left/right are exact mirrors. Docked
and floating are analogs: a floating stack is a docked column that
happens to float; collapsed forms are one visual language rotated to
fit. A user who learns one surface has learned them all.

**P8 — Sizes are sticky. (A)** A panel keeps its width and height across
every move, minimize/expand round-trip, float/dock round-trip, and
reconnect, until the user resizes it or space constraints force a clamp.
Defaults (300px width) appear only for panels that have never had a size.

**P9 — One signifier per action. (A)** Every distinct action gets exactly
one visual signifier per view. Enlarging an action's *hit area* with
unmarked surface is encouraged (the backing rule); duplicating its
*iconography* is forbidden — a repeated icon reads as a different
action. Litmus: if an invariant makes two controls equivalent, they
merge into one signifier. A collapsed multi-group window applies it: its
bars carry no individual `+` — the window header owns expand, bar
surfaces are unmarked backing.

**P10 — Borders divide, they never enclose. (A)** A 1px line may separate
two adjacent siblings; a line may never OUTLINE a thing. Enclosure is
surface contrast and, floating, elevation — never a drawn boundary.
Exemptions, both state (not structure): the keyboard focus ring and the
accent underline on an active tab. Every divider and surface color is a
theme variable; light/dark parity is a requirement.

**P11 — Minimum hit targets. (A)** Every distinct drop zone is ≥8px in
its narrow dimension; every clickable control is ≥20px per dimension OR
backed by a larger unmarked hit surface (its host handle). A zone that
cannot afford its minimum in context is REMOVED, not shrunk (D4): a
sub-minimum zone converts intent into misfires.

**P12 — Granularity nests. (A)** The SMALLEST interactive unit under the
pointer owns the press (label → pane, cap → group, bar background →
group, handle → scope), and each enclosing unit gets exactly the surface
its children don't claim. A press never arms two levels at once.

**P13 — Minimize keeps the chrome, EXACTLY. (D)** A minimized panel is
its header with the body removed, and the constancy is exact: the label
row keeps identical x AND y offsets and padding, and the right-end
control keeps the same form at the same inset, across the round-trip
(D33). The bar carries the group's tab labels, dimmed, as many as fit —
overflow collapses to a `+N` badge for the REMAINDER only (D36) — or the
pane's minimized face (D19), with the `+` toggle at the RIGHT end
exactly where the expanded header's `−` sat. Bars sit on the panel's
BODY surface, not chrome gray: a bar is the panel, sleeping (D19). No
pill (D18): pills mark handles that are slices of larger surfaces; the
bar is handle in its entirety, and its labels are its identity. Face
bars keep the unmergeable header's exact height (2.75em), surface, and
content offsets. The rail is the documented exception: it exists to
reclaim WIDTH, so it is the header ROTATED — cap on top, spine rows
below, `+` on its header at the top.

**P14 — One structure per picture. (A)** Two layouts that render
identically must be the same model value. Canonical form, normalized at
every structural commit (never on pure weight changes, so a resize can't
restructure mid-gesture): (a) EXPANDED full-width vertical stacking is
BANDS — an expanded multi-leaf column may exist only when its band has
sibling columns (D12; a RAILED lone multi-leaf column is exempt — it
renders as one packed strip, its own canonical form, D42); (b) adjacent
bands with the same multi-column partition (~2px) zip-merge into one
band of stacked columns (D13).

**P15 — Correct by construction: invalid states are unrepresentable.
(A)** When a state is wrong, make it unrepresentable — by types, model
shape, or normalization at commit — rather than defending against it at
every consumer. P14 is its structural instance; D38's container-owned
collapse is its collapse instance. §10 catalogs the mechanisms.

### Non-goals

- **Keyboard layout rearrangement.** Click-level keyboard parity stays
  (focusable targets, Enter/Space, arrow traversal, Escape, focus
  restoration). No keyboard path for dock/split/merge/reorder.
- **Undo after commit.** Escape aborts an in-flight gesture; a committed
  drop has no undo. Mitigation is prevention: D1's zone balance makes
  destructive-by-accident drops hard to trigger.
- **Server-authoritative layout sync.** The client owns layout after
  placement; user drags are never reported back to the server (§8).

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Region** | The docked container on the `left` or `right` screen edge. Vertical stack of **bands**. |
| **Band** (row) | A full-region-width horizontal slice of a region. Holds ≥1 **columns** side by side. |
| **Column** | A vertical stack of ≥1 **cells** inside a band. Column widths divide the band. |
| **Cell** (leaf) | One tab **group** at a dock position. Cell heights divide the column. |
| **Group** | An ordered set of ≥1 panes (tabs) with one active tab. The PANEL scope; carries no collapse state (D38). |
| **Visual column** | The STACK scope's docked form (§1.1): the whole region when every band is single-column, else one model column of one band. |
| **Floating window** | A free box holding a vertical stack of ≥1 groups. The STACK scope's floating form. |
| **Bar** | The collapsed FLOATING rendering, per cell (D20/D38): one group of a collapsed window drawn as its 26px handle at `win.width`. |
| **Rail** | The collapsed DOCKED rendering: the scope packed into a 36px vertical strip of spine rows — a whole region (D21) or one column of ANY band, a band's sole column included (D28/D42; the rest of a sole rail's band is plain band body). Explicit only; never appears emergently. |
| **Collapse stores** | The ONE state's two container homes (D38/D44): `FloatingWindow.collapsed`, `DockColumn.railed`. The packed region rail is DERIVED (`isRegionPackedOn`), not stored. No group-level flag exists. |
| **Area** | A nested dockable surface inside a panel body (flat tab group; no splits). |
| **Main panel** | The control panel: an ordinary group in the MODEL (docks, stacks, floats, minimizes like any other) that opts into `unmergeable` and a titleNode header (the connection-status row; minimized face per D19). |
| **Unmergeable panel** | A panel that may never become a tab of another group (and vice versa). It renders a full-width header instead of a tab strip; drops on it offer splits/snaps only, never merge/insert. |

Chrome anatomy — every row is an instance of §1.2's handle anatomy:

| Term | Meaning |
|---|---|
| **Grip bar** | The panel handle atop an expanded cell (gray, ~0.9em): drag moves the group; hosts the `−` only on a single-group floating window (D32). Unmergeable panels render their full-width header in its place. |
| **Tab strip** | The row(s) of tabs below a grip bar; wraps to multiple rows. Pane-scope surface, not a handle. |
| **Pill** | The centered grip mark on a handle. A signifier only — the whole surface drags. True-centers in the handle's full width, so grip bars, parent handles, and window headers share one centerline (P7). |
| **Chevron** | The « / » collapse control at the right end of a parent handle; the rail's entry point. Drag-through like every right-end control. |
| **Parent handle** | The docked stack handle: a slim body-colored bar above the scope's cells, at region placement (single-visual-column region, D26) or column placement (each column of a multi-column region, D27). Drag floats the scope. |
| **Rail header** | The collapsed stack handle atop a rail — the parent handle's mirror. Drag floats the scope as a collapsed window (D38); click or `+` expands it. |
| **Cap** | The collapsed panel handle inside a rail: the gray top segment of one rail cell; drags that group. Always a quiet pill (D25). |
| **Spine row** | One tab's row inside a rail cell: upright icon above rotated title. |
| **Face** | Pane-provided content rendered in place of a bar's default icon+title (D19). |

---

## 3. Surface inventory

There are exactly FOUR forms — scope × collapse state, per the collapse
law: the expanded cell (§3.1), the bar (§3.2), the rail (§3.3), and the
floating window (§3.4). Anatomy is listed top-to-bottom / left-to-right.

### Parent handles (docked stack handles, D26/D27)

One handle per stack (§1.2), placed where the visual column is:

**Region placement (D26).** A docked region that is one visual column —
every band single-column — renders a slim full-width StackHandleBar
(`data-dock-region-handle`) above all its cells, single-panel regions
included. Drag floats the WHOLE stack as one window — honest because the
float preserves the stack exactly (P1/P8), and the mirror of the rail
header's drag (P7). The « / » chevron sits at the right end — the rail
header's `+` spot — with the handle's motionless click as its backing.
It renders only while the region is expanded; while railed, the rail's
own header is the handle (P9).

**Column placement (D27).** Any multi-column band suppresses the region
handle (it would span independent visual columns while its drag
flattened them — P1/P12); instead EVERY column of EVERY band renders its
own handle (`data-dock-column-handle`). Drag floats THAT column as a
stacked window (leaf order and height ratios preserved, P8). When the
column's band has SIBLING columns, the right end carries the chevron
(D28): it rails exactly that column in place; the handle's click backs
it. A band's LONE column carries the chevron too (D42): it rails that
column in place — the 36px strip with the rest of the band as plain
band body. The whole-REGION rail remains the single-visual-column form,
so the region chevron exists only at region placement. Dragging a
column out of a 2-column region leaves a single-column region whose
region handle, chevron included, reappears automatically.

### 3.1 Expanded cell (docked or floating-stacked)

- Grip bar: the panel handle (§1.2). Drag moves the group. On a
  SINGLE-GROUP FLOATING WINDOW it hosts the `−` and the backing click
  (D6/D32); everywhere else — every docked cell, every stacked floating
  cell — it is drag-only. The `−` is drag-through: dragging it moves the
  panel; a motionless click minimizes.
- Tab strip: one tab per pane; wraps; the empty strip area drags the
  group; the active tab is underlined in accent color. Pane scope: a tab
  press tears out / reorders that pane, a click activates it (P12).
- Body: panel content; scrolls internally; never a drag surface.
- UNMERGEABLE panels render no grip bar: the full-width header — plain
  title or titleNode — IS the panel handle, same rules: drag moves; on a
  single-group floating window a motionless background click toggles and
  the right end carries the `−`/`+`; docked or stacked, drag-only, no
  toggle. The toggle is the COMPACT ChromeToggle (1.2em, 10px icon, D29)
  at the same inset expanded and minimized (D33): the whole header is
  the click target, so the toggle is a pure signifier. A DOCKED
  titleNode header always draws the gray top rule (separator from the
  parent handle above); floating keeps the rule only when stacked.

### 3.2 The bar (the collapsed FLOATING rendering, D20/D38)

- One cell of a collapsed window (`window.collapsed`), drawn as its
  handle: 26px tall (`MINIMIZED_BAR_PX`), at full `win.width`, on the
  panel's BODY surface (a bar is the panel, sleeping, D19). A collapsed
  window is ALL bars (one per group of its stack, dividers between)
  under its header; mixed windows don't exist (D38).
- Anatomy (P13/D33): the group's tab labels, dimmed — ALL that fit, in
  order; overflow collapses to a `+N` badge naming only the REMAINDER on
  hover (D36) — then slack, then, on a SINGLE-GROUP window only, the `+`
  at the RIGHT end, at the `−`'s exact form and inset. A multi-group
  window's bars carry no individual `+`: the window header's toggle owns
  expand, and the bar surface is unmarked backing for it (P9). No pill
  (D18).
- Face (D19): a single-pane group whose pane provides a minimized face
  renders it in place of the default icon+title, inside the same hit
  surface (gestures and keyboard unchanged), at the unmergeable header's
  own 2.75em height and content offsets (D33). The MAIN PANEL's face is
  its connection-status row (action icons hidden).
- Gestures (collapse law 4; pane scope per label): a tab label's click
  expands the window to THAT tab; its drag tears THAT pane out into a
  new window born collapsed (a single-pane group floats wholesale, ids
  stable). The `+` (single-group windows, drag-through; aria "Expand
  panel") and any background press's motionless click expand the window.
  Tabs hidden behind the `+N` are one expand away.

### 3.3 The rail (the collapsed docked stack: whole region D21, one column D28)

- One form, two scopes. REGION scope (DERIVED, D44: every band
  single-column and every column railed — `isRegionPackedOn`): the
  whole region as ONE packed 36px rail holding every leaf across every
  band, contiguous. Entered via the region chevron (rail every column)
  or by railing the columns one at a time. COLUMN scope
  (`DockColumn.railed`): THAT column as the same rail IN PLACE, band
  siblings unaffected. Either way structure stays in the MODEL and
  returns intact on expand — the rail is a view. Expanded width is
  remembered (P8): `regionWidth` for the region, the width weight for
  a column. Expanding from the packed rail: the header's `+` expands
  EVERYTHING; a spine-row click expands just that panel's band
  (granular, user-adjudicated).
- Rail header: the collapsed stack handle (§1.2). Drag floats the scope
  as one COLLAPSED window (identity transfer, D38); click or `+` expands
  the scope, clearing ONLY the rail flag. Honest labels: "Expand panel
  area" / "Expand column" — never "Expand all panes". Keyboard expand
  lands focus on the first revealed cell's active tab — or on its header
  toggle when that panel is unmergeable (§4's fallback).
- Per cell: a gray cap — always a quiet pill (D25; the rail's ONE `+` is
  the header's); one spine row per tab (upright icon above rotated
  title), dimmed; hairline dividers between cells. A LONE cell's
  cap/background click still expands scope + group (unmarked backing —
  unambiguous); with 2+ cells a background click is inert (which cell
  would it mean?).
- Spine row click expands the scope AND that panel *to that tab* (ops
  clear the flags at the op level, §7); spine row drag tears out just
  that pane (born collapsed, D38); cap/background drag moves the whole
  group.
- Chevrons: « on the left edge, » on the right, always at the right end
  of a PARENT HANDLE (§1.2) — never on cell chrome. Drag-through like
  every right-end control. Collapse hands focus to the rail header that
  replaces the chevron, pointer and keyboard alike (edge case 14).
  Chevrons render only while expanded.

### 3.4 Floating window

- Multi-group: a window header — the stack handle — on top, ALWAYS
  present, even while collapsed (D17: a collapsed window is the same
  stack of cells, all 26px bars, at full `win.width`; no fit-content
  jump). Drag moves the window; its right-end toggle sets
  `window.collapsed` (D38). Single-group windows have no header
  (coinciding scopes merge, §1.2): the grip bar moves the window and
  carries the `−`, setting the same flag.
- Cells render as §3.1 without the docked context; a collapsed window
  renders every cell as its bar (§3.2). Mixed windows are
  unrepresentable (D38).
- Side grips resize width; top/bottom/corner grips resize height (pin),
  with a detent that snaps back to auto-height at the content height. A
  fully-minimized window keeps its WIDTH grips (D15 — the bars hold
  `win.width`, P8) and hides the vertical/corner grips (nothing to
  size); it ignores a pinned height.

### 3.5 Floating z-order and multi-client

- Any press anywhere on a floating window raises it to the front
  (capture phase; does not consume the press). Front order is paint
  order only — raising never reorders the DOM (in-flight clicks
  survive).
- Drops resolve back-to-front: targets are collected in front-order, and
  a nested area's targets rank immediately above their HOST window —
  above the host's own cells, below any window in front.
- Ownership is by the window's whole PAPER rect: the frontmost window
  whose rect contains the pointer OWNS it — only its targets (cells,
  hosted areas) are eligible, so a pointer on its header, divider gaps,
  or padding never resolves to an occluded docked panel or lower window.
  Seam dead-spot recovery is scoped the same way, and region-edge bands
  yield under the same rule: a drop over a float never docks THROUGH it.
- Multi-client: layout is per-client state; server placement commands
  fan out and each client's gate arbitrates against its own user's
  touches (P6). Clients never sync layouts with each other.

### 3.6 Mobile (no dock surface)

Below the mobile breakpoint (Mantine `xs`, ~576px width) the dock
surface does not mount at all: no regions, rails, floating windows, or
drag/dock. The control panel renders as the bottom sheet, and
standalone panels render inside it as an ACCORDION of bar-like
sections (D45): ONE identity row per panel, two states (P9: identity
never renders twice; P13: the bar is the header with the body
removed). Collapsed: dimmed tab labels + first icon, rotating chevron
right, the whole row a tap target. Expanded, single-tab panel: the
header stays and the content renders below WITHOUT a tab strip.
Expanded, multi-tab panel: the REAL tab strip takes over the header
row (tabs activate on tap; the chevron alone collapses). Sections
start COLLAPSED (the sheet is wayfinding chrome on a small screen);
several may be open at once. `visible` is honored (hidden panels render
no section); sections sort by server-side `order`. Placement axes
(position/width/height) do not apply off the dock surface; they replay
when the viewport widens and the dock remounts.

### 3.7 Nested area

- A flat tab strip + body inside a host panel. Drops:
  insert-at-tab-position over its tab strip, merge elsewhere. Never
  splits, never minimizes separately.
- A frame of the host panel around the area stays hot for the HOST's
  zones, so a full-bleed area doesn't make the host undockable-beside
  (P5).

---

## 4. Gesture reference

Threshold: a press becomes a drag past 3px of motion
(`MOTION_THRESHOLD_PX`, strictly >3px); below that, release is a click.
One active gesture at a time; extra pointers are ignored.

Every row below follows from §1 — *a press on a handle drags its scope;
a motionless handle click is its right-end action (backing); pane-scope
surfaces (tabs, labels, spine rows) act on their pane; every affordance
on a collapsed container acts on its ONE flag (D38)* — except where
marked ⚠ (stated, not derived; see §11).

| Grabbed surface | Drag moves | Motionless click |
|---|---|---|
| Grip bar (expanded, single-group floating window, D32) | that group (= the window) | toggle minimize (backing for the `−`, D6) |
| Grip bar (expanded, docked or stacked cell) | that group | — (no panel-level minimize; the scope's control is its handle's, D30/D32) |
| Tab strip background (expanded) | that group | — |
| Unmergeable header (full width, either title form) | that group | toggle minimize (single-group floating window only, D32; drag-only docked/stacked) |
| `−` minimize button (single-group floating windows only, D32) | that group (drag-through) | minimize group |
| Tab | that pane (tear out / reorder) | activate tab |
| Window header (floating multi-group) | whole window | toggle `window.collapsed` (D38) |
| Bar background (incl. right slack) | that group — its new window born collapsed (D38) | expand the window (clear its flag) |
| Bar tab label / face (all labels that fit, D36) | that pane — new window born collapsed | expand the window to that tab |
| Bar `+` (right end; single-group windows only — a multi-group window's expand is its header's, P9) | that group (drag-through; born collapsed) | expand the window ("Expand panel") |
| Region parent handle — pill / background | whole region (as one stacked window) | collapse region to the rail (backing for its chevron) |
| Region-collapse chevron | whole region (drag-through) | collapse region to the rail; focus hands off to the rail header (both input paths) |
| Column parent handle — pill / background | that visual column (as one stacked window, height ratios preserved) | rail that column when the handle hosts a chevron; ⚠ no action on a pill-only handle |
| Column-collapse chevron (every column handle, D28/D42) | that visual column (drag-through) | rail that column; if it was the band's LAST expanded column, the nearest railed sibling expands (tie → left) so the band keeps one expanded column (D43); focus hands off to the column rail's header (both input paths) |
| Rail header (region or column scope) | that scope — floats as one COLLAPSED window (identity transfer, D38) | expand the scope (a column rail clears its column's flag; the packed rail's `+` expands EVERY column, D44) |
| Rail cell cap / background (quiet pill) | whole group — new window born collapsed | expand scope + group (lone cell only; inert with 2+ cells) |
| Rail spine row | that pane — new window born collapsed | expand scope to that tab |
| Region resize divider | region width (expanded columns only; railed columns ride as fixed chrome, §6) | — |
| Column (width) divider inside a band | neighboring columns' widths (inert only when a RAILED column flanks it — bars never make it inert; they hold their column's width, D20/D24) | — |
| Band (height) divider between bands | neighboring bands' heights — always live and free (D41): shrinking a rail band scrolls its spine, growing past its spine is allowed, and a drag landing within 8px of the spine content DETENTS onto it (re-entering auto/content-tracking mode) | — |
| Height divider (expanded stack) | neighboring cells' heights | — |
| Height divider (collapsed window — bars each side) | — (INERT, D24: nothing tradeable) | — |
| Window edge/bottom grips | window size | — |

Escape during any of the above restores the exact pre-gesture layout,
including region widths and collapse states.

Keyboard: every click target above is focusable (visible focus ring),
with Enter/Space performing its motionless click. Tab strips and rails
are `tablist`s with arrow-key traversal: Left/Right on strips, Up/Down
on rails; a bar is a `tablist` of its visible labels (D36). Focus never
falls to `<body>`: after a keyboard expand it lands on the revealed
tab — or, when the revealed cell renders no tab strip (an unmergeable
panel's full-width header), on that header's toggle; after a keyboard
minimize/collapse — whose control unmounts with its surface — it hands
off to the same-spot control that undoes it (a bar's `+` or the window
header's toggle, the rail's header). The handoff runs on the POINTER
path too: the activated control unmounts under the click either way, so
pointer collapse hands focus to the same replacement control.

Touch: all drag surfaces set `touch-action: none`; a browser-cancelled
pointer aborts like Escape (P2).

---

## 5. Drop system

### 5.1 Zone taxonomy, outermost to innermost

Zones nest like the scopes: region-scope zones at the region's boundary,
panel-scope zones inside cells, pane-scope zones on tab strips. Priority
is resolution order — outer boundaries first — with ONE inversion (item
2): the most specific expressible intent overrides. Pixel values are
constants in `hitTest.ts`; changing one is a spec change.

1. **Empty screen edge** (48px at an edge with no region): docks as the
   region's first content, full height. Active past the screen edge
   (slam gestures).
2. **Insertable tab strip** (override, ⚠ inversion): a pointer over a
   tab strip where a tab insert would resolve always beats region-level
   bands — specific intent beats broad intent (§11, T8).
3. **Region edge bands** (occupied edge): 8px top/bottom bands insert a
   full-span band above/below everything; 40px outer/inner side bands
   dock a column at that side, each capped to a third of the region
   width so the middle third stays for per-cell zones. The full-span
   side result ("beside everything") survives only where it is honest:
   a single band, a canonical stack (all bands single-column — the drop
   ZIPS the bands into one nested column), or a region-railed region. A
   non-zippable multi-band region (rows can't nest) resolves side hits
   PER BAND instead: a hit at y over band N inserts a column at band N's
   outer edge — a split on the outer column's nearest-y leaf, hint
   band-tall (P1) — so a pointer over band N never commits into band M.
   Except in a region-railed region (whose bands narrow to thirds over a
   cell, leaving its middle zones reachable), the side bands YIELD
   entirely to any collapsed docked cell under the pointer: a 40px band
   would shadow a whole 36px rail whose own sliver already docks a
   column beside it — including a rail abutting the region edge, where
   the band cedes its entire claim. And the per-band claim extends
   INWARD over any run the band's content doesn't reach: an all-railed
   band packs its strips and leaves an empty tail whose only honest
   meaning is "split beside the outermost rail", not dead space.
   Suppressed where they'd duplicate a per-cell split (single leaf
   edge-wise) and while a floating window's paper rect owns the pointer
   (§3.5). Over a region-railed region's EMPTY area, the side bands
   widen to left/right HALVES — no dead center stripe. The 8px
   top/bottom band-inserts and item 4's seams are SUPPRESSED over a
   region-railed region: a band-insert into a rail has no honest
   geometry (D39 — the expanded newcomer would be swallowed collapsed),
   so those pointers fall through to the rail's own cell zones and the
   drop JOINS the rail. A seam band-insert takes an equal share of
   region height (the MEAN of existing band weights) — a fixed weight
   could render as a 0px sliver on a px-scale region.
4. **Cross-band seams**: the divider between two bands inserts a new
   full-width band at that index. Band extents come from rendered cell
   rects, and an all-railed band's cells are content-tall — so its
   extent extends to the RENDERED band box, derived from its neighbors'
   edges and the container's; the seam sits at the true divider, never
   mid-band. The region-railed packed strip has no band boxes at all:
   its seams are suppressed with item 3's band-inserts — drops join the
   rail (D39).
5. **Per-target zones**: the cell-, rail-, and bar-level zones of
   §5.2–5.4.
6. **Anywhere else**: no drop; release floats the dragged stack at the
   pointer (D7 — motion means move; Escape is the abort).

### 5.2 Expanded docked cell zones

- Above the tab strip (the grip bar): split above this cell.
- Over the tab strip: insert at that tab position (2D nearest-tab, works
  with wrapped rows).
- Content side bands (30% of width, ≤120px): split left/right of this
  cell. If the cell's column is the band's only column, the drop
  *band-splits* so the new panel sits beside just this cell; otherwise
  the new column spans the band and the hint is drawn band-tall (P1).
- Content top/bottom bands (25%, ≤100px): split above/below this cell.
  The content-TOP band splits ABOVE — it repeats the grip bar's intent —
  so merge stays reachable only in the middle.
- Content center — roughly the middle third each way — merges (become a
  tab). Splits are the casual default; merging requires aim (D1: the one
  destructive-by-accident gesture is an unwanted merge). Suppressed for
  unmergeable panels.

### 5.3 Rail cell zones (§5.2 rotated; identical in region and column rails)

- 8px outer/inner side slivers: dock a column beside.
- 8px top/bottom edges (`MINIMIZED_EDGE_BAND_PX` — P11's floor): stack a
  cell above/below.
- Over a spine row: insert at that tab position.
- The rest, cap included: merge into that group, staying minimized.

A COLUMN rail's droppable surface is the FULL band-tall strip, not just
its content-tall cells: the header run above the first cell belongs to
that cell (top 8px stack-above, then insert at position 0) and the empty
tail below the spine rows to the last cell (side slivers run full
height; the middle is stack-below, with the hint at the spine content's
true bottom — where the new cell actually lands — not the strip's far
bottom). Interior cells keep their own boxes. Region-rail cells stay
content-sized: the region-rail halves bands (§5.1 item 3) already cover
the strip's empty area.

### 5.4 Bar zones (in-place minimized cells)

- A bar's whole slot is a drop target: drop merges into that group,
  staying minimized. Insertion at a tab position aims at the bar's
  visible tab labels (D36); a drop right of the last label appends.
- Docked bars do not exist — docked collapse renders as the rail (D38),
  and the rail's zones are §5.3's.
- Floating bars are ordinary stack cells (D17): top/bottom snap zones of
  `min(10px, barHeight/3)` — ≈8.67px on the 26px bar — insert into the
  window's stack at that seam. Thirds because a flat 10px is
  unsatisfiable on a 26px bar (two 10px zones would leave a sub-8px
  merge middle); thirds keep all three zones at P11's floor.

### 5.5 Hints and previews

- **Line** = an insertion boundary (3px bar) at the true landing edge,
  spanning the true affected extent. **Merge highlight** = the whole
  group being joined. **Fill** = a translucent block for empty-edge
  docks (no boundary to point at).
- Top/bottom splits additionally shrink the target cell live to vacate
  the space (contents scroll; no distortion). Left/right splits show
  only the line. Collapsed targets never shrink.
- Drop targets are snapshotted at drag start and refreshed on any layout
  change, container scroll, or window resize; a floating window growing
  MID-DRAG also marks the cached rects stale. Hints never lag the
  visible geometry.
- Divider gaps are never dead spots, in EITHER axis: the horizontal gap
  between stacked docked cells maps to the seam split it sits in the
  middle of; the vertical gap between side-by-side columns to the column
  insert at that seam (left half splits right of the left cell, right
  half left of the right cell — the same landing, mirror-symmetric, hint
  at the gap center); a floating stack's gap to the snap at that index —
  the hint never flickers to "no drop" crossing a seam.

Collapse is the container's (D38), so drops need no adoption or
normalization rules: a group joining an expanded container renders
expanded; a pane merged into a collapsed container's group becomes a tab
inside it, still collapsed — dropping into a minimized target never
expands it (edge case 1). Whether INSERTING an expanded panel into a
collapsed window collapses the newcomer (container rule) or expands the
window is an open question (§11).

---

## 6. Sizing model

- **Region width**: expanded columns of the width-determining band (the
  widest) carry pixel widths; the region's width is their sum, with
  every RAILED column counted at its rendered 36px — a railed column's
  stored weight is ALWAYS its P8 restore width, and no aggregator ever
  reads it as rendered width (D40). Docking a new column *grows* the
  region by the newcomer's width (D3): existing panels never shrink
  because something arrived (P3 outranks canvas preservation; the
  resizer is the recovery). The newcomer's width IS the dragged window's
  width — every drag-dock path floats first, so the window still carries
  it — born railed included: the new column STORES the window's width,
  so the rail round-trip restores it, and contributes only the rendered
  36px strip. Columns with NO source window (server-built / injected
  layouts) take the 300px region default as their restore width even
  when born railed; the 36px rendered accounting keeps an injected
  all-railed row from reserving phantom 300s. D3 binds every band, not
  just the width-determining one: a narrower band gaining a column never
  halves its survivors. A RAILED column renders at the fixed 36px rail
  width, stored weight preserved (P8) — never silently rewritten by a
  drop; the resizer redistributes over EXPANDED columns only, and the
  region stops being width-resizable when it is railed or every
  width-determining column is.
- **Minimums**: expanded columns / regions / windows ≥ 96px grab width
  (`MIN_REGION_GRAB_PX`; the ~220px CONTENT minimum is the body's —
  below it the panel scrolls horizontally); cells ≥ ~50px; windows ≥
  50px height, floored at the content height when shorter. Resizes
  clamp; they never squeeze a cell below its header. The cell minimum is
  also a RENDER floor on expanded docked leaves — without it repeated
  same-target splits clip the smallest cell's chrome. An all-railed band
  floors at a 60px grab height (`ALL_RAILED_BAND_MIN_PX`) — its spine
  scrolls at any height, so its live seam clamps there rather than at a
  per-leaf sum.
- **Band heights (D41)**: EVERY band — rail or expanded — sizes by its
  weighted share (`flex-basis:0` + `flex-grow`), with NO maximum height:
  panels don't have maximum heights, and neither do bands. "No dead gray
  below the spine" is a DEFAULT, not a wall — the auto/pinned model
  floating windows already use, applied to rail bands: when a band
  BECOMES all-railed (and an expanded band exists to reclaim the
  difference), its weight SNAPS to its measured content height (the
  tallest spine), committed before paint so the stale share never shows.
  While a band sits AT its snap default it keeps TRACKING content
  (webfonts landing after the first measure, label renames — fonts.ready
  plus a spine-cell ResizeObserver re-snap it); once the user drags its
  seam away from the default it is PINNED and never re-snapped — and a
  drag landing back within 8px of the content height DETENTS onto it
  exactly, which also resumes tracking (the detent un-pins, mirroring
  the window rule). Snapped px commit alongside every sibling band's
  rendered px rescaled so the total still fills the region — weights
  render as ratios, so a lone px write would rescale everyone and miss
  the content height. When the region is ALL rail bands (nothing to
  donate to), no band snaps and weighted shares FILL the region
  uniformly. A huge MANY-tab rail never overflows (a grow share can't
  exceed the container; the spine scrolls internally). Rails stay
  SEPARATE — an all-rails band is side-by-side rail columns, never
  merged; each column fills the band height, and every divider rule
  (rail-to-rail included) runs the FULL band height: a rail column's
  body is the whole band, empty tail included, so the boundary between
  two columns spans their whole shared edge. An inert rail-to-rail
  divider renders dimmer than a live resize handle so the two read
  distinctly.
- **Split defaults**: a top/bottom leaf drop and a left/right column
  drop both default the two sides to HALF the target's current weight —
  sibling weights may be on any scale (divider drags write px), so only
  a scale-invariant default keeps the hint's 50/50 promise (P1). A
  RAILED target column is exempt: its weight is a P8 restore width, not
  a rendered share — halving it would permanently corrupt the expand
  width, so it stands and the newcomer takes a width default instead. A
  multi-group stack dropped top/bottom divides its half among its leaves
  by the stack's preserved height ratios (P8).
- **Dividers** (D24): a divider is INERT — no resize cursor, no armed
  gesture, no height-pin side effect — unless something tradeable sits
  on EACH side (a cursor that no-ops lies). Height dividers need an
  expanded cell each side (bars are fixed 26px); width dividers go inert
  only beside a RAILED column (fixed chrome, D28). BAND dividers are
  always live and FREE (D41): a rail band's height is a plain weighted
  share, so there is always height to trade — dragging into it squeezes
  it below its content (the spine scrolls), dragging away grows it
  freely past the spine (the dead gray is then the user's explicit
  choice), and a drag landing within 8px of the spine content DETENTS
  onto it (`BAND_CONTENT_DETENT_PX`). A band divider drag computes new
  weights from the bands' RENDERED px snapshotted at gesture start, not
  their stored weights — stored weights can sit on another scale
  entirely. Floating stack dividers carry the same ~12px invisible grab
  overlay as docked ones (P11) — only while resizable.
- **Stack grow normalization**: flex-grow factors normalize per site
  over EXPANDED cells only — minimized cells render flexGrow 0 — so
  freed space is never stranded (edge case 16). The BAND level is the
  one exception (D41): every band, rail bands included, carries its
  weighted grow — rail bands hold real height there; the
  snap-to-content default is what keeps that height honest.
- **Round-trips** (P8): float→dock carries height ratios into the
  column; dock→float restores the remembered window size;
  minimize→expand holds width by construction; rail→expand restores the
  pre-collapse width at either scope — a column born railed from a
  window expands to that window's width (D40); a railed column dragged
  out floats at its preserved expanded width; reconnects replay the same
  sizes.
- **Windows**: auto-height tracks content up to the container; pinned
  height is user-set via the bottom grip; the content-height detent
  un-pins. A fully-minimized window ignores pinned height.

---

## 7. Collapse operations and conversion

The collapse law (§1.3) states the semantics; this section is the
op-level residue.

- Stores and ops (D38/D44): the `−` / window-header toggle flips
  `FloatingWindow.collapsed`; the column chevron sets
  `DockColumn.railed`; the region chevron rails EVERY column
  (railRegion — the packed rail is derived, not stored); every expand
  path clears column flags. Ops act on containers; groups carry nothing. Collapsing a
  missing scope is a no-op; clearing is always legal. Any column may
  rail, a band's sole column included (D42) — setColumnRailed sets
  exactly the flag it is named for; scope ROUTING (a single-visual-
  column region collapses via the region store, D32) is
  collapseContainerOf's job.
- ACCORDION (D43, user-directed): railing the LAST expanded column of a
  multi-column band expands its nearest railed sibling (tie → left), so
  the rail gesture always leaves the band with one expanded column —
  collapsing "Stats" beside a railed "Tools" hands the band to Tools
  instead of stranding a wide band of nothing but strips. This is the
  adjudicated P3 exception: the one expand no gesture aimed at
  directly. Drops are untouched — identity transfers can still build
  all-rails bands (D41's snap/height rules govern those); a sole-column
  band has no sibling to hand off to (D42).
- Expand ops clear docked flags at the op level (D21/D28): any op that
  expands a docked panel (a spine-row expand-to-tab, a toggle landing
  expanded) clears the region flag AND the containing column's railed
  flag — an "expanded" panel hidden behind a rail would be a dead end
  (P5). The rail header's click/`+` clears only its scope's flag; a
  spine-row click also activates that tab.
- Rail toggles commit as USER ops, and the docked flags join every
  resident's ownership signature (P6, `:r`/`:R` terms) — else a stale
  single-axis server replay could silently re-flip a rail the user just
  set.
- Conversion is store distribution, not state change: ops adding a
  side-by-side column to a region-railed region clear the region flag
  and keep the WHOLE old rail railed as ONE consolidated column beside
  the expanded newcomer (P5; D28). A rail built from stacked bands
  becomes one railed column (its cells stacked, as the packed rail
  already rendered them) — one visual unit stays one unit. Where both
  docked flags exist, region takes render precedence.
- Structural carry: a D12 band split leaves fragments of a railed column
  railed (same picture re-expressed, P14) — but a RAILED lone
  multi-leaf column is EXEMPT from the D12 split itself (D42): it
  renders as one packed strip, its own canonical form, and splitting it
  would change the picture. EXPANDING such a column splits it into
  bands at the op (rail flips skip normalize, so D12-canonical form is
  reached by construction). A D13 zip keeps the flag only when BOTH
  halves carried it. A railed column left as its band's sole column
  simply stays railed (collapse law 5) — no migration, no forced
  expand.
- Transfers (collapse law 3): floating a railed scope by its header
  yields a COLLAPSED window; docking a collapsed window rails the
  landing column, band, or region — identity with NO exceptions (D42
  restored the band-insert case: a collapsed band-insert lands as a
  railed sole-column band); any container created by dragging out of a
  collapsed scope (spine row, cap, bar label) is born collapsed. No
  stamping exists; server `float()` moves geometry and touches no
  collapse, and a server docked→docked position move carries the source
  container's collapse the same way — identity on both paths (§8).
- A railed scope reserves exactly 36px; it is still a full drop target,
  and a railed region still hosts region-edge docking on its outer side.

---

## 8. Server placement (the panels API)

The Python surface: `server.gui.add_panel()` returns a `PanelHandle`
(content via `add_tab`; placement via `dock_left/right`,
`dock_above/below(anchor)`, `float(x, y, width, height)`; sizing via
`set_width`/`set_height`; lifecycle via `remove()` and `visible`), and
`server.gui.main_panel` wraps the control panel with the placement/
sizing subset. Both exist on `server.gui` (broadcast) and `client.gui`
(per-client). The contract:

- **The server owns existence; the user owns arrangement.** Panels have
  no close affordance in the UI — they exist until `remove()`. Users
  rearrange, resize, and collapse freely; none of it is reported back to
  the server (no getters for position/size/collapse state).
- Three independent write-only axes per panel: position, width, height.
  There is no collapse axis (D31). A message carries exactly one axis;
  applying one can never disturb another (no yank by construction).
- Moves are identity for collapse (collapse law 3): a position command
  on a docked panel that lands docked carries its container's collapse —
  a railed source lands railed — exactly like the user path. A placement
  command never expands a railed panel.
- Fresh vs stale: each panel has a monotonically increasing layout
  counter per server run. An axis message applies iff the user hasn't
  touched that panel since the message's stamp, or the stamp is provably
  newer than the last applied (P6; `placementGate.ts`). Late joiners
  replay the latest message per axis and reconstruct the same placement.
- A replay bundle applies position first, then size — size ops resolve
  against the panel's FINAL location.
- Split placements (`dock_below(anchor)` etc.) defer until the anchor is
  actually docked; a never-dockable anchor (hidden, emptied, cyclic)
  falls back to a right-edge dock rather than hanging (P5). Anchors must
  share the panel's scope (`main_panel` is a legal anchor from any
  scope); cross-scope anchors, self-anchors, and removed anchors raise
  `ValueError`.
- `visible = False` removes the panel from the dock without destroying
  it; `True` re-places it via its stored placement axes.
- `set_width` applies as the region width when docked and the window
  width when floating; `set_height` sets a floating window's height and
  is a documented no-op on docked panels (docked cells size to split
  weights).
- `gui.reset()` removes standalone panels like other GUI elements;
  `configure_theme(control_layout=...)` is soft-deprecated in favor of
  `main_panel` verbs (`control_width` remains the theme default width;
  `set_width` overrides).
- Known sharp edges, accepted by design: re-issuing a placement verb
  overrides whatever the user did (a periodic `dock_right()` loop will
  fight the user); per-client placement reaches only currently-connected
  clients; notification offsets track only the control panel.

Planned (adjudicated, not yet shipped): placement messages become four
per-axis `update_simple` messages (position / width / height /
collapsed) with client-owned placement state, replacing the coalesced
placement dict — `set_width` structurally cannot carry a position, so
the gate's per-field arbitration simplifies further.

---

## 9. Edge-case ledger

Behaviors that MUST hold (each is or should be pinned by a test):

1. Drop on a minimized target merges *without expanding it*; a drop
   beside a collapsed container never collapses the dropped stack, and a
   group joining an expanded container renders expanded — consequences
   of container-owned state (D38).
2. Escape mid-drag restores pre-gesture collapse flags along with the
   layout — drags never change collapse (P2).
3. Dragging a `−`/`+` button never toggles; a motionless click never
   moves (drag-through arbitration, §1.2).
4. A viewport resize between press and drag-threshold doesn't teleport
   the window (grab offsets resolve against the current model position).
5. Undocking a minimized panel then expanding restores its docked width,
   not the 36px rail width (P8).
6. A pinned-height window expands from minimized at its pinned height.
7. The last panel leaving an edge nulls the region; the next dock
   recreates it at the remembered width (P8).
8. An emptied-then-revived docked panel reappears (no orphan group).
9. Same-batch and reversed-order anchor splits both resolve (no race, no
   hang); never-dockable anchors fall back (§8).
10. Wheel-scrolling a tall rail mid-drag doesn't desync drop targets
    (§5.5 snapshot refresh).
11. A drop into a wrapped tab strip's second row lands at that row's
    index.
12. ONLY the container flags produce collapsed renderings (collapse law
    1) — a rail never appears emergently — and expanding any panel from
    a rail clears the owning flag. A docked scope never renders in-place
    bars: the rail is the docked rendering (D38).
13. Region-edge docking beside a railed region stays reachable from the
    outer half of the rail (§5.1 item 3).
14. Bar/rail keyboard expand moves focus onto the revealed tab strip (an
    unmergeable reveal: its header toggle, §4); keyboard
    minimize/collapse moves it onto the replacement control. Neither
    direction — on either input path — drops focus to `<body>`.
15. Left/right mirrored layouts resolve mirrored drops everywhere (P7,
    swept).
16. Expanded content absorbs ALL space freed by collapsed chrome — no
    band/column/stack ever strands dead area from fractional grow sums
    (normalization over expanded cells only, §6; band heights via the
    snap default).
17. Docking a column beside a region-railed region consolidates the rail
    (§7): the whole old rail becomes one railed column (stacked bands
    included) beside the expanded newcomer — never a half-railed split.

Accepted trade: on a LEFT region squeezed into the scrolling state, the
RegionResizer's 5px over-the-panel strip (below the 48px chrome
clearance) overlaps the column scrollbar's outer edge. The scrollbar's
remaining width still scrolls, and narrowing the straddle would cost the
region-resize grab everywhere for a rare degenerate state.

---

## 10. Model integrity (correct by construction)

P15's mechanisms, as shipped. The recurring bug classes each mechanism
retires are unrepresentable or caught at commit — not defended against
at every consumer.

- **Invariant checker** (`dock/layoutInvariants.ts`): one function
  defines "valid layout" for the app AND the fuzzer. `applyOp` asserts
  it on every commit in dev (console.error, never throw) and
  time-throttled in production. Hard invariants include: no duplicate or
  orphaned panes/groups; no un-migrated legacy `regionCollapsed` field
  (D44: injection/restore chokepoints run
  `migrateRegionCollapsedInPlace`); `regionWidth` ≈ Σ over the width
  row of (railed ? 36 : weight). (Retired: "no railed sole-column
  band" — D42 made it legal; "regionCollapsed ⇒ docked edge / all
  bands single-column" — D44 deleted the store.)
  `canonicalViolations` is the parallel SOFT set (transient-tolerant;
  normalization owes convergence, not instantaneous truth); an EXPANDED
  lone multi-leaf column is its D12 half — a RAILED one is exempt
  (D42: one packed strip is its own canonical form).
- **Canonical form** (`normalizeCanonicalBandsInPlace`): P14's D12/D13
  rules run on every STRUCTURAL commit; `structureSignature` ignores
  weights and collapse flags, so weight-only and rail-flip commits skip
  normalize — which is why collapse ops must reach legal states BY
  CONSTRUCTION, not rely on a later normalize (e.g. expanding a railed
  lone multi-leaf column splits it into bands at the op, D42).
- **Single construction sites / choke points**: `movePaneInPlace`
  (detach-first — a pane can never be in two groups),
  `detachAllPreservingStackWeights` (capture-before-detach ordering
  unviolatable), `planRegion` (parallel fields built at one site),
  `patchFloatPositions` (the one sanctioned commit bypass; its type
  makes the position-only claim structural), `api.replace()` (the one
  wholesale-injection entry; seeds the fresh-id floor).
- **Types**: flavored `PaneId`/`GroupId`/`WindowId`/`NodeId`/`AreaId`
  (mutually unassignable); `WindowHeight` as `{mode:"auto"} |
  {mode:"pinned"; px}` (pin-trap unrepresentable); float ownership as
  one optional `anchor: {x; y}` object (presence = anchored; half-set
  ownership unrepresentable); `TabGroup.activeId: PaneId | null` (no
  `""` sentinel); `makeGroup(NonEmpty<PaneId>)`.
- **Placement protocol**: per-axis `(counter, runId)` stamps + one
  shared gate (`placementGate.ts`) for the main panel and standalone
  panels; split placements defer on their anchor via a synchronous store
  predicate, with a timeout only as a stale-state tripwire.

Planned structural work, in order: server-provided stable panel key
(identity as input, not label+order inference); column weights always
px (retiring the three-way weight decode); a placement coordinator (one
ordered pass over the placement store, replacing per-panel effect
fan-out).

---

## 11. Open questions

Unadjudicated; do not resolve in code without recording the decision in
§12.

- **Expanded panel inserted into a collapsed window**: collapse the
  newcomer (container rule — what code does consistently today) or
  expand the window? Adjudicate before wiring the snap zones.
- **T3 — The bar breaks the handle anatomy.** A bar has no centered
  pill; its labels sit left; face bars replace the anatomy wholesale.
  The rail cap — the same scope, collapsed differently — keeps the pill
  and drops the control. Reconciliation on record (D18: pills mark
  handles that are slices of larger surfaces; the bar keeps HEADER
  anatomy — identity left, control right), but a stacked cell's grip
  bar is also handle-in-its-entirety and keeps its pill. Options:
  restate the anatomy law as two-tier (identity-bearing headers vs
  anonymous slivers) — spec-only; or restore the pill (rejected on use).
- **T7 — The region scope loses its handle in multi-column regions.**
  One-handle-per-scope fails there: the multi-column region has no
  region handle, so no region-wide collapse (D42 gave the LONE column
  its chevron, closing that half of the old gap — every docked scope
  that exists as a visual column is now collapsible). The derivation (a
  packed rail can't honestly render a grid; a handle may not span what
  its drag would flatten — D27) makes this a geometric limit. Options:
  accept; or give the region scope a compound affordance railing every
  column.
- **Shared header for PARTIAL rail-band runs (D44b, adjudicated,
  pending).** The packed region rail already draws one header; a
  contiguous run of rail bands amid expanded bands still renders
  per-band headers today. The user chose ONE shared header + one `+`
  per contiguous run (P9/D25); the renderer work (a RailRun grouping in
  SplitView) is the remaining D44 piece.
- **T8 — The tab-strip override inverts zone priority.** §5.1 resolves
  outermost first except item 2, where a pane-scope insert beats region
  bands. "Specific intent beats broad intent" is a second axiom, not
  derivable from nesting. Accepted ergonomics; recorded so the next
  zone addition doesn't cargo-cult either rule.
- **T9 — Minimize changes the handle's surface.** An expanded grip bar
  is chrome gray; its bar is body-colored (D19). D33 makes POSITION
  constancy exact but says nothing about surface; the keep-list is
  {position (exact), width, height (face bars), control form+inset}.
  Accepted (user-directed on real use); extending D33 to surface would
  re-gray plain bars, re-opening D19.

---

## 12. Decision index

One line per decision ID — the CURRENT rule only (rationale and
evolution live in git history). "Retired" means the decision no longer
has surviving behavior of its own.

- **D1** — generous split bands; center-merge requires aim; no dwell
  timers.
- **D2** — retired (band bar deleted, D20).
- **D3** — side-docking GROWS the region by the newcomer's width;
  existing panels never shrink; binds every band.
- **D4** — sub-minimum drop zones are removed, not shrunk (P11).
- **D5** — retired into D9/D36 (per-tab tear-out lives where per-tab
  labels live).
- **D6** — the `−` is the only visible minimize signifier; its host
  row's motionless click is unmarked backing. No double-click grammar.
- **D7** — release over nothing floats at the pointer; Escape is the
  abort.
- **D8** — the main panel is ordinary in the model; `unmergeable` +
  titleNode header are per-pane properties.
- **D9** — one label per tab on minimized surfaces: click = expand to
  that tab, drag = tear out (rail spine rows; bars via D36).
- **D10** — minimized bars are the expanded header kept in place; the
  rail is the exception (reclaims width). Sharpened by D33; see P13.
- **D11** — the 4-level model stays; confusion is addressed by canonical
  form (D12/D13), not amputation.
- **D12** — an EXPANDED multi-leaf column may exist only when its band
  has sibling columns; lone multi-leaf columns normalize into
  consecutive bands at structural commits. RAILED lone multi-leaf
  columns are exempt (D42): one packed strip is its own canonical form.
- **D13** — adjacent bands with the same multi-column partition (~2px)
  zip-merge; structural commits only; railed flags survive a zip only
  when both halves carried them.
- **D14** — retired into D36 (bars show all labels that fit; `+N` for
  overflow only).
- **D15** — a fully-minimized window keeps side grips (bars hold
  `win.width`), hides vertical/corner grips.
- **D16** — retired (per-cell minimize died with D37/D38; what survives
  is the death of adoption rules).
- **D17** — a window is ALWAYS a vertical stack of cells; the window
  header persists while collapsed; no fit-content jump.
- **D18** — no pills on bars: a bar is a handle in its entirety.
- **D19** — bars sit on the panel's BODY surface; a pane may provide a
  minimized face at the unmergeable header's height and offsets; the
  main panel's face is its connection-status row.
- **D20** — bars render IN PLACE at their column's width (floating
  stacks); the segmented band bar is deleted.
- **D21** — the packed region rail: one 36px strip for a fully railed
  single-column-band region, with one header. Since D44 it is DERIVED
  (`isRegionPackedOn`), not stored; the region chevron rails every
  column to produce it.
- **D22** — retired (nested-column stack handle deleted; superseded by
  D27's per-column handles).
- **D23** — retired into D26/D28 (chevron placement); its click-only
  clause reversed (chevrons are drag-through).
- **D24** — a divider with nothing tradeable on one side is INERT; band
  dividers are always live (a rail band's height is tradeable, D41).
- **D25** — one `+` per rail: the header's; caps are quiet pills; honest
  scope labels on toggles.
- **D26** — single-visual-column regions carry a full-width region
  parent handle (pill drag floats the stack; chevron at right end; bar
  click backs it).
- **D27** — handle scope is a VISUAL COLUMN: multi-column regions render
  a handle per column; the region handle resurrects when the region
  drops to one visual column.
- **D28** — per-column rails: `DockColumn.railed` renders that column as
  a 36px strip in place; column chevrons in multi-column bands;
  everything that knew the region flag extends to the column flag.
- **D29** — unmergeable header chrome: gray top rule when docked; the
  compact ChromeToggle in both title forms.
- **D30** — one collapse control per scope: a stacked cell's grip bar
  has no `−`; a 2+ stack collapses via its stack's control; expand is
  never gated.
- **D31** — no server collapse axis: placement is
  position/width/height only; stack-scope collapse both directions in
  the UI.
- **D32** — the LARGEST coinciding scope owns the collapse control: the
  `−` renders only on single-group floating windows; docked collapse is
  uniformly chevron → rail.
- **D33** — P13 is exact: label row offsets/padding and control
  form+inset are identical across the minimize round-trip.
- **D34** — every collapse transition may animate; presentation-only
  (instant model, reduced-motion honored, suppressed during divider
  drags). Auto-height window collapse snaps (CSS `auto` can't
  interpolate) — accepted.
- **D35** — real tooltips on every `−`/`+`/«/».
- **D36** — bars show all labels that fit, in order; `+N` names the
  remainder only; per-label click/drag; per-label `tablist`.
- **D37** — subsumed by D38 (uniform collapse became structural).
- **D38** — collapse is ONE state per container
  (`FloatingWindow.collapsed` / `DockColumn.railed`; the third store,
  `regionCollapsed`, was later deleted by D44); `TabGroup.collapsed`
  deleted; bars and rail are two renderings; transfers between worlds
  are identity.
- **D39** — largely retired by D42 (its migrate-or-expand rule and op
  gates died with the legality change). Surviving: band-inserts and
  seams over a REGION rail are suppressed — those drops join the rail
  (an expanded newcomer must not be swallowed by `regionCollapsed`).
- **D40** — a railed column's stored weight is ALWAYS its P8 restore
  width; born-railed columns store the source window's width;
  aggregators account railed columns at the rendered 36px.
- **D41** — band heights are free weighted shares with a
  snap-to-content DEFAULT for all-railed bands (auto/pinned model:
  content-tracking while parked, pinned once dragged, 8px content
  detent un-pins); rails never merge; divider rules run the full band
  height; band seams are always live.
- **D42** — a railed sole-column band is LEGAL (user: "why can't we
  have two rails in the top half, one rail in the bottom half?"): the
  lone rail renders its 36px strip with the rest of the band as plain
  band body; every column handle carries the chevron; collapsed
  band-inserts land railed (identity, no exceptions); flags never
  migrate between the column and region stores (the region rail is a
  different picture, entered via the region chevron only); a RAILED
  lone multi-leaf column is exempt from the D12 split (one packed strip
  is its own canonical form) and splits into bands when EXPANDED, at
  the op, by construction.
- **D43** — accordion (user: "if we collapse Stats we should expand
  Tools"): railing the LAST expanded column of a multi-column band
  expands its nearest railed sibling (tie → left) — the rail gesture
  always leaves the band one expanded column. Adjudicated P3 exception;
  drops/identity untouched (all-rails bands remain reachable by drop
  and keep D41's height rules). The region chevron (railRegion)
  bypasses it: rail-all is the explicit ask.
- **D45** — mobile panels are an accordion of bars (user: appending
  every panel's full content into the bottom sheet "seems like bad
  UX"): below the `xs` breakpoint each standalone panel renders as a
  collapsed bar-like section in the sheet, expanding in place on tap;
  `visible`/`order` honored; placement axes inert off the dock surface.
  Chosen over a tabbed sheet (one panel at a time; nested tab strips
  read poorly) and a full-height pager (hides the canvas relationship).
- **D44** — region/column rail unification (user-adjudicated, all three
  recommended options): `regionCollapsed` is DELETED as a store; the
  packed region rail is DERIVED (`isRegionPackedOn`: every band
  single-column, every column railed). The region chevron = rail every
  column; the packed header's `+` = expand every column; a spine-row
  expand is GRANULAR (just that band). No store migration, no
  beside-dock consolidation, no stale-flag hazards; invariants #14/#15
  retired, replaced by "no un-migrated legacy field"
  (`migrateRegionCollapsedInPlace` runs at injection/restore
  chokepoints). Band-insert/seam suppression over a packed region kept
  for now (drops join the rail); un-suppressing is a future zone-design
  question. Remaining piece: D44b shared headers for partial rail-band
  runs (§11).
