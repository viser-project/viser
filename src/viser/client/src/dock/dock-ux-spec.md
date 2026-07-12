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
of panels that reads as one column: a docked column, or a floating
window's stack), which sits in a **region** (a left/right screen edge) —
or floats. Each scope has exactly one **handle** that moves it and one
control that collapses it, and each scope collapses as a unit into the
form its geometry can honestly keep: a floating panel into a 26px
**bar**, a floating stack into a window of bars, and a docked column
into a 36px **rail**. Collapse itself is ONE state stored on the
container (D38): bars and rails are two renderings of it, and moving a
collapsed thing between worlds converts the rendering, never the state.
Structurally a docked region is a three-level tree — a region holds
**columns** side by side, a column stacks **cells** top to bottom, each
cell one group (D46). Vertical stacking exists only INSIDE a column, so
one picture has exactly one representation, by construction: there is no
canonicalization pass, because there is nothing to normalize.

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
| **Panel** | One tab group: ≥1 panes, one active tab. Carries NO collapse state (D38). | A cell of a column. | A cell of a window's stack. |
| **Stack** | A VISUAL COLUMN: the maximal vertical run of panels the eye reads as one column. Docked: one region column (the whole region, when it has one column). Floating: the window's stack. | A docked column. | The window. |
| **Region** | One screen edge (`left`/`right`): ≥1 full-height columns side by side. | The edge's whole tree. | — |

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
  handle carries the chevron: any column may rail in place (D28/D46).
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
| Region | The stack handle, when the region is one column; NO handle otherwise (§11) | The columns' rail headers (a packed region is N strips, each its own scope) |

### 1.3 The collapse law

Collapse is ONE state, at STACK scope, stored per CONTAINER (D38):

1. **One state, container-stored (P15).** The model stores exactly TWO
   collapse flags, one per container kind: `FloatingWindow.collapsed`
   and `DockColumn.railed` (D44 deleted the regionCollapsed store).
   There is NO group-level flag, so a partially collapsed stack is
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
   window rails the landing column; floating a railed column yields a
   collapsed window; a container created by dragging OUT of a collapsed
   scope (a torn-out pane, a dragged rail cell) is born collapsed. No
   stamping, no adoption, no mixed-state normalization. Groups dropped
   INTO an expanded container simply render expanded: collapse belongs
   to the container they left, not to them. (The reverse — an expanded
   panel inserted into a collapsed window — is an open question, §11.)
4. **Expand is one gesture, one flag.** Any expand affordance on a
   collapsed container — a bar's `+`, background, or tab label; the rail
   header, a lone cap, a spine row — clears that container's single flag
   (label/spine paths also activate their tab). Expand is never gated
   (P5).
5. **A fully railed region is DERIVED, not stored (D44/D46).** "Packed"
   means every column railed (`isRegionPackedOn`) — N side-by-side 36px
   strips, each with its own header (rails never merge). The region
   chevron rails every column (railRegion); expanding back out is
   per-column — each strip's `+`, cap, or spine rows clear just THAT
   column's flag (granular by adjudication). There is no store
   migration and no flag consolidation anywhere in the system.
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
a handle covers exactly what its drag moves (D27). Corollary for D46:
a side drop inserts a full-height column, so its hint is REGION-tall.

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
attention-seeking styling. No gesture ever expands a scope it didn't
aim at (the D43 accordion is deleted, D46): this principle has no
exceptions.

**P4 — Deterministic core; motion is pure presentation. (A)** The MODEL
commits instantly: no timers, no settle states, no logic gated on an
animation finishing — and motion may never gate on measurement. Every
collapse transition MAY animate, as presentation only; D34 states the
full mechanism (ease family, suppression rules, the docked
drawer + glide model, floating height endpoints, post-ease hit-test
refresh).

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
identically must be the same model value. Under D46 this holds BY
CONSTRUCTION: vertical stacking exists only inside a column, columns
exist only side by side in a region, so no two tree shapes can draw the
same picture. There is no canonicalization pass — P15's strongest form.

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
- **Grid layouts inside a region (D46).** A region is columns side by
  side, full stop. `[A]` spanning above `[B][C]` is unrepresentable;
  users who want vertical adjacency stack panels within a column. This
  is the adjudicated trade: the band level's expressiveness was not
  worth its interaction problems (rail-over-expanded whitespace,
  collapse semantics that needed an accordion to stay sane) or its
  canonicalization machinery.

---

## 2. Vocabulary

Pane / panel / tab: a **pane** is the atomic client unit of content
(`PaneId`/`PaneSpec`); a **panel** is the user-facing container (a tab
group presented as a panel; Python `PanelHandle`); a **tab** is a pane's
presentation in a strip.

| Term | Meaning |
|---|---|
| **Region** | The docked container on the `left` or `right` screen edge: ≥1 **columns** side by side, each full region height. Column widths divide the region. |
| **Column** | A full-height vertical stack of ≥1 **cells**. Cell heights divide the column. Carries the docked collapse flag (`railed`). |
| **Cell** (leaf) | One tab **group** at a dock position. |
| **Group** | An ordered set of ≥1 panes (tabs) with one active tab. The PANEL scope; carries no collapse state (D38). |
| **Visual column** | The STACK scope's docked form (§1.1): one region column. When the region has one column, region and stack coincide. |
| **Floating window** | A free box holding a vertical stack of ≥1 groups. The STACK scope's floating form. |
| **Bar** | The collapsed FLOATING rendering, per cell (D20/D38): one group of a collapsed window drawn as its 26px handle at `win.width`. |
| **Rail** | The collapsed DOCKED rendering: a railed column packed into a 36px vertical strip of spine rows (D28). Rails never merge: a fully railed region is N adjacent strips, each with its own header (D46). Explicit only; never appears emergently. |
| **Packed region** | A region whose every column is railed (`isRegionPackedOn`) — a DERIVED reading (D44), not a stored state. |
| **Collapse stores** | The ONE state's two container homes (D38/D44): `FloatingWindow.collapsed`, `DockColumn.railed`. No group-level or region-level flag exists. |
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
| **Parent handle** | The docked stack handle: a slim body-colored bar above the scope's cells, at region placement (single-column region, D26) or column placement (each column of a multi-column region, D27). Drag floats the scope. |
| **Rail header** | The collapsed stack handle atop a rail — the parent handle's mirror. Drag floats the column as a collapsed window (D38); click or `+` expands it. |
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

**Region placement (D26).** A docked region with ONE column renders a
slim full-width StackHandleBar (`data-dock-region-handle`) above all its
cells, single-panel regions included. Drag floats the WHOLE stack as one
window — honest because the float preserves the stack exactly (P1/P8),
and the mirror of the rail header's drag (P7). The « / » chevron sits at
the right end — the rail header's `+` spot — with the handle's
motionless click as its backing. It renders only while the column is
expanded; while railed, the rail's own header is the handle (P9).

**Column placement (D27).** A multi-column region suppresses the region
handle (it would span independent visual columns while its drag
flattened them — P1/P12); instead EVERY column renders its own handle
(`data-dock-column-handle`). Drag floats THAT column as a stacked window
(leaf order and height ratios preserved, P8). Every column handle
carries the chevron at the right end (D28/D46): it rails exactly that
column in place; the handle's click backs it. Dragging a column out of
a 2-column region leaves a single-column region whose region handle,
chevron included, reappears automatically.

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

### 3.3 The rail (the collapsed docked rendering, D28/D46)

- ONE scope: a railed COLUMN (`DockColumn.railed`) renders as a 36px
  strip in place — cap, spine rows, dividers — full region height.
  Sibling columns are unaffected. A fully railed region is simply N of
  these strips side by side (the derived packed reading, D44); they
  never merge into one strip, and each keeps its own header (D46).
  Structure stays in the MODEL and returns intact on expand — the rail
  is a view. Expanded width is remembered (P8): the column's stored
  weight is its restore width (D40).
- Rail header: the collapsed stack handle (§1.2). Drag floats the column
  as one COLLAPSED window (identity transfer, D38); click or `+` expands
  the column, clearing ONLY its railed flag. Honest label: "Expand
  column". Keyboard expand lands focus on the first revealed cell's
  active tab — or on its header toggle when that panel is unmergeable
  (§4's fallback).
- Per cell: a gray cap — always a quiet pill (D25; the rail's ONE `+` is
  the header's); one spine row per tab (upright icon above rotated
  title), dimmed; hairline dividers between cells. A LONE cell's
  cap/background click still expands scope + group (unmarked backing —
  unambiguous); with 2+ cells a background click is inert (which cell
  would it mean?).
- Spine row click expands the column AND that panel *to that tab* (ops
  clear the flags at the op level, §7); spine row drag tears out just
  that pane (born collapsed, D38); cap/background drag moves the whole
  group.
- Chevrons: « on the left edge, » on the right, always at the right end
  of a PARENT HANDLE (§1.2) — never on cell chrome. The region chevron
  (single-column regions only, D26) rails the column; every column
  handle in a multi-column region carries its own (D27/D28). Drag-through
  like every right-end control. Collapse hands focus to the rail header
  that replaces the chevron, pointer and keyboard alike (edge case 14).
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
  renders every cell as its bar (§3.2), with a hairline between the
  window header and the first bar (every other bar boundary draws a
  divider; an unmarked header/bar seam reads as one surface). Mixed
  windows are unrepresentable (D38). Collapse/expand eases the window
  height in both height modes (D34: auto endpoints are measured px).
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
| Region parent handle — pill / background (single-column regions, D26) | whole region (as one stacked window) | rail the column (backing for its chevron) |
| Region-collapse chevron (single-column regions) | whole region (drag-through) | rail the column; focus hands off to the rail header (both input paths) |
| Column parent handle — pill / background | that column (as one stacked window, height ratios preserved) | rail that column (backing for its chevron) |
| Column-collapse chevron (every column handle, D28/D46) | that column (drag-through) | rail that column — sibling columns are untouched (no accordion, D46); focus hands off to the column rail's header (both input paths) |
| Rail header | that column — floats as one COLLAPSED window (identity transfer, D38) | expand that column (clear its one flag; granular even in a packed region, D44/D46) |
| Rail cell cap / background (quiet pill) | whole group — new window born collapsed | expand column + group (lone cell only; inert with 2+ cells) |
| Rail spine row | that pane — new window born collapsed | expand the column to that tab |
| Region resize divider | region width (expanded columns only; railed columns ride as fixed chrome, §6) | — |
| Column (width) divider between sibling columns | neighboring columns' widths (inert when a RAILED column flanks it — fixed 36px chrome, D24/D28) | — |
| Height divider (expanded docked stack) | neighboring cells' heights | — |
| Height divider (expanded floating stack) | neighboring cells' heights; an AUTO-height window pins first, seeded with the cells' RENDERED px (entering pinned mode reproduces the exact on-screen layout); dragging DOWN past the below cells' minimum PUSHES the window bottom down (the excess grows the cell above the divider) | — (a motionless press restores everything, auto height included — P2) |
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
   side bands — specific intent beats broad intent (§11, T8).
3. **Region edge side bands** (occupied edge): 40px outer/inner side
   bands (each capped to a third of the region width, so the middle
   stays for per-cell zones) dock a NEW FULL-HEIGHT COLUMN at that side
   of the region. The hint is region-tall (P1: that is exactly what
   lands). Under D46 there are no top/bottom region bands and no
   cross-band seams — vertical adjacency is a per-cell split INSIDE a
   column, never a region-level insert. The side bands YIELD entirely
   to any collapsed docked cell under the pointer — packed regions
   included: a 40px band would shadow a whole 36px strip whose own
   8px sliver already docks a column beside it, and packed strips tile
   the whole region, so dock-beside there is entirely the rails' own
   slivers (edge case 13). Suppressed where they'd duplicate a per-cell
   split (a single-column, single-leaf region) and while a floating
   window's paper rect owns the pointer (§3.5).
4. **Per-target zones**: the cell-, rail-, and bar-level zones of
   §5.2–5.4.
5. **Anywhere else**: no drop; release floats the dragged stack at the
   pointer (D7 — motion means move; Escape is the abort).

### 5.2 Expanded docked cell zones

- Above the tab strip (the grip bar): split above this cell — the ONLY
  above-claim on the cell (D48). The column's FIRST cell also claims
  the parent-handle run above it (the scanner extends its drop rect to
  the column top, mirroring the rail rule): region-owned chrome is
  never a no-drop hole (P5), and a slam to the top of an occupied dock
  splits above the top cell.
- Over the tab strip: insert at that tab position (2D nearest-tab, works
  with wrapped rows).
- Content side bands (30% of width, ≤120px): insert a NEW FULL-HEIGHT
  COLUMN beside this cell's column, on that side (D46: side drops are
  column inserts; the hint is region-tall, P1).
- Content bottom band (25%, ≤100px): split below this cell, within its
  column. There is NO content-top band (D48): the strip and everything
  below it down to the bottom band merges, so overshooting the strip
  lands in the same outcome family (a merge appends — structurally
  identical to the strip's own insert-at-end, `mergeGroupsInto` IS
  `insertTabsInto(end)`; the two claims are one action with two views,
  P9-consistent).
- Content center merges (become a tab). D1's "merge requires aim"
  holds horizontally (side bands stay generous) and at the seams
  (grip bars / bottom bands); vertically-above it is re-adjudicated by
  D48 — a generous above-claim below the strip made the strip an
  island and its preview displaced the aim target. MERGE-SUPPRESSED
  pairs (an unmergeable target, or a dragged stack holding an
  unmergeable panel) keep the pre-D48 top band as split-above: their
  merge is null, so overshoot-lands-in-merge cannot hold (the zone
  would be a P5 no-drop hole), and no strip island exists there — the
  strip insert is suppressed too.

### 5.3 Rail cell zones (§5.2 rotated; D48 deliberately does NOT
rotate here — a rail cell has no content body to re-claim above, its
8px top edge is chrome-thin at P11's floor, and its hint is a line,
not a target-displacing shrink)

- 8px outer/inner side slivers: dock a new full-height column beside
  this rail's column.
- 8px top/bottom edges (`MINIMIZED_EDGE_BAND_PX` — P11's floor): stack a
  cell above/below within the rail's column.
- Over a spine row: insert at that tab position.
- The rest, cap included: merge into that group, staying minimized.

A rail's droppable surface is the FULL region-tall strip, not just its
content-tall cells: the header run above the first cell belongs to that
cell (top 8px stack-above, then insert at position 0) and the empty tail
below the spine rows to the last cell (side slivers run full height; the
middle is stack-below, with the hint at the spine content's true
bottom — where the new cell actually lands — not the strip's far
bottom). Interior cells keep their own boxes.

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
  spanning the true affected extent — REGION-tall for column inserts
  (D46), cell-tall for in-column splits. **Merge highlight** = the whole
  group being joined. **Fill** = a translucent block for empty-edge
  docks (no boundary to point at).
- Top/bottom splits additionally shrink the target cell live to vacate
  the space (contents scroll; no distortion). Left/right column inserts
  show only the line. Collapsed targets never shrink.
- Drop targets are snapshotted at drag start and refreshed on any layout
  change, container scroll, or window resize; a floating window growing
  MID-DRAG also marks the cached rects stale. Hints never lag the
  visible geometry.
- Divider gaps are never dead spots, in EITHER axis: the horizontal gap
  between stacked docked cells maps to the seam split it sits in the
  middle of; the vertical gap between side-by-side columns to the column
  insert at that seam (left half inserts right of the left column, right
  half left of the right column — the same landing, mirror-symmetric,
  hint at the gap center); a floating stack's gap to the snap at that
  index — the hint never flickers to "no drop" crossing a seam.

Collapse is the container's (D38), so drops need no adoption or
normalization rules: a group joining an expanded container renders
expanded; a pane merged into a collapsed container's group becomes a tab
inside it, still collapsed — dropping into a minimized target never
expands it (edge case 1). Whether INSERTING an expanded panel into a
collapsed window collapses the newcomer (container rule) or expands the
window is an open question (§11).

---

## 6. Sizing model

- **Region width**: ONE invariant (D40). Column weights are ALWAYS
  reconciled pixel widths — every column, lone and railed included; a
  railed column's weight is ALWAYS its P8 restore width, never read as
  rendered width and never silently rewritten by a drop. `regionWidth`
  is the derived rendered need: Σ over columns of (railed ? 36 :
  weight), at any column count — so a fully railed region holds exactly
  36 × its column count, restore widths in the weights. Every
  consumer-visible layout has been reconciled: `migrateLegacyLayout`
  adopts persisted pre-invariant layouts at the injection/restore
  chokepoints (§10).
  Docking a new column *grows* the region by the newcomer's width (D3):
  existing panels never shrink because something arrived (P3 outranks
  canvas preservation; the resizer is the recovery). The newcomer's
  width IS the dragged window's width — every drag-dock path floats
  first, so the window still carries it — born railed included: the new
  column STORES the window's width, so the rail round-trip restores it,
  and contributes only the rendered 36px strip. Columns with NO source
  window (server-built / injected layouts) take the 300px region
  default as their restore width even when born railed. The resizer
  redistributes over EXPANDED columns only, and the region stops being
  width-resizable when every column is railed.
- **Minimums**: expanded columns / regions / windows ≥ 96px grab width
  (`MIN_REGION_GRAB_PX`; the ~220px CONTENT minimum is the body's —
  below it the panel scrolls horizontally); cells ≥ ~50px; windows ≥
  50px height, floored at the content height when shorter. Resizes
  clamp; they never squeeze a cell below its header. The cell minimum is
  also a RENDER floor on expanded docked leaves — without it repeated
  same-target splits clip the smallest cell's chrome.
- **Split defaults**: a top/bottom leaf drop halves the target cell's
  weight; a left/right COLUMN insert defaults the newcomer to its
  dragged window's width (D3 — the region grows; nothing is halved). A
  RAILED target column's weight is never halved by any drop: it is a P8
  restore width, not a rendered share. A multi-group stack dropped
  top/bottom divides its half among its leaves by the stack's preserved
  height ratios (P8).
- **Cursor vocabulary**: dividers BETWEEN panes show the splitter
  cursors (`col-resize`/`row-resize` -- both sides trade); grips that
  resize ONE thing keep the directional edge cursors (`ew`/`ns`/
  `nwse`/`nesw-resize`: window edges and corners, and the region's
  canvas-edge resizer, which resizes the region against the canvas).
- **Dividers** (D24): a divider is INERT — no resize cursor, no armed
  gesture, no height-pin side effect — unless something tradeable sits
  on EACH side (a cursor that no-ops lies). Height dividers need an
  expanded cell each side (bars are fixed 26px); width dividers go inert
  beside a RAILED column (fixed 36px chrome, D28) — the rail-to-rail
  divider renders dimmer than a live handle so the two read distinctly.
  Every column divider runs the FULL region height (columns are
  full-height by construction). Floating stack dividers carry the same
  ~12px invisible grab overlay as docked ones (P11) — only while
  resizable.
- **Stack grow normalization**: flex-grow factors normalize per site
  over EXPANDED cells only — minimized cells render flexGrow 0 — so
  freed space is never stranded (edge case 16).
- **Round-trips** (P8): float→dock carries height ratios into the
  column; dock→float restores the remembered window size;
  minimize→expand holds width by construction; rail→expand restores the
  pre-collapse width — a column born railed from a window expands to
  that window's width (D40); a railed column dragged out floats at its
  preserved expanded width; reconnects replay the same sizes.
- **Windows**: auto-height tracks content up to the container; pinned
  height is user-set via the bottom grip OR by a stack-divider drag
  (which pins at the current rendered layout — seeding weights with the
  cells' rendered px, the same snapshot rule as docked divider drags);
  the content-height detent un-pins. A stack-divider drag past the
  below cells' minimum grows the window (push-through), clamped to the
  dock container's bottom. A fully-minimized window ignores pinned
  height.

---

## 7. Collapse operations and conversion

The collapse law (§1.3) states the semantics; this section is the
op-level residue.

- Ops and their flags (D38/D44/D46): the `−` / window-header toggle
  flips `FloatingWindow.collapsed`; the column chevron sets
  `DockColumn.railed` (setColumnRailed — a bare flag flip; no
  restructuring exists to accompany it, and sibling columns are never
  touched, P3); the region chevron (single-column regions) rails that
  column; railRegion rails every column. Ops act on containers; groups
  carry nothing. Collapsing a missing scope is a no-op; clearing is
  always legal.
- Expand ops clear docked flags at the op level (D28): any op that
  expands a docked panel (a spine-row expand-to-tab, a toggle landing
  expanded) clears the containing column's railed flag — an "expanded"
  panel hidden behind a rail would be a dead end (P5). A spine-row
  click also activates its tab. Granularity is §1.3 item 5's.
- Rail toggles commit as USER ops, and the railed flags join every
  resident's ownership signature (P6, `:r` terms) — else a stale
  single-axis server replay could silently re-flip a rail the user just
  set.
- Transfer identity (collapse law 3) at the op level: docking a
  collapsed window rails the landing column when the drop lands as a
  column — a side drop lands as a railed full-height column — and rails
  nothing on a stack drop (the pane joins the landing column's state).
  Server `float()` moves geometry and touches no collapse, and a server
  docked→docked position move carries the source container's collapse
  the same way — identity on both paths (§8).
- A railed column reserves exactly 36px; it is still a full drop target,
  and a packed region still hosts region-edge docking on its outer side
  via its outermost strip's sliver (the yield rule, §5.1 item 3; zones
  in §5.3).
- Legacy migration: layouts persisted under the pre-D46 band model
  (`{rows: [...]}` regions) or the pre-D44 `regionCollapsed` flag are
  converted at the injection/restore chokepoints (one owner,
  `migrateLegacyLayout`, running rows-then-flag). The band era's
  canonical form stored every EXPANDED stack as consecutive
  single-column bands, so that shape converts to ONE multi-leaf column
  (band weights become leaf height shares; an all-railed stack stays
  railed) — never rotated into side-by-side columns. Mixed multi-column
  bands are unrepresentable and fall back to columns left-to-right,
  expanded weights rescaled so the remembered region width survives. A
  set region flag rails every column. No other code path sees the
  legacy shapes.

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
- Four independent write-only axes per panel: position, width, height,
  collapsed (D47 -- `minimize()` / `expand()`; supersedes D31's removal).
  A message carries exactly one axis; applying one can never disturb
  another (no yank by construction). The collapsed axis acts at CONTAINER
  scope, like every collapse (D38): minimizing a docked panel rails its
  column (stack-mates ride along), a floating one collapses its window;
  `expand()` routes through the group expand, clearing the destination's
  rail. Applied after position, so a position+collapse bundle rails the
  DESTINATION container, never the departing one.
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
  clients; notification offsets track only the control panel; and
  `expand()` acts at container scope while touch-tracking is per-panel —
  expanding panel A un-rails column-mates the user minimized alongside
  it (the documented container contract, but the one place a server
  command overrides sibling panels' user-set state).

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
   not the 36px rail width (P8) — the width travels in the column
   WEIGHT (always-px, D40), never in regionWidth.
6. A pinned-height window expands from minimized at its pinned height.
7. The last panel leaving an edge nulls the region; the next dock
   recreates it at the remembered width (P8). The memory is the edge's
   preserved regionWidth when the region left expanded; a region that
   left PACKED remembers only its strip run, so the recreate takes the
   docked window's own width (which carried the restore px out).
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
13. Region-edge docking beside a packed region stays reachable: the
    side bands yield to the strips, whose own 8px slivers dock a column
    beside (§5.1 item 3 / §5.3).
14. Bar/rail keyboard expand moves focus onto the revealed tab strip (an
    unmergeable reveal: its header toggle, §4); keyboard
    minimize/collapse moves it onto the replacement control. Neither
    direction — on either input path — drops focus to `<body>`.
15. Left/right mirrored layouts resolve mirrored drops everywhere (P7,
    swept).
16. Expanded content absorbs ALL space freed by collapsed chrome — no
    column or stack ever strands dead area from fractional grow sums
    (normalization over expanded cells only, §6).
17. A motionless press on a floating stack divider changes NOTHING: no
    visible movement (the pin seeds rendered px) and no surviving mode
    change (an auto window a press briefly pinned reverts on release) —
    P2's "a motionless click never moves", for dividers.

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

- **The three-level shape (D46)**: `DockRegion { columns }` →
  `DockColumn { children }` → leaves. P14 holds by construction —
  vertical stacking exists only inside a column — so there is NO
  canonicalization pass, no `structureSignature` gating, and no soft
  "convergence owed" invariant class.
- **Invariant checker** (`dock/layoutInvariants.ts`): one function
  defines "valid layout" for the app AND the fuzzer. `applyOp` asserts
  it on every commit in dev (console.error, never throw) and
  time-throttled in production. Hard invariants include: no duplicate or
  orphaned panes/groups; no un-migrated legacy field (`regionCollapsed`
  or band-era `rows` — the injection/restore chokepoints run
  `migrateRowsToColumnsInPlace` + `migrateRegionCollapsedInPlace` +
  `migrateLoneColumnWidthInPlace`, the last adopting a pre-always-px
  lone column's regionWidth into its weight);
  `regionWidth` ≈ Σ over columns of (railed ? 36 : weight) — invariant
  #12, covering ANY column count.
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
(identity as input, not label+order inference); a placement coordinator
(one ordered pass over the placement store, replacing per-panel effect
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
  region handle, so no one-gesture region-wide collapse or expand (each
  column rails/expands individually; `railRegion`/`expandRegionRail`
  exist as ops but have no multi-column affordance). The derivation (a
  handle may not span what its drag would flatten — D27) makes this a
  geometric limit. Options: accept (current); or give the region scope
  a compound affordance railing every column.
- **T8 — The tab-strip override inverts zone priority.** §5.1 resolves
  outermost first except item 2, where a pane-scope insert beats region
  side bands. "Specific intent beats broad intent" is a second axiom,
  not derivable from nesting. Accepted ergonomics; recorded so the next
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
evolution live in git history). Retired IDs (no surviving behavior of
their own) are grouped at the end so they stay findable without
consuming paragraphs.

- **D1** — generous split bands; center-merge requires aim; no dwell
  timers.
- **D3** — side-docking GROWS the region by the newcomer's width;
  existing panels never shrink.
- **D4** — sub-minimum drop zones are removed, not shrunk (P11).
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
- **D15** — a fully-minimized window keeps side grips (bars hold
  `win.width`), hides vertical/corner grips.
- **D17** — a window is ALWAYS a vertical stack of cells; the window
  header persists while collapsed; no fit-content jump.
- **D18** — no pills on bars: a bar is a handle in its entirety.
- **D19** — bars sit on the panel's BODY surface; a pane may provide a
  minimized face at the unmergeable header's height and offsets; the
  main panel's face is its connection-status row.
- **D20** — bars render IN PLACE at their column's width (floating
  stacks); the segmented band bar is deleted.
- **D21** — the rail reclaims WIDTH: the docked collapsed rendering is
  a fixed 36px strip. Its region-scope form was absorbed by D44/D46:
  packed is derived, N per-column strips that never merge — no single
  packed strip, no shared header.
- **D24** — a divider with nothing tradeable on one side is INERT; width
  dividers go inert beside a railed column (fixed 36px chrome).
- **D25** — one `+` per rail: the header's; caps are quiet pills; honest
  scope labels on toggles.
- **D26** — single-column regions carry a full-width region parent
  handle (pill drag floats the stack; chevron at right end; bar click
  backs it).
- **D27** — handle scope is a VISUAL COLUMN: multi-column regions render
  a handle per column; the region handle resurrects when the region
  drops to one column.
- **D28** — per-column rails: `DockColumn.railed` renders that column as
  a 36px strip in place; every column handle carries the chevron.
- **D29** — unmergeable header chrome: gray top rule when docked; the
  compact ChromeToggle in both title forms.
- **D30** — one collapse control per scope: a stacked cell's grip bar
  has no `−`; a 2+ stack collapses via its stack's control; expand is
  never gated.
- **D31** — superseded in part by D47: the server collapse axis is
  back (its removal's motivating mixed-stack awkwardness died with
  container-owned collapse). Surviving: stack-scope collapse in both
  directions in the UI.
- **D32** — the LARGEST coinciding scope owns the collapse control: the
  `−` renders only on single-group floating windows; docked collapse is
  uniformly chevron → rail.
- **D33** — P13 is exact: label row offsets/padding and control
  form+inset are identical across the minimize round-trip.
- **D34** — the collapse-motion mechanism (P4 is the axiom): every
  collapse transition MAY animate, as presentation only — the model
  commits instantly, motion rides one 160ms ease family, honors
  prefers-reduced-motion (instant), and is suppressed under an active
  divider drag (`[data-dock-resizing]`) and while the canvas guard is
  actively scaling (squeeze-tracking values must not lag the resize).
  Docked collapse is the DRAWER + GLIDE model: content renders at its
  COMMITTED geometry immediately (columns lay out in a pane fixed at
  the drawn width — nothing reflows mid-ease, no scrollbar flicker);
  the region container's width and the canvas insets ease between
  committed values; each column FLIP-glides from its previous screen
  position to its new one on the same curve, so a column whose
  position didn't change stays perfectly still. Floating collapse
  eases the window height in both height modes, toward the
  DETERMINISTIC collapsed endpoint — a calc() over chrome (header +
  bars + dividers), never a DOM measure: a PINNED window's endpoints
  are both numeric and ease natively (the FLIP must not hijack that
  transition); an AUTO-height window's `auto` endpoint is a measured
  px via FLIP (CSS cannot interpolate to `auto`). Drag hit-testing
  re-reads geometry on `transitionend`, filtered to the eased
  properties, so cached rects never lag the visible surface.
- **D35** — real tooltips on every `−`/`+`/«/».
- **D36** — bars show all labels that fit, in order; `+N` names the
  remainder only; per-label click/drag; per-label `tablist`.
- **D38** — collapse is ONE state per container
  (`FloatingWindow.collapsed` / `DockColumn.railed`; the third store,
  `regionCollapsed`, was later deleted by D44); `TabGroup.collapsed`
  deleted; bars and rail are two renderings; transfers between worlds
  are identity.
- **D40** — the width contract: EVERY column weight — lone and railed
  columns included — is a reconciled pixel width; a railed column's
  weight is ALWAYS its P8 restore width (born-railed columns store the
  source window's width), and aggregators account railed columns at
  the rendered 36px, so `regionWidth` is uniformly the rendered need
  (Σ railed ? 36 : weight) at any column count. The P8
  restore/undock/recreate round-trips read the WEIGHT, never
  regionWidth.
- **D44** — region/column rail unification: `regionCollapsed` is
  DELETED as a store; the packed region reading is DERIVED
  (`isRegionPackedOn`: every column railed). railRegion rails every
  column; expands are granular per column. Invariants #14/#15 retired,
  replaced by "no un-migrated legacy field" at the injection/restore
  chokepoints.
- **D45** — mobile panels are an accordion of bars (user: appending
  every panel's full content into the bottom sheet "seems like bad
  UX"): below the `xs` breakpoint each standalone panel renders as a
  collapsed bar-like section in the sheet, expanding in place on tap;
  `visible`/`order` honored; placement axes inert off the dock surface.
  Chosen over a tabbed sheet (one panel at a time; nested tab strips
  read poorly) and a full-height pager (hides the canvas relationship).
- **D46** — columns-only layout model (user-adjudicated: rail-over-
  expanded whitespace and neighbor-expanding collapse revealed "some
  fundamental problems"; option 1 chosen over disabling per-column
  collapse). The band level is DELETED: a region is side-by-side
  full-height columns, each a stack of leaves — `[A]` over `[B][C]` is
  unrepresentable. Consequences: P14 holds by construction (D12/D13 and
  the canonicalization pass deleted); side drops insert full-height
  columns with region-tall hints; top/bottom region bands, cross-band
  seams, and band-height machinery (D41) deleted; the D43 accordion
  deleted; rails never merge (a packed region is N strips, each with
  its own header and granular expand); per-column collapse (D28/D40/
  D44) survives unchanged. Legacy `{rows}` layouts migrate at the
  injection/restore chokepoints.
- **D47** — `minimize()` / `expand()` restored (user-adjudicated): a
  fourth write-only placement axis (`GuiSetPanelCollapsedMessage`,
  ordinary update_simple lifecycle), container-scoped per D38 -- panels
  stacked together minimize together, exactly like the on-screen
  control, and the docstrings say so. D31's removal rationale ("strange
  that panels in a stack can still be individually expanded after
  they're all minimized together") described the pre-D38 group-flag
  model; container-owned collapse made that state unrepresentable, so
  the objection dissolved. Applied after position (destination-container
  semantics); replays to late joiners; arbitration via the standard
  per-axis (counter, runId) gate.
- **D48** — no content-top band (user-adjudicated): dock-above belongs
  to the grip bar alone; the tab strip and everything below it down to
  the bottom band merges (bottom + side bands survive). Carve-out:
  merge-SUPPRESSED pairs keep the pre-D48 top band as split-above
  (their merge is null). Rationale and the full zone statement: §5.2.

Retired — one line per ID; the pointer is where any surviving content
lives:

- **D2** — retired: the segmented band bar died with D20's in-place
  bars.
- **D5** — retired into D9/D36: per-tab tear-out lives where per-tab
  labels live.
- **D11** — retired by D46: the band level was deleted after all.
- **D12** — retired by D46: no bands, no canonical form, no
  normalization pass. Its band-era canonical shape survives only as
  §7's legacy-migration input.
- **D13** — retired by D46: no bands to zip.
- **D14** — retired into D36: bars show all labels that fit; `+N` for
  the overflow remainder only.
- **D16** — retired: per-cell minimize died with D37/D38. What
  survives is the death of adoption rules — groups travel as-is
  across drops (§5.5).
- **D22** — retired: the nested-column stack handle was superseded by
  D27's per-column handles.
- **D23** — retired into D26/D28 (chevron placement); its click-only
  clause reversed — chevrons are drag-through (§1.2).
- **D37** — subsumed by D38: uniform collapse became structural.
- **D39** — retired by D46: band-inserts and cross-band seams no
  longer exist as zones; nothing is left to suppress.
- **D41** — retired by D46: band heights died with bands. Its
  surviving rules live in §3.3 (rails never merge) and §6 (column
  dividers run the full region height).
- **D42** — retired by D46: a railed column beside expanded siblings
  is no longer a distinct legal shape to defend — any column may rail,
  trivially.
- **D43** — retired by D46: the accordion is DELETED; railing a column
  never touches its siblings (P3).
