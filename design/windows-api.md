# Spec: Standalone Panels API

Status: **Superseded — historical design doc.** This was the original spec; the
shipped implementation diverged. For accurate current behavior see
`design/windows-api-concerns.md` (esp. §K "Dedicated panel entity") and the
docstrings on `GuiApi.add_panel` / `PanelHandle`. Key differences from this doc:

- Panels are a **dedicated `GuiPanelMessage` entity**, not a `GuiTabGroupMessage`
  with a `standalone` flag; there is no `collapsed` field on the placement dict.
- **No `minimize()` / `expand()` methods.** Initial collapsed state is the
  one-shot `add_panel(expand_by_default=...)` hint; the user controls collapse
  thereafter.
- `float()` coordinates are **viewport/canvas-relative** (not dock-root), the
  default float position is **top-left**, and **negative coords are gaps from the
  far edge** (`x=-15` = 15px from the right, etc.).
- `add_panel(*, visible=True, expand_by_default=True)` takes kwargs.

Owner: brentyi · Branch: `brent/windows_api`

## 1. Summary

Add a Python API for creating **standalone panels** — dockable / floating GUI
containers that live outside the main control panel — and for placing them
programmatically (dock to a viewport edge, split above/below another panel, or
float at explicit coordinates).

```python
panel = server.gui.add_panel()
with panel.add_tab("Statistics"):
    server.gui.add_plotly(fig)
panel.dock_right()
```

A panel is a dockable container; tabs are the content. Placement (the container)
and content (a tab) live on separate handles, so neither is overloaded in the
single-tab or multi-tab case.

## 2. Terminology

We use **panel** for the dockable container and **tab** for its content. This
matches viser's existing "control panel" language and avoids colliding with the
browser *viewport* (the dock-edge sentinel). Note this inverts the dock
library's internal naming, where today "panel" (`PanelSpec`) means tab *content*
and `TabGroup` / `FloatingWindow` mean the container. The client identifiers are
being renamed to match (container = panel, content = tab); the Python surface and
wire protocol below do not depend on the old client names.

## 3. Goals / non-goals

**Goals**

- Create standalone panels from `server.gui` (broadcast) and `client.gui`
  (per-client).
- Place panels: dock to a viewport left/right edge, split above/below another
  panel, or float.
- Reposition imperatively — calling a placement verb again moves the panel.
- Reuse the existing client-side dock system rather than building new layout UI.

**Non-goals (v1)** — these are deliberate scope cuts, each with an escape hatch
(user-drag in the browser, or a future raw-layout API):

- Server-authoritative layout sync. The client owns layout after initial
  placement; user drags are **not** reported back to the server (§6).
- Reading current layout / sizes / positions / minimized state from the server.
- Docking to the viewport **top/bottom** (the dock model only has left/right
  viewport edges; vertical relationships are expressed as `dock_above`/
  `dock_below` splits against another panel — §7).
- Left/right splits against a **specific panel's cell** (left/right always target
  the viewport edge; horizontal order within an edge is controlled by call
  order).
- Tab-stacking / merging two independently-created panels (no `merge_into`).
  Build multi-tab panels up front via repeated `add_tab`.
- A panel-level title independent of its tabs (only tabs carry labels).
- User-initiated close. **The server owns panel existence** (§5); users can
  rearrange, drag, and minimize, but cannot close a panel or its tabs from the
  UI. Panels disappear only via `remove()`.
- Lifecycle callbacks (`on_close` / `on_move` / `on_minimize`). Since the user
  can't close panels and layout isn't synced back, there is nothing to call back
  about in v1.

## 4. Public API surface

All methods exist on both `server.gui` and `client.gui`.

```python
class GuiApi:
    def add_panel(self) -> PanelHandle: ...

    @property
    def main_panel(self) -> MainPanelHandle: ...

    # Unchanged — inline only:
    def add_tab_group(self, *, order: float | None = None,
                      visible: bool = True) -> GuiTabGroupHandle: ...
```

- `add_panel()` is analogous to `add_modal()`: a top-level, non-inline,
  context-driven container created with the universal `add_*` verb. It takes no
  arguments — placement comes from the verbs, content from `add_tab`.
- There is no `standalone` kwarg and no overloaded return type. Standalone vs
  inline is a difference of *which factory* you call (`add_panel` vs
  `add_tab_group`).

## 5. Semantics: imperative commands

Placement, sizing, and minimize are **imperative commands**, not a synced layout:

1. A command updates a single coalesced `placement` prop on the panel (via the
   existing `GuiUpdateMessage` path).
2. The latest value is stored server-side and **replayed to clients that connect
   later**, so a panel created docked-right appears docked-right for everyone.
3. Issuing a command applies it to all currently-connected clients of the owning
   scope. It does **not** continuously re-assert: a user dragging the panel
   afterward changes only client-local layout and is not echoed to the server.
   The server never fights the user until the next explicit command.
4. Calling a command again issues a new command and repositions/resizes the
   panel.

**The server owns existence; the user owns arrangement.** A standalone panel has
no close button — neither the panel nor its individual tabs can be closed from
the UI. It exists until the server calls `remove()`. Users may freely rearrange
(drag, dock, float), minimize, and resize. Because closing is the only
*destructive* user action and it is disallowed, the server never desyncs from a
"the user deleted my panel" event.

This keeps us fully compatible with the existing ephemeral / localStorage layout
model and requires no new layout-sync protocol.

## 6. Handle types

```python
PlaceableHandle = PanelHandle | MainPanelHandle
```

### 6.1 `PanelHandle`

A dockable / floating container.

```python
class PanelHandle:
    # --- content ---
    def add_tab(self, label: str, icon: IconName | None = None) -> GuiTabHandle: ...

    # --- placement (imperative; each call (re)positions; returns None) ---
    def dock_left (self) -> None: ...                          # viewport left edge
    def dock_right(self) -> None: ...                          # viewport right edge
    def dock_above(self, anchor: PlaceableHandle) -> None: ... # column split, above anchor
    def dock_below(self, anchor: PlaceableHandle) -> None: ... # column split, below anchor
    def float(self, *, x: float | None = None, y: float | None = None,
              width: float | None = None, height: float | None = None) -> None: ...

    # --- sizing (imperative) ---
    def set_width (self, width: float)  -> None: ...           # px
    def set_height(self, height: float) -> None: ...           # px

    # --- minimize (imperative commands; NOT synced back) ---
    def minimize(self) -> None: ...
    def expand  (self) -> None: ...

    # --- lifecycle ---
    def remove(self) -> None: ...
```

- `add_tab` reuses the existing `GuiTabGroupHandle.add_tab` machinery; a panel is
  implemented as a standalone tab group (a single tab is the degenerate case,
  rendered as a plain header).
- `dock_left` / `dock_right` take **no anchor** — they always dock to the
  viewport edge. To order several panels along an edge, dock them in the desired
  order (left docks insert before existing; right docks insert after).
- `dock_above` / `dock_below` take a **panel anchor** and create a vertical
  (column) split relative to it. There is no viewport top/bottom edge.
- `float()` with all-`None` args floats at a client-chosen default position and
  size. Coordinates are CSS pixels, relative to the dock-root container.
- `set_width` applies as the region width when docked and the window width when
  floating. `set_height` applies only to **floating** panels (it sets the window
  height); on a docked panel — whether solo or stacked via `dock_above`/
  `dock_below` — it has no effect, because docked cells size to their split
  weights, not an explicit px height. (Stacked-height control is deferred; see
  §13.)
- `minimize` / `expand` are **commands, not synced state**: there is no way to
  read the current minimized state from Python, and a user expanding the panel by
  hand is not reported back. They are replayed to late-joining clients like other
  placement commands.

### 6.2 `MainPanelHandle`

Wraps the control panel (`CONTROL_PANEL_ID`). Placement / sizing / minimize only:

```python
class MainPanelHandle:
    def dock_left (self) -> None: ...
    def dock_right(self) -> None: ...
    def dock_above(self, anchor: PlaceableHandle) -> None: ...
    def dock_below(self, anchor: PlaceableHandle) -> None: ...
    def float(self, *, x=None, y=None, width=None, height=None) -> None: ...
    def set_width (self, width: float)  -> None: ...
    def set_height(self, height: float) -> None: ...
    def minimize(self) -> None: ...
    def expand  (self) -> None: ...
    # no add_tab(), no remove()
```

- `main_panel` renders on every client, so it is a legal `dock_*` anchor from any
  scope (the §9 cross-scope exception).
- `set_width` overrides `configure_theme(control_width=...)` for the control
  panel (last-writer-wins; both coalesce into the same prop). `control_width`
  remains the theme default; `set_width` is the explicit override.

### 6.3 `GuiTabHandle` (existing, reused)

Returned by `panel.add_tab`. Unchanged: context manager that fills the tab;
`title` / `icon` mutable; `remove()` removes the tab from the server side.

## 7. Message layer

Standalone panels are tab-group create messages with two additions to the props:

```python
class GuiTabGroupProps:  # additions
    standalone: bool = False              # register as own dock group, not in control panel
    placement: GuiDockPlacement | None = None
```

`GuiDockPlacement` carries four orthogonal fields so independent commands
(`dock_*`/`float`, `minimize`/`expand`, `set_width`, `set_height`) never clobber
each other when coalesced:

```python
GuiDockPlacement = {
    "position": EdgePlacement | SplitPlacement | FloatPlacement | None,
    "collapsed": bool,          # set by minimize() / expand()
    "width":  float | None,     # set by set_width() and float(width=)
    "height": float | None,     # set by set_height() and float(height=)
}

EdgePlacement  = {"kind": "edge",  "edge": "left" | "right"}
SplitPlacement = {"kind": "split", "anchor_uuid": str, "side": "above" | "below"}
FloatPlacement = {"kind": "float", "x": float | None, "y": float | None}
```

- Verb → `position` mapping:
  - `dock_left/right()` → `EdgePlacement`.
  - `dock_above(anchor)` → `SplitPlacement(side="above")`.
  - `dock_below(anchor)` → `SplitPlacement(side="below")`.
  - `float(x, y)` → `FloatPlacement`; `float(width, height)` additionally write
    the top-level `width` / `height` fields.
- `anchor_uuid` is the anchor panel's tab-group uuid; `main_panel` uses
  `CONTROL_PANEL_ID`.
- `placement` is delivered through `GuiUpdateMessage` so it coalesces and replays
  (§5).
- No new top-level message types are required; reuse create + update + remove.

## 8. Frontend bridge

In `src/viser/client/src/dock/` + `ControlPanel/`:

1. When a tab-group message has `standalone=True`, register it as its own dock
   group via the existing `registerTabGroup` / panel-spec path instead of
   rendering it inside the control panel container.
2. Apply `placement` into the `DockLayout` through `dock/layoutOps.ts`:
   - `position` → `dockToEdge` (edge), `dropOnDockedLeaf(region="top"/"bottom")`
     against the anchor's leaf (split), or `addFloatingPanel` / `floatGroup`
     (float);
   - `width` → `setRegionWidth` (docked) or `resizeWindow` (floating);
   - `height` → `resizeWindow` height (floating only; ignored when docked);
   - `collapsed` → `toggleCollapsed` / `expandGroup`.
   Apply on create and re-apply on each `placement` prop update (the imperative
   reposition).
3. `anchor_uuid` resolves to the target group's id.
4. `main_panel` placement overrides `ControlPanelDockSync`'s default top-right
   placement.
5. Server-created panels and their tabs render with **no close affordance**.
6. User drags continue mutating the client-local layout; nothing is sent back to
   the server.

## 9. Scope rules (server vs client)

- `add_panel` / `main_panel` exist on both `server.gui` and `client.gui`.
- A panel's scope follows the `GuiApi` that created it (broadcast vs single
  client).
- **Anchor rule:** the anchor and the panel being placed must share a scope.
  Enforced in Python (`anchor._impl.gui_api is self._impl.gui_api`), raising
  `ValueError` otherwise.
- **Exception:** `main_panel` renders on every client, so it is a legal anchor
  from any scope.

## 10. Errors & edge cases

- `dock_above` / `dock_below` against a removed anchor → `ValueError`.
- Placement against `self` (`dock_above(self)`) → `ValueError`.
- Cross-scope anchor (non-`main_panel`) → `ValueError` (§9).
- `float()` with all-`None` args → client-chosen default position/size.
- `remove()` on a panel removes the dock group and all its tabs/children.
- `set_height` on any docked panel (solo or stacked) → no-op (documented).

## 11. `configure_theme` deprecation

`configure_theme(control_layout=...)` is **soft-deprecated**:

- `"floating"` (default) → unchanged: the control panel on the dock surface.
- `"collapsible"` and `"fixed"` → translated to `main_panel.dock_right()`. Both
  become "docked right, user-collapsible"; the new dock system makes every docked
  panel collapsible, so the old `fixed` (non-collapsible) distinction does not
  survive — this is the one behavior we drop.
- Passing any non-default `control_layout` emits a `DeprecationWarning` pointing
  to `main_panel`.
- `control_width` is **not** deprecated; it remains the theme default width
  (`set_width` overrides per-panel).

## 12. Build phases

1. **Core.** `PanelHandle` + `MainPanelHandle`; `add_panel` / `main_panel`;
   `standalone` + `placement` props and `GuiDockPlacement`; frontend bridge for
   create + reposition covering `edge`, `float`, `split`, `width`, `height`,
   `collapsed`; no-close affordance.
2. **Theme.** `control_layout` soft-deprecation → `main_panel.dock_right()`.
3. **Polish.** Cross-scope error paths, docs + example, client identifier rename.

## 13. Deferred to future versions

- Reading layout / size / minimized state back from the server (would need a
  sync protocol).
- Lifecycle callbacks (`on_close`, `on_move`, `on_minimize`).
- `merge_into` / tab-stacking of independently-created panels (`TabPlacement`).
- Left/right splits against a specific panel's cell; viewport top/bottom edges.
- Explicit height for docked/stacked panels (`set_height` is floating-only;
  docked cells size to split weights, and weight redistribution from Python is
  deferred).
- A raw-layout escape hatch for fully-custom arrangements (the intended answer
  to long-tail "I want a slightly different layout" requests).
