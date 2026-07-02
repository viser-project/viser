> **Historical design notes.** Working document from the design phase of
> the panels/docking feature; kept for context. The implementation has
> since evolved -- where this document and the code disagree, the code
> (and `dock-correct-by-construction.md`) are authoritative.

# Standalone Panels: Bugs, Behavior Concerns & Mitigations

Status: companion to `design/windows-api.md` · Branch: `brent/windows_api`

This document catalogs the known sharp edges of the standalone panels feature
(`server.gui.add_panel()` / `main_panel`), grouped into **(A) behavior that is
correct-by-design but may surprise users**, **(B) latent bugs / fragilities in
the implementation**, and **(C) interactions with existing features**. Each entry
notes the current mitigation and, where relevant, a recommended follow-up.

The throughline: placement is **imperative and one-directional** (server → client,
replayed to late joiners, never read back). Most concerns are downstream of that
single design choice (see `windows-api.md` §5).

---

## A. Behavior that may surprise users (correct by design)

### A1. The server never sees user rearrangement
After a panel is placed, the user can drag / dock / float / minimize it freely in
the browser. None of that is reported to the server. Consequences:

- There is **no getter** for a panel's current position, size, or minimized
  state. `panel.minimize()` is a fire-and-forget command, not synced state.
- Re-issuing a placement verb **overrides** whatever the user did. E.g. a 1 Hz
  loop calling `panel.dock_right()` would yank the panel back every second,
  fighting the user.

**Mitigation:** documented prominently in docstrings and the spec. Placement is
"initial intent + explicit repositioning," not continuous control.
**Follow-up:** if users need to react to layout, add a one-directional *event*
channel (`on_move` / `on_minimize`) — explicitly deferred (spec §13).

### A2. Per-client placement only repositions currently-connected clients
A placement command applies to all clients of the owning scope *at send time*,
and is replayed to clients that connect *later*. A client that was connected,
dragged the panel, and is still connected is **not** re-synced unless a new
command is issued. This is the same model as every other coalesced GUI prop.

**Mitigation:** matches existing viser semantics; documented.

### A3. `fixed` and `collapsible` are now identical
`configure_theme(control_layout="fixed"|"collapsible")` both translate to
`main_panel.dock_right()`. The old "fixed = cannot collapse" guarantee is gone —
every docked panel is user-collapsible in the dock system. A user relying on a
non-collapsible sidebar will find it collapsible.

**Mitigation:** `DeprecationWarning` points to `main_panel`; spec §11 documents
the dropped distinction. The legacy `SidebarPanel` code path is now unreachable
via the public API (see B7).

### A4. No close button — panels persist until `remove()`
Standalone panels (and their individual tabs) have **no** user-facing close
affordance. This is intentional (the server owns existence), and is satisfied
"for free" because the dock library never had a close button. Users expecting a
✕ will not find one.

**Mitigation:** documented; `remove()` is the only teardown path.

### A5. `dock_left`/`dock_right` ordering is call-order dependent
There is no anchor for edge docks. Two panels both calling `dock_right()` are
ordered by *call order* (`dockToEdge` inserts new-after-existing on the right,
new-before on the left). Reordering the Python calls reorders the panels. This is
subtle and unwritten in the panel's own state.

**Mitigation:** documented in `dock_left`/`dock_right` docstrings.
**Risk:** if two panels are created/placed from different threads, the resulting
order is non-deterministic. No locking around placement today.

### A6. `set_height` applies to floating panels only
`set_height` sets the window height of a **floating** panel. On any **docked**
panel — solo OR stacked via `dock_above`/`dock_below` — it is a no-op, because
docked cells size to their split weights, not an explicit px height.

**History/correction:** an earlier draft of the spec claimed `set_height` would
redistribute stack weights for stacked panels, but the implementation only ever
handled the floating case (`applyPanelPlacement` applies height only when the
group is floating). Rather than ship half-working weight redistribution, the spec
and docstring were corrected to "floating only," and stacked-height control is
explicitly deferred (spec §13). So there is no longer a spec/impl divergence.
**Mitigation:** documented accurately in the docstring + spec; silent + harmless
when docked. Covered by a unit test asserting the docked no-op.

---

## B. Latent bugs / implementation fragilities

### B1. Split placement falls back silently when the anchor isn't docked
`dock_above`/`dock_below` map to `dropOnDockedLeaf`, which requires the anchor to
be in a **docked** leaf. If the anchor is currently *floating* or *not yet
placed*, `applyPanelPlacement` falls back to a plain **right-edge dock** rather
than erroring. So `panel.dock_below(floating_anchor)` puts `panel` on the right
edge, nowhere near the anchor.

**Why:** the dock model has no "split below a floating window" op; the anchor's
docked leaf is the only valid split target.
**Mitigation (improved):** the fallback keeps the panel visible, and now emits a
`console.warn` naming the anchor and explaining it must be docked first — so the
mis-placement is diagnosable instead of silent. Verified by the warning
assertion in `panelPlacement.test.ts` and the e2e
`test_dock_below_floating_anchor_falls_back`.
**Residual:** the fallback edge (right) still isn't "below the anchor"; a fuller
fix (snapping into the anchor's floating stack) is deferred. Low priority — the
warning makes it self-explanatory.

### B2. Anchor resolution races panel creation order
`dock_above(anchor)` resolves the anchor → its group at *apply time* on the
client. If the anchor panel's create/registration message hasn't been processed
yet (e.g. the anchor was created microseconds before and its panes aren't
registered), `anchorGroupOf` returns null → B1 fallback. The Python side only
validates the anchor isn't removed / cross-scope; it can't guarantee client-side
ordering.

**Mitigation:** in practice messages are ordered on the wire, and the
`ready`-gated effect re-applies when the tab set settles, so the common case
works.
**VERIFIED not a practical bug:** `test_dock_below_same_batch_anchor` (e2e)
creates the anchor and the dependent back-to-back with NO wait between them and
asserts the dependent still stacks below the anchor on the same edge. Wire
ordering + the ready-gate are sufficient; the race did not manifest.
**Residual risk:** a truly pathological ordering could still hit the B1 fallback;
re-issuing the command fixes it. Low priority given the e2e result.

### B3. The whole placement dict is re-sent on every command
Because `GuiUpdateMessage` coalesces per prop-name (`update:placement`,
latest-wins), each command serializes and sends the *entire* placement object.
This is correct (partial updates would drop sibling fields — see B-rationale in
`_gui_handles._PlacementMixin`) but means rapid placement churn sends redundant
full dicts. Cheap (the dict is tiny), but worth knowing.

**Mitigation:** the buffer coalesces to the latest, so only one survives per
flush. No unbounded growth.

### B4. `placement` mutation is in-place and aliased
`_PlacementMixin._get_placement()` returns the *live* dict stored on the panel's
props (or on the api for `main_panel`); commands mutate it in place, then queue a
message referencing it. The message serializer reads the dict when the message is
flushed. If a second command mutates the same dict before the first flush, the
first queued message would serialize the *newer* state.

**RESOLVED (see F3).** The adversarial pass found this was NOT merely cosmetic:
the same aliased dict is also captured by the state recorder (`.viser` / embed),
where each message must be a point-in-time snapshot — a later mutation would
silently rewrite recorded history. `_send_placement` now snapshots with
`dict(...)` at send time (shallow suffices: `position` is always replaced
wholesale, never mutated in place), removing the entire aliasing hazard for both
the live buffer and the recording path.

### B5. `main_panel` updates bypass the GUI-config store
The control panel has no `GuiComponentMessage` config, so a `placement` update to
`CONTROL_PANEL_ID` is special-cased in `MessageHandler` (routed to
`setMainPanelPlacement`) to avoid the "non-existent component" error. This is a
targeted carve-out: any *other* update key sent to `CONTROL_PANEL_ID` is silently
dropped (the `continue` after handling placement).

**Mitigation:** only `placement` is ever sent to `CONTROL_PANEL_ID` today.
**Risk:** a future feature sending another prop to the control panel would
silently no-op. Guard: the carve-out only consumes `placement`, leaving room to
extend.

### B6. Registration → placement is a two-render dance
A standalone panel's panes must be registered (their pane specs created) before
placement can reference them; placing earlier races the registry reconciliation.
`StandalonePanelPlacement` gates on `ready` (all panes present in `dock.panes`)
and applies one render later. This mirrors the existing inline-tab-group pattern
(`DockableTabGroup`), so it's a known-good shape — but it means a panel briefly
exists *unplaced* (its group created, not docked) before the placement lands.

**Mitigation:** the unplaced window is invisible (no position) for ~1 frame.
**Risk:** a test asserting placement *synchronously* after create would flake;
the e2e tests use `expect(...).to_be_visible(timeout=...)` to absorb this.

### B6b. RESOLVED: a panel with NO placement verb was invisible
Originally, `add_panel()` followed by `add_tab(...)` but *no* `dock_*`/`float()`
created a group that was in `layout.groups` but in no docked tree / floating
window / area — so it rendered **nowhere**, silently. A likely user trip-up
("why isn't my panel showing?"). **Fixed:** `applyPanelPlacement` now floats an
unplaced panel at the default position when its placement has no `position`
(opt-in via `floatIfUnplaced`, default true; the control panel passes false since
it's floated separately). A panel the user already moved is left alone (the
guard checks `findGroupLocation === null`). Covered by
`floats an unplaced panel at the default ...` + the opt-out + the don't-yank unit
tests, and `test_add_panel_without_placement_is_visible` (e2e).

### B7. Dead code: the legacy `SidebarPanel` layout
With `control_layout` deprecated to `dock_right()`, the `ControlPanel.tsx`
sidebar path (`collapsible`/`fixed` → `SidebarPanel`) became unreachable: it
required `!useMobileView && !dockFloating` on a websocket source, but
`!dockFloating` on websocket implies mobile (since `control_layout` always
resolves to `"floating"`) — a contradiction.

**RESOLVED.** Deleted the sidebar branch from `ControlPanel.tsx` (now the mobile
bottom-sheet only), removed the `control_layout` prop from it and its App call
site, deleted `SidebarPanel.tsx`, and dropped the now-orphaned `controlWidthEm`
helper. The mobile bottom-sheet and static-export paths are unchanged; verified
by the full e2e suite (281 passed). *Confirmed first via tracing that no test
referenced the sidebar and static exports never mount `ControlPanel`.*

### B8. `add_panel()` always parents under `"root"`
Panels are created with `container_uuid="root"` regardless of the current
container context. Calling `add_panel()` *inside* a `with folder:` or
`with tab:` block still creates a top-level panel, not a nested one. This matches
`add_modal` (top-level by design) but differs from every other `add_*`.

**Mitigation:** documented as "top-level, like add_modal."
**Risk:** mild surprise; a user might expect context nesting. Acceptable.

### B9b. RESOLVED: stale `panelIds` in e2e helpers after the rename
The `Panel`→`Pane` client rename renamed the dock layout model's
`TabGroup.panelIds` → `paneIds`. The Python e2e helpers (`dock_helpers.py` and
two `test_dock_playground_*` files) construct/inspect layout dicts that mirror
that shape and still used `panelIds`, so injected layouts had `undefined` panes
and `set_layout` timed out. This passed unit tests (vitest doesn't touch the
Python helpers) and tsc (Python isn't typechecked against TS) but failed e2e —
**caught only by running the full e2e suite**. Fixed by renaming `panelIds` →
`paneIds` in the helpers. *Lesson: any rename of a serializable layout field must
also sweep the Python e2e mirrors, which no compiler checks.*

### B9. `add_panel` ignores the thread-local container; tabs use it correctly
Within `with panel.add_tab(...):`, the tab sets the active container so nested
`add_*` calls land inside — this reuses the existing `GuiTabHandle` machinery and
is exercised by `test_add_panel_add_tab_reuses_tab_group_machinery`. No known
bug, noted for completeness because the panel-vs-tab container scoping is subtle.

---

## C. Interactions with existing features

### C1. `reset()` removes standalone panels
`GuiApi.reset()` walks the root container and removes children, which now includes
standalone panels (they parent under root). So `reset()` tears them down — correct
and probably expected, but worth noting it now affects panels too. `main_panel`
is unaffected (it's not a child; its placement persists on the api).

**RESOLVED.** `reset()` now clears `_main_panel_placement` and broadcasts the
cleared placement, so it no longer replays to clients that connect after the
reset, and connected clients revert the control panel to its default float. The
clearing update is only sent when a placement was actually set (no spurious
message otherwise). Covered by `test_reset_clears_main_panel_placement`,
`test_reset_without_main_panel_placement_sends_nothing` (unit) and
`test_reset_reverts_main_panel_to_float` (e2e). Standalone panels are removed by
`reset()` via the normal root-container walk, so no analogous residue exists for
them.

### C2. Garbage collection of removed panels
`remove()` on a panel queues a `GuiRemoveMessage`; the message buffer purges
pending `update:placement` messages for that uuid (the remove-purges-updates path
in `_async_message_buffer`). Verified indirectly by the existing entity-lifecycle
tests passing. A panel removed before any client connects leaves no residue.

**Mitigation:** covered by existing buffer GC; `test_remove_panel_removes_it`
(e2e) confirms the client drops it.

### C3. Multi-client / per-client scope
`client.gui.add_panel()` creates a panel scoped to one client; `server.gui` is
broadcast. The anchor rule forbids cross-scope anchors except `main_panel`
(validated in Python). Not yet exercised by an e2e multi-client test.
**Follow-up:** add a multi-client e2e asserting a per-client panel doesn't leak
to other clients (the scope is enforced by *which websocket* the message goes to,
which is existing infrastructure, so low risk — but untested for panels
specifically).

### C4. Notifications offset only tracks the control panel
The notifications layer insets to clear a docked *control* panel
(`ControlPanelDockSync` → `onDockStateChange`). A standalone panel docked on the
same edge did **not** push notifications clear of it.

**RESOLVED.** `ControlDockState` now carries `leftRegionWidthPx` — the RENDERED
width of the *entire* left-docked region (control panel + any standalone panels),
read from `metrics.reservedWidth.left`. App's notifications offset uses this
whenever it's > 0, so a left-docked standalone panel is cleared even when the
control panel is elsewhere. (Right-edge notifications were never offset; that's
unchanged — notifications live top-left.)

### C5. `configure_theme(control_width=...)` vs `main_panel.set_width()`
Both target the control panel width and coalesce into different mechanisms:
`control_width` is a theme prop applied by `ControlPanelDockSync`;
`main_panel.set_width()` writes the placement width. Last-writer-wins is *not*
guaranteed between the two because they flow through different code paths
(theme-driven width effect vs. placement effect). Their ordering on screen is
whichever effect runs last.

**RESOLVED.** The theme-width effect now applies `control_width` only when the
placement has no `width` (i.e. `set_width()` hasn't been called); when a
placement width is present, the placement effect owns the width. So `set_width()`
deterministically overrides `control_width`, and the two effects can't fight
regardless of render order. (`set_width` still applies as region width when
docked, window width when floating — unchanged.)

---

## D. Test coverage — gaps now CLOSED

All of the following are now covered (e2e in `tests/e2e/test_panels.py` unless
noted):

- **Multi-client / per-client scope** (C3) — `test_per_client_panel_is_isolated`
  asserts a `client.gui` panel shows on exactly one of two clients.
- **Notifications offset** vs a docked standalone panel (C4) — code resolved;
  driven by `leftRegionWidthPx` (the existing notification e2e still passes).
- **`reset()` + main-panel placement** (C1) — 2 unit + 1 e2e
  (`test_reset_reverts_main_panel_to_float`).
- **Split anchor that is floating** (B1 fallback) — unit (op + warning) and e2e
  (`test_dock_below_floating_anchor_falls_back`).
- **Late-joining client replay** of placement —
  `test_late_joining_client_sees_placed_panel`.
- **Bare `add_panel()` visibility** (B6b) — `test_add_panel_without_placement_is_visible`.

Final suite sizes: e2e **see full run below**; client vitest **362**; Python
panel units **17**.

---

## E. Status of follow-ups — all resolved

1. **C1** — RESOLVED (`reset()` clears + broadcasts main-panel placement).
2. **B1/B2** — RESOLVED (console warning on the fallback; race verified
   not-a-practical-bug). Deeper "snap into floating stack" deferred (low pri).
3. **C4** — RESOLVED (notifications clear the whole left-docked region).
4. **C5** — RESOLVED (theme width defers to `set_width`).
5. **D** — RESOLVED (coverage added; see above).
6. **B7** — RESOLVED (dead sidebar layout deleted).

Remaining deferred-by-design (spec §13, not bugs): layout read-back / events,
`merge_into` tab-stacking, viewport top/bottom edges, raw-layout escape hatch.

---

## F. Adversarial review pass (critic agents)

A round of independent critic agents reviewed the Python, the TS bridge, and the
tests. Their material findings and dispositions:

### Fixed (real bugs the critics caught)

- **F1 (was a real regression — MAJOR): clearing a `set_width()` override left
  the control panel stuck wide.** The C5 two-effect design had a ref-guard
  (`appliedWidth.current === widthPx`) that short-circuited the theme-width
  re-apply when the override cleared. **Fixed** by collapsing to a single
  effective-width effect: `effectiveFloatWidth = placementWidth ?? themeWidth`,
  applied whenever either changes. Regression-guarded by
  `test_clearing_set_width_reverts_to_theme_width` (e2e).
- **F2 (real bug — MAJOR): adding/removing a tab re-applied a panel's placement,
  yanking a user-moved panel back.** `StandalonePanelPlacement` had `orderKey`
  (tab list) in the placement effect's deps, so a tab change re-docked the panel
  — violating the "imperative, not continuous" contract. **Fixed** by splitting
  into two effects: placement applies only on `placementKey` change; a separate
  `reconcilePanelMembership` op updates group membership on `orderKey` change
  WITHOUT repositioning (and preserves the user's tab order). Regression-guarded
  by `test_tab_added_does_not_move_panel` (e2e).
- **F3 (real, recording-path corruption — MAJOR): the placement dict was aliased
  into the queued message and serialized later**, so a later in-place mutation
  could rewrite an already-queued/recorded message. **Fixed** by snapshotting
  (`dict(...)`) at send time in `_send_placement` (shallow is sufficient because
  `position` is always replaced wholesale).
- **F4 (spec/impl divergence — MAJOR): `set_height` was spec'd to redistribute
  stack weights for stacked panels but only ever handled floating.** Rather than
  ship half-working weight redistribution, the spec/docstring were corrected to
  "floating only" and stacked-height deferred (see A6, spec §13). Now covered by
  unit tests (floating sets height; docked is a no-op).
- **F5 (MINOR): bare `assert isinstance(anchor, PanelHandle)`** in
  `_resolve_anchor_uuid` (stripped under `-O`) → now a `ValueError` with a clear
  message.
- **F6 (test quality — the headline "split verified" tests couldn't tell success
  from the fallback):** the e2e split tests asserted only leaf COUNT, which the
  right-edge fallback also satisfies. **Fixed** by asserting vertical stacking via
  bounding boxes (real column split = panels stacked + x-overlap; fallback =
  side-by-side), and the floating-anchor test now captures the `console.warn` and
  asserts the anchor stayed floating.

### Accepted with mitigation (documented, not fixed)

- **Dangling `anchor_uuid` when an anchor panel is removed (Python 5.2).** The
  dependent panel keeps a placement referencing a dead uuid. The client handles
  this gracefully — unresolvable anchor → right-edge fallback + warning (verified
  by `test_dock_below_floating_anchor_falls_back`, same code path). Adding a
  cross-panel dependency graph to rewrite references was judged not worth the
  complexity for an edge case the client already degrades cleanly.
- **No locking on the shared placement dict (Python 1.2).** Concurrent placement
  commands from multiple threads can interleave. This matches every other viser
  prop setter (also unlocked); GUI commands are conventionally issued from one
  thread. The F3 snapshot removes the worst consequence (cross-message
  corruption). Lower likelihood for `main_panel` would need genuine multi-thread
  use.
- **`control_layout` deprecation unconditionally `dock_right()`s (Python 7.1),**
  clobbering a prior `main_panel` placement if both are used. It's a deprecated
  path; mixing it with the new API is the user's edge case. Documented.
- **`CONTROL_PANEL_ID` update carve-out drops non-`placement` keys (TS 8)** and
  **standalone discovery doesn't react to a runtime `standalone` flip (TS 4).**
  Both rest on protocol invariants that hold today (only `placement` is sent to
  the control panel; `standalone` is set at creation, never flipped). Documented
  as load-bearing assumptions.

### Confirmed correct by the critics (no action)

Default-float-when-unplaced guard (doesn't yank user-moved panels), anchor-race
fallback, C4 `reservedWidth` reactivity, the `Panel`→`Pane` rename completeness.

### Round 2 (re-review of the round-1 fixes + a /simplify pass)

The round-1 fixes changed real control flow, so a second critic + cleanup pass
ran. The React critic came back **fully clean** (all five round-1 changes —
ref-gated placement effect, width layout-effect + first-run seed, `floatTopRight`
helper, memoized discovery/keys — verified correct). One real Python bug found
and fixed:

- **F7 (real bug — MEDIUM): `reset()` rebound `_main_panel_placement`,
  orphaning held handles.** `main_panel` handles capture the placement dict by
  reference; `reset()` reassigning the field left any handle obtained *before*
  the reset pointing at a dead dict, so its later commands never reached the api
  (placement not persisted/replayed, and a later reset couldn't clear it).
  **Fixed** by clearing the dict IN PLACE (`.clear()`/`.update()`) instead of
  rebinding. Regression-guarded by
  `test_main_panel_handle_held_across_reset_stays_in_sync`.

/simplify (round 1) applied: consolidated a tripled comment block, extracted the
duplicated control-panel default-float geometry into a `floatTopRight` helper,
memoized `standaloneUuids` + the `JSON.stringify` placement keys, and collapsed
`_resolve_anchor_uuid`'s double type-dispatch into a single ladder. A
false-positive (`control_layout = "floating"` flagged as dead — it's read at the
theme-message construction) was correctly skipped.

### Round 3 (final convergence check) — both critics returned CONVERGED

The Python critic found zero bugs. The TS critic found zero *frontend* bugs but
flagged one real latent server-side fragility:

- **F8 (latent — LOW/MED, hardened): `add_panel` relied on `__init__` back-filling
  the create message's placement.** `add_panel` built the create message with no
  `placement` (defaulting to `None`), then `PanelHandle.__init__` set
  `_impl.props.placement = _empty_placement()`, relying on `message.props` and
  `_impl.props` being the same object to retroactively fix the already-queued
  message. If serialization ever raced ahead (or the aliasing broke), the client
  would receive `placement: null` and the panel would silently never render (the
  React `placement === null` early-return). **Hardened** by seeding
  `placement=_empty_placement()` directly on the create message in `add_panel`,
  so the wire always carries a non-null placement regardless of `__init__`
  timing. The React `null` guard is now genuinely defensive (never fires for
  standalone panels), not load-bearing.

After F8, a re-verification of the changed `add_panel` path confirmed the create
message always carries a non-null placement and the handle still aliases it
(commands persist). **Loop converged: critics report no remaining bugs.**

---

## G. Improvement pass (robustness / cleanliness / consistency)

A separate review pass (not bug-hunting) targeted hardening and polish. Applied:

**Robustness**
- **G1: removed-panel guard.** Placement/size/minimize commands and `add_tab`
  queue messages directly (bypassing `props_setattr`'s removed-guard). Added a
  `_check_not_removed()` choke point in `_send_placement` and a guard in
  `PanelHandle.add_tab`, so commands on a removed panel raise `RuntimeError`
  (matching `CommandHandle`/`props_setattr`) instead of queuing ghost updates.
- **G2: dimension validation.** `set_width`/`set_height`/`float` now reject
  non-positive / non-finite sizes with `ValueError` at the Python boundary
  (NaN/negative widths produced broken, sticky, replayed layouts; the client's
  floating-window resize didn't clamp them).

**Consistency**
- **G3: `add_panel(visible=...)`.** Added the `visible` kwarg for parity with
  every other `add_*` factory (the handle already had a working `.visible`
  setter, so the factory gap was a visible asymmetry).
- Kept `float`/`set_width`/`minimize` as methods (not properties): deliberate,
  because the state isn't readable — now stated explicitly in the `PanelHandle`
  docstring so the method-not-property choice reads as intentional.

**Cleanliness / convention**
- **G4: renamed `findPanelGroup` → `panelGroupOf`** (it sat one letter off
  `findPaneGroup` after the Pane rename — exactly the confusion the rename
  removed).
- **G5: killed the hand-written TS `PanelPlacement` type;** it now aliases the
  GENERATED wire type (`NonNullable<GuiTabGroupMessage["props"]["placement"]>`),
  removing a real drift risk if the Python placement shape changes.
- Trimmed the doubled aliasing comments in `reset()` / `add_panel` to single
  cross-references.

**Docs**
- Cross-linked `add_panel` ↔ `main_panel`; added an `Example::` to `add_panel`;
  panel-specific `PanelHandle.remove` docstring ("only way to close, no UI
  button"); clarified `dock_left`/`dock_right` ordering wording; surfaced the
  "imperative, not synced/readable" contract on the `PanelHandle` class docstring;
  added a `minimize`/`expand` demo to `examples/02_gui/11_panels.py`.

**Skipped (deliberate):** renaming `float` to `set_floating` (the API surface was
locked with the user); converting size methods to properties (would mix
readable/write-only properties — more confusing). A false-positive
(`control_layout = "floating"` flagged as dead — it's read at theme-message
construction) was correctly skipped.

New regression tests: `test_commands_on_removed_panel_raise`,
`test_invalid_dimensions_raise`, `test_add_panel_visible_kwarg` (Python, 22 total).

---

## H. Minimality pass (smaller, still robust)

A pass to remove incidental complexity without weakening the guards. Applied:

- **Single removed-guard.** The previous pass added a `_check_not_removed()` call
  to every command *and* `_send_placement`. Since every command routes through
  `_send_placement`, the per-command calls were pure duplication -- removed them
  (8 lines) and kept the one inline guard at the top of `_send_placement` (the
  one choke point). `add_tab` keeps its own guard (it doesn't go through
  `_send_placement`). Mutating a dead panel's (unreachable) dict before the guard
  raises is harmless; the single guard is smaller and equally robust.
- **Dropped the `_get_placement()` getter + `_placement_self_state`** indirection
  (no subclass overrode it) -- commands now read/write `self._placement`
  directly. ~one method + a layer of indirection gone.
- **Merged the width and height blocks** in `applyPanelPlacement` into a single
  `findGroupLocation` lookup (they don't relocate the group), removing a
  redundant tree walk and a block.
- **Replaced the `floatTopRight(place => ...)` higher-order helper** with a flat
  `topRightGeometry()` returning `{x, y, width}`; each call site computes the
  geometry then calls its op directly (no callback indirection). Dropped a now-
  unused `DockLayout` import.

A verification critic confirmed all four simplifications behavior-preserving
(CLEAN, no regressions); full e2e (283 passed), vitest (361), pytest (22), tsc,
ruff, eslint all green. Structures that look repetitive but are load-bearing were
deliberately kept: the two-effect split in `StandalonePanelPlacement` (different
triggers/ops -- collapsing reintroduces the yank-on-tab-change bug), the
`_set_position` helper (4 callers), and the per-verb public methods (API surface).

---

## I. Visual bug-hunt pass (running the example + screenshots)

Running `examples/02_gui/11_panels.py` surfaced visual bugs that no headless test
caught. Found via screenshots + multi-strategy code tracing; all fixed with e2e
regression guards.

- **I1 (CRITICAL): "Drop a panel here" placeholders in the control panel.**
  Standalone panels parent under `root`, and the control panel renders
  `GeneratedGuiContainer("root")` -- so each standalone panel was ALSO rendered
  inline as a nested `DockArea`, which went empty once its panes were torn out to
  the real dock group. **Fixed:** `TabGroupComponent` renders `null` for a
  standalone tab group when inside the dock surface (it's owned by
  `StandalonePanelSync`); `GuiContainer` filters standalone panels out of the
  inline list when in the dock surface.
- **I2 (CRITICAL): `float(x,y)` was dock-root-relative, so a float landed under a
  left-docked control panel.** **Fixed:** server float coords are now
  canvas-relative -- `applyPanelPlacement` adds the canvas left inset
  (`metrics.reservedWidth.left`) to a float's x via `offsetWindowX`. Verified:
  `float(x=40)` with a 300px left dock lands at x=340. Stays canvas-aligned on
  window resize (the inset is a fixed px width). A user drag still records
  absolute coords (drag/resize math is unchanged).
- **I3 (CRITICAL, found by code-trace): standalone panels were invisible on
  MOBILE.** The bottom-sheet layout has no dock surface, so `StandalonePanelSync`
  never runs there -- and the inline-skip (I1) hid the panel entirely. **Fixed:**
  the skip is gated on `inDockSurface`; outside the dock surface a standalone
  panel falls back to `PlainTabGroup`, so its content shows inline in the bottom
  sheet.
- **I4 (MAJOR): a standalone panel flipped the desktop control panel into an
  empty generated-GUI view.** `useShowGenerated` counted standalone panels as
  inline GUI, so a root containing only a standalone panel showed an empty body
  (the panel renders in its own dock group). **Fixed:** `useShowGenerated`
  ignores standalone panels when in the dock surface.
- **I5 (robustness, from the dynamics critic): one `isStandalonePanel(conf)`
  helper** now backs all three filter sites (inline render, show-generated,
  StandalonePanelSync discovery) -- they previously hand-duplicated the predicate
  (and one used `=== true` vs truthy), where any disagreement reproduces I1/I3.

A dynamics critic verified the render-path changes correct across mixed-content,
reset, remove, churn, and multi-client scenarios (no flicker, no stale dock
groups). New e2e guards: `test_no_drop_placeholders_in_control_panel`,
`test_float_is_canvas_relative`, `test_standalone_panel_visible_on_mobile`,
`test_control_panel_not_blank_with_only_standalone`.

*Lesson: these were all invisible to headless DOM tests because they manifest as
duplicate/empty/mispositioned rendering -- only running the example and looking
caught them. The root cause of I1/I3/I4 was the same as a deferred design choice
(`add_panel` parents under `root`): standalone panels share the root container
with inline GUI, so every root-rendering path must special-case them.*

- **I6 (MAJOR): a float didn't track the canvas when docked insets changed
  later.** Server float coords are canvas-relative, but the I2 fix baked the
  inset into `win.x` at *placement* time -- so docking another panel (e.g. a
  second panel to the right, growing the right region) left the float stranded
  under the now-wider docked region. **Fixed:** a `DockManager` effect clamps
  floating windows into the canvas bounds `[leftInset, containerW - rightInset -
  width]` whenever the insets change. It only pulls a float IN when it would
  intrude (never nudges one that fits, never fights a user drag). This composes
  with I2: I2 places the float correctly initially; I6 keeps it correct as docks
  change. Covered by `test_dock_playground_float_clamp.py`.

## J. Testing tiers (decoupling from the Python API)

Observation that emerged from the visual round: nearly all of these bugs live in
the **client rendering/layout layer**, which is testable WITHOUT the Python API,
the websocket, or a `ViserServer` -- yet the early repros booted a full server +
built a scene in Python just to check a `left: win.x` calculation. The right
tiers, fastest first:

1. **vitest** over the pure `layoutOps` (`panelPlacement.test.ts`) -- placement
   math, instant.
2. **dock playground** (`/dock_test.html` via Vite; `window.__dockSetLayout` /
   `window.__dockLayout`) -- rendering, insets, float-clamp, drag/drop in a real
   browser with NO Python. `test_dock_playground_*` + the new
   `test_dock_playground_float_clamp.py` (~6s, server-free).
3. **Python e2e** (`test_panels.py`) -- only the thin Python↔client integration
   (does `add_panel().float()` emit the right wire message and get applied).

The float-clamp (I6) is covered at tier 2 (playground), not tier 3 -- exactly the
layer where these visual bugs live. Future panel rendering/layout work should
start at tiers 1-2.

## K. Dedicated panel entity (architecture)

The standalone-panel filters (sections A-I) all stemmed from one design choice:
a panel was a `GuiTabGroupMessage` with `standalone=true` parented under the
`"root"` GUI container -- the same container the control panel renders. Every
inline-render path therefore had to special-case panels via `isStandalonePanel()`
(in `Generated.tsx`, `ControlPanel.tsx`, `TabGroup.tsx`) and discover them by
filtering the root set (`StandalonePanelSync`). Those filters were the direct
source of I1/I3/I4 (drop placeholders, mobile-invisible, blank control panel).

Refactored to a **dedicated top-level entity** (like a modal):
- `GuiPanelMessage` / `GuiPanelRemoveMessage` (`_messages.py`), NOT tagged
  `GuiComponentMessage`, so they never reach `addGui` -> never enter `configStore`
  or any container set. `GuiPanelProps` carries the tab triple + placement +
  expand_by_default (lifted off `GuiTabGroupProps`).
- Server: `add_panel` registers into `_panel_handle_from_uuid` (parallel to
  `_modal_handle_from_uuid`); `reset()` drains it. `PanelHandle` is built from a
  shared `_TabContainerMixin` (also used by `GuiTabGroupHandle`) so `add_tab` is
  not duplicated; it no longer subclasses `GuiTabGroupHandle`.
- Client: a dedicated `panels` store (GuiState) with `addPanel`/`updatePanel`/
  `removePanel`; `MessageHandler` routes panel create/remove/update (placement
  still rides `GuiUpdateMessage`, coalesced as before). `useGuiTabPanelRegistry`
  was generalized to a content provider so panels and inline tab groups share the
  pane-spec machinery.
- **All `isStandalonePanel()` filters were deleted** -- panels are structurally
  absent from inline rendering by construction. The one new requirement: panels
  left the root set, so the implicit mobile bottom-sheet fallback was replaced by
  an explicit `PanelsFallback` (renders panels as `PlainTabGroup` inside a
  `GuiComponentContextProvider` when there is no dock surface). Guarded by
  `test_standalone_panel_visible_on_mobile`.

## L. Multi-agent review loop (bugs found + fixed)

A multi-iteration adversarial review (Python lifecycle/concurrency, client
placement/gesture dynamics, message/sync/replay, serialization, geometry, API
ergonomics, plus a second-opinion pass on the fixes) surfaced and fixed:

- **Resize snap-back (J1):** `resizeWindow`/`resizeWindowHeight` and
  `snapToWindowStack` didn't release a server-placed window's `requestedX/Y`, so a
  user edge-resize/snap got re-anchored on the next canvas change. Fixed via
  `releaseRequestedCoords` (called from the user-gesture handlers); the ops stay
  pure. A right/bottom-anchored panel's far-edge grip now grows toward the cursor.
- **Negative-coord off-screen flash (J2):** `resolveRequestedFloatPosition` placed
  a negative coord off-screen when the canvas was unmeasured (first apply). Now
  falls back to the near edge until measured.
- **Over-clamp on resize (J3):** the resolve effect was split so dragged floats
  are pushed inward only on INSET change, not on container resize (the container
  observer owns dragged-float anchoring + overhang).
- **ResizeObserver thrash (J4):** the per-window observer keyed on `layout.floating`
  (new array each commit) re-attached every drag frame; now keyed on the window-id
  set.
- **Full tab-swap orphan (J5):** replacing ALL of a panel's tabs at once left it
  ungrouped/invisible; the membership effect now re-applies placement when the
  group can't be found.
- **`visible` was a no-op (J6):** `add_panel(visible=)` / `.visible` wrote a prop
  the client never read. Now wired: `visible=False` removes the panel's panes
  (hide-without-destroy), `True` re-places. Guarded by
  `test_panel_visible_toggle_hides_and_shows`.
- **`set_width` had no MAX cap (J7):** a server `set_width(huge)` could overflow
  the canvas. `reconcileRegionWidths` now clamps regionWidth to `[colsMin,
  colsMax]` on every commit (renamed `clampRegionWidth`).
- **`placement` desync (J8):** `PanelHandle._placement` is now a property over
  `props.placement` (single source of truth), so a direct `panel.placement = ...`
  can't diverge the command stream from the replayed state.
- **`with add_panel():` cryptic error (J9):** raised a bare
  `AttributeError('__enter__')`; now a clear `TypeError` pointing to `add_tab`.
- **`add_tab` removed-guard symmetry (J10):** moved into `_TabContainerMixin` so
  tab groups and panels both guard before mutating; NaN/inf float coords rejected
  via `_check_coordinate`.
- **Borrowed-tab teardown (verified, not a bug):** removing a panel removes its
  tabs even after they were dragged into other groups/windows (the registry
  reconciliation + `removePane` are location-agnostic). Locked in with op tests.

Confirmed clean by the review: serialization/static-export (all GUI is
`include_in_scene_serialization=False` — no orphan tab content), late-join replay,
multi-client isolation, disconnect/reconnect freeze, the panel→pane rename, and
the dock width/split geometry. The 3 failing `test_dock_playground_*` drag tests
are pre-existing software-WebGL environment flakes (the PR touches none of the
code they exercise; confirmed via a stash A/B).
