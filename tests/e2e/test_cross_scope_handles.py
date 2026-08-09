"""E2E tests for cross-scope (server vs. client handle) scene/GUI semantics.

Scene and GUI elements can be added through two scopes: ``server.scene`` /
``server.gui`` (broadcast, persistent buffer, replayed to late joiners) and
``client.scene`` / ``client.gui`` (one connection, ephemeral buffer). The
frontend merges both scopes into single stores -- the scene tree is keyed by
user-chosen node name with no record of which scope created an entry -- while
the Python side keeps disjoint per-scope registries and buffers.

This suite pins that seam from both directions:

- **Contract tests** lock in cross-scope behavior that any future redesign
  must preserve: per-client namespace isolation, the ephemeral lifecycle of
  client-scoped elements across reconnects, and the deliberate cross-scope
  exclusivity of scene pointer callbacks.

- **Rule tests** cover the cross-scope name discipline enforced by the
  server-wide ``SceneNameIndex``: overlapping-scope name reuse is rejected
  at the add site, a child's audience must be a subset of its parent's,
  broadcast removals cascade into per-client subtrees (Python handles
  included, matching the frontend's name-keyed cascade), and disconnects
  free a client's names. Fast Python-level coverage of the same rules lives
  in ``tests/test_scene_name_index.py``; here they run against a real
  browser so the frontend-observable halves (node state, click dispatch,
  world-axes overrides) are exercised too.
"""

from __future__ import annotations

import threading
import time
from typing import Generator

import pytest
from playwright.sync_api import Browser, Page

import viser
import viser._client_autobuild

from .utils import (
    canvas_center,
    find_free_port,
    wait_for_connection,
    wait_for_scene_node,
    wait_for_scene_node_hidden,
    wait_for_scene_node_removed,
    wait_for_scene_node_visible,
    wait_for_server_ready,
)

JS_GET_NODE_POSITION = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return null;
    const obj = m.nodeRefFromName[nodeName];
    if (!obj) return null;
    return [obj.position.x, obj.position.y, obj.position.z];
}
"""


def get_client_handle(
    server: viser.ViserServer, expected_count: int = 1, timeout: float = 10.0
) -> viser.ClientHandle:
    """Wait until ``expected_count`` clients are registered, return the newest.

    Client handles register on the first camera message, which can trail
    the websocket handshake that ``wait_for_connection`` observes.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        clients = server.get_clients()
        if len(clients) >= expected_count:
            return clients[max(clients.keys())]
        time.sleep(0.05)
    raise TimeoutError(
        f"Expected {expected_count} connected client(s) within {timeout}s."
    )


def wait_for_node_position(
    page: Page,
    node_name: str,
    position: tuple[float, float, float],
    timeout: int = 5_000,
) -> None:
    """Wait until a node's three.js local position matches ``position``."""
    page.wait_for_function(
        """([nodeName, expected]) => {
            const m = window.__viserMutable;
            if (!m || !m.nodeRefFromName) return false;
            const obj = m.nodeRefFromName[nodeName];
            if (!obj) return false;
            const p = obj.position;
            return (
                Math.abs(p.x - expected[0]) < 1e-4 &&
                Math.abs(p.y - expected[1]) < 1e-4 &&
                Math.abs(p.z - expected[2]) < 1e-4
            );
        }""",
        arg=[node_name, list(position)],
        timeout=timeout,
    )


@pytest.fixture()
def two_client_setup(browser: Browser) -> Generator[dict, None, None]:
    """A viser server with two connected pages and their client handles."""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())

    context1 = browser.new_context()
    page1 = context1.new_page()
    wait_for_connection(page1, server.get_port())
    client1 = get_client_handle(server, expected_count=1)

    context2 = browser.new_context()
    page2 = context2.new_page()
    wait_for_connection(page2, server.get_port())
    client2 = get_client_handle(server, expected_count=2)
    assert client2.client_id != client1.client_id

    yield {
        "server": server,
        "page1": page1,
        "page2": page2,
        "client1": client1,
        "client2": client2,
    }

    context1.close()
    context2.close()
    server.stop()


# ---------------------------------------------------------------------------
# Contract tests: cross-scope behavior that must be preserved.
# ---------------------------------------------------------------------------


def test_per_client_namespaces_are_isolated(two_client_setup: dict) -> None:
    """Elements added via one client handle must not appear for other clients."""
    page1: Page = two_client_setup["page1"]
    page2: Page = two_client_setup["page2"]
    client1: viser.ClientHandle = two_client_setup["client1"]
    client2: viser.ClientHandle = two_client_setup["client2"]

    client1.scene.add_icosphere("/only_c1", radius=0.3)
    client2.scene.add_icosphere("/only_c2", radius=0.3)

    wait_for_scene_node(page1, "/only_c1")
    wait_for_scene_node(page2, "/only_c2")

    # Poll a little to let any (incorrect) cross-delivery land, then assert
    # isolation.
    time.sleep(0.5)
    assert page1.evaluate(
        "() => window.__viserSceneTree.getState()['/only_c2'] === undefined"
    )
    assert page2.evaluate(
        "() => window.__viserSceneTree.getState()['/only_c1'] === undefined"
    )


def test_same_name_coexists_across_different_clients(two_client_setup: dict) -> None:
    """Two clients may each own a node with the SAME name, with independent
    state. Any single-namespace redesign must key identity by (audience,
    name), not name alone, to keep this working."""
    page1: Page = two_client_setup["page1"]
    page2: Page = two_client_setup["page2"]
    client1: viser.ClientHandle = two_client_setup["client1"]
    client2: viser.ClientHandle = two_client_setup["client2"]

    client1.scene.add_icosphere("/own", radius=0.3, position=(1.0, 0.0, 0.0))
    client2.scene.add_icosphere("/own", radius=0.3, position=(0.0, 2.0, 0.0))

    wait_for_node_position(page1, "/own", (1.0, 0.0, 0.0))
    wait_for_node_position(page2, "/own", (0.0, 2.0, 0.0))


def test_client_scope_elements_do_not_survive_reconnect(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Server-scoped elements are replayed after a reconnect; client-scoped
    elements are not (the per-client buffer is ephemeral and the reconnected
    browser is a brand-new ClientHandle). This is the documented contract --
    client state is ephemeral, rebuilt in on_client_connect; durable state
    lives client-side or in application code (see the ClientHandle
    docstring). The server never retains per-client element state."""
    client = get_client_handle(viser_server)

    viser_server.scene.add_box("/shared_box", dimensions=(1.0, 1.0, 1.0))
    client.scene.add_icosphere("/client_sphere", radius=0.3)
    wait_for_scene_node(viser_page, "/shared_box")
    wait_for_scene_node(viser_page, "/client_sphere")

    viser_server._websock_server.disconnect_all_clients()

    # The frontend reconnects automatically, resets its stores, and replays
    # the broadcast backlog.
    wait_for_scene_node_removed(viser_page, "/client_sphere")
    wait_for_scene_node(viser_page, "/shared_box", timeout=15_000)
    time.sleep(0.5)
    assert viser_page.evaluate(
        "() => window.__viserSceneTree.getState()['/client_sphere'] === undefined"
    ), "client-scoped node unexpectedly survived (or was replayed after) reconnect"


def test_scene_pointer_callbacks_are_cross_scope_exclusive(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Scene pointer callbacks (scene-level on_click) enforce cross-scope
    exclusivity: registering on the server scope tears down every client
    scope's registrations, and vice versa. This is a deliberate workaround
    for the shared client-side enable toggle -- pin it so the
    action-at-a-distance stays visible."""
    client = get_client_handle(viser_server)

    @client.scene.on_click()
    def _(_event: viser.SceneClickEvent) -> None:
        pass

    assert len(client.scene._scene_pointer_cb) == 1

    @viser_server.scene.on_click()
    def _(_event: viser.SceneClickEvent) -> None:
        pass

    # Server-scope registration reached into the client scope and removed
    # its callback.
    assert len(viser_server.scene._scene_pointer_cb) == 1
    assert len(client.scene._scene_pointer_cb) == 0

    # And the reverse: a client-scope registration tears down the server's.
    @client.scene.on_click()
    def _(_event: viser.SceneClickEvent) -> None:
        pass

    assert len(client.scene._scene_pointer_cb) == 1
    assert len(viser_server.scene._scene_pointer_cb) == 0


def test_gui_container_context_does_not_span_scopes(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A ``with server.gui.add_folder(...)`` block does NOT capture elements
    added through a client handle's GuiApi: the container context is
    per-GuiApi-instance, so the button silently lands at the client's root.
    Characterization -- if cross-scope nesting is ever supported (or made an
    error), this should change deliberately."""
    client = get_client_handle(viser_server)

    with viser_server.gui.add_folder("SrvFolder"):
        stray = client.gui.add_button("StrayBtn")

    assert stray._impl.parent_container_id == "root"

    # The button still renders for the client (at the root, not the folder).
    button = viser_page.get_by_role("button", name="StrayBtn")
    button.wait_for(state="visible", timeout=5_000)


# ---------------------------------------------------------------------------
# Cross-scope name rules (enforced by SceneNameIndex).
# ---------------------------------------------------------------------------


def test_cross_scope_same_name_add_raises(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A name claimed by one scope cannot be re-added from an overlapping
    scope: both scopes share one name-keyed scene tree on the frontend, so
    the second add would silently corrupt the first node's state. The add
    raises instead, leaving the existing node untouched."""
    client = get_client_handle(viser_server)

    viser_server.scene.add_icosphere("/dup", radius=0.3, position=(1.0, 2.0, 0.0))
    wait_for_node_position(viser_page, "/dup", (1.0, 2.0, 0.0))

    with pytest.raises(ValueError, match="already used"):
        client.scene.add_icosphere("/dup", radius=0.3, position=(0.0, 0.0, 0.0))

    # The rejected add left no trace: no client-scope registry entry, and the
    # frontend node keeps the server's state.
    assert "/dup" not in client.scene._handle_from_node_name
    time.sleep(0.3)
    wait_for_node_position(viser_page, "/dup", (1.0, 2.0, 0.0))

    # And the reverse direction: a client-owned name rejects a broadcast add.
    client.scene.add_icosphere("/own", radius=0.3)
    wait_for_scene_node(viser_page, "/own")
    with pytest.raises(ValueError, match="already used"):
        viser_server.scene.add_icosphere("/own", radius=0.3)


def test_click_dispatches_to_single_scope(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """One physical click reaches exactly one scope's callbacks. (Before the
    name index, a cross-scope name collision made one click fire BOTH
    scopes' handlers; collisions are now rejected at the add site, so
    dispatch is unique by construction.)"""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)
    client = get_client_handle(viser_server)

    server_clicks: list[int] = []
    server_clicked = threading.Event()

    server_box = viser_server.scene.add_box(
        "/dup_click", dimensions=(4.0, 4.0, 0.2), color=(200, 60, 60)
    )

    @server_box.on_click
    def _(_event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        server_clicks.append(1)
        server_clicked.set()

    # The conflicting client-scoped twin is rejected...
    with pytest.raises(ValueError, match="already used"):
        client.scene.add_box(
            "/dup_click", dimensions=(4.0, 4.0, 0.2), color=(60, 200, 60)
        )

    wait_for_scene_node(viser_page, "/dup_click")
    time.sleep(0.5)  # Let click bindings reach the frontend.

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.up()

    # ...and the click reaches the server-scoped handle exactly once.
    assert server_clicked.wait(5.0), "click did not reach the server-scoped handle"
    time.sleep(0.5)
    assert len(server_clicks) == 1


def test_broadcast_remove_invalidates_client_scope_child(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Removing a server-scoped parent invalidates a client-scoped child
    handle parented under it: the frontend's name-keyed cascade already
    deleted the child node, so the Python handle must not stay live."""
    client = get_client_handle(viser_server)

    parent = viser_server.scene.add_frame("/parent", show_axes=False)
    child = client.scene.add_icosphere("/parent/child", radius=0.3)
    wait_for_scene_node(viser_page, "/parent/child")

    # The client scope did not re-create the broadcast parent for itself.
    assert "/parent" not in client.scene._handle_from_node_name

    parent.remove()

    # The frontend cascade removes the client-scoped child...
    wait_for_scene_node_removed(viser_page, "/parent/child")
    # ...and the Python handle agrees; later writes fail loudly.
    assert child._impl.removed, (
        "client-scoped child handle still live after its node was removed "
        "by a broadcast cascade"
    )
    with pytest.raises(RuntimeError, match="removed"):
        child.position = (1.0, 0.0, 0.0)


def test_client_parent_rejects_broadcast_child(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A child's audience must be a subset of its parent's: a broadcast
    child under a per-client parent would dangle for every other viewer."""
    client = get_client_handle(viser_server)

    client.scene.add_frame("/client_parent", show_axes=False)
    wait_for_scene_node(viser_page, "/client_parent")

    with pytest.raises(ValueError, match="audience"):
        viser_server.scene.add_icosphere("/client_parent/child", radius=0.3)


def test_disconnect_frees_client_names(browser: Browser) -> None:
    """A disconnect releases the client's name claims, so the names become
    available to other scopes again."""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())

    context = browser.new_context()
    page = context.new_page()
    wait_for_connection(page, server.get_port())
    client = get_client_handle(server)

    client.scene.add_icosphere("/mine", radius=0.3)
    with pytest.raises(ValueError, match="already used"):
        server.scene.add_icosphere("/mine", radius=0.3)

    context.close()
    deadline = time.monotonic() + 10.0
    while server.get_clients() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not server.get_clients(), "client never disconnected"

    server.scene.add_icosphere("/mine", radius=0.3)
    server.stop()


def test_world_axes_toggle_reaches_connected_client(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """server.scene.world_axes is the only world-axes handle (client scopes
    have none -- accessing client.scene.world_axes raises), and its toggles
    reach an already-connected client in both directions."""
    client = get_client_handle(viser_server)
    with pytest.raises(AttributeError, match="server.scene.world_axes"):
        _ = client.scene.world_axes

    viser_server.scene.world_axes.visible = True
    wait_for_scene_node_visible(viser_page, "/WorldAxes")

    viser_server.scene.world_axes.visible = False
    wait_for_scene_node_hidden(viser_page, "/WorldAxes")


def test_world_axes_server_state_deterministic_for_new_client(
    browser: Browser,
) -> None:
    """A client connecting after the server showed the world axes sees them
    visible. (Previously each ClientHandle re-added /WorldAxes with
    visible=False over the per-client connection, racing the broadcast
    replay -- the axes' state at connect was nondeterministic.)"""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())

    server.scene.world_axes.visible = True

    context = browser.new_context()
    page = context.new_page()
    wait_for_connection(page, server.get_port())
    wait_for_scene_node_visible(page, "/WorldAxes")

    context.close()
    server.stop()
