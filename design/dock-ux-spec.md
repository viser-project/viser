# Dock UX specification

Status: DRAFT for iteration. This is the *normative* companion to
`dock-correct-by-construction.md` (which covers the model and invariants).
That doc says what states are representable; this one says how the dock must
FEEL — what every gesture does, what every drop means, and why. Where the
implementation disagrees with this document, one of them is wrong, and we
decide which on paper before touching code.

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
Structurally a docked region is a
four-level tree — region stacks **bands**, a band holds **columns** side
by side, a column stacks **cells**, each cell one group — kept in a
canonical form so one picture has one representation. §1 states the laws;
§2 defines every term.

Reading map: §1–§9 are normative (scope model + principles, vocabulary,
surfaces, gestures, drops, sizing, minimize/expand, server placement, edge
cases). §1 alone should predict any interaction; later sections supply the
numbers and edge cases. §10 is the cross-check protocol, its audit record,
and the open tensions. §11 is the decision history behind the normative
text (D1–D40); D-numbers cite it.

How to use it: (1) iterate until the laws and tables read as "yes,
that's the product we want"; (2) cross-check against the implementation
and e2e suite per §10 — every mismatch becomes a code fix or a recorded
spec amendment; (3) new behavior questions get answered by §1 FIRST,
then encoded in the tables — if §1 can't answer, §1 is incomplete: fix
it, don't special-case, and park underivable rules on §10's tensions
list.

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
window is a panel that is its whole stack. Coincidence is where the
tensions live (§10).

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
  Every `−`/`+`/«/» carries a real tooltip, not a bare title attribute
  (D35).
- The rest of the surface is **unmarked backing** for that control: a
  motionless click anywhere on the handle performs the right-end action
  (D6; P9's hit-area rule; P11's backing rule). The `+`/`−` toggles are
  drag-through (a press flows to the handle's drag arbitration); the
  chevrons included: since D32 their host bars' motionless click backs
  the identical collapse, so drag-through is safe (T6 resolved, 2026-07-06).

Presence rules, derived:

- The right-end control renders iff collapsing that scope is legal and
  has an honest collapsed geometry. A STACKED cell's grip bar has no
  `−` and no backing click (collapse is stack-scoped, D30); a LONE
  column of a single-column band in a mixed region has no chevron (a
  36px rail inside a full-width band would strand dead space, D28) — it
  keeps a pill-only, click-inert handle, which under D32 leaves that
  scope with no docked collapse affordance — uncollapsible by
  adjudication (D39: its rail would be dead-band geometry; T7 records
  the strain).
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
  same flag, so "toggle-all" is now simply "toggle"); docked keeps the
  parent handle above the grip bar for layout constancy, but D32 removes
  the second collapse control, so the stacked handles no longer compete.

The handles by scope and state:

| Scope | Expanded handle | Collapsed handle |
|---|---|---|
| Panel | Grip bar (unmergeable panels: the full-width header); hosts the `−` only on a single-group floating window (D32) | The bar (floating); inside a rail: the cell cap (pill only — its scope's `+` is the rail header's) |
| Stack (docked) | Parent handle (region- or column-placed per §1.1's visual column) | Rail header |
| Stack (floating) | Window header (multi-group; single-group windows: the panel's grip bar) | Window header, unchanged (D17) |
| Region | The stack handle, when the region is one visual column; NO handle otherwise (tension T7) | Rail header |

### 1.3 The collapse law

Collapse is ONE state, at STACK scope, stored per CONTAINER (D38 —
user-adjudicated: "minimized with the '−' when floating and minimized
with the '>>' when docked should use the same state representation…
if we take a '−'-minimized window and dock it, it should become
'>>'-minimized. And vice versa."):

1. **One state, container-stored (P15).** The model stores exactly three
   collapse flags, one per stack-scope container: `FloatingWindow.
   collapsed`, `DockColumn.railed`, `regionCollapsed[edge]`. There is NO
   group-level flag — `TabGroup.collapsed` is DELETED, so a partially
   collapsed stack is unrepresentable by construction (D37's invariant,
   made structural). Groups don't collapse; the thing that holds them
   does.
2. **Two renderings of the one state.** A collapsed FLOATING container
   renders as its window of stacked bars at full `win.width` (face bar
   for a lone main-panel window) — width kept, since width has no one to
   yield to (D17/D20). A collapsed DOCKED container renders as the 36px
   rail — width reclaimed for the canvas (D21/D28). Bars vs rail is
   presentation chosen by context, never a state difference; the `−`
   (floating) and the » (docked) set the SAME property at their scope
   (D32 places each control on its scope's handle).
3. **Transfers are identity, not conversion.** Docking a collapsed
   window rails the landing column (or joins/creates the region rail);
   floating a railed column or region yields a collapsed window; a
   container created by dragging OUT of a collapsed scope (a torn-out
   pane, a dragged rail cell) is born collapsed. No stamping, no
   adoption, no mixed-state normalization — there is nothing at group
   level to normalize. Groups dropped INTO an expanded container simply
   render expanded: collapse belongs to the container they left, not to
   them. (The reverse — an expanded panel inserted into a collapsed
   window — is an open sub-question, §10.)
4. **Expand is one gesture, one flag.** Any expand affordance on a
   collapsed container — a bar's `+`, background, or tab label; the rail
   header, a lone cap, a spine row — clears that container's single flag
   (label/spine paths also activate their tab). Expand is never gated
   (P5). D31's `expandStackOf` machinery reduces to a flag clear.
5. **Store migration, not state change.** When scopes widen or narrow
   structurally, the flag moves to the canonical store, and the rule
   is BAND-scoped, as the illegal geometry is (D39): a railed column
   left as its band's SOLE column migrates its flag to the REGION
   store when the region flag draws the identical picture — every
   band single-column, every column railed: that region IS the region
   rail (D28's orphan-degradation-to-bars rule dies with the group
   flag). Anywhere else — expanded content elsewhere in the region, or
   a mixed band structure — the flag DROPS and the column expands: the
   only legal state (a rail inside a full-width band is the dead
   geometry D28 rejected). Where both docked stores are set, region
   takes render precedence.
6. **Client-only, instant.** Server placement is position/width/height —
   no collapse axis (D31). Collapse changes only by user gesture (P3),
   never emerges from state, and the model commits instantly; motion is
   presentation (P4/D34).

### 1.4 Principles

Axioms are marked (A); rules that now derive from §1.1–1.3 are marked
(D) and kept under their historical numbers because code and tests cite
them.

**P1 — Honest hints. (A)** During a drag, the hint shows *exactly* what
the drop will do: the insertion line sits where the panel's edge will
land, a merge highlight covers exactly the group being joined, the
affected extent drawn is the extent changed. A hint may never promise a
smaller or larger effect than the drop delivers. Corollary for handles:
a handle covers exactly what its drag moves — this is what forced parent
handles down to visual-column scope (D27).

**P2 — One gesture grammar. (A)** Everywhere in the dock:

- *press + move > 3px* = move the thing under the grip;
- *press + release, motionless* = the surface's primary action (activate
  a tab, expand a minimized group, a handle's right-end action);
- *Escape mid-drag* = "never mind": layout, sizes, and collapse states
  return to their pre-drag values;
- *Enter/Space on a focused element* = its motionless click.

No surface may bind these differently. A surface that can't support one
of them simply doesn't respond, it never reinterprets. Drags never
change collapse state — expanding is exclusively a click. Since D38 that
reads at CONTAINER level: state rides with the container you drag (a
rail floats as a collapsed window), and what you drag out of a collapsed
container is born collapsed; a group joining an expanded container
renders expanded not because the drag changed anything but because
collapse was never the group's property.

**P3 — Content is sacred, chrome is quiet. (A)** Panels never move,
resize, or change collapse state except by (a) a user gesture, (b) an
explicit server placement command (position/size only), or (c) a
structural necessity spelled out in §7. Minimized forms are wayfinding
chrome: dimmed labels, compact geometry, no content preview, no
attention-seeking styling — a minimized group shows no "active" emphasis
because nothing is shown.

**P4 — Deterministic core; motion is pure presentation. (A)** The MODEL
commits instantly: no timers, no settle states, no logic gated on an
animation finishing. EVERY collapse transition MAY animate (D34) — cell
minimize/expand, a floating window's auto-height change, rail
collapse/expand widths at both scopes — but only as presentation: one
CSS transition (`collapseAnim`, 160ms) between committed values,
honoring prefers-reduced-motion (instant) and suppressed under an active
divider drag (`[data-dock-resizing]`). Drag hit-testing re-reads
geometry on `transitionend`, filtered to the eased properties, so cached
rects never lag the visible surface.

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
happens to float; collapsed forms are one visual language rotated to fit.
A user who learns one surface has learned them all. (Where the analogy
bends — rail vs bars, handle stacking vs merging — see §10 tensions.)

**P8 — Sizes are sticky. (A)** A panel keeps its width and height across
every move, minimize/expand round-trip, float/dock round-trip, and
reconnect, until the user resizes it or space constraints force a clamp.
Defaults (300px width) appear only for panels that have never had a size.

**P9 — One signifier per action. (A)** Every distinct action gets exactly
one visual signifier per view. Enlarging an action's *hit area* with
unmarked surface is encouraged (the backing rule); duplicating its
*iconography* is forbidden — a repeated icon reads as a different
action. Litmus: if an invariant makes two controls equivalent, they
merge into one signifier. A collapsed multi-group window applies it:
its bars carry no individual `+` — the window header owns expand, bar
surfaces are unmarked backing (T4 resolved to the rail's rule, 2026-07-06).

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

**P13 — Minimize keeps the chrome, EXACTLY. (D — collapse law 2;
sharpened by D33.)** A minimized panel is its header with the body
removed, and the constancy is exact: the label row keeps identical x AND
y offsets and padding, and the right-end control keeps the same form at
the same inset, across the round-trip — minimizing may remove content
but never re-lays-out the chrome that stays. The bar carries the group's
tab labels, dimmed, as many as fit — overflow collapses to a `+N` badge
for the REMAINDER only (D36: "+N obfuscates what panels are present") —
or the pane's minimized face (D19), with the `+` toggle at the RIGHT end
exactly where the expanded header's `−` sat: a mis-click is undone
without moving the mouse. Bars sit on the panel's BODY surface, not
chrome gray: a bar is the panel, sleeping (D19). No pill (D18): pills
mark handles that are slices of larger surfaces; the bar is handle in
its entirety, and its labels are its identity. (The anatomy drift this
implies is tension T3.) Face bars keep the unmergeable header's exact
height (2.75em), surface, and content offsets. The rail is the
documented exception: it exists to reclaim WIDTH, so it is the header
ROTATED — cap on top, spine rows below, `+` on its header at the top.

**P14 — One structure per picture. (A)** Two layouts that render
identically must be the same model value. Canonical form, normalized at
every structural commit (never on pure weight changes, so a resize can't
restructure mid-gesture): (a) full-width vertical stacking is BANDS — a
multi-leaf column may exist only when its band has sibling columns
(D12); (b) adjacent bands with the same multi-column partition (~2px)
zip-merge into one band of stacked columns (D13). Redundant
representations are where confusion lives.

**P15 — Correct by construction: invalid states are unrepresentable.
(A)** The companion doc's theme, named here because UX decisions cite it
(D32/D37/D38): when a state is wrong, make it unrepresentable — by
types, model shape, or normalization at commit — rather than defending
against it at every consumer. P14 is its structural instance; D38's
container-owned collapse is its collapse instance: a mixed stack is not
a state to escape from but a state that cannot exist, because the
would-be per-group flag is gone.

### Non-goals (decided 2026-07-03)

- **Keyboard layout rearrangement.** Click-level keyboard parity stays
  (focusable targets, Enter/Space, arrow traversal, Escape, focus
  restoration — built, tested, cheap). No keyboard path for
  dock/split/merge/reorder will be added.
- **Undo after commit.** Escape aborts an in-flight gesture; a committed
  drop has no undo. Mitigation is prevention: D1's zone balance makes
  destructive-by-accident drops hard to trigger.

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
| **Rail** | The collapsed DOCKED rendering: the scope packed into a 36px vertical strip of spine rows — a whole region (D21) or one column of a multi-column band (D28). Explicit only; never appears emergently. |
| **Collapse stores** | The ONE state's three container homes (D38): `FloatingWindow.collapsed`, `DockColumn.railed`, `regionCollapsed[edge]`. No group-level flag exists. |
| **Area** | A nested dockable surface inside a panel body (flat tab group; no splits). |
| **Main panel** | The control panel: an ordinary group in the MODEL (docks, stacks, floats, minimizes like any other) that opts into `unmergeable` and a titleNode header (the connection-status row; minimized face per D19). |
| **Unmergeable panel** | A panel that may never become a tab of another group (and vice versa). It renders a full-width header instead of a tab strip; drops on it offer splits/snaps only, never merge/insert. |

Chrome anatomy — every row is an instance of §1.2's handle anatomy:

| Term | Meaning |
|---|---|
| **Grip bar** | The panel handle atop an expanded cell (gray, ~0.9em): drag moves the group; hosts the `−` only on a single-group floating window (D32). Unmergeable panels render their full-width header in its place. |
| **Tab strip** | The row(s) of tabs below a grip bar; wraps to multiple rows. Pane-scope surface, not a handle. |
| **Pill** | The centered grip mark on a handle. A signifier only — the whole surface drags. True-centers in the handle's full width, so grip bars, parent handles, and window headers share one centerline (P7). |
| **Chevron** | The « / » collapse control at the right end of a parent handle; the rail's entry point. Drag-through like every right-end control (T6 resolved). |
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
The handle spans the full region width because everything it acts on IS
that width. It renders only while the region is expanded; while railed,
the rail's own header is the handle (P9).

**Column placement (D27).** Any multi-column band suppresses the region
handle (it would span independent visual columns while its drag
flattened them — P1/P12); instead EVERY column of EVERY band renders its
own handle (`data-dock-column-handle`). Drag floats THAT column as a
stacked window (floatColumn; leaf order and height ratios preserved,
P8). When the column's band has SIBLING columns, the right end carries
the chevron (D28): it rails exactly that column in place; the handle's
click backs it. A LONE column (single-column band in a mixed region)
keeps a pill-only handle with no click action (§1.2 presence rule) —
under D32 that scope has no docked collapse affordance at all:
uncollapsible (D39). The whole-REGION rail remains the
single-visual-column form —
railing N stacked bands per-column would render broken stacked strips —
so the region chevron exists only at region placement. Dragging a column
out of a 2-column region leaves a single-column region whose region
handle, chevron included, reappears automatically.

### 3.1 Expanded cell (docked or floating-stacked)

- Grip bar: the panel handle (§1.2). Drag moves the group. On a
  SINGLE-GROUP FLOATING WINDOW it hosts the `−` and the backing click
  (D6/D32); everywhere else — every docked cell, every stacked floating
  cell — it is drag-only: the collapse control is the enclosing scope's
  (the parent handle's chevron docked, the window header's toggle-all
  floating). The `−` is drag-through: dragging it moves the panel; a
  motionless click minimizes.
- Tab strip: one tab per pane; wraps; the empty strip area drags the
  group; the active tab is underlined in accent color. Pane scope: a tab
  press tears out / reorders that pane, a click activates it (P12).
- Body: panel content; scrolls internally; never a drag surface.
- UNMERGEABLE panels render no grip bar: the full-width header — plain
  title or titleNode — IS the panel handle, same rules: drag moves; on
  a single-group floating window (D32) a motionless background click
  toggles and the right end carries the `−`/`+` (both title forms — a
  plain-title header without it would be a zero-signifier action);
  docked or stacked, drag-only, no toggle. The toggle is the COMPACT
  ChromeToggle (1.2em, 10px icon, D29) at the same inset expanded and
  minimized (D33): the whole header is the click target, so the toggle
  is a pure signifier. A DOCKED titleNode header always draws the gray
  top rule (separator from the parent handle above); floating keeps the
  rule only when stacked.

### 3.2 The bar (the collapsed FLOATING rendering, D20/D38)

- One cell of a collapsed window (`window.collapsed`), drawn as its
  handle: 26px tall (`MINIMIZED_BAR_PX`), at full `win.width`, on the
  panel's BODY surface (light/dark scheme — a bar is the panel,
  sleeping, D19). A collapsed window is ALL bars (one per group of its
  stack, dividers between) under its header; there is no per-cell
  minimized state (D38), so mixed windows don't exist.
- Anatomy (P13/D33): the group's tab labels, dimmed — ALL that fit, in
  order; overflow collapses to a `+N` badge naming only the REMAINDER
  on hover (D36, superseding D14's single-title rule) — then slack,
  then, on a SINGLE-GROUP window only, the `+` at the RIGHT end, at
  the `−`'s exact form and inset. A multi-group window's bars carry no
  individual `+`: the window header's toggle owns expand, and the bar
  surface is unmarked backing for it (P9, T4 resolved). No pill (D18).
- Face (D19): a single-pane group whose pane provides a minimized face
  renders it in place of the default icon+title, inside the same hit
  surface (gestures and keyboard unchanged), at the unmergeable
  header's own 2.75em height and content offsets (D33) — minimizing
  never moves, shrinks, or re-spaces the label row. The MAIN PANEL's
  face is its connection-status row (action icons hidden): old-viser
  continuity via a general mechanism.
- Gestures (collapse law 4; pane scope per label): a tab label's click
  expands the window to THAT tab; its drag tears THAT pane out into a
  new window born collapsed (a single-pane group floats wholesale, ids
  stable). The `+` (single-group windows, drag-through; aria "Expand
  panel") and any background press's motionless click expand the
  window — one flag, so every bar's expand affordance reveals the
  whole window by construction; a multi-group window's "Expand
  panels" is its header toggle's. Tabs hidden behind the `+N` are one
  expand away.

### 3.3 The rail (the collapsed docked stack: whole region D21, one column D28)

- One form, two scopes; explicit entry only (the chevrons — never
  emergent, collapse law 6). REGION scope (`regionCollapsed[edge]`,
  single-visual-column regions only): the whole region as ONE packed
  36px rail holding every leaf across every band, contiguous — the
  canvas gets the width back, no dead gaps. COLUMN scope
  (`DockColumn.railed`, columns of multi-column bands): THAT column as
  the same rail IN PLACE, band siblings unaffected. Either way structure
  stays in the MODEL and returns intact on expand — the rail is a view.
  Expanded width is remembered (P8): `regionWidth` for the region, the
  width weight for a column.
- Rail header: the collapsed stack handle (§1.2). Drag floats the scope
  as one COLLAPSED window (identity transfer, D38); click or `+`
  expands the scope, clearing ONLY the rail flag. Honest labels:
  "Expand panel area" / "Expand column" — never "Expand all panes".
  Keyboard expand lands focus on the first revealed cell's active tab
  — or on its header toggle when that panel is unmergeable (a
  full-width header renders no tab strip; §4's fallback).
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
  every right-end control (T6 resolved): the drag drags the handle's
  scope. Collapse hands focus to the rail header that replaces the
  chevron, pointer and keyboard alike (edge case 14). Chevrons render
  only while expanded.

### 3.4 Floating window

- Multi-group: a window header — the stack handle — on top, ALWAYS
  present, even while collapsed (D17: a collapsed window is the same
  stack of cells, all 26px bars, at full `win.width`; no fit-content
  jump). Drag moves the window; its right-end toggle sets
  `window.collapsed` (D38 — one flag, so the old "minimize all /
  expand all" pair is simply "toggle"). Single-group windows have no
  header (coinciding scopes merge, §1.2): the grip bar moves the window
  and carries the `−`, setting the same flag.
- Cells render as §3.1 without the docked context; a collapsed window
  renders every cell as its bar (§3.2). Mixed windows are
  unrepresentable (D38).
- Side grips resize width; top/bottom/corner grips resize height (pin),
  with a detent that snaps back to auto-height at the content height. A
  fully-minimized window keeps its WIDTH grips (D15 — the bars hold
  `win.width`, P8) and hides the vertical/corner grips (nothing to size);
  it ignores a pinned height.

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

### 3.6 Nested area

- A flat tab strip + body inside a host panel. Drops:
  insert-at-tab-position over its tab strip, merge elsewhere. Never
  splits, never minimizes separately.
- A frame of the host panel around the area stays hot for the HOST's
  zones, so a full-bleed area doesn't make the host undockable-beside
  (P5).

---

## 4. Gesture reference

Threshold: a press becomes a drag past 3px of motion; below that, release
is a click. One active gesture at a time; extra pointers are ignored.

Every row below follows from §1 — *a press on a handle drags its scope;
a motionless handle click is its right-end action (backing); pane-scope
surfaces (tabs, labels, spine rows) act on their pane; every affordance
on a collapsed container acts on its ONE flag (D38)* — except where
marked ⚠ (stated, not derived; see §10 tensions).

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
| Bar `+` (right end; single-group windows only — a multi-group window's expand is its header's, P9/T4) | that group (drag-through; born collapsed) | expand the window ("Expand panel") |
| Region parent handle — pill / background | whole region (as one stacked window) | collapse region to the rail (backing for its chevron) |
| Region-collapse chevron | whole region (drag-through, T6 resolved) | collapse region to the rail; focus hands off to the rail header (both input paths) |
| Column parent handle — pill / background | that visual column (as one stacked window, height ratios preserved) | rail that column when the handle hosts a chevron; ⚠ no action on a pill-only handle |
| Column-collapse chevron (band has sibling columns, D28) | that visual column (drag-through, T6 resolved) | rail that column; focus hands off to the column rail's header (both input paths) |
| Rail header (region or column scope) | that scope — floats as one COLLAPSED window (identity transfer, D38) | expand the scope (clear its flag) |
| Rail cell cap / background (quiet pill) | whole group — new window born collapsed | expand scope + group (lone cell only; inert with 2+ cells) |
| Rail spine row | that pane — new window born collapsed | expand scope to that tab |
| Region resize divider | region width (expanded columns only; railed columns ride as fixed chrome, §6) | — |
| Column (width) divider inside a band | neighboring columns' widths (inert only when a RAILED column flanks it — bars never make it inert; they hold their column's width, D20/D24) | — |
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
path too: the activated control unmounts under the click either way,
so pointer collapse hands focus to the same replacement control
(restored after T6's drag-through rerouted pointer clicks through the
host's backing, which had silently dropped it).

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
   region's first content, full height. Active past the screen edge (slam
   gestures).
2. **Insertable tab strip** (override, ⚠ inversion): a pointer over a tab
   strip where a tab insert would resolve always beats region-level bands
   — specific intent beats broad intent.
3. **Region edge bands** (occupied edge): 8px top/bottom bands insert a
   full-span band above/below everything; 40px outer/inner side bands
   dock a column at that side, each capped to a third of the region
   width so the middle third stays for per-cell zones. The full-span
   side result ("beside everything") survives only where it is honest:
   a single band, a canonical stack (all bands single-column — the drop
   ZIPS the bands into one nested column), or a D21-collapsed region.
   A non-zippable multi-band region (rows can't nest) resolves side
   hits PER BAND instead: a hit at y over band N inserts a column at
   band N's outer edge — a split on the outer column's nearest-y leaf,
   hint band-tall (P1) — so a pointer over band N never commits into
   band M. Except in a D21-collapsed region (whose bands narrow to
   thirds over a cell, leaving its middle zones reachable), the side
   bands YIELD entirely to any collapsed docked cell under the
   pointer: a 40px band would shadow a whole 36px rail whose own
   sliver already docks a column beside it — including a rail abutting
   the region edge, where the band cedes its entire claim. And the
   per-band claim extends INWARD over any run the band's content
   doesn't reach: an all-railed band packs its strips and leaves an
   empty tail whose only honest meaning is "split beside the outermost
   rail", not dead space. Suppressed where they'd duplicate a per-cell
   split (single leaf edge-wise) and while a floating window's paper
   rect owns the pointer (§3.5). Over a D21-railed region's EMPTY
   area, the side bands widen to left/right HALVES — no dead center
   stripe. The 8px top/bottom band-inserts and item 4's seams are
   SUPPRESSED over a D21-collapsed region: a band-insert into a rail
   has no honest geometry (D39 — the expanded newcomer would be
   swallowed collapsed), so those pointers fall through to the rail's
   own cell zones and the drop JOINS the rail. A seam band-insert
   takes an equal share of region height
   (the MEAN of existing band weights) — a fixed weight could render
   as a 0px sliver on a px-scale region.
4. **Cross-band seams**: the divider between two bands inserts a new
   full-width band at that index. Band extents come from rendered cell
   rects, and an all-railed band's cells are content-tall — so its
   extent extends to the RENDERED band box, derived from its
   neighbors' edges and the container's (rails hold width, not
   height); the seam sits at the true divider, never mid-band. The
   D21 packed strip has no band boxes at all: its seams are suppressed
   with item 3's band-inserts — drops join the rail (D39).
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
that cell (top 8px stack-above, then insert at position 0) and the
empty tail below the spine rows to the last cell (side slivers run full
height; the middle is stack-below, with the hint at the spine content's
true bottom — where the new cell actually lands — not the strip's far
bottom). Interior cells keep their own boxes. Region-rail cells stay
content-sized: the D21 halves bands (§5.1 item 3) already cover the
strip's empty area.

### 5.4 Bar zones (in-place minimized cells)

- A bar's whole slot is a drop target: drop merges into that group,
  staying minimized. Insertion at a tab position aims at the bar's
  visible tab labels (D36); a drop right of the last label appends.
- Docked bars do not exist — docked collapse renders as the rail
  (D38), and the rail's zones are §5.3's.
- Floating bars are ordinary stack cells (D17): top/bottom snap zones
  of `min(10px, barHeight/3)` — ≈8.67px on the 26px bar — insert into
  the window's stack at that seam. Thirds because a flat 10px is
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
  middle of; the vertical gap between side-by-side columns to the
  column insert at that seam (left half splits right of the left cell,
  right half left of the right cell — the same landing, mirror-
  symmetric, hint at the gap center); a floating stack's gap to the
  snap at that index — the hint never flickers to "no drop" crossing a
  seam.

Collapse is the container's (D38), so drops need no adoption or
normalization rules: a group joining an expanded container renders
expanded (its old container kept the state); a pane merged into a
collapsed container's group becomes a tab inside it, still collapsed —
dropping into a minimized target never expands it (edge case 1).
Whether INSERTING an expanded panel into a collapsed window collapses
the newcomer (container rule) or expands the window is an open
sub-question (§10).

---

## 6. Sizing model

- **Region width**: expanded columns of the width-determining band (the
  widest) carry pixel widths; the region's width is their sum, with
  every RAILED column counted at its rendered 36px — a railed column's
  stored weight is ALWAYS its P8 restore width, and no aggregator
  (region width, reserved-width planning) ever reads it as rendered
  width (D40). Docking a
  new column *grows* the region by the newcomer's width (D3): existing
  panels never shrink because something arrived (P3 outranks canvas
  preservation; the resizer is the recovery). The newcomer's width IS
  the dragged window's width — every drag-dock path floats first, so
  the window still carries it — born railed included: the new column
  STORES the window's width, so the rail round-trip restores it, and
  contributes only the rendered 36px strip (D40, superseding the
  born-railed-36-weight clause). Columns with NO source window
  (server-built / injected layouts) take the 300px region default as
  their restore width even when born railed; the 36px rendered
  accounting keeps an injected all-railed row from reserving phantom
  300s. D3 binds every band, not just the width-determining one: a
  narrower band gaining a column never halves its survivors — with a
  fully-railed widthRow the region grows by the newcomer and survivors
  keep their pixels; with an expanded widthRow the region width holds
  (the rail band's fixed chrome is the slack). A RAILED column renders
  at the fixed 36px rail width, stored weight preserved (P8) — that
  weight is a RESTORE width, never silently rewritten by a drop; the
  resizer redistributes over EXPANDED columns only, and the region
  stops being width-resizable when it is railed or every
  width-determining column is.
- **Minimums**: expanded columns / regions / windows ≥ 96px grab width
  (`MIN_REGION_GRAB_PX`; the ~220px CONTENT minimum is the body's —
  below it the panel scrolls horizontally); cells ≥ ~50px; windows ≥
  50px height, floored at the content height when shorter. Resizes
  clamp; they never squeeze a cell below its header. The cell minimum is
  also a RENDER floor on expanded docked leaves (mirroring the floating
  stack's, P7) — without it repeated same-target splits clip the
  smallest cell's chrome. Railed columns don't raise their band's height
  floor (a rail's spine scrolls internally); an all-railed band's
  divider MIN is the ~60px grab floor — but bands never
  height-COLLAPSE: rails hold width, not height, so an all-railed band
  renders full-height rail strips like any band (the bars-era band
  collapse squeezed rails into a sliver behind a scrollbar — fixed
  2026-07-06, pinned by the full-height rail e2e test).
- **Split defaults**: a top/bottom leaf drop and a left/right column
  drop both default the two sides to HALF the target's current weight —
  sibling weights may be on any scale (divider drags write px), so only
  a scale-invariant default keeps the hint's 50/50 promise (P1). A
  RAILED target column is exempt: its weight is a P8 restore width,
  not a rendered share — halving it would permanently corrupt the
  expand width, so it stands and the newcomer takes a width default
  instead (reconciled to the dragged window's width above). A
  multi-group stack dropped top/bottom divides its half among its leaves
  by the stack's preserved height ratios (P8).
- **Dividers** (D24): a divider is INERT — no resize cursor, no armed
  gesture, no height-pin side effect — unless something tradeable sits
  on EACH side (a cursor that no-ops lies). Height dividers need an
  expanded cell each side (bars are fixed 26px); width dividers go
  inert only beside a RAILED column (fixed chrome, D28). Floating stack
  dividers carry the same ~12px invisible grab overlay as docked ones
  (P11) — only while resizable.
- **Stack grow normalization**: flex-grow factors normalize per site
  over EXPANDED cells only — minimized cells render flexGrow 0 — so
  freed space is never stranded (edge case 16).
- **Round-trips** (P8): float→dock carries height ratios into the
  column; dock→float restores the remembered window size;
  minimize→expand holds width by construction; rail→expand restores the
  pre-collapse width at either scope — a column born railed from a
  window expands to that window's width (D40); a railed column dragged
  out floats at its preserved expanded width; reconnects replay the
  same sizes.
- **Windows**: auto-height tracks content up to the container; pinned
  height is user-set via the bottom grip; the content-height detent
  un-pins. A fully-minimized window ignores pinned height.

---

## 7. Minimize / expand semantics

The collapse law (§1.3) states the semantics; this section is the
op-level residue.

- Stores and ops (D38): the `−` / window-header toggle flips
  `FloatingWindow.collapsed`; the chevrons set `DockColumn.railed` /
  `regionCollapsed[edge]`; every expand path clears its container's one
  flag. Ops act on containers; groups carry nothing. Collapsing a
  missing scope is a no-op; clearing is always legal — and collapse
  ops REFUSE geometry with no honest collapsed form: railing the sole
  column of a single-column band in a mixed region is gated at the op
  level, not just in chrome (D39).
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
  already rendered them) — never split per band, which would strand a
  railed loner the D39 rule then expands, leaving a half-railed rail.
  Where both docked flags exist, region takes render precedence.
- Structural carry and migration: a D12 band split leaves fragments of
  a railed column railed (same picture re-expressed, P14); a D13 zip
  keeps the flag only when BOTH halves carried it; a railed column
  left as its band's SOLE column migrates its flag to the REGION store
  at canonicalization when every band is single-column and every
  column railed — the region rail is the identical picture (collapse
  law 5 — the pre-D38 degrade-to-bars rule is dead) — and otherwise
  DROPS it and expands (D39). That drop is the P3(c) structural
  necessity, spelled out: a rail inside a full-width band is the dead
  geometry D28 rejected, so the expansion is forced, not chosen — the
  one collapse change no gesture asked for. The same rule governs the
  transfer clause below: a collapsed band-insert into an expanded
  canonical stack lands EXPANDED (its rail would be a lone-column
  band). Invariants reject the stranded state at commit (D39).
- Transfers (collapse law 3): floating a railed scope by its header
  yields a COLLAPSED window; docking a collapsed window rails the
  landing column or joins/creates the region rail — except a
  band-insert into an expanded canonical stack, which lands expanded
  (D39, above); any container created by dragging out of a collapsed
  scope (spine row, cap, bar label) is born collapsed. No stamping
  exists; server `float()` moves geometry and touches no collapse,
  and a server docked→docked position move carries the source
  container's collapse the same way — identity on both paths (§8).
- A railed scope reserves exactly 36px; it is still a full drop target,
  and a railed region still hosts region-edge docking on its outer
  side.

---

## 8. Server placement semantics

- Three independent write-only axes per panel: position, width, height.
  There is no collapse axis (D31). A message carries exactly one axis;
  applying one can never disturb another (no yank by construction).
- Moves are identity for collapse (collapse law 3): a position command
  on a docked panel that lands docked carries its container's collapse
  — a railed source lands railed — exactly like the user path, which
  floats first so identity rides the window. Identity both paths; a
  placement command never expands a railed panel.
- Fresh vs stale: each panel has a monotonically increasing layout
  counter per server run. An axis message applies iff the user hasn't
  touched that panel since the message's stamp, or the stamp is provably
  newer than the last applied. Late joiners replay the latest message
  per axis and reconstruct the same placement.
- A replay bundle applies position first, then size — size ops resolve
  against the panel's FINAL location.
- Split placements (`dock_below(anchor)` etc.) defer until the anchor is
  actually docked; a never-dockable anchor (hidden, emptied, cyclic)
  falls back to a right-edge dock rather than hanging (P5).
- `visible = False` removes the panel from the dock without destroying
  it; `True` re-places it via its stored placement axes.

---

## 9. Edge-case catalog

Behaviors that MUST hold (each is or should be pinned by a test):

1. Drop on a minimized target merges *without expanding it*; a drop
   beside a collapsed container never collapses the dropped stack, and a
   group joining an expanded container renders expanded — both are
   consequences of container-owned state, not rules (D38).
2. Escape mid-drag restores pre-gesture collapse flags along with the
   layout — drags never change collapse (P2), so the restore is a pure
   state return with nothing to re-expand.
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
    a rail clears the owning flag. A docked scope never renders
    in-place bars: the rail is the docked rendering (D38).
13. Region-edge docking beside a railed region stays reachable from the
    outer half of the rail (§5.1 item 3).
14. Bar/rail keyboard expand moves focus onto the revealed tab strip
    (an unmergeable reveal: its header toggle, §4); keyboard
    minimize/collapse moves it onto the replacement control (the bar's
    `+` or window-header toggle / the rail's header). Neither
    direction — on either input path (§4) — drops focus to `<body>`.
15. Left/right mirrored layouts resolve mirrored drops everywhere (P7,
    swept).
16. Expanded content absorbs ALL space freed by collapsed chrome — no
    band/column/stack ever strands dead area from fractional grow sums
    (normalization over expanded cells only, §6; railed columns excluded
    the same way).
17. Docking a column beside a region-railed region consolidates the
    rail (§7): the whole old rail becomes one railed column (stacked
    bands included) beside the expanded newcomer — never a half-railed
    split.

---

## 10. Cross-check protocol (phase 2)

For each table row and catalog item above: find the implementing code
and the pinning test; record `OK` / `DIFFERS (code)` / `DIFFERS (spec)`
/ `UNTESTED`. Differences resolve in review; "spec changed because X"
lives in §11 and git history. Suites: `hitTest*` (zones, sweep, mirror),
`layoutOps*` (ops, fuzz, lifecycle), `panelPlacement` (gating),
`tests/e2e/test_dock_playground_*` (gestures), `tests/e2e/test_panels.py`
(server round-trips).

Prior passes, one line each (full fix lists live in git history):

- 2026-07-03 — full pass post D1–D9: 0 DIFFERS; edge case 10 pinned.
- 2026-07-03, end of day — D10–D13 implemented and verified (452 unit
  tests incl. the canonicalizer suite; e2e green; CI 23/23).
- 2026-07-04 — normative re-sync to D16–D22 after the minimize redesign.
- 2026-07-04, stability-loop iterations 2–5 — hit-box/display/UX audits
  plus a real-example pass drove D23–D25 and the D4/D6/D19 amendments,
  plus code fixes (placement-axis ordering, owning-window drop mask, P6
  user-op commits + rail placement signatures, keyboard focus handoffs,
  band minimums, content-top band restored to split-above).
- 2026-07-04 — D26 (region parent handle) landed and re-audited; full
  §10 pass same day (record below).
- 2026-07-05 — D27–D31 landed with sections re-synced and new pins
  (rail round-trips, conversion incl. zip, D12/D13 flag carry,
  lone-in-stack `−` gating, `expandStackOf`); server collapse axis
  deleted.
- 2026-07-05, later — D32–D38 adjudicated (user pass on the docked main
  panel and stack minimize, culminating in D38's one-state rule);
  normative text updated ahead of enforcement.
- 2026-07-06 — rail drop zones re-derived from first principles after a
  real-layout report (expanded band over two railed columns): (a) no
  zone left of the leftmost rail — the 40px side band shadowed the
  whole 36px strip; (b) cell-short hints beside rails; (c) side hits
  over band 2 committing into band 1 — plus width rows W1–W12 (a
  collapsed drop reserving +307px of phantom width, survivors halved
  in non-width bands, railed P8 restore widths corrupted by the split
  default). Fixes, now normative in §5/§6: per-band side resolution,
  band-tall side hints with rail-honest band extents, the full-strip
  rail drop surface, left/right divider-gap recovery, window-width
  newcomer defaults (the born-railed 36px WEIGHT clause of this record
  was later superseded by D40 — the weight is the window's width, 36px
  is rendering only). The sweep test
  had laid rails at weight-share width, band-tall, never collapsed —
  geometry rails never have; it now mirrors the renderer, with two new
  invariants: every target reaches at least one zone, and no
  split/merge/insert commits across bands.
- 2026-07-06, later — chrome enforcement: D32–D38 enforced (completion
  record below); T4 resolved to the rail's one-signifier rule; T6
  resolved to drag-through.
- 2026-07-07 — stability pass 1: three parallel audits (UX/spec
  conformance with live probes and screenshots; model/state with
  ops-level execution; zones/geometry with the renderer-true sweep
  harness). Findings by family: RAIL STRANDS — three reachable paths
  minted a railed sole-column band in a mixed region (a collapsed
  source seam-inserted, the last expanded band-sibling removed, an
  ungated programmatic collapse), a fourth silently expanded a railed
  survivor, and band-inserts over a region rail swallowed expanded
  drops → D39, §5.1 suppression, op gates, commit invariants (no
  railed sole-column band; region flag ⇒ docked edge; region rail ⇒
  all bands single-column), canonicalization added to the fuzz
  pipeline. WIDTH — the born-railed 36px weight doubled as the P8
  restore width (expand → 36px sliver; all-railed width row → a 350px
  region collapsed to 122px on one click) and injected all-railed rows
  reserved phantom 300s → D40. GEOMETRY — rail cell drop rects
  unclipped to the rail's scroll box (cross-band commits, displaced
  seams, over-tall hints) and a ~7px dead pocket at column÷cell
  divider T-junctions → scanner clip + recovery fallback, code-side.
  SERVER — a docked→docked position move dropped collapse while
  `float()` carried it → identity both paths (§8). FOCUS — keyboard
  expand onto an unmergeable reveal, and pointer-path collapse after
  T6's drag-through, both dropped focus to `<body>` → §4's no-tab
  fallback and pointer handoff restoration. STALENESS — enforcement-
  pending framing, chevron click-only rows, the unqualified bar-`+`,
  expand-on-drag references, and record dates swept (this revision).
- 2026-07-07 — stability pass 2: three parallel audits over the
  container-collapse generation (one credit-interrupted; its finding
  recovered from scratch tests and hand-verified). Finding: docking a
  panel beside a region rail built from STACKED bands half-railed it —
  the beside-dock railed each band's column individually, so every band
  but the target's became a railed loner the D39 rule then expanded.
  Fix: `dropOnDockedLeaf` and `dockToEdge` consolidate the rail into
  ONE railed column beside the expanded newcomer
  (`consolidateRegionRailToColumnInPlace`); a railed target column
  never band-splits. §7 conversion rule, D39, edge case 17 corrected
  from per-column to consolidation; two regression pins.

**Full-pass record — 2026-07-05 (scope-model rewrite):** every
normative claim in §1–§9 (pre-D32 state) was re-traced to
`src/viser/client/src/dock/*` and `ControlPanel/*`. Verdicts: §1 —
handle anatomy, presence gating (`isLoneInVisualColumn`, chevrons,
pill-only lone columns), `expandStackOf` scoping all confirmed. §3 — 0
DIFFERS; one SPEC fix: P13/§3.2 still claimed "grip-bar gray" bars while
D19 and `MinimizedBar.tsx` (body surface) said otherwise — resolved to
D19/code, no code change. §4 — all rows traced (threshold strictly >3px,
`MOTION_THRESHOLD_PX`; wording fixed from "≥3px"). §5 — zone geometry,
seam recoveries, owning-window mask, mean-weight inserts, bar-append
bound match `hitTest.ts`. §6 — constants confirmed (96/220/50/50/60;
half-target splits; cascadeResize). §7 — conversion,
degradation/promotion, stamping, user-op rail commits, `:r`/`:R`
signatures confirmed (`layoutOps.ts:1803–2105`). §8 — three axes,
position→size order, deferral + right-edge fallback confirmed
(`placementGate.ts`, `placementCoordinator.tsx`). §9 — 0 DIFFERS.

Accepted trade (re-verified 2026-07-04): on a LEFT region squeezed into
the scrolling state, the RegionResizer's 5px over-the-panel strip (below
the 48px chrome clearance) overlaps the column scrollbar's outer edge.
The scrollbar's remaining width still scrolls, and narrowing the straddle
would cost the region-resize grab everywhere for a rare degenerate state.

### D32–D38 — completion record (adjudicated 2026-07-05; enforced
2026-07-06; verified in stability pass 1, 2026-07-07)

The enforcement worklist that lived here is done; every item was
re-verified in code and live during pass 1:

- **D32**: the `−` renders only on single-group floating windows
  (`isSoleFloatingGroup`); a docked sole panel shows zero minimize
  controls. Open (a) — the pill-only lone column — closed by D39:
  uncollapsible (its rail is illegal geometry). Open (b) confirmed: a
  1-leaf column of a multi-column band collapses solely via its
  chevron.
- **D33**: exact, pixel-verified — the main panel's face bar measured
  against its expanded header: label x 671.09 = 671.09, toggle x
  951.16 = 951.16, toggle width 17.75 = 17.75; window rect unchanged
  across the round-trip.
- **D34**: all collapse transitions animate (cell flex, rail/region
  widths, window height), with one honest gap on record: an
  AUTO-height window's expanded height is CSS `auto`, which cannot
  interpolate — its collapse snaps (endpoints honest, no JS
  choreography per P4); pinned-height windows animate both directions
  against a deterministic collapsed height
  (`collapsedWindowHeightCss`).
- **D35**: real tooltips on every `−`/`+`/«/».
- **D36**: labels in order until they don't fit, `+N` for the
  remainder only, per-label click/drag, insertion across visible
  labels, per-label `tablist`.
- **D37/D38**: `TabGroup.collapsed` DELETED; `FloatingWindow.collapsed`
  added; transfers are identity; drag-outs born collapsed; hitTest
  container-derives collapsed-ness; `stampCollapsedInPlace` and
  `isLoneInVisualColumn` survive only in "this is gone" comments.

Still open (from D37, carried through D38): inserting an EXPANDED
panel into a collapsed window — collapse the newcomer (container rule)
or expand the window? Code applies the container rule consistently at
every join path; adjudicate before wiring the snap zones.

Resolved by the above and removed from the tensions list: T1 (rail vs
bars are two renderings of one container state — D38 dissolves the
tension entirely) and T2 (the docked double control is gone; handle
stacking remains but no longer competes, D32).

### Open tensions (unadjudicated — do not resolve in code without a D-record)

Rules that still do NOT derive cleanly from §1. Each lists the principle
it strains, the code's current behavior, and options.

- **T3 — The bar breaks the handle anatomy.** Strains §1.2. A collapsed
  panel's rendering has no centered pill; its labels sit left (D36
  strengthens this — the bar reads as a compressed tab strip), and face
  bars replace the anatomy wholesale. The rail cap — the same scope,
  collapsed differently — keeps the pill and drops the control. The
  reconciliation on record (D18: pills mark handles that are slices of
  larger surfaces; the bar keeps HEADER anatomy — identity left,
  control right) works, but a stacked cell's grip bar is also
  handle-in-its-entirety and keeps its pill. Options: restate the
  anatomy law as two-tier (identity-bearing headers vs anonymous
  slivers) — spec-only; or restore the pill (rejected on use, D18).
- **T4 — Expand-signifier multiplicity on collapsed windows.** Strains
  P9. The rail applies P9 strictly: ONE `+`, on the header (D25 —
  "three `+`s in a 36px rail read as three different mysteries"). A
  collapsed window does not: every bar's `+`, background, and labels
  clear the same flag (D38), and the header toggle besides — N+1
  signifiers for one action. D25's reasoning applies verbatim and was
  not applied. Options: (a) accept — per-bar chrome must exist on a
  single-bar window, and presence flipping with stack size moves
  chrome; (b) one `+` per collapsed window (header only); (c) per-cell
  expand (rejected by D31 and structurally dead under D38).
  RESOLVED (2026-07-06, chrome enforcement): the rail's one-signifier rule applies — a multi-group collapsed window's bars carry no individual `+`; the window header's toggle owns expand; bar labels remain unmarked backing and the keyboard path.
- **T6 — Chevrons are click-only; every other right-end control is
  drag-through.** Strains §1.2's fixed anatomy / P2 uniformity. Code:
  toggles flow presses to the handle's drag arbitration; the chevrons
  swallow pointerdown. No derivation on record (carried from D23 by
  fiat), and drag-through would be harmless — the drag would drag the
  scope, the click already equals the backing click. Options: make
  chevrons drag-through; or record the justification.
  RESOLVED (2026-07-06, chrome enforcement): chevrons are drag-through. D32 made every chevron host's motionless click back the identical collapse, so the press can flow to the host's drag-starter like all other right-end controls. Pointer-click focus handoff initially moved to the keyboard/synthetic path only; stability pass 1 found that dropped pointer focus to `<body>` and restored the handoff on both input paths (§4).
- **T7 — The region scope loses its handle in multi-column regions.**
  Strains one-handle-per-scope, and D32 raises the stakes: docked
  collapse now lives exclusively on chevrons, so a scope without one
  (the multi-column region; the lone column, adjudicated uncollapsible
  by D39) is uncollapsible. The derivation (a packed rail can't
  honestly render a
  grid; a handle may not span what its drag would flatten — D27) makes
  this a geometric limit. Options: accept; or give the region scope a
  compound affordance railing every column.
- **T8 — The tab-strip override inverts zone priority.** §5.1 resolves
  outermost first except item 2, where a pane-scope insert beats region
  bands. "Specific intent beats broad intent" is a second axiom, not
  derivable from nesting. Accepted ergonomics; recorded so the next zone
  addition doesn't cargo-cult either rule.
- **T9 — Minimize changes the handle's surface.** Strains P13's literal
  reading. Code: an expanded grip bar is chrome gray; its bar is
  body-colored (D19: "a bar IS the panel, sleeping"). D33 makes POSITION
  constancy exact but says nothing about surface; the keep-list is
  explicitly {position (exact), width, height*, control form+inset}
  (*face bars) — surface constancy holds only for titleNode headers and
  face bars. Options: accept (user-directed on real use) — the default;
  or extend D33 to surface (re-grays plain bars, re-opening D19).

---

## 11. Decision record

Former open questions, decided with the maintainer. The normative
sections are the single statement of current behavior; these records
preserve each decision's rationale — history, not normative text. The
play-by-play lives in git history.

- **D1 (merge zone, 2026-07-03):** generous per-cell split bands (30%
  sides ≤120px, 25% top/bottom ≤100px) leave center-merge roughly the
  middle third: splits are the casual default, merging requires aim. No
  dwell timers (P4).
- **D2 (band-bar background drag, 2026-07-03):** the band bar's
  background dragged the whole band. Retired with the band bar (D20).
- **D3 (region growth, 2026-07-03):** side-docking always GROWS the
  region by the newcomer's width; existing panels never shrink because
  something arrived. Canvas cost accepted; the resizer is the recovery.
- **D4 (thin zones, 2026-07-03; final 2026-07-04):** sub-minimum drop
  zones are REMOVED, not shrunk (P11): band segments lost their 6px
  top/bottom zones (seams next door express the intent), floating-bar
  snap zones became `min(10px, height/3)`.
- **D5 (tear-out granularity, 2026-07-03):** resolved by D9, rescoped by
  D14 — per-tab tear-out lives where per-tab labels live.
- **D6 (minimize gesture, 2026-07-03; final 2026-07-04):** the `−` stays
  the only visible minimize signifier; a motionless click on its host
  row is unmarked backing for it. Double-click rejected: it would extend
  the P2 grammar globally for one shortcut. Scoped by D30, then D32.
- **D7 (release over nothing, 2026-07-03):** always float at the
  pointer. Motion means move; Escape is the abort.
- **D8 (main panel, 2026-07-03, amended):** ordinary in the MODEL; the
  shipped panel opts into `unmergeable` with a titleNode header.
  Unmergeability is a per-pane property, not main-panel special-casing.
- **D9 (segment anatomy, 2026-07-03):** one label per tab on minimized
  surfaces (click = expand to that tab, drag = tear out). Superseded on
  bars by D14's single title; survives as the rail's spine rows and,
  via D36, back on bars.
- **D10 (minimize keeps the chrome — P13 adopted, 2026-07-03):**
  minimized bars are the expanded header kept in place: title left, one
  toggle at the RIGHT where the `−` was, width unchanged. The rail is
  the documented exception (reclaims width).
- **D11 (keep the 4-level model, 2026-07-03):** single-group columns
  REJECTED: they would make vertical stacking narrower than the region
  unrepresentable ("dock below just A beside B") and break floating
  stacks' side-docking. Confusion is addressed by canonical form
  (D12/D13), not amputation.
- **D12 (canonical bands, 2026-07-03):** a multi-leaf column may exist
  only when its band has sibling columns; lone multi-leaf columns
  normalize into consecutive bands (heights preserved) at structural
  commits.
- **D13 (zip-merge, 2026-07-03):** adjacent bands with the same
  multi-column partition (~2px) zip corresponding columns — one seam,
  one set of handles for a 2×2 grid. Structural commits only.
- **D14 (single-title bars, 2026-07-04; partially superseded by D36):**
  bars show ONE title (active tab + `+N`), not a label per tab —
  hands-on review found per-tab labels busy — at grip-bar scale (26px).
  A minimized panel reads as "the panel collapsed to its handle". The
  rail confirmed KEPT (width reclaim). D36 restores as many labels as
  fit; the `+N` survives for overflow only.
- **D15 (minimized windows stay width-resizable, 2026-07-04):** a
  fully-minimized window keeps its side grips — the bars hold
  `win.width` (P8) — and hides vertical/corner grips. Same round: pill
  position constancy folded into P13; edge case 16 added after the
  fractional flex-grow bug.
- **D16 (per-cell minimize everywhere, 2026-07-04):** the
  uniform-collapse invariant DELETED — any cell minimizes individually;
  mixed stacks legal. With it died normalizeStackCollapseInPlace,
  invariant #14, and the adoption rules. Amended by D30/D31; D37 later
  reinstated a STRONGER, scoped uniformity — what survives of D16 is the
  per-cell model flag and the death of adoption.
- **D17 (minimized floating stacks are stacked rows, 2026-07-04):** a
  window is ALWAYS a vertical stack of cells, each expanded or a bar.
  The all-minimized "chip bar" mode deleted (inline segments,
  window-level `+`, chip wrappers, window pill). Inserting into a
  minimized stack uses ordinary seams.
- **D18 (no pills on bars, 2026-07-04):** a bar is a handle in its
  entirety; a pill inside it is a redundant signifier. Pills remain on
  expanded headers, where the handle is a slice of a larger surface.
- **D19 (pane-provided minimized face, 2026-07-04; amended
  2026-07-06):** a pane may provide
  a custom face for its bar, rendered at the unmergeable header's own
  height (2.75em) on the panel's body surface: minimizing removes
  content but never moves, shrinks, or recolors the label row. ALL bars
  are body-surfaced (user-directed: "a bar IS the panel, sleeping" — the
  earlier gray uniformity was reversed on use). The main panel's face is
  its connection-status row. One helper (`minimizedBarPx`) keeps layout
  math and rendered heights agreeing.
- **D20 (band bar deleted; bars in place, 2026-07-04):** the segmented
  HorizontalMinimizedBand deleted. A minimized cell renders as its bar
  IN PLACE at its column's width; a fully-minimized band shrinks to bar
  height by flex. Accepted honest geometry: a minimized column beside
  expanded siblings shows bars at top, empty space below.
- **D21 (region collapse is explicit, 2026-07-04):** the rail never
  appears emergently when the last panel minimizes. An explicit chevron
  toggles `regionCollapsed[edge]`; expanding a panel from the rail
  clears it. Generalized to column scope by D28.
- **D22 (nested-column stack handle deleted, 2026-07-04):** its
  justification ("signals coupled collapse") died with D16. Partially
  superseded by D27's per-column handles, justified by scope honesty.
- **D23 (inline chevron, 2026-07-04; superseded by D26):** moved the
  chevron from a positioned overlay into the top-right cell's chrome
  row (the overlay occluded header content). Surviving clauses —
  click-only (since reversed: T6 resolved to drag-through,
  2026-07-06), no chevron while collapsed — carried into D26/D28.
- **D24 (inert dividers, 2026-07-04):** a divider with nothing tradeable
  on one side is INERT — a resize cursor that no-ops lies. Height
  dividers need an expanded cell each side; width dividers go inert only
  beside RAILED columns. cascadeResize walks past bars; grab overlays
  only while resizable.
- **D25 (one `+` per rail, 2026-07-04):** the rail cap stopped flipping
  between `+` (lone) and pill (stacked): ALWAYS a quiet pill; the rail's
  one expand signifier is the header's ("three `+`s in a 36px rail read
  as three different mysteries"). Lone-cell cap/background click remains
  unmarked backing. Honest toggle labels; keyboard expand focuses the
  first revealed tab.
- **D26 (region parent handle, 2026-07-04; supersedes D23's placement):**
  user-directed. The chevron on the top-right cell "appears on the first
  panel in a docked stack, but it really applies to all panels in the
  stack" — a P12 violation. A slim full-width parent handle above the
  region's cells: pill drag floats the stack, chevron at the right end,
  bar click backs it. Deleted: per-cell chevron slots, the grip-bar
  overhang, the strip corner reservation. Scoped by D27.
- **D27 (handle scope is a VISUAL COLUMN, 2026-07-04):** user-directed.
  With `[A][B]` zipped over `[A][C]`: "there are two columns. So there
  should be two separate parent handles. There's some weirdness right
  now where there's only one parent handle, and dragging it out produces
  [A]/[B]/[C]" — the region-wide handle promised the region as one unit
  while its drag flattened the structure (P1/P8/P12). Multi-column
  regions render a handle per column (drag = floatColumn, ratios
  preserved); single-visual-column regions keep the region handle, which
  resurrects automatically when a region drops back to one column.
- **D28 (per-column rail, 2026-07-05):** user-directed. D21's rail
  generalizes to the handle's scope: `DockColumn.railed` renders that
  column as a 36px strip in place; column handles in multi-column bands
  carry the chevron. Conversion rule, from the user's request — "if we
  dock a new column next to it we should end up with the new column
  still expanded and the original rail still minimized as a rail" — ops
  adding a column beside a region-railed region clear the region flag
  and keep the old rail railed (refined by §7 to ONE consolidated
  column, 2026-07-07). Everything that knew the region
  flag extends to the column flag (classification, stamping, width
  restore, `:r` signatures, expand paths, D12 carry, D13 both-halves
  zip). Lone columns keep pill-only handles; railed-flanked width
  dividers go inert (D24).
- **D29 (unmergeable header chrome, 2026-07-05):** the DOCKED titleNode
  header always draws the gray top rule (separator from the parent
  handle above; floating keeps stacked-only), and the unmergeable
  header's toggle is the COMPACT ChromeToggle for both title forms — the
  whole header is the click target, so the toggle is a pure signifier.
  The user judged the full-size form visually heavy beside the panel's
  own action icons.
- **D30 (one collapse control per scope, 2026-07-05; amends D16, scopes
  D6):** user-directed: "Either all panels are minimized or none of them
  are. This would be simpler." The cell-level `−` (and its backing
  click) renders only where the cell IS its whole visual column
  (rescoped again by D32 to floating only); a 2+ stack collapses via its
  stack's control. Expand deliberately ungated everywhere (P5). D30's
  per-cell expand clause and the server collapse axis were superseded by
  D31; still standing: the control scoping, the model's per-cell flag,
  the minimized face.
- **D31 (collapse stack-scoped BOTH directions; no server collapse axis,
  2026-07-05):** user-directed, twice. Server: "Perhaps we should get
  rid of the `.minimize()` method in Python? it would be simpler that
  way." — `minimize()`/`expand()` and `GuiSetPanelCollapsedMessage`
  deleted; placement is position/width/height only. UI: "It's strange
  that panels in a stack can still be individually expanded after
  they're all minimized together." — a stacked bar's every expand
  affordance routes through `expandStackOf` (whole visual column, rail
  flags clearing). Collapse ops can no longer produce or preserve a
  mixed stack; the remaining sources (structural composition,
  degradation) were closed outright by D37. The model keeps the per-cell
  flag.
- **D32 (largest coinciding scope owns collapse, 2026-07-05):**
  user-directed: "The main panel can still be minimized when docked,
  which feels wrong." When scopes coincide, the LARGEST scope's control
  is the only collapse control (one-control-per-scope completed, P15): a
  sole docked panel collapses via the region handle's » to the RAIL; the
  panel-level `−` and its backing click render only on single-group
  FLOATING windows. Docked collapse is uniformly chevron → rail; the bar
  becomes a floating form. Resolves former T2. Enforced 2026-07-06;
  its open lone-column question closed by D39 (uncollapsible).
- **D33 (exact P13, 2026-07-05):** user-directed, twice: "The spacing of
  the panel also changes when the panel is minimized, which is wrong,"
  and "The `−` and `+` icons for the expanded and minimized main panel
  are laid out differently." Constancy becomes exact: the label row
  keeps identical x/y offsets and padding across minimize/expand, and
  the right-end control keeps the same form at the same inset in both
  states. Enforced 2026-07-06, pixel-verified (§10).
- **D34 (motion covers all collapse transitions, 2026-07-05):** the P4
  transition extends to floating-window minimize and rail
  collapse/expand widths at both scopes. Still presentation-only:
  instant model, reduced-motion, drag suppression. Supersedes "rail
  collapse stays instant". Enforced 2026-07-06 (auto-height gap on
  record, §10).
- **D35 (real tooltips, 2026-07-05):** every `−`/`+`/«/» control gets a
  real tooltip, not a bare `title` attribute. Enforced 2026-07-06.
- **D36 (bars show all labels that fit, 2026-07-05):** user-directed:
  "+N obfuscates what panels are present." A multi-tab bar renders its
  labels in order, as many as fit; `+N` covers the REMAINDER only.
  Per-label click/drag stays pane-scoped (D9's segment gestures return
  on the horizontal form). Partially supersedes D14. Enforced
  2026-07-06.
- **D37 (uniform collapse unrepresentable, 2026-07-05):** user-directed:
  "We should also make minimized panels in docked stacks
  unrepresentable." Uniform collapse graduates from an ops property
  (D30/D31) toward a model guarantee (P15): docked stacks never mix
  collapsed and expanded cells; the rail is their collapsed form. First
  specified as an invariant plus entry normalization; hours later D38
  made the mechanism structural (no group flag to normalize), subsuming
  D37's invariant, its entry-expansion P2 exception, and its open
  sub-questions. Closes D31's structural caveat.
- **D38 (collapse is ONE state per container, 2026-07-05):**
  user-directed, the model's centerpiece: "minimized with the '−' when
  floating and minimized with the '>>' when docked should use the same
  state representation… if we take a '−'-minimized window and dock it,
  it should become '>>'-minimized. And vice versa." Collapse is a
  single stack-scope state stored per container —
  `FloatingWindow.collapsed`, `DockColumn.railed`,
  `regionCollapsed[edge]` — and `TabGroup.collapsed` is DELETED (P15:
  group-level collapse unrepresentable). Bars (floating; width kept)
  and the rail (docked; width reclaimed) are two RENDERINGS of the one
  state; the `−` and » set the same property at their scope; transfers
  between worlds are identity (dock a collapsed window → railed scope;
  float a railed scope → collapsed window; drag-outs born collapsed) —
  no stamping, no adoption, nothing to normalize. `expandStackOf`
  reduces to a flag clear; orphan degradation becomes store migration
  to the region flag. Server API unaffected (no collapse axis exists).
  Enforced 2026-07-06 (§10; one open sub-question — an expanded panel
  inserted into a collapsed window).
- **D39 (band-scoped rail rule, 2026-07-07):** stability pass 1: three
  reachable paths (a collapsed source seam-inserted into a mixed
  region; the last expanded band-sibling removed by detach,
  merge-away, or server hide; an ungated programmatic collapse)
  stranded a railed column as its band's SOLE column — the full-width
  dead-band geometry D28 rejected, uncaught by any invariant — while
  the identical input in an all-single-column region resolved
  differently. The rule, band-scoped as the geometry is: a railed
  column that becomes its band's sole column MIGRATES its flag to the
  region store when the region rail is the identical picture — the
  whole region single-column and all-railed (collapse law 5) —
  otherwise the flag DROPS and the column expands, the only legal
  state for that geometry. The drop is a P2/P3 exception on
  record: a structural-necessity collapse change, spelled out here
  and in §7. The same rule at the transfer clause: a collapsed
  band-insert into an expanded canonical stack lands EXPANDED (its
  rail would be a lone-column band); and band-insert zones over a D21
  region rail are SUPPRESSED — the honest result, an expanded band
  inside a rail, is unrepresentable — so those drops join the rail
  (§5.1). Op gates (railing a lone column of a single-column band is
  refused at the op level), commit invariants (no railed sole-column
  band; region flag ⇒ docked edge; region rail ⇒ all bands
  single-column), and a normalized-pipeline fuzz enforce it. Closes
  D32 open (a): the lone column is uncollapsible.
- **D40 (a railed weight is ALWAYS the restore width, 2026-07-07;
  supersedes the 2026-07-06 rail-polish record's born-railed-36-weight
  clause):** stability pass 1: writing 36 as a born-railed column's
  weight made 36 double as its only P8 restore width — expanding it
  produced a 36px "expanded" column (below §6's 96px minimum), and in
  an all-railed width row one click collapsed a 350px region to a
  122px sliver. The contract: a railed column's stored weight is
  ALWAYS its P8 restore width; a column born railed from a window
  stores the WINDOW's width, so the collapsed round-trip restores it;
  aggregators (region width, reserved-width planning) account railed
  columns at the rendered 36px and read weights only from expanded
  columns. No-source-window columns (server-built / injected) keep
  the 300px default as restore width; the 36px rendered accounting
  stops injected all-railed rows from reserving phantom 300s.
