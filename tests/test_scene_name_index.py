"""Tests for cross-scope scene-node name handling.

Scene-node names share one namespace per viewer: the frontend's scene tree is
keyed by name with no notion of which scope (``server.scene`` vs. a
``client.scene``) created a node. ``SceneNameIndex`` is the server-wide
structure that sees every scope's claims and enforces:

1. No overlapping-scope name reuse (broadcast overlaps every client scope;
   two different client scopes never overlap).
2. A child's audience must be a subset of its parent's.

Covers the index in isolation, plus the integrated behavior on a headless
``ViserServer`` with synthetic in-process client connections (no browser; the
e2e side lives in ``tests/e2e/test_cross_scope_handles.py``).
"""

from __future__ import annotations

import asyncio
from typing import cast

import pytest

import viser
import viser._client_autobuild
from viser._scene_name_index import SceneNameIndex
from viser._viser import ClientHandle
from viser.infra import ClientId
from viser.infra._async_message_buffer import AsyncMessageBuffer
from viser.infra._infra import WebsockClientConnection, _ClientHandleState

# ---------------------------------------------------------------------------
# SceneNameIndex in isolation.
# ---------------------------------------------------------------------------

_API_A = object()  # Stand-ins; the index never calls into these.
_API_B = object()


def test_index_broadcast_vs_client_conflicts() -> None:
    index = SceneNameIndex()
    index.commit("/x", None, _API_A)  # type: ignore[arg-type]

    # Broadcast /x conflicts with any client's /x, both directions.
    with pytest.raises(ValueError, match="already used"):
        index.check_claimable("/x", cast(ClientId, 0))

    index2 = SceneNameIndex()
    index2.commit("/x", cast(ClientId, 0), _API_A)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="already used"):
        index2.check_claimable("/x", None)


def test_index_same_scope_and_disjoint_clients_allowed() -> None:
    index = SceneNameIndex()
    index.commit("/x", cast(ClientId, 0), _API_A)  # type: ignore[arg-type]

    # Same scope: allowed (supersede path).
    index.check_claimable("/x", cast(ClientId, 0))
    # A different client: allowed (audiences never meet).
    index.check_claimable("/x", cast(ClientId, 1))

    index2 = SceneNameIndex()
    index2.commit("/x", None, _API_A)  # type: ignore[arg-type]
    index2.check_claimable("/x", None)


def test_index_parent_audience_subset_rule() -> None:
    index = SceneNameIndex()
    index.commit("/bcast", None, _API_A)  # type: ignore[arg-type]
    index.commit("/client0", cast(ClientId, 0), _API_B)  # type: ignore[arg-type]

    # Broadcast parent covers every child scope.
    index.check_claimable("/bcast/child", None)
    index.check_claimable("/bcast/child", cast(ClientId, 0))

    # Client parent covers only its own scope.
    index.check_claimable("/client0/child", cast(ClientId, 0))
    with pytest.raises(ValueError, match="audience"):
        index.check_claimable("/client0/child", None)
    with pytest.raises(ValueError, match="audience"):
        index.check_claimable("/client0/child", cast(ClientId, 1))

    # Unclaimed parents are unchecked (nodes may be added under parents that
    # don't exist yet).
    index.check_claimable("/nowhere/child", None)
    index.check_claimable("/nowhere/child", cast(ClientId, 1))


def test_index_release_and_drop_scope() -> None:
    index = SceneNameIndex()
    index.commit("/x", None, _API_A)  # type: ignore[arg-type]
    index.commit("/y", cast(ClientId, 0), _API_A)  # type: ignore[arg-type]
    index.commit("/z", cast(ClientId, 0), _API_A)  # type: ignore[arg-type]

    index.release("/x", None)
    index.check_claimable("/x", cast(ClientId, 0))  # Freed.
    index.release("/x", None)  # Idempotent.

    index.drop_scope(cast(ClientId, 0))
    index.check_claimable("/y", None)  # Freed.
    index.check_claimable("/z", None)  # Freed.


def test_index_exists_visible() -> None:
    index = SceneNameIndex()
    index.commit("/bcast", None, _API_A)  # type: ignore[arg-type]
    index.commit("/mine", cast(ClientId, 0), _API_B)  # type: ignore[arg-type]

    # Broadcast nodes are visible to every scope.
    assert index.exists_visible("/bcast", None)
    assert index.exists_visible("/bcast", cast(ClientId, 0))
    # Client nodes are visible only within their own scope.
    assert index.exists_visible("/mine", cast(ClientId, 0))
    assert not index.exists_visible("/mine", None)
    assert not index.exists_visible("/mine", cast(ClientId, 1))
    assert not index.exists_visible("/absent", None)


def test_index_foreign_descendants() -> None:
    index = SceneNameIndex()
    index.commit("/a", None, _API_A)  # type: ignore[arg-type]
    index.commit("/a/own", None, _API_A)  # type: ignore[arg-type]
    index.commit("/a/c0", cast(ClientId, 0), _API_B)  # type: ignore[arg-type]
    index.commit("/a/c0/deep", cast(ClientId, 0), _API_B)  # type: ignore[arg-type]
    index.commit("/aa", cast(ClientId, 0), _API_B)  # type: ignore[arg-type]

    foreign = index.foreign_descendants("/a", None)
    names = sorted(name for _, name in foreign)
    # Own-scope descendants and prefix-similar names (/aa) are excluded.
    assert names == ["/a/c0", "/a/c0/deep"]


# ---------------------------------------------------------------------------
# Integrated behavior on a headless server + synthetic clients.
# ---------------------------------------------------------------------------


@pytest.fixture()
def server() -> viser.ViserServer:
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server = viser.ViserServer(port=0, verbose=False)
    yield server
    server.stop()


def _make_synthetic_client(server: viser.ViserServer, client_id: int) -> ClientHandle:
    """In-process ClientHandle with a real per-client message buffer but no
    websocket (mirrors how WebsockServer builds per-client state; same
    pattern as tests/test_panel.py). Buffer construction hops to the server's
    loop thread because AsyncMessageBuffer's asyncio primitives bind to the
    running loop."""

    async def _make_buffer() -> AsyncMessageBuffer:
        return AsyncMessageBuffer(server._event_loop, persistent_messages=False)

    buffer = asyncio.run_coroutine_threadsafe(
        _make_buffer(), server._event_loop
    ).result(timeout=5.0)
    conn = WebsockClientConnection(
        client_id, _ClientHandleState(buffer, server._event_loop)
    )
    return ClientHandle(conn, server)


def test_cross_scope_same_name_raises_both_directions(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)

    server.scene.add_icosphere("/dup", radius=0.1)
    with pytest.raises(ValueError, match="already used"):
        client.scene.add_icosphere("/dup", radius=0.1)
    # The rejected add left no trace in the client scope.
    assert "/dup" not in client.scene._handle_from_node_name

    client.scene.add_icosphere("/own", radius=0.1)
    with pytest.raises(ValueError, match="already used"):
        server.scene.add_icosphere("/own", radius=0.1)
    assert "/own" not in server.scene._handle_from_node_name


def test_same_name_across_clients_coexists(server: viser.ViserServer) -> None:
    client0 = _make_synthetic_client(server, 0)
    client1 = _make_synthetic_client(server, 1)

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


def test_client_child_under_broadcast_parent(server: viser.ViserServer) -> None:
    client = _make_synthetic_client(server, 0)

    server.scene.add_frame("/parent", show_axes=False)
    child = client.scene.add_icosphere("/parent/child", radius=0.1)

    # The client scope did NOT re-create the broadcast parent (the frontend
    # keys nodes by name; a duplicate parent add would clobber the shared
    # node for this client).
    assert "/parent" not in client.scene._handle_from_node_name
    assert "/parent/child" in client.scene._handle_from_node_name
    assert not child._impl.removed


def test_broadcast_child_under_client_parent_raises(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)

    client.scene.add_frame("/cp", show_axes=False)
    with pytest.raises(ValueError, match="audience"):
        server.scene.add_icosphere("/cp/child", radius=0.1)
    with pytest.raises(ValueError, match="audience"):
        _make_synthetic_client(server, 1).scene.add_icosphere("/cp/child", radius=0.1)


def test_broadcast_remove_cascades_into_client_scope(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)

    parent = server.scene.add_frame("/parent", show_axes=False)
    child = client.scene.add_icosphere("/parent/child", radius=0.1)
    grandchild = client.scene.add_icosphere("/parent/child/deep", radius=0.1)

    parent.remove()

    # The whole client-scope subtree is invalidated, matching the frontend's
    # name-keyed cascade.
    assert child._impl.removed
    assert grandchild._impl.removed
    assert "/parent/child" not in client.scene._handle_from_node_name
    # Writes to the dead handles fail loudly instead of silently targeting a
    # nonexistent node.
    with pytest.raises(RuntimeError, match="removed"):
        child.position = (1.0, 0.0, 0.0)
    # The names are free again, in any scope.
    server.scene.add_icosphere("/parent/child", radius=0.1)


def test_transform_controls_cascade_cleans_registry(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)

    parent = server.scene.add_frame("/parent", show_axes=False)
    tc = client.scene.add_transform_controls("/parent/gizmo")
    assert "/parent/gizmo" in client.scene._handle_from_transform_controls_name

    parent.remove()

    assert tc._impl.removed
    assert "/parent/gizmo" not in client.scene._handle_from_transform_controls_name


def test_client_remove_does_not_touch_broadcast_siblings(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)

    server.scene.add_frame("/parent", show_axes=False)
    server_child = server.scene.add_icosphere("/parent/shared", radius=0.1)
    client_child = client.scene.add_icosphere("/parent/mine", radius=0.1)

    client_child.remove()

    assert client_child._impl.removed
    assert not server_child._impl.removed
    assert "/parent" in server.scene._handle_from_node_name


def test_disconnect_frees_client_names(server: viser.ViserServer) -> None:
    client = _make_synthetic_client(server, 0)
    client.scene.add_icosphere("/mine", radius=0.1)

    with pytest.raises(ValueError, match="already used"):
        server.scene.add_icosphere("/mine", radius=0.1)

    # Simulate the disconnect teardown's index cleanup.
    with server._scene_lifecycle_lock:
        server._scene_name_index.drop_scope(cast(ClientId, 0))

    server.scene.add_icosphere("/mine", radius=0.1)


def test_server_reset_cascades_client_subtrees_only(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)

    server.scene.add_frame("/shared", show_axes=False)
    nested = client.scene.add_icosphere("/shared/mine", radius=0.1)
    top_level = client.scene.add_icosphere("/standalone", radius=0.1)

    server.scene.reset()

    # Client nodes under broadcast parents die with them; top-level client
    # nodes are untouched (reset is scoped to the caller's own elements).
    assert nested._impl.removed
    assert not top_level._impl.removed


# ---------------------------------------------------------------------------
# World axes (server-owned; no client-scope handle).
# ---------------------------------------------------------------------------


def test_client_scene_construction_sends_nothing(
    server: viser.ViserServer,
) -> None:
    client = _make_synthetic_client(server, 0)
    buffer = client._websock_connection._state.message_buffer
    assert len(buffer.message_from_id) == 0, (
        "client SceneApi construction queued messages; it must not re-add "
        "/WorldAxes (or anything else) over the per-client connection"
    )
    assert "/WorldAxes" not in client.scene._handle_from_node_name


def test_client_world_axes_raises_with_pointer_to_server(
    server: viser.ViserServer,
) -> None:
    """The world axes are one shared broadcast node; there is no per-client
    handle for them. The error message points at server.scene.world_axes."""
    client = _make_synthetic_client(server, 0)
    with pytest.raises(AttributeError, match="server.scene.world_axes"):
        _ = client.scene.world_axes
    # The server-side handle is unaffected.
    server.scene.world_axes.visible = True
    assert server.scene.world_axes.visible


def test_client_add_world_axes_name_raises(server: viser.ViserServer) -> None:
    client = _make_synthetic_client(server, 0)
    with pytest.raises(ValueError, match="already used"):
        client.scene.add_frame("/WorldAxes")
