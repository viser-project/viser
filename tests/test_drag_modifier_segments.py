"""Unit tests for mid-drag modifier switching (drag "segments").

A single physical drag is partitioned into one *segment* per held
(button, modifier) combo. When the held modifier changes mid-drag the
client ends the current segment and starts a new one under the new
combo; the server routes each segment's start/update/end to whichever
callback that combo is bound to (``_handle_node_drag`` ->
``_dispatch_drag_callbacks``).

These tests drive ``_handle_node_drag`` directly with a crafted message
sequence -- no browser -- to lock down that the server bookkeeping
(``_active_drag_handles``) and per-modifier dispatch stay consistent
across the synthetic end/start boundary the client emits. The real
client-side segmentation (key listeners, geometry preservation) is
covered by the e2e suite and the ``planModifierTransition`` unit tests.
"""

from __future__ import annotations

import asyncio
from typing import Generator, cast
from unittest.mock import Mock

import pytest

import viser
from viser import _messages
from viser.infra import ClientId


@pytest.fixture
def server() -> Generator[viser.ViserServer, None, None]:
    s = viser.ViserServer()
    try:
        yield s
    finally:
        s.stop()


def _drag_msg(
    name: str,
    phase: _messages._DragPhase,
    modifier: _messages.KeyModifier | None,
) -> _messages.SceneNodeDragMessage:
    return _messages.SceneNodeDragMessage(
        phase=phase,
        name=name,
        instance_index=None,
        start_position=(0.0, 0.0, 0.0),
        start_screen_pos=(0.0, 0.0),
        end_position=(1.0, 1.0, 1.0),
        end_screen_pos=(1.0, 1.0),
        button="left",
        modifier=modifier,
    )


def _dispatch(
    server: viser.ViserServer,
    client_id: ClientId,
    message: _messages.SceneNodeDragMessage,
) -> None:
    """Run ``_handle_node_drag`` on the server's event loop and block."""
    asyncio.run_coroutine_threadsafe(
        server.scene._handle_node_drag(client_id, message),
        server._event_loop,
    ).result()


def test_modifier_switch_routes_segments_to_each_binding(
    server: viser.ViserServer,
) -> None:
    """Switching the held modifier mid-drag routes each segment's
    start/update/end to the callback bound to that combo, and leaves the
    other combo's callback untouched."""
    box = server.scene.add_box("/seg_box", dimensions=(1.0, 1.0, 1.0))

    ctrl_phases: list[str] = []
    ctrl_shift_phases: list[str] = []

    # Async callbacks are awaited in dispatch order on the event loop, so
    # the phase lists are complete and deterministic once ``_dispatch``
    # returns. (Sync callbacks are fire-and-forget on a thread pool and
    # would race the assertions.)
    @box.on_drag("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent) -> None:
        ctrl_phases.append(event.phase)
        # The active segment's modifier always matches this binding.
        assert event.modifier == "cmd/ctrl"

    @box.on_drag("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent) -> None:
        ctrl_shift_phases.append(event.phase)
        assert event.modifier == "cmd/ctrl+shift"

    client = cast(ClientId, 42)
    server._connected_clients[client] = Mock()

    # The client emits this sequence when the user holds Ctrl, drags,
    # then adds Shift mid-drag and keeps dragging before releasing: the
    # Ctrl segment is ended and a Ctrl+Shift segment is started, with the
    # grab geometry preserved across the boundary.
    _dispatch(server, client, _drag_msg("/seg_box", "start", "cmd/ctrl"))
    _dispatch(server, client, _drag_msg("/seg_box", "update", "cmd/ctrl"))
    _dispatch(server, client, _drag_msg("/seg_box", "end", "cmd/ctrl"))
    _dispatch(server, client, _drag_msg("/seg_box", "start", "cmd/ctrl+shift"))
    _dispatch(server, client, _drag_msg("/seg_box", "update", "cmd/ctrl+shift"))
    _dispatch(server, client, _drag_msg("/seg_box", "end", "cmd/ctrl+shift"))

    # Each callback sees exactly one clean start...end for its own combo,
    # and nothing from the other segment.
    assert ctrl_phases == ["start", "update", "end"]
    assert ctrl_shift_phases == ["start", "update", "end"]

    # Bookkeeping released after the final end.
    assert not server.scene._is_drag_active_for("/seg_box")


def test_modifier_switch_keeps_drag_active_across_boundary(
    server: viser.ViserServer,
) -> None:
    """The node stays "actively dragged" across the segment boundary --
    the end of one segment is immediately followed by the start of the
    next, so a concurrent ``remove()`` would still preserve callbacks
    until the gesture truly finishes."""
    box = server.scene.add_box("/active_box", dimensions=(1.0, 1.0, 1.0))
    box.on_drag("left", modifier="cmd/ctrl")(lambda _: None)
    box.on_drag("left", modifier="cmd/ctrl+shift")(lambda _: None)

    client = cast(ClientId, 7)
    server._connected_clients[client] = Mock()

    _dispatch(server, client, _drag_msg("/active_box", "start", "cmd/ctrl"))
    assert server.scene._is_drag_active_for("/active_box")

    # Old segment ends...
    _dispatch(server, client, _drag_msg("/active_box", "end", "cmd/ctrl"))
    # ...new segment starts. The node is active again immediately.
    _dispatch(server, client, _drag_msg("/active_box", "start", "cmd/ctrl+shift"))
    assert server.scene._is_drag_active_for("/active_box")

    _dispatch(server, client, _drag_msg("/active_box", "end", "cmd/ctrl+shift"))
    assert not server.scene._is_drag_active_for("/active_box")


def test_unbound_segment_does_not_dispatch(
    server: viser.ViserServer,
) -> None:
    """A segment whose modifier matches no binding dispatches to nobody
    (server-side filter), but still cycles the active-drag bookkeeping
    cleanly. In practice the client suppresses these entirely (dormant
    state); this pins the server's filter as a backstop."""
    box = server.scene.add_box("/unbound_box", dimensions=(1.0, 1.0, 1.0))

    ctrl_phases: list[str] = []

    @box.on_drag("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent) -> None:
        ctrl_phases.append(event.phase)

    client = cast(ClientId, 99)
    server._connected_clients[client] = Mock()

    _dispatch(server, client, _drag_msg("/unbound_box", "start", "cmd/ctrl"))
    _dispatch(server, client, _drag_msg("/unbound_box", "end", "cmd/ctrl"))
    # Shift-only is unbound: no callback fires for this segment.
    _dispatch(server, client, _drag_msg("/unbound_box", "start", "shift"))
    _dispatch(server, client, _drag_msg("/unbound_box", "update", "shift"))
    _dispatch(server, client, _drag_msg("/unbound_box", "end", "shift"))

    assert ctrl_phases == ["start", "end"]
    assert not server.scene._is_drag_active_for("/unbound_box")
