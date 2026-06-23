"""Unit tests for the standalone panel API (add_panel / main_panel).

These cover the Python handle layer: that placement commands produce the right
coalesced `placement` prop, that the placement state persists on the message
buffer for replay to late-joining clients, and that scope / anchor validation
raises as specified.
"""

from __future__ import annotations

import warnings
from typing import Any
from unittest.mock import patch

import viser
import viser._client_autobuild
from viser import _messages as m
from viser._gui_handles import CONTROL_PANEL_ID


def _make_server() -> viser.ViserServer:
    return viser.ViserServer(port=0, verbose=False)


def _props(panel: viser.PanelHandle) -> m.GuiPanelProps:
    """Typed access to a panel's props (values live in _impl.props)."""
    props = panel._impl.props
    assert isinstance(props, m.GuiPanelProps)
    return props


def _placement(panel: viser.PanelHandle) -> m.GuiDockPlacement:
    """The panel's current placement dict (always present on a panel)."""
    return _props(panel).placement


def _position(panel: viser.PanelHandle) -> dict[str, Any]:
    """The panel's current (non-None) position, as a plain dict for assertions."""
    position = _placement(panel)["position"]
    assert position is not None
    return dict(position)


def _latest_placement_update(server: viser.ViserServer, uuid: str) -> dict[str, Any]:
    """The coalesced `placement` value currently sitting in the broadcast buffer
    for `uuid` (i.e. what a newly-connected client would replay)."""
    buffer = server._websock_server._broadcast_buffer.message_from_id
    found: dict[str, Any] | None = None
    for msg in buffer.values():
        if (
            isinstance(msg, m.GuiUpdateMessage)
            and msg.uuid == uuid
            and "placement" in msg.updates
        ):
            found = msg.updates["placement"]
    assert found is not None, f"No placement update buffered for {uuid}."
    return found


def test_add_panel_is_dedicated_entity() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        assert isinstance(panel, viser.PanelHandle)
        # A panel is a dedicated top-level entity tracked in its own registry --
        # NOT under the root GUI container (so it never renders inline).
        assert panel._impl.uuid in server.gui._panel_handle_from_uuid
        root = server.gui._container_handle_from_uuid["root"]
        assert panel._impl.uuid not in root._children
        # Empty placement until a command is issued.
        assert _placement(panel) == {
            "position": None,
            "width": None,
            "height": None,
        }
    finally:
        server.stop()


def test_add_panel_add_tab_appends_tabs() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        with panel.add_tab("Stats"):
            server.gui.add_markdown("hello")
        with panel.add_tab("Logs"):
            server.gui.add_markdown("world")
        assert panel._tab_labels == ("Stats", "Logs")
        assert len(panel._tab_container_ids) == 2
    finally:
        server.stop()


def test_reset_clears_panels() -> None:
    """gui.reset() must drain panels (they live in their own registry, not under
    the root container, so they won't be removed by the root-children loop)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        with panel.add_tab("A"):
            server.gui.add_markdown("a")
        panel.dock_right()
        assert len(server.gui._panel_handle_from_uuid) == 1
        server.gui.reset()
        assert len(server.gui._panel_handle_from_uuid) == 0
        # A GuiPanelRemoveMessage was queued for the dropped panel.
        buffer = server._websock_server._broadcast_buffer.message_from_id
        # After remove supersedes create, no create message for the panel remains.
        assert not any(
            isinstance(msg, m.GuiPanelMessage) and msg.uuid == panel._impl.uuid
            for msg in buffer.values()
        )
    finally:
        server.stop()


def test_dock_edges_set_position_and_buffer() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.dock_right()
        assert _position(panel) == {
            "kind": "edge",
            "edge": "right",
        }
        # Buffered for replay.
        assert _latest_placement_update(server, panel._impl.uuid)["position"] == {
            "kind": "edge",
            "edge": "right",
        }
        # Repositioning overwrites.
        panel.dock_left()
        assert _position(panel) == {
            "kind": "edge",
            "edge": "left",
        }
    finally:
        server.stop()


def test_dock_above_below_split_against_panel() -> None:
    server = _make_server()
    try:
        anchor = server.gui.add_panel()
        panel = server.gui.add_panel()
        panel.dock_above(anchor)
        assert _position(panel) == {
            "kind": "split",
            "anchor_uuid": anchor._impl.uuid,
            "side": "above",
        }
        panel.dock_below(anchor)
        assert _position(panel)["side"] == "below"
    finally:
        server.stop()


def test_float_and_size_commands_coalesce_orthogonally() -> None:
    """dock/float (position) and width/height are orthogonal fields: setting one
    must not clear the others."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.set_width(400)
        panel.float(x=10, y=20)
        placement = _placement(panel)
        assert placement["position"] == {"kind": "float", "x": 10, "y": 20}
        assert placement["width"] == 400  # not clobbered by float
        # float(width=, height=) also writes the size fields.
        panel.float(width=300, height=200)
        assert _placement(panel)["width"] == 300
        assert _placement(panel)["height"] == 200
    finally:
        server.stop()


def test_set_width_and_set_height_write_placement() -> None:
    """set_width / set_height are standalone commands that write the coalesced
    placement size fields (orthogonal to position)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.set_width(512)
        panel.set_height(384)
        placement = _placement(panel)
        assert placement["width"] == 512
        assert placement["height"] == 384
        # Position untouched (size is orthogonal).
        assert placement["position"] is None
        # The latest coalesced placement is buffered for replay.
        buffered = _latest_placement_update(server, panel._impl.uuid)
        assert buffered["width"] == 512 and buffered["height"] == 384
    finally:
        server.stop()


def test_expand_by_default_rides_create_message() -> None:
    """add_panel(expand_by_default=False) sets the one-shot initial collapsed hint
    on the create message props (not the coalesced placement)."""
    server = _make_server()
    try:
        collapsed = server.gui.add_panel(expand_by_default=False)
        assert _props(collapsed).expand_by_default is False
        expanded = server.gui.add_panel()
        assert _props(expanded).expand_by_default is True
    finally:
        server.stop()


def test_main_panel_placement_persists_across_handles() -> None:
    """main_panel returns throwaway handles; placement is owned by the api."""
    server = _make_server()
    try:
        server.gui.main_panel.dock_right()
        # A fresh handle still sees the placement.
        assert server.gui.main_panel._placement["position"] == {
            "kind": "edge",
            "edge": "right",
        }
        # Targeted at the fixed control-panel uuid.
        assert _latest_placement_update(server, CONTROL_PANEL_ID)["position"] == {
            "kind": "edge",
            "edge": "right",
        }
    finally:
        server.stop()


def test_reset_clears_main_panel_placement() -> None:
    """gui.reset() must clear a prior main-panel placement and broadcast the
    cleared value, so it doesn't replay to clients that connect after the
    reset (regression: placement persisted across reset)."""
    server = _make_server()
    try:
        server.gui.main_panel.dock_left()
        assert server.gui._main_panel_placement["position"] is not None
        server.gui.reset()
        # Server state cleared.
        assert server.gui._main_panel_placement == {
            "position": None,
            "width": None,
            "height": None,
        }
        # The cleared placement is buffered for replay (overrides the old dock).
        assert _latest_placement_update(server, CONTROL_PANEL_ID)["position"] is None
    finally:
        server.stop()


def test_main_panel_handle_held_across_reset_stays_in_sync() -> None:
    """A MainPanelHandle obtained BEFORE reset() must keep working after it.
    reset() clears the placement dict in place (not a rebind), so the held
    handle still aliases the api's live dict; a later command on it persists to
    the api (regression: rebinding orphaned held handles)."""
    server = _make_server()
    try:
        mp = server.gui.main_panel  # captures the live placement dict
        mp.dock_left()
        server.gui.reset()
        assert server.gui._main_panel_placement["position"] is None
        # The held handle still drives the api's state.
        mp.dock_right()
        assert server.gui._main_panel_placement["position"] == {
            "kind": "edge",
            "edge": "right",
        }
    finally:
        server.stop()


def test_reset_without_main_panel_placement_sends_nothing() -> None:
    """reset() with no prior main-panel placement must not emit a spurious
    placement update."""
    server = _make_server()
    try:
        server.gui.add_panel()  # a panel, but no main-panel placement
        server.gui.reset()
        buffer = server._websock_server._broadcast_buffer.message_from_id
        main_updates = [
            msg
            for msg in buffer.values()
            if isinstance(msg, m.GuiUpdateMessage)
            and msg.uuid == CONTROL_PANEL_ID
            and "placement" in msg.updates
        ]
        assert main_updates == []
    finally:
        server.stop()


def test_main_panel_is_legal_anchor() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.dock_above(server.gui.main_panel)
        assert (
            _position(panel)["anchor_uuid"] == CONTROL_PANEL_ID
        )
    finally:
        server.stop()


def test_dock_against_self_raises() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        try:
            panel.dock_above(panel)
            assert False, "expected ValueError"
        except ValueError as e:
            assert "itself" in str(e)
    finally:
        server.stop()


def test_main_panel_against_itself_raises() -> None:
    """main_panel hands out fresh throwaway handles, so an identity check misses
    main_panel.dock_above(main_panel). The self-check is by uuid, so this must
    still raise (regression: a main-panel self-split)."""
    server = _make_server()
    try:
        try:
            server.gui.main_panel.dock_above(server.gui.main_panel)
            assert False, "expected ValueError"
        except ValueError as e:
            assert "itself" in str(e)
    finally:
        server.stop()


def test_dock_against_removed_anchor_raises() -> None:
    server = _make_server()
    try:
        anchor = server.gui.add_panel()
        panel = server.gui.add_panel()
        anchor.remove()
        try:
            panel.dock_below(anchor)
            assert False, "expected ValueError"
        except ValueError as e:
            assert "removed" in str(e)
    finally:
        server.stop()


def test_cross_scope_anchor_raises() -> None:
    """A panel cannot anchor against a panel from a different scope. The rejection
    is keyed on `gui_api` identity (`anchor._impl.gui_api is self._placement_gui_api`),
    which is exactly what distinguishes broadcast (`server.gui`) from per-client
    (`client.gui`) scope at runtime. We exercise that branch with two distinct
    `GuiApi`s (two servers); the real broadcast-vs-per-client isolation is also
    covered end-to-end by `test_per_client_panel_is_isolated` (e2e)."""
    server = _make_server()
    try:
        server2 = _make_server()
        try:
            panel_a = server.gui.add_panel()
            panel_b = server2.gui.add_panel()
            try:
                panel_a.dock_above(panel_b)
                assert False, "expected ValueError"
            except ValueError as e:
                assert "scope" in str(e)

            # The exception: main_panel renders on every client, so it is a legal
            # anchor from ANY scope -- even server2's panel anchoring server's
            # main panel must NOT raise.
            panel_b.dock_below(server.gui.main_panel)
            assert _position(panel_b)["anchor_uuid"] == CONTROL_PANEL_ID
        finally:
            server2.stop()
    finally:
        server.stop()


def test_remove_panel_removes_group() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        with panel.add_tab("A"):
            server.gui.add_markdown("x")
        uuid = panel._impl.uuid
        panel.remove()
        assert panel._impl.removed is True
        assert uuid not in server.gui._container_handle_from_uuid
    finally:
        server.stop()


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_control_layout_deprecation_translates_to_dock_right() -> None:
    server = viser.ViserServer()
    try:
        for layout in ("collapsible", "fixed"):
            server.gui._main_panel_placement["position"] = None
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                server.gui.configure_theme(control_layout=layout)  # type: ignore[arg-type]
            assert any(
                issubclass(w.category, DeprecationWarning) for w in caught
            ), f"{layout} did not warn"
            assert server.gui._main_panel_placement["position"] == {
                "kind": "edge",
                "edge": "right",
            }
    finally:
        server.stop()


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_control_layout_floating_does_not_warn_or_place() -> None:
    server = viser.ViserServer()
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            server.gui.configure_theme(control_layout="floating")
        assert not any(issubclass(w.category, DeprecationWarning) for w in caught)
        assert server.gui._main_panel_placement["position"] is None
    finally:
        server.stop()


def test_commands_on_removed_panel_raise() -> None:
    """Placement/size/add_tab on a removed panel must raise (the placement path
    bypasses props_setattr's removed-guard, so it has its own). Without this,
    commands would queue updates against a dead uuid (ghost)."""
    import functools

    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.remove()
        calls = (
            panel.dock_left,
            panel.dock_right,
            functools.partial(panel.float, x=0, y=0),
            functools.partial(panel.set_width, 300),
            functools.partial(panel.set_height, 200),
            functools.partial(panel.add_tab, "late"),
        )
        for call in calls:
            try:
                call()
                assert False, "expected RuntimeError on a removed panel"
            except RuntimeError as e:
                assert "removed" in str(e).lower()
    finally:
        server.stop()


def test_invalid_dimensions_raise() -> None:
    """set_width/set_height/float reject non-positive and non-finite sizes
    before they reach the client (NaN/negative/zero produce broken layouts)."""
    import functools
    import math

    server = _make_server()
    try:
        panel = server.gui.add_panel()
        for bad in (-5.0, 0.0, math.nan, math.inf):
            for call in (
                functools.partial(panel.set_width, bad),
                functools.partial(panel.set_height, bad),
                functools.partial(panel.float, width=bad),
                functools.partial(panel.float, height=bad),
            ):
                try:
                    call()
                    assert False, f"expected ValueError for dimension {bad!r}"
                except ValueError:
                    pass
        # Valid values still work.
        panel.set_width(300.0)
        panel.set_height(200.0)
        assert _placement(panel)["width"] == 300.0
        assert _placement(panel)["height"] == 200.0
    finally:
        server.stop()


def test_add_panel_visible_kwarg() -> None:
    """add_panel(visible=...) threads through to the create message, matching
    other add_* factories."""
    server = _make_server()
    try:
        panel = server.gui.add_panel(visible=False)
        assert _props(panel).visible is False
    finally:
        server.stop()
