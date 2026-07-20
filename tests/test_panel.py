"""Unit tests for the standalone panel API (add_panel / main_panel).

These cover the Python handle layer: that placement commands (dock/float/size)
each queue the right per-axis message (placement is write-only -- no
server-side state to read back), that those messages persist in the broadcast
buffer for replay to late-joining clients, and that scope / anchor validation
raises as specified.
"""

from __future__ import annotations

import asyncio
import threading
import warnings
from typing import Any
from unittest.mock import patch

import pytest

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


def _latest(server: viser.ViserServer, uuid: str, message_type: type) -> Any:
    """The latest buffered message of `message_type` targeting `uuid` (i.e. what a
    newly-connected client would replay). Placement is write-only: each command
    queues a per-axis message that coalesces latest-wins per type, so this is the
    panel's effective state for that axis. Asserts one exists."""
    buffer = server._websock_server._broadcast_buffer.message_from_id
    found = None
    for msg in buffer.values():
        if isinstance(msg, message_type) and getattr(msg, "uuid", None) == uuid:
            found = msg
    assert found is not None, f"No {message_type.__name__} buffered for {uuid}."
    return found


def _position(server: viser.ViserServer, uuid: str) -> dict[str, Any]:
    """The panel's latest buffered position, as a plain dict for assertions."""
    return dict(_latest(server, uuid, m.GuiSetPanelPositionMessage).position)


def _buffered_types(server: viser.ViserServer, uuid: str) -> set[type]:
    """The set of message types currently buffered for `uuid` (to assert a command
    sends ONLY its own axis -- e.g. set_width must not queue a position)."""
    buffer = server._websock_server._broadcast_buffer.message_from_id
    return {type(msg) for msg in buffer.values() if getattr(msg, "uuid", None) == uuid}


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
        # No placement messages until a command is issued (write-only: state
        # only exists once a dock/float/size command is called).
        assert _buffered_types(server, panel._impl.uuid) == {m.GuiPanelMessage}
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


def test_tab_remove_updates_panel_message() -> None:
    """tab.remove() must drop the tab from the panel's buffered create message
    (the client learns membership only from the panel props, so the coalesced
    GuiPanelMessage is what a late joiner replays)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        with panel.add_tab("Stats"):
            server.gui.add_markdown("hello")
        logs_tab = panel.add_tab("Logs")
        with logs_tab:
            server.gui.add_markdown("world")
        assert panel._tab_labels == ("Stats", "Logs")
        logs_tab.remove()
        assert panel._tab_labels == ("Stats",)
        assert len(panel._tab_container_ids) == 1
        latest = _latest(server, panel._impl.uuid, m.GuiPanelMessage)
        assert latest.props._tab_labels == ("Stats",)
        assert len(latest.props._tab_container_ids) == 1
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
        # The remove superseded the create in the broadcast buffer, so a late
        # joiner won't replay the now-gone panel: no create message remains.
        buffer = server._websock_server._broadcast_buffer.message_from_id
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
        uuid = panel._impl.uuid
        panel.dock_right()
        # The dock command queues a Position message (buffered for replay).
        assert _latest(server, uuid, m.GuiSetPanelPositionMessage).position == {
            "kind": "edge",
            "edge": "right",
        }
        # Repositioning coalesces latest-wins (same message type).
        panel.dock_left()
        assert _latest(server, uuid, m.GuiSetPanelPositionMessage).position == {
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
        uuid = panel._impl.uuid
        panel.dock_above(anchor)
        assert _latest(server, uuid, m.GuiSetPanelPositionMessage).position == {
            "kind": "split",
            "anchor_uuid": anchor._impl.uuid,
            "side": "above",
        }
        panel.dock_below(anchor)
        assert (
            _latest(server, uuid, m.GuiSetPanelPositionMessage).position["side"]
            == "below"
        )
    finally:
        server.stop()


def test_placement_axes_are_independent() -> None:
    """Each axis is its own message type, so they coalesce independently: a
    set_width after a dock_right leaves the position message intact (and a
    set_width queues NO position -- it can't re-dock a user-moved panel)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        panel.dock_right()
        panel.set_width(400)
        # Position survives the later set_width (independent coalescing slots).
        assert _latest(server, uuid, m.GuiSetPanelPositionMessage).position == {
            "kind": "edge",
            "edge": "right",
        }
        assert _latest(server, uuid, m.GuiSetPanelWidthMessage).width == 400
    finally:
        server.stop()


def test_set_width_sends_only_width() -> None:
    """set_width queues ONLY a width message -- no position. (This is what makes
    resizing unable to yank a panel the user has dragged elsewhere.)"""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        panel.set_width(512)
        panel.set_height(384)
        assert _latest(server, uuid, m.GuiSetPanelWidthMessage).width == 512
        assert _latest(server, uuid, m.GuiSetPanelHeightMessage).height == 384
        # No position message was queued by size commands.
        assert m.GuiSetPanelPositionMessage not in _buffered_types(server, uuid)
    finally:
        server.stop()


def test_float_sends_position_and_optional_size() -> None:
    """float() queues a float Position, plus Width/Height only when given."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        panel.float(x=10, y=20)
        assert _latest(server, uuid, m.GuiSetPanelPositionMessage).position == {
            "kind": "float",
            "x": 10,
            "y": 20,
        }
        # No size yet (x/y only).
        assert m.GuiSetPanelWidthMessage not in _buffered_types(server, uuid)
        panel.float(width=300, height=200)
        assert _latest(server, uuid, m.GuiSetPanelWidthMessage).width == 300
        assert _latest(server, uuid, m.GuiSetPanelHeightMessage).height == 200
    finally:
        server.stop()


def test_minimize_sends_collapsed_message() -> None:
    """minimize() queues a Collapsed(True) message; a fresh panel queues none."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        assert m.GuiSetPanelCollapsedMessage not in _buffered_types(server, uuid)
        panel.minimize()
        assert _latest(server, uuid, m.GuiSetPanelCollapsedMessage).collapsed is True
    finally:
        server.stop()


def test_expand_sends_collapsed_false() -> None:
    """expand() is the imperative inverse of minimize(): Collapsed(False), with
    a bumped counter so it beats an earlier minimize in the coalesced buffer."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        panel.minimize()
        first = _latest(server, uuid, m.GuiSetPanelCollapsedMessage)
        panel.expand()
        latest = _latest(server, uuid, m.GuiSetPanelCollapsedMessage)
        assert latest.collapsed is False
        assert latest.counter > first.counter
    finally:
        server.stop()


def test_remove_purges_buffered_placement_messages() -> None:
    """Removing a panel purges its buffered per-axis placement messages (they
    share the panel's `gui` entity), so a late-joining client can't replay
    placement for a panel that no longer exists."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        panel.dock_right()
        panel.set_width(300)
        assert m.GuiSetPanelPositionMessage in _buffered_types(server, uuid)
        panel.remove()
        # Only the remove tombstone remains (it coalesces over the create via
        # the shared redundancy key -- the standard entity lifecycle); every
        # per-axis placement update must be gone.
        assert _buffered_types(server, uuid) == {m.GuiPanelRemoveMessage}, (
            "placement messages must be purged with the panel"
        )
    finally:
        server.stop()


def test_placement_messages_carry_run_id() -> None:
    """Every placement message is stamped with the GuiApi's run id (counters are
    only comparable within one run/scope; the client uses run_id to detect a
    restarted server or another scope)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        uuid = panel._impl.uuid
        panel.dock_right()
        panel.set_width(300)
        pos = _latest(server, uuid, m.GuiSetPanelPositionMessage)
        width = _latest(server, uuid, m.GuiSetPanelWidthMessage)
        assert pos.run_id == width.run_id == server.gui._layout_run_id
        assert len(pos.run_id) > 0
    finally:
        server.stop()


def test_main_panel_placement_targets_control_panel_uuid() -> None:
    """main_panel returns throwaway handles; its commands target the fixed
    control-panel uuid via the same per-axis messages."""
    server = _make_server()
    try:
        server.gui.main_panel.dock_right()
        # A fresh handle issues the same command, targeting CONTROL_PANEL_ID.
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "edge", "edge": "right"}
    finally:
        server.stop()


def test_main_panel_float_after_dock() -> None:
    """main_panel.float() after a dock_* queues a float Position (the command
    behind the 05_theming "floating" option), coalescing over the edge dock so
    the client undocks."""
    server = _make_server()
    try:
        server.gui.main_panel.dock_left()
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "edge", "edge": "left"}
        server.gui.main_panel.float()
        # The latest Position (what a late joiner replays) is now the float.
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "float", "x": None, "y": None}
    finally:
        server.stop()


def test_reset_resets_main_panel_placement_to_default() -> None:
    """gui.reset() returns the control panel to its default (top-right float)
    by sending default per-axis messages. These coalesce over any prior
    main-panel placement, so a stale dock doesn't replay to clients that
    connect after the reset (regression: placement persisted across reset)."""
    server = _make_server()
    try:
        server.gui.main_panel.dock_left()
        server.gui.reset()
        # The latest buffered Position is the default float.
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "float", "x": None, "y": None}
    finally:
        server.stop()


def test_reset_clears_main_panel_collapsed() -> None:
    """Scan regression (P2): collapsed is the fourth independent axis with its
    own redundancy slot, so gui.reset() must send Collapsed(False) -- otherwise
    a prior main_panel.minimize() survives the reset in the buffer and late
    joiners replay a minimized 'default' control panel."""
    server = _make_server()
    try:
        server.gui.main_panel.minimize()
        assert (
            _latest(server, CONTROL_PANEL_ID, m.GuiSetPanelCollapsedMessage).collapsed
            is True
        )
        server.gui.reset()
        assert (
            _latest(server, CONTROL_PANEL_ID, m.GuiSetPanelCollapsedMessage).collapsed
            is False
        )
    finally:
        server.stop()


def test_client_scoped_reset_does_not_touch_main_panel_placement() -> None:
    """client.gui.reset() resets the GUI elements it owns but must NOT reset
    the main panel's placement: a client-scoped GuiApi mints its own run_id,
    which the client's placement gate treats as a fresh deliberate command --
    so the default CONTROL_PANEL_ID messages would clobber server-authored
    placement (e.g. undock a dock_left control panel) for that one client."""
    from viser._viser import ClientHandle
    from viser.infra._async_message_buffer import AsyncMessageBuffer
    from viser.infra._infra import WebsockClientConnection, _ClientHandleState

    server = _make_server()
    try:
        server.gui.main_panel.dock_left()

        # Synthetic in-process client connection: no websocket needed, we only
        # inspect the outgoing per-client message buffer (mirrors how
        # WebsockServer constructs the per-client state). Constructed ON the
        # server's loop thread: AsyncMessageBuffer's asyncio.Event fields bind
        # to the current event loop at construction on Python <= 3.9, and this
        # test thread has none (production buffers are always built inside the
        # loop, so only the test needs the hop).
        async def _make_buffer() -> AsyncMessageBuffer:
            return AsyncMessageBuffer(server._event_loop, persistent_messages=False)

        buffer = asyncio.run_coroutine_threadsafe(
            _make_buffer(), server._event_loop
        ).result(timeout=5.0)
        conn = WebsockClientConnection(
            0, _ClientHandleState(buffer, server._event_loop)
        )
        client = ClientHandle(conn, server)

        client.gui.add_button("local")
        client.gui.reset()

        # The client-scoped reset drained its own GUI elements...
        root = client.gui._container_handle_from_uuid["root"]
        assert root._children == {}
        # ...but queued NO main-panel placement messages on the per-client
        # connection.
        placement_types = (
            m.GuiSetPanelPositionMessage,
            m.GuiSetPanelWidthMessage,
            m.GuiSetPanelHeightMessage,
            m.GuiSetPanelCollapsedMessage,
        )
        assert not any(
            isinstance(msg, placement_types) for msg in buffer.message_from_id.values()
        )
        # The server-authored broadcast placement is untouched by the
        # client-scoped reset...
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "edge", "edge": "left"}
        # ...while a server-scoped reset still resets it to the default.
        server.gui.reset()
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "float", "x": None, "y": None}
    finally:
        server.stop()


@pytest.mark.filterwarnings("ignore:Attempted to remove an already removed")
def test_concurrent_panel_remove_single_winner() -> None:
    """Two concurrent remove() calls must resolve to exactly one winner: the
    loser warns (filtered above; warnings state is global, so per-thread
    catch_warnings would race) and returns. Regression: the tombstone check ran
    before the lifecycle lock was taken and was never re-checked inside, so
    both racers could pass and the loser's registry pop raised KeyError (which
    would also abort a gui.reset() mid-drain)."""
    server = _make_server()
    try:
        for _ in range(20):
            panel = server.gui.add_panel()
            uuid = panel._impl.uuid
            barrier = threading.Barrier(2)
            errors: list[BaseException] = []

            def racer(p: viser.PanelHandle = panel) -> None:
                try:
                    barrier.wait()
                    p.remove()
                except BaseException as e:  # pragma: no cover - failure path
                    errors.append(e)

            threads = [threading.Thread(target=racer) for _ in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert errors == [], errors
            assert uuid not in server.gui._panel_handle_from_uuid
            # Exactly the remove tombstone remains buffered for the panel.
            assert _buffered_types(server, uuid) == {m.GuiPanelRemoveMessage}
    finally:
        server.stop()


def test_panel_double_remove_warns_and_noops() -> None:
    """A second remove() on the same handle warns and returns (no KeyError,
    no duplicate remove message)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.remove()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            panel.remove()
        assert any("already removed" in str(w.message) for w in caught)
    finally:
        server.stop()


def test_queue_placement_rechecks_anchor_under_lock() -> None:
    """dock_above/dock_below validate the anchor in _resolve_anchor_uuid BEFORE
    the lifecycle lock is taken; _queue_placement must re-check `removed` under
    the lock, or an anchor.remove() in between persists a split placement
    referencing a dead anchor uuid in the replay buffer. Simulate the
    interleaving by running the two stages with the removal in between."""
    server = _make_server()
    try:
        anchor = server.gui.add_panel()
        panel = server.gui.add_panel()
        # Stage 1: the pre-lock check passes while the anchor is alive.
        anchor_uuid = panel._resolve_anchor_uuid(anchor)
        # The anchor is removed between the check and the enqueue.
        anchor.remove()
        # Stage 2: the locked enqueue must reject with the same ValueError the
        # sequential path promises.
        try:
            panel._set_position(
                {"kind": "split", "anchor_uuid": anchor_uuid, "side": "below"},
                anchor=anchor,
            )
            assert False, "expected ValueError"
        except ValueError as e:
            assert "removed" in str(e)
        # No split placement referencing the dead anchor was buffered.
        assert m.GuiSetPanelPositionMessage not in _buffered_types(
            server, panel._impl.uuid
        )
    finally:
        server.stop()


def test_layout_counter_is_global_across_panels() -> None:
    """Scan regression (D50): collapse acts on the panel's CONTAINER, so when
    stacked panels' collapse axes conflict, a late joiner must replay them in
    command order -- which requires the counter to be one strictly increasing
    sequence ACROSS panels, not per-panel."""
    server = _make_server()
    try:
        a = server.gui.add_panel()
        b = server.gui.add_panel()
        b.dock_below(a)  # positions first (a right-edge fallback is fine here)
        b.expand()
        a.minimize()
        b_collapsed = _latest(server, b._impl.uuid, m.GuiSetPanelCollapsedMessage)
        a_collapsed = _latest(server, a._impl.uuid, m.GuiSetPanelCollapsedMessage)
        assert a_collapsed.run_id == b_collapsed.run_id
        # a.minimize() came AFTER b.expand() and must outrank it globally.
        assert a_collapsed.counter > b_collapsed.counter
    finally:
        server.stop()


def test_main_panel_handle_held_across_reset_stays_in_sync() -> None:
    """A MainPanelHandle obtained BEFORE reset() must keep working after it. The
    handle holds no state (placement is write-only, keyed by CONTROL_PANEL_ID), so
    a later command on a held handle still drives the (post-reset) state."""
    server = _make_server()
    try:
        mp = server.gui.main_panel
        mp.dock_left()
        server.gui.reset()
        # The held handle still drives placement.
        mp.dock_right()
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "edge", "edge": "right"}
    finally:
        server.stop()


def test_main_panel_is_legal_anchor() -> None:
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        panel.dock_above(server.gui.main_panel)
        assert _position(server, panel._impl.uuid)["anchor_uuid"] == CONTROL_PANEL_ID
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
            assert (
                _position(server2, panel_b._impl.uuid)["anchor_uuid"]
                == CONTROL_PANEL_ID
            )
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
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                server.gui.configure_theme(control_layout=layout)  # type: ignore[arg-type]
            assert any(issubclass(w.category, DeprecationWarning) for w in caught), (
                f"{layout} did not warn"
            )
            # The deprecation docks the control panel to the right.
            assert _latest(
                server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
            ).position == {"kind": "edge", "edge": "right"}
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
        # "floating" issues no DOCK -- the control panel's position stays the
        # default float (server init resets it to a default float; floating must
        # not turn that into an edge dock).
        assert _latest(
            server, CONTROL_PANEL_ID, m.GuiSetPanelPositionMessage
        ).position == {"kind": "float", "x": None, "y": None}
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


def test_panel_is_not_a_context_manager() -> None:
    """`with server.gui.add_panel():` is a natural mistake (a panel is a tab
    container, not a GUI context). It must raise a CLEAR TypeError, not a bare
    AttributeError on __enter__."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        # Use a real `with` statement -- this is the actual user mistake. CPython
        # looks up `__exit__` on the type *before* calling `__enter__`, so the
        # panel must define both for the helpful TypeError to surface (otherwise
        # `with` fails with a bare `AttributeError: __exit__`).
        try:
            with panel:
                pass
            assert False, "expected TypeError"
        except TypeError as e:
            assert "context manager" in str(e)
            assert "add_tab" in str(e)
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
        uuid = panel._impl.uuid
        assert _latest(server, uuid, m.GuiSetPanelWidthMessage).width == 300.0
        assert _latest(server, uuid, m.GuiSetPanelHeightMessage).height == 200.0
    finally:
        server.stop()


def test_float_coordinates_allow_negative_reject_nonfinite() -> None:
    """float(x=, y=) accepts negatives/zero (gaps from far/near edges) but rejects
    NaN/inf, which would produce a broken, replayed window position."""
    import functools
    import math

    server = _make_server()
    try:
        panel = server.gui.add_panel()
        # Negatives + zero are valid coordinates.
        panel.float(x=-15.0, y=0.0)
        assert _position(server, panel._impl.uuid) == {
            "kind": "float",
            "x": -15.0,
            "y": 0.0,
        }
        # NaN / inf (either axis) are rejected.
        for bad in (math.nan, math.inf, -math.inf):
            for call in (
                functools.partial(panel.float, x=bad),
                functools.partial(panel.float, y=bad),
            ):
                try:
                    call()
                    assert False, f"expected ValueError for coordinate {bad!r}"
                except ValueError:
                    pass
    finally:
        server.stop()


def test_add_tab_on_removed_container_raises_cleanly() -> None:
    """add_tab on a removed tab group / panel raises RuntimeError WITHOUT leaving
    half-registered state (the shared _TabContainerMixin guard, applied before any
    mutation)."""
    server = _make_server()
    try:
        # Tab group.
        tg = server.gui.add_tab_group()
        tg.remove()
        try:
            tg.add_tab("late")
            assert False, "expected RuntimeError"
        except RuntimeError:
            pass
        assert tg._tab_handles == []  # no half-registered tab
        assert tg._tab_container_ids == ()

        # Panel (same shared guard).
        panel = server.gui.add_panel()
        panel.remove()
        try:
            panel.add_tab("late")
            assert False, "expected RuntimeError"
        except RuntimeError:
            pass
        assert panel._tab_handles == []
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


def test_add_tab_racing_remove_never_leaks_container() -> None:
    """add_tab() racing remove() must never leak an orphan tab container: the
    removed check, tab registration, and append run atomically under the
    panel lifecycle lock, so either the remover drains the new tab or the
    adder raises. Regression: a bare (unlocked) check let a tab register into
    _container_handle_from_uuid for a panel that no longer existed -- a live
    container that silently accepted children forever."""
    import threading

    server = _make_server()
    try:
        gui = server.gui
        for _ in range(40):
            panel = gui.add_panel()
            barrier = threading.Barrier(2)
            added: list = []

            def adder() -> None:
                barrier.wait()
                try:
                    added.append(panel.add_tab("T"))
                except RuntimeError:
                    pass  # remove() won the race: correct outcome.

            def remover() -> None:
                barrier.wait()
                panel.remove()

            t1 = threading.Thread(target=adder)
            t2 = threading.Thread(target=remover)
            t1.start(), t2.start()
            t1.join(timeout=10), t2.join(timeout=10)
            assert not t1.is_alive() and not t2.is_alive(), "deadlock"

            # No orphan: any tab the adder created was drained by the
            # remover, so nothing owned by this dead panel is registered.
            for tab in added:
                assert tab._id not in gui._container_handle_from_uuid, (
                    "orphan tab container leaked for a removed panel"
                )
    finally:
        server.stop()
