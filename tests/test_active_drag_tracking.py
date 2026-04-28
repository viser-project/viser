"""Unit tests for the server-side active-drag bookkeeping.

These exercise ``SceneApi._active_drag_handles``, ``_is_drag_active_for``,
and ``_drop_active_drags_for_client`` directly — no browser, no
playwright. The full client→server gesture flow is covered by the
e2e suite (``tests/e2e/test_scene_node_drag.py``); this file just
locks down the multi-client + disconnect semantics that the e2e suite
can't exercise without a two-browser fixture.

Tests bypass ``_handle_node_drag`` entirely: they directly poke
``_active_drag_handles`` to simulate the start-phase populate and then
call the bookkeeping primitives. Integration with real drag messages
is covered by the e2e suite.
"""

from __future__ import annotations

from typing import Generator, cast

import pytest

import viser
from viser import _messages
from viser.infra import ClientId


@pytest.fixture
def server() -> Generator[viser.ViserServer, None, None]:
    """Fresh ViserServer per test; auto-stopped on teardown."""
    s = viser.ViserServer()
    try:
        yield s
    finally:
        s.stop()


def test_active_drag_keyed_by_client_and_name(server: viser.ViserServer) -> None:
    """Two clients dragging the same node populate distinct keys, and
    each client's ``end`` only pops its own entry. Name-only keying
    would collapse them and one client's end would tear down both."""
    box = server.scene.add_box("/multi_box", dimensions=(1.0, 1.0, 1.0))

    client_a = cast(ClientId, 100)
    client_b = cast(ClientId, 200)

    # Simulate the start-phase populate that ``_handle_node_drag``
    # performs for each client.
    server.scene._active_drag_handles[(client_a, "/multi_box")] = box
    server.scene._active_drag_handles[(client_b, "/multi_box")] = box

    assert (client_a, "/multi_box") in server.scene._active_drag_handles
    assert (client_b, "/multi_box") in server.scene._active_drag_handles
    assert server.scene._is_drag_active_for("/multi_box")

    # Client A ends — pops only its key.
    server.scene._active_drag_handles.pop((client_a, "/multi_box"), None)
    assert (client_a, "/multi_box") not in server.scene._active_drag_handles
    assert (client_b, "/multi_box") in server.scene._active_drag_handles

    # B's drag is still live, so the node is still considered
    # actively dragged — ``handle.remove()`` would preserve drag_cb.
    assert server.scene._is_drag_active_for("/multi_box")

    # Client B ends — map empty, node no longer "active".
    server.scene._active_drag_handles.pop((client_b, "/multi_box"), None)
    assert not server.scene._is_drag_active_for("/multi_box")


def test_drop_active_drags_for_client_evicts_only_target_client(
    server: viser.ViserServer,
) -> None:
    """``_drop_active_drags_for_client`` clears all entries for one
    client (across all node names) without touching other clients'
    entries. Without this, a client that disconnects mid-drag leaks
    one entry per dropped drag — pinning ``SceneNodeHandle`` refs
    AND making ``_is_drag_active_for`` return spurious-true for
    those node names (which would then prevent a future
    ``handle.remove()`` from clearing its callbacks)."""
    box1 = server.scene.add_box("/leak_box_1", dimensions=(1.0, 1.0, 1.0))
    box2 = server.scene.add_box("/leak_box_2", dimensions=(1.0, 1.0, 1.0))

    client_a = cast(ClientId, 300)
    client_b = cast(ClientId, 400)

    server.scene._active_drag_handles[(client_a, "/leak_box_1")] = box1
    server.scene._active_drag_handles[(client_a, "/leak_box_2")] = box2
    server.scene._active_drag_handles[(client_b, "/leak_box_1")] = box1
    assert len(server.scene._active_drag_handles) == 3

    # A "disconnects" — drop A's entries.
    server.scene._drop_active_drags_for_client(client_a)

    # Only B's entry remains.
    assert server.scene._active_drag_handles == {
        (client_b, "/leak_box_1"): box1,
    }
    assert server.scene._is_drag_active_for("/leak_box_1")
    assert not server.scene._is_drag_active_for("/leak_box_2")


def test_drop_active_drags_for_client_handles_empty_state(
    server: viser.ViserServer,
) -> None:
    """No-op when the client had no in-flight drags. Defensive: this
    is the common path (most disconnects happen with no active drag)."""
    client = cast(ClientId, 500)
    server.scene._drop_active_drags_for_client(client)
    assert server.scene._active_drag_handles == {}


def test_is_drag_active_for_returns_false_when_empty(
    server: viser.ViserServer,
) -> None:
    """Sanity: empty map ⇒ no drag active for any node."""
    assert not server.scene._is_drag_active_for("/anything")
    assert not server.scene._is_drag_active_for("")


def _binding_messages_for(
    server: viser.ViserServer, name: str
) -> list[_messages.SetSceneNodeDragBindingsMessage]:
    buffer = server._websock_server._broadcast_buffer.message_from_id
    return [
        m
        for m in buffer.values()
        if isinstance(m, _messages.SetSceneNodeDragBindingsMessage) and m.name == name
    ]


def test_remove_mid_drag_displaces_stale_binding_in_buffer(
    server: viser.ViserServer,
) -> None:
    """Removing a node mid-drag must displace the persistent
    ``SetSceneNodeDragBindingsMessage`` so a future same-named node
    doesn't inherit stale bindings on late-joining clients.

    ``SetSceneNodeDragBindingsMessage`` is keyed by name in the
    redundancy map, so emitting an empty replacement at remove() time
    overwrites the prior non-empty entry."""
    box = server.scene.add_box("/x", dimensions=(1.0, 1.0, 1.0))
    box.on_drag_start("left")(lambda _: None)

    bindings = _binding_messages_for(server, "/x")
    assert len(bindings) == 1
    assert bindings[0].bindings != ()

    client = cast(ClientId, 1)
    server.scene._active_drag_handles[(client, "/x")] = box
    box.remove()

    bindings = _binding_messages_for(server, "/x")
    assert len(bindings) == 1, "remove() should displace, not duplicate"
    assert bindings[0].bindings == (), (
        "remove() while actively dragged must clear the persistent buffer entry"
    )

    # Simulate end-phase pop after the client's final drag message.
    server.scene._active_drag_handles.pop((client, "/x"), None)

    # Recreate same name without drag callbacks. The buffer must still
    # show empty bindings for /x — a late-joining client must not see
    # the original binding.
    server.scene.add_box("/x", dimensions=(1.0, 1.0, 1.0))
    bindings = _binding_messages_for(server, "/x")
    assert all(m.bindings == () for m in bindings), (
        "recreated same-name node must not inherit stale bindings"
    )


def test_remove_without_active_drag_clears_binding_in_buffer(
    server: viser.ViserServer,
) -> None:
    """Sanity: the non-actively-dragged remove path also displaces the
    persistent binding entry (this path was already correct via
    ``_sync_drag_bindings`` clearing ``drag_cb`` and re-emitting; this
    test pins it so a future refactor doesn't regress it)."""
    box = server.scene.add_box("/y", dimensions=(1.0, 1.0, 1.0))
    box.on_drag_start("left")(lambda _: None)

    box.remove()

    bindings = _binding_messages_for(server, "/y")
    assert len(bindings) == 1
    assert bindings[0].bindings == ()


def test_cascade_remove_clears_descendant_interaction_state(
    server: viser.ViserServer,
) -> None:
    """Removing a parent must also clear stale click/drag state for
    its descendants. The persistent buffer keys
    ``SetSceneNodeClickableMessage`` / ``SetSceneNodeDragBindingsMessage``
    by name; without descendant cleanup, a same-name child recreated
    after parent removal would inherit stale interaction flags on
    late-joining clients."""
    server.scene.add_frame("/parent")
    child = server.scene.add_box("/parent/child", dimensions=(1.0, 1.0, 1.0))
    child.on_drag_start("left")(lambda _: None)
    child.on_click(lambda _: None)

    bindings = _binding_messages_for(server, "/parent/child")
    assert len(bindings) == 1 and bindings[0].bindings != ()

    server.scene._handle_from_node_name["/parent"].remove()

    bindings = _binding_messages_for(server, "/parent/child")
    assert len(bindings) == 1, "cascade remove must displace descendant bindings"
    assert bindings[0].bindings == ()

    buffer = server._websock_server._broadcast_buffer.message_from_id
    clickable = [
        m
        for m in buffer.values()
        if isinstance(m, _messages.SetSceneNodeClickableMessage)
        and m.name == "/parent/child"
    ]
    assert len(clickable) == 1
    assert clickable[0].clickable is False, (
        "cascade remove must displace descendant clickable=true"
    )
