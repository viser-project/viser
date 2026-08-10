"""Tests for cross-scope scene semantics: per-name variant slots.

Scene nodes are identified by (owner, name): the broadcast scope
(``server.scene``) and each per-client scope (``client.scene``) may each hold
one variant of a name, fed independently by their scopes' messages. The
client renders the effective variant per the display rule (real client >
real broadcast > virtual client > virtual broadcast); shadowing and
promotion are covered by the frontend's ``SceneTreeState.test.ts`` and the
e2e suite (``tests/e2e/test_cross_scope_handles.py``).

This file covers the Python/server half on a headless server with synthetic
in-process clients: owner stamping, unconditional same-scope virtual
anchors, scope-local cascade, and coexistence in the registries.
"""

from __future__ import annotations

from typing import Generator

import pytest

import viser
import viser._client_autobuild
from viser import _messages as m

from .infra_utils import (
    broadcast_messages,
    client_buffer_messages,
    make_synthetic_client,
)


@pytest.fixture()
def server() -> Generator[viser.ViserServer, None, None]:
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server = viser.ViserServer(port=0, verbose=False)
    yield server
    server.stop()


# ---------------------------------------------------------------------------
# Owner stamping.
# ---------------------------------------------------------------------------


def test_owner_stamped_onbroadcast_messages(server: viser.ViserServer) -> None:
    handle = server.scene.add_icosphere("/ball", radius=0.1, position=(1.0, 0.0, 0.0))
    handle.visible = False
    handle.color = (10, 20, 30)

    for msg in broadcast_messages(server):
        if hasattr(msg, "owner"):
            assert msg.owner == "", f"{type(msg).__name__} not broadcast-stamped"


def test_owner_stamped_on_client_messages(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 3)
    handle = client.scene.add_icosphere("/ball", radius=0.1, position=(1.0, 0.0, 0.0))
    handle.visible = False
    handle.color = (10, 20, 30)
    handle.remove()

    scene_messages = [
        msg for msg in client_buffer_messages(client) if hasattr(msg, "owner")
    ]
    assert len(scene_messages) > 0
    for msg in scene_messages:
        assert msg.owner == "3", f"{type(msg).__name__} not client-stamped"


# ---------------------------------------------------------------------------
# Coexistence: same name in both scopes is legal, state is scope-local.
# ---------------------------------------------------------------------------


def test_same_name_coexists_across_scopes(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 0)

    server_handle = server.scene.add_icosphere("/dup", radius=0.1)
    client_handle = client.scene.add_icosphere("/dup", radius=0.2)

    # Both registries hold their own live handle; neither superseded.
    assert not server_handle._impl.removed
    assert not client_handle._impl.removed
    assert server.scene._handle_from_node_name["/dup"] is server_handle
    assert client.scene._handle_from_node_name["/dup"] is client_handle

    # Removing one scope's variant does not touch the other's.
    client_handle.remove()
    assert client_handle._impl.removed
    assert not server_handle._impl.removed


def test_same_name_across_clients_coexists(server: viser.ViserServer) -> None:
    client0 = make_synthetic_client(server, 0)
    client1 = make_synthetic_client(server, 1)

    h0 = client0.scene.add_icosphere("/own", radius=0.1)
    h1 = client1.scene.add_icosphere("/own", radius=0.2)
    assert not h0._impl.removed
    assert not h1._impl.removed


def test_same_scope_supersede_still_works(server: viser.ViserServer) -> None:
    old = server.scene.add_box("/re", dimensions=(1.0, 1.0, 1.0))
    new = server.scene.add_box("/re", dimensions=(2.0, 2.0, 2.0))
    assert old._impl.removed
    assert not new._impl.removed
    assert server.scene._handle_from_node_name["/re"] is new


# ---------------------------------------------------------------------------
# Unconditional same-scope virtual anchors.
# ---------------------------------------------------------------------------


def test_virtual_anchors_created_per_scope(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 0)

    # Broadcast parent exists; the client's deep add still creates a
    # same-scope anchor chain (which does not shadow: anchors are virtual).
    server.scene.add_frame("/parent", show_axes=False)
    client.scene.add_icosphere("/parent/child/deep", radius=0.1)

    assert "/parent" in client.scene._handle_from_node_name
    assert "/parent/child" in client.scene._handle_from_node_name

    creates = {
        msg.name: msg
        for msg in client_buffer_messages(client)
        if isinstance(msg, m._CreateSceneNodeMessage)
    }
    assert creates["/parent"].virtual is True
    assert creates["/parent/child"].virtual is True
    assert creates["/parent/child/deep"].virtual is False
    for msg in creates.values():
        assert msg.owner == "0"


def test_real_add_supersedes_virtual_anchor(server: viser.ViserServer) -> None:
    server.scene.add_icosphere("/a/b", radius=0.1)
    anchor = server.scene._handle_from_node_name["/a"]

    real = server.scene.add_frame("/a", show_axes=True)
    assert anchor._impl.removed
    assert server.scene._handle_from_node_name["/a"] is real
    # The real frame's create message is not virtual.
    creates = [
        msg
        for msg in broadcast_messages(server)
        if isinstance(msg, m._CreateSceneNodeMessage) and msg.name == "/a"
    ]
    assert len(creates) == 1  # Redundancy key replaced the anchor's create.
    assert creates[0].virtual is False


# ---------------------------------------------------------------------------
# Scope-local cascade.
# ---------------------------------------------------------------------------


def test_cascade_is_scope_local(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 0)

    parent = server.scene.add_frame("/parent", show_axes=False)
    server_child = server.scene.add_icosphere("/parent/shared", radius=0.1)
    client_child = client.scene.add_icosphere("/parent/mine", radius=0.1)

    parent.remove()

    # Broadcast descendants die with the parent; the client's subtree
    # survives, anchored by its own scope's virtual /parent.
    assert server_child._impl.removed
    assert not client_child._impl.removed
    assert "/parent/mine" in client.scene._handle_from_node_name
    assert "/parent" in client.scene._handle_from_node_name  # The anchor.

    # The client can still update and remove its node normally.
    client_child.position = (1.0, 2.0, 3.0)
    client_child.remove()
    assert client_child._impl.removed


def test_client_cascade_does_not_touch_broadcast(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 0)

    server.scene.add_frame("/parent", show_axes=False)
    server_child = server.scene.add_icosphere("/parent/shared", radius=0.1)
    client_parent_variant = client.scene.add_frame("/parent", show_axes=True)
    client_child = client.scene.add_icosphere("/parent/mine", radius=0.1)

    client_parent_variant.remove()

    assert client_child._impl.removed  # Same-scope cascade.
    assert not server_child._impl.removed  # Other scope untouched.
    assert "/parent" in server.scene._handle_from_node_name


def test_remove_messages_enumerate_descendants(server: viser.ViserServer) -> None:
    """The frontend does not recurse on removes; the server must enumerate
    one RemoveSceneNodeMessage per same-scope descendant."""
    parent = server.scene.add_frame("/p", show_axes=False)
    server.scene.add_icosphere("/p/a", radius=0.1)
    server.scene.add_icosphere("/p/a/b", radius=0.1)

    parent.remove()

    # After GC/redundancy, creates are gone; a remove tombstone per name.
    removed_names = {
        msg.name
        for msg in broadcast_messages(server)
        if isinstance(msg, m.RemoveSceneNodeMessage)
    }
    assert {"/p", "/p/a", "/p/a/b"} <= removed_names


# ---------------------------------------------------------------------------
# World axes.
# ---------------------------------------------------------------------------


def test_client_scene_construction_sends_nothing(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 0)
    assert len(client_buffer_messages(client)) == 0, (
        "client SceneApi construction queued messages; it must not re-add "
        "/WorldAxes (or anything else) over the per-client connection"
    )
    assert "/WorldAxes" not in client.scene._handle_from_node_name


def test_client_world_axes_property_raises(server: viser.ViserServer) -> None:
    client = make_synthetic_client(server, 0)
    with pytest.raises(AttributeError, match="server.scene.world_axes"):
        _ = client.scene.world_axes
    # The sanctioned per-client override: a client-scoped "/WorldAxes" frame
    # (shadows the server's variant on that client's frontend).
    override = client.scene.add_frame("/WorldAxes", show_axes=True)
    assert not override._impl.removed
    assert not server.scene.world_axes._impl.removed


def test_reset_world_axes_skip_is_broadcast_only(server: viser.ViserServer) -> None:
    """Regression: reset()'s "/WorldAxes" carve-out protects the broadcast
    scope's default handle only -- a client-scoped override is an ordinary
    per-client node and must reset away with everything else."""
    client = make_synthetic_client(server, 0)
    override = client.scene.add_frame("/WorldAxes", show_axes=True)

    client.scene.reset()
    assert override._impl.removed
    assert "/WorldAxes" not in client.scene._handle_from_node_name

    server.scene.reset()
    assert not server.scene.world_axes._impl.removed


def test_stamped_messages_roundtrip_through_serialization(
    server: viser.ViserServer,
) -> None:
    """Regression: the owner/virtual stamps are non-init dataclass fields,
    which (a) vars()-based serialization silently omitted until first
    assignment and (b) ``Message.deserialize`` choked on (they aren't
    ``__init__`` parameters). The public serialize -> deserialize round trip
    must stay lossless, stamps included."""
    import msgspec

    from viser.infra import Message

    client = make_synthetic_client(server, 3)
    client.scene.add_frame("/rt/leaf", show_axes=False)  # Anchor + real node.

    messages = client_buffer_messages(client)
    assert len(messages) > 0
    for msg in messages:
        serialized = msg.as_serializable_dict()
        # The stamps are always on the wire (the generated TypeScript
        # declares them as required fields).
        assert serialized["owner"] == "3"
        if hasattr(msg, "virtual"):
            assert "virtual" in serialized

        decoded = Message.deserialize(msgspec.msgpack.encode(serialized))
        assert type(decoded) is type(msg)
        assert decoded.owner == msg.owner  # type: ignore[attr-defined]
        if hasattr(msg, "virtual"):
            assert decoded.virtual == msg.virtual  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Dead-client writes. (Cross-scope GUI container tests live in
# tests/test_gui_cross_scope.py.)
# ---------------------------------------------------------------------------


def test_dead_connection_write_warns_once(server: viser.ViserServer) -> None:
    """Writes through handles owned by a disconnected client warn exactly
    once per connection, instead of accumulating silently forever."""
    import warnings as warnings_module

    client = make_synthetic_client(server, 0)
    handle = client.scene.add_icosphere("/mine", radius=0.1)

    # Simulate the disconnect teardown's buffer shutdown.
    client._websock_connection._state.message_buffer.set_done()

    with warnings_module.catch_warnings(record=True) as caught:
        warnings_module.simplefilter("always")
        handle.position = (1.0, 0.0, 0.0)
        handle.position = (2.0, 0.0, 0.0)  # Second write: no second warning.
    dead_warnings = [w for w in caught if "closed connection" in str(w.message)]
    assert len(dead_warnings) == 1

    # Removal messages are exempt: releasing a departed client's elements
    # (e.g. inside on_client_disconnect, which runs after the buffer is
    # closed) is ordinary cleanup, not a leak in the making. The click
    # callback matters: remove() then also emits empty interaction-bindings
    # messages (not lifecycle_phase="remove"), which must be covered by the
    # same exemption.
    client2 = make_synthetic_client(server, 1)
    handle2 = client2.scene.add_icosphere("/theirs", radius=0.1)
    handle2.on_click(lambda _: None)
    client2._websock_connection._state.message_buffer.set_done()
    with warnings_module.catch_warnings(record=True) as caught:
        warnings_module.simplefilter("always")
        handle2.remove()
    assert not any("closed connection" in str(w.message) for w in caught)
