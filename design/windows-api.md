# Spec: Standalone Windows API

Status: **Draft** · Owner: brentyi · Target branch: `claude/amazing-tesla-ciurta`

## 1. Summary

Add a Python API for creating **standalone windows** — dockable / floating GUI
containers that live outside the main control panel — and for placing them
programmatically (dock to a viewport edge, split against another window, stack
as tabs, or float at explicit coordinates).

The public surface is intentionally small:

```python
win = server.gui.add_window()
with win.add_tab("Statistics"):
    server.gui.add_plotly(fig)
win.dock_right("viewport")
```

A window is a dockable container; tabs are the content. The two responsibilities
— **placement** (the container) and **content** (a tab) — live on separate
handles, so neither handle is ever overloaded, in the single-tab or multi-tab
case.

## 2. Motivation

Today every GUI element is rendered inside the control panel (or a per-client
tree). The frontend already supports tearing tab groups out into floating /
docked windows by hand (see §4), but the **server has no way to author that
layout**. Users who want a plot or a log in its own floating panel cannot
express it from Python.

This spec adds that authoring layer while staying consistent with viser's
existing conventions (`add_*` factories, context-manager containers, coalesced
prop updates).

## 3. Goals / non-goals

**Goals**

- Create standalone windows from `server.gui` (broadcast) and `client.gui`
  (per-client).
- Place windows: dock to viewport left/right, split above/below/left/right of
  another window, stack as tabs, or float.
- Reposition imperatively — calling a placement verb again moves the window.
- Reuse the existing client-side dock system rather than building new layout UI.

**Non-goals (v1)**

- Server-authoritative layout sync. The client still owns layout after initial
  placement; user drags are **not** reported back to the server (see §6).
- Reading current layout / sizes / positions from the server.
- Docking to the viewport **top/bottom** (the dock model only supports left/right
  viewport edges; top/bottom relationships are expressed as splits between
  windows — see §7).
- Merging two independently-created windows after the fact (deferred; build
  multi-tab windows up front via repeated `add_tab`).

## 4. Background: what already exists

Findings from a codebase investigation. File references are anchors for
implementation, not exact line guarantees.

### 4.1 GUI API scoping (server vs client)

- `GuiApi` (`src/viser/_gui_api.py`) is instantiated twice: once owned by
  `ViserServer` (broadcasts to all clients) and once per `ClientHandle`
  (single client). The owner determines whether messages go through
  `_websock_server` (broadcast) or `_websock_connection` (single client).
- Handles do **not** track a target client; scope is implied by which `GuiApi`
  owns the handle.
- There is one shared control panel per server. On the client it is an
  unmergeable floating window with a fixed id (`CONTROL_PANEL_ID`,
  `ControlPanel/ControlPanel.tsx`).

### 4.2 Handle hierarchy

- `_GuiHandleState` (`src/viser/_gui_handles.py`) carries `uuid`, `gui_api`,
  `props`, and `parent_container_id`.
- Containers implement `GuiContainerProtocol` (a `_children` dict) and register
  in `gui_api._container_handle_from_uuid`.
- `GuiFolderHandle` and `GuiTabHandle` are context managers: `__enter__` sets the
  active container uuid so subsequent `add_*` calls nest inside; `__exit__`
  restores it.
- `GuiTabHandle` is already a content container (`_children`, enter/exit) but is
  **not** a `_GuiHandle` subclass — confirming handles need not subclass it.

### 4.3 Tab groups

- `GuiTabGroupHandle.add_tab(label, icon)` appends a `GuiTabHandle` and updates
  the props tuples `_tab_labels`, `_tab_icons_html`, `_tab_container_ids`.
- Each tab's `_id` is the container uuid for its children.
- Active tab is tracked client-side; `GuiTabGroupHandle.value` is `None`.

### 4.4 Client-side dock system (the key reuse)

`src/viser/client/src/dock/` is a production dock system. Its data model
(`dock/types.ts`) maps almost 1:1 onto this spec:

| Spec concept            | Client model                                            |
| ----------------------- | ------------------------------------------------------- |
| window (placeable)      | `TabGroup` / `FloatingWindow`                            |
| tab (content)           | `PanelSpec` (`id`, `title`, `icon`, `render`, …)         |
| `float()`               | `FloatingWindow` (`x`, `y`, `width`, `height`, `stack`)  |
| `dock_left/right`       | `DockEdge` (`"left" | "right"` only)                     |
| `dock_above/below/…`    | `DockSplit` (`row` / `column`)                           |
| tab-merge               | `DropRegion` `"center"`                                  |

- The control panel itself is one unmergeable floating window.
- A rendered `GuiTabGroupHandle` registers with the dock surface via
  `GuiDockContext.registerTabGroup(uuid)` (`ControlPanel/ControlPanelDock.tsx`);
  each tab becomes a `PanelSpec` rendering `MemoizedGeneratedGuiContainer`.
- Layout state is **client-side and ephemeral** (localStorage). The server sends
  no layout today.

### 4.5 Message layer

- `_CreateGuiComponentMessage` base; container messages carry `container_uuid`
  + a `props` object. `GuiTabGroupProps` holds the tab tuples + `order` +
  `visible`.
- `GuiUpdateMessage(uuid, updates: dict)` coalesces arbitrary prop changes and is
  replayed to newly-connected clients. **This is the mechanism we reuse for
  placement.**
- `GuiModalMessage` has no `container_uuid` (renders in a portal) — precedent
  that `add_*` is used for non-inline, top-level entities.

## 5. Public API surface

All methods exist on both `server.gui` and `client.gui`.

```python
class GuiApi:
    def add_window(
        self,
        *,
        visible: bool = True,
    ) -> WindowHandle: ...

    @property
    def main_window(self) -> MainWindowHandle: ...

    # Unchanged — inline only, no `standalone` kwarg, no overloads:
    def add_tab_group(self, *, order: float | None = None,
                      visible: bool = True) -> GuiTabGroupHandle: ...
```

Notes:

- `add_window()` is analogous to `add_modal()`: a top-level, non-inline,
  context-driven container created with the universal `add_*` verb.
- There is **no** `standalone` kwarg anywhere and **no** overloaded return type.
  Standalone vs inline is a difference of *which factory* you call
  (`add_window` vs `add_tab_group`), not a flag.

## 6. Semantics: imperative placement

Placement is **imperative**, not an authoritative synced layout:

1. A placement verb sets a single coalesced `placement` prop on the window
   (via the existing `GuiUpdateMessage` path).
2. The latest value is stored server-side and **replayed to clients that connect
   later**, so a window created docked-left appears docked-left for everyone.
3. Setting the prop applies the command to all currently-connected clients of
   the owning scope. It does **not** continuously re-assert: a user dragging the
   window afterward changes only client-local layout and is not echoed to the
   server, so the server never fights the user until the next explicit verb call.
4. Calling a verb again issues a new command and repositions the window.

This keeps us fully compatible with the existing ephemeral/localStorage model and
requires no new layout-sync protocol.

## 7. Handle types

No shared base class (the placement methods are thin wrappers delegating to a
module-level helper). Anchors use a type alias:

```python
PlaceableHandle = WindowHandle | MainWindowHandle
```

### 7.1 `WindowHandle`

A dockable / floating container.

```python
class WindowHandle:
    # --- content ---
    def add_tab(self, label: str, icon: IconName | None = None) -> GuiTabHandle: ...

    # --- placement (imperative; each call (re)positions) ---
    def dock_left (self, anchor: PlaceableHandle | Literal["viewport"], *,
                   new_column: bool = False) -> Self: ...
    def dock_right(self, anchor: PlaceableHandle | Literal["viewport"], *,
                   new_column: bool = False) -> Self: ...
    def dock_above(self, anchor: PlaceableHandle) -> Self: ...   # column split; no "viewport"
    def dock_below(self, anchor: PlaceableHandle) -> Self: ...
    def float(self, *, x: float | None = None, y: float | None = None,
              width: float | None = None, height: float | None = None) -> Self: ...

    # --- lifecycle / state ---
    visible: bool                 # mutable
    def remove(self) -> None: ...
```

- `add_tab` reuses the existing `GuiTabGroupHandle.add_tab` machinery; a window is
  implemented as a standalone tab group (a single tab is the degenerate case).
- Placement verbs return `Self` to allow chaining, e.g.
  `with win.add_tab("Log"): ...` after `win.dock_left(...)`.
- `"viewport"` is the sentinel for the browser viewport edge (renamed from
  `"window"` to avoid colliding with the window noun). Only `dock_left` /
  `dock_right` accept it — the dock model has no top/bottom viewport edge.

### 7.2 `MainWindowHandle`

Wraps the control panel (`CONTROL_PANEL_ID`). Placement verbs only:

```python
class MainWindowHandle:
    def dock_left (self, anchor: PlaceableHandle | Literal["viewport"], *,
                   new_column: bool = False) -> Self: ...
    def dock_right(self, anchor: PlaceableHandle | Literal["viewport"], *,
                   new_column: bool = False) -> Self: ...
    def dock_above(self, anchor: PlaceableHandle) -> Self: ...
    def dock_below(self, anchor: PlaceableHandle) -> Self: ...
    def float(self, *, x=None, y=None, width=None, height=None) -> Self: ...
    visible: bool
    # no add_tab(), no remove()
```

### 7.3 `GuiTabHandle` (existing, reused)

Returned by `window.add_tab`. Unchanged: context manager that fills the tab;
`title` / `icon` mutable; `remove()` removes the tab.

## 8. Message layer changes

Standalone windows are tab-group create messages with two additions to the
props:

```python
class GuiTabGroupProps:  # additions
    standalone: bool = False             # register as own dock group, not in control panel
    placement: GuiDockPlacement | None = None
```

`GuiDockPlacement` is a JSON-serializable tagged union:

```python
GuiDockPlacement = (
    EdgePlacement      # {"kind": "edge",  "edge": "left"|"right", "new_column": bool}
    | SplitPlacement   # {"kind": "split", "direction": "row"|"column",
                       #  "anchor_uuid": str, "side": "before"|"after"}
    | TabPlacement     # {"kind": "tab",   "anchor_uuid": str}
    | FloatPlacement   # {"kind": "float", "x": float|None, "y": float|None,
                       #  "width": float|None, "height": float|None}
)
```

- Verb → placement mapping:
  - `dock_left/right("viewport", new_column=…)` → `EdgePlacement`.
  - `dock_left/right(window)` → `SplitPlacement` (`direction="row"`).
  - `dock_above/below(window)` → `SplitPlacement` (`direction="column"`).
  - `tab_*` semantics (stack into anchor's group) → `TabPlacement`.
  - `float(...)` → `FloatPlacement`.
- `placement` is delivered through `GuiUpdateMessage` so it coalesces and replays
  (§6). `anchor_uuid` is the anchor window's tab-group uuid; `main_window` uses
  `CONTROL_PANEL_ID`.
- No new top-level message types are required for v1; reuse create + update +
  remove.

## 9. Frontend bridge

In `src/viser/client/src/dock/` + `ControlPanel/`:

1. When a tab-group message has `standalone=True`, register it as its own dock
   group via the existing `registerTabGroup` / `PanelSpec` path instead of
   rendering it inside the control panel container.
2. Apply `placement` into the `DockLayout` through `dock/layoutOps.ts`:
   - on create — seed the group's position (`docked` edge, `floating`, or split);
   - on `placement` prop update — re-apply the corresponding layout op (the
     imperative reposition).
3. `anchor_uuid` resolves to the target group's id; tab-merge uses the
   `DropRegion "center"` op.
4. User drags continue mutating the client-local layout; nothing is sent back to
   the server.

## 10. Scope rules (server vs client)

- `add_window` / `main_window` exist on both `server.gui` and `client.gui`.
- A window's scope follows the `GuiApi` that created it (broadcast vs single
  client).
- **Anchor rule:** the anchor and the window being placed must share a scope.
  Enforced in Python (`anchor._impl.gui_api is self._impl.gui_api`), raising
  `ValueError` otherwise.
- **Exception:** `main_window` renders on every client, so it is a legal anchor
  from any scope.

## 11. Errors & edge cases

- `dock_above` / `dock_below` with `"viewport"` is a static type error (the
  literal isn't in the parameter type) and a runtime `ValueError` as a backstop.
- Placement against a removed window → `ValueError` ("anchor has been removed").
- Placement against `self` → `ValueError`.
- Cross-scope anchor (non-`main_window`) → `ValueError` (§10).
- `float()` with all-`None` args → window floats at a default position/size
  chosen by the client.
- `remove()` on a window removes the dock group and all its tabs/children.

## 12. Build phases

1. **Core.** `WindowHandle` + `MainWindowHandle`; `add_window` / `main_window`;
   `standalone` + `placement` props and the `GuiDockPlacement` union; frontend
   bridge for create + reposition covering `edge`, `float`, and `tab`.
2. **Splits.** `dock_above/below` and window-anchored `dock_left/right`
   (`SplitPlacement` row/column) + `new_column`, validated against
   `layoutOps.ts`.
3. **Polish.** `remove`, `visible` toggling for standalone windows, title/icon
   updates, cross-scope error paths, docs + examples.

## 13. Open questions

- Naming: keep `add_tab` as the content factory on `WindowHandle`, or a
  window-specific name? (Current decision: reuse `add_tab` for consistency with
  inline tab groups.)
- Should `main_window.remove()` / re-parenting ever be allowed? (Current: no.)
- Do we want a future `window.tab_with(other)` / merge op for composing two
  independently-created windows? (Deferred from v1.)
- Default float geometry: client-chosen vs a documented constant.
