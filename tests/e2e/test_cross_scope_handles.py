"""E2E tests for cross-scope (server vs. client handle) scene/GUI semantics.

Scene and GUI elements can be created through two scopes: ``server.scene`` /
``server.gui`` (broadcast, persistent) and ``client.scene`` / ``client.gui``
(one connection, ephemeral). Scene nodes are identified by (owner, name):
each scene-tree name holds at most one variant per scope, fed independently
by its scope's messages, and the client renders the effective variant chosen
by the display rule (real client > real broadcast > virtual client > virtual
broadcast).

This suite pins that seam from both directions:

- **Contract tests** lock in cross-scope behavior that any future redesign
  must preserve: per-client namespace isolation, the ephemeral lifecycle of
  client-scoped elements across reconnects, and scene pointer callback
  coexistence (both scopes may register; a gesture matching both scopes'
  filters fires both scopes' callbacks; one scope's disable never
  deactivates the other's).

- **Variant/shadowing tests** cover the display rule end to end: a client
  variant shadows the server's and un-shadows with the server's LATEST
  state, clicks dispatch to exactly the effective variant's scope, removal
  cascades are scope-local (client children survive broadcast parent
  removal, anchored at the parent's frozen pose), and virtual anchors never
  shadow real nodes. Fast Python-side coverage of the same rules lives in
  ``tests/test_scene_scopes.py``; the frontend store logic is unit-tested in
  ``src/viser/client/src/SceneTreeState.test.ts``.
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
    get_client_handle,
    wait_for_connection,
    wait_for_scene_node,
    wait_for_scene_node_hidden,
    wait_for_scene_node_removed,
    wait_for_scene_node_visible,
    wait_for_server_ready,
)

JS_GET_EFFECTIVE_OWNER = """
(nodeName) => {
    const tree = window.__viserSceneTree;
    if (!tree) return null;
    const node = tree.getState()[nodeName];
    if (!node) return null;
    return node.message.owner ?? "";
}
"""


def wait_for_node_position(
    page: Page,
    node_name: str,
    position: tuple[float, float, float],
    timeout: int = 10_000,
) -> None:
    """Wait until a node's latest wire pose matches ``position``.

    Observes ``nodePoseData`` (written synchronously when the message is
    handled), NOT the mounted three.js object: the object's position is
    applied by a ``useFrame`` hook and needs requestAnimationFrame ticks,
    which stall for seconds under CI's software-GL + xdist contention (the
    only repeated CI failures in this suite were exactly that stall). The
    applier path is covered by the visual/pixel tests."""
    wait_for_scene_node(page, node_name, timeout=timeout)  # Delivery proof.
    page.wait_for_function(
        """([nodeName, expected]) => {
            const pose = window.__viserMutable?.nodePoseData?.[nodeName];
            if (!pose) return false;
            const p = pose.position;
            return (
                Math.abs(p[0] - expected[0]) < 1e-4 &&
                Math.abs(p[1] - expected[1]) < 1e-4 &&
                Math.abs(p[2] - expected[2]) < 1e-4
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

    for context in (context1, context2):
        try:
            context.close()
        except Exception:
            pass  # A test may have closed it already (disconnect tests).
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
    state."""
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
    browser is a brand-new ClientHandle). This includes shadowing variants:
    after a reconnect, the server's variant of a previously-shadowed name is
    the one shown."""
    client = get_client_handle(viser_server)

    viser_server.scene.add_box(
        "/shared_box", dimensions=(1.0, 1.0, 1.0), position=(2.0, 0.0, 0.0)
    )
    client.scene.add_icosphere("/client_sphere", radius=0.3)
    # A client variant shadowing a server name. Wait on the EFFECTIVE OWNER
    # flipping to the client -- a (0, 0, 0) pose wait would pass vacuously on
    # the store's freshly-initialized default pose before the shadowing add
    # has even been processed.
    client.scene.add_box("/shared_box", dimensions=(0.5, 0.5, 0.5))
    wait_for_scene_node(viser_page, "/client_sphere")
    viser_page.wait_for_function(
        f"() => ({JS_GET_EFFECTIVE_OWNER})('/shared_box') === '{client.client_id}'",
        timeout=10_000,
    )

    viser_server._websock_server.disconnect_all_clients()

    # The frontend reconnects automatically, resets its stores, and replays
    # the broadcast backlog: the client sphere is gone, and the server's
    # variant of /shared_box (at ITS position) is effective again.
    wait_for_scene_node_removed(viser_page, "/client_sphere")
    wait_for_node_position(viser_page, "/shared_box", (2.0, 0.0, 0.0), timeout=15_000)
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/shared_box") == ""


def test_scene_pointer_callbacks_coexist_across_scopes(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Scene pointer callbacks coexist across scopes: filters are kept per
    owner on the frontend and gesture engagement uses the union, so both
    scopes' registrations fire on one physical click and one scope's
    disable never deactivates the other's. (This replaced the interim
    cross-scope exclusivity rule.)"""
    client = get_client_handle(viser_server)

    server_clicked = threading.Event()
    client_clicked = threading.Event()

    @client.scene.on_click()
    def _(_event: viser.SceneClickEvent) -> None:
        client_clicked.set()

    @viser_server.scene.on_click()
    def _(_event: viser.SceneClickEvent) -> None:
        server_clicked.set()

    # Registration in one scope leaves the other's callbacks alone.
    assert len(viser_server.scene._scene_pointer_cb) == 1
    assert len(client.scene._scene_pointer_cb) == 1

    time.sleep(0.5)  # Let both enable messages reach the frontend.
    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.up()

    # One physical click, both scopes' callbacks.
    assert server_clicked.wait(5.0), "server-scope scene click did not fire"
    assert client_clicked.wait(5.0), "client-scope scene click did not fire"

    # One scope disabling its filters must not deactivate the other's: after
    # the client scope clears, a click still reaches the server callback.
    client.scene.remove_click_callback()
    server_clicked.clear()
    client_clicked.clear()
    time.sleep(0.5)  # Let the disable reach the frontend.
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.up()
    assert server_clicked.wait(5.0), (
        "server-scope scene click stopped firing after the client scope "
        "cleared its own filters"
    )
    time.sleep(0.3)
    assert not client_clicked.is_set()


def test_gui_container_nesting_is_directional(two_client_setup: dict) -> None:
    """A ``with server.gui.add_folder(...)`` block CAN capture elements added
    through a client handle's GuiApi: the client element renders inside the
    shared folder for that client only, and dies with the folder. The
    reverse (server element into a client container) raises instead of
    silently landing the element at the other scope's root (the historical
    behavior)."""
    server = two_client_setup["server"]
    page1: Page = two_client_setup["page1"]
    page2: Page = two_client_setup["page2"]
    client1 = two_client_setup["client1"]

    with server.gui.add_folder("SrvFolder") as folder:
        client1.gui.add_button("MineBtn")

    # Client 1 sees its button inside the shared folder; client 2 sees the
    # folder but no button.
    button1 = page1.get_by_role("button", name="MineBtn")
    button1.wait_for(state="visible", timeout=5_000)
    page2.get_by_text("SrvFolder").wait_for(state="visible", timeout=5_000)
    assert page2.get_by_role("button", name="MineBtn").count() == 0

    # DOM containment, not just coexistence: collapsing the folder must hide
    # the client's button; expanding brings it back.
    page1.get_by_text("SrvFolder").click()
    button1.wait_for(state="hidden", timeout=5_000)
    page1.get_by_text("SrvFolder").click()
    button1.wait_for(state="visible", timeout=5_000)

    # Removing the server folder cascades into the cross-nested client
    # element (the one deliberate exception to scope-local removal).
    folder.remove()
    button1.wait_for(state="hidden", timeout=5_000)

    # Outside any server container context, client adds work normally...
    client1.gui.add_button("OkBtn")
    page1.get_by_role("button", name="OkBtn").wait_for(state="visible", timeout=5_000)

    # ...and the reverse nesting direction raises.
    with client1.gui.add_folder("CliFolder"):
        with pytest.raises(RuntimeError, match="not vice versa"):
            server.gui.add_button("StrayBtn")


def test_disconnect_detaches_cross_nested_gui_elements(
    two_client_setup: dict,
) -> None:
    """A real websocket disconnect runs the cross-scope release hook: the
    departed client's elements are detached from the server's container
    tree, so removing the server folder afterwards is warning-free and
    still propagates to the remaining client."""
    import warnings as warnings_module

    server = two_client_setup["server"]
    page1: Page = two_client_setup["page1"]
    page2: Page = two_client_setup["page2"]
    client1 = two_client_setup["client1"]

    with server.gui.add_folder("SrvFolder") as folder:
        client1.gui.add_button("MineBtn")
    page1.get_by_role("button", name="MineBtn").wait_for(state="visible", timeout=5_000)
    page2.get_by_text("SrvFolder").wait_for(state="visible", timeout=5_000)

    # Disconnect client 1 for real and wait for the server-side teardown.
    page1.context.close()
    deadline = time.time() + 5.0
    while client1.client_id in server._connected_clients:
        assert time.time() < deadline, "client 1 never disconnected"
        time.sleep(0.05)

    # The folder's cross-nested child was detached bookkeeping-only, so this
    # removal must not try to message the dead connection.
    with warnings_module.catch_warnings(record=True) as caught:
        warnings_module.simplefilter("always")
        folder.remove()
    assert not any("closed connection" in str(w.message) for w in caught)
    page2.get_by_text("SrvFolder").wait_for(state="hidden", timeout=5_000)


# ---------------------------------------------------------------------------
# Variant slots + display rule (shadowing).
# ---------------------------------------------------------------------------


def test_client_variant_shadows_and_unshadows_with_latest_state(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The core shadowing round trip: a client-scoped add of a server-owned
    name shadows it for that client; server updates keep accumulating in the
    hidden variant; removing the client variant promotes the server's node
    with its LATEST state -- no resurrection round trip."""
    client = get_client_handle(viser_server)

    viser_server.scene.add_icosphere("/dup", radius=0.3, position=(1.0, 2.0, 0.0))
    wait_for_node_position(viser_page, "/dup", (1.0, 2.0, 0.0))

    # Client-scoped variant at the origin: shadows the server's node.
    client_variant = client.scene.add_icosphere(
        "/dup", radius=0.3, position=(0.0, 0.0, 0.0)
    )
    wait_for_node_position(viser_page, "/dup", (0.0, 0.0, 0.0))
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/dup") == str(client.client_id)

    # Server keeps writing while shadowed; the display doesn't budge.
    viser_server.scene._handle_from_node_name["/dup"].position = (3.0, 3.0, 0.0)
    time.sleep(0.5)
    wait_for_node_position(viser_page, "/dup", (0.0, 0.0, 0.0))

    # Un-shadow: the server's variant shows again, at its LATEST position.
    client_variant.remove()
    wait_for_node_position(viser_page, "/dup", (3.0, 3.0, 0.0))
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/dup") == ""


def test_click_dispatches_to_effective_variant_only(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A click on a shadowing client variant reaches the client scope's
    callback and never the shadowed server variant's."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)
    client = get_client_handle(viser_server)

    server_clicked = threading.Event()
    client_clicks: list[int] = []
    client_clicked = threading.Event()

    server_box = viser_server.scene.add_box(
        "/dup_click", dimensions=(4.0, 4.0, 0.2), color=(200, 60, 60)
    )

    @server_box.on_click
    def _(_event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        server_clicked.set()

    client_box = client.scene.add_box(
        "/dup_click", dimensions=(4.0, 4.0, 0.2), color=(60, 200, 60)
    )

    @client_box.on_click
    def _(_event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        client_clicks.append(1)
        client_clicked.set()

    wait_for_scene_node(viser_page, "/dup_click")
    # Wait until the client-scoped variant is the effective one (non-empty
    # owner) before clicking.
    viser_page.wait_for_function(
        """(nodeName) => {
            const tree = window.__viserSceneTree;
            const node = tree && tree.getState()[nodeName];
            return node !== undefined && (node.message.owner ?? "") !== "";
        }""",
        arg="/dup_click",
        timeout=5_000,
    )
    time.sleep(0.5)  # Let click bindings reach the frontend.

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.up()

    assert client_clicked.wait(5.0), "click did not reach the client-scoped handle"
    time.sleep(0.5)
    assert not server_clicked.is_set(), (
        "click dispatched to the shadowed server-scoped handle too"
    )
    assert len(client_clicks) == 1


def test_scope_local_cascade_client_child_survives(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Removing a broadcast parent removes only broadcast descendants: a
    client-scoped child survives, hanging from its own scope's virtual
    anchor, which inherits the departing parent's pose (children don't
    teleport)."""
    client = get_client_handle(viser_server)

    parent = viser_server.scene.add_frame(
        "/parent", show_axes=False, position=(1.0, 0.0, 1.0)
    )
    child = client.scene.add_icosphere("/parent/child", radius=0.3)
    wait_for_scene_node(viser_page, "/parent/child")

    parent.remove()

    # The child's entry survives on the frontend...
    time.sleep(0.5)
    wait_for_scene_node(viser_page, "/parent/child")
    # ...hanging from the client's promoted virtual anchor...
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/parent") == str(
        client.client_id
    )
    # ...which inherited the departed parent's pose (frozen-pose
    # inheritance -- the child stays where it was).
    viser_page.wait_for_function(
        """(expected) => {
            const m = window.__viserMutable;
            const pose = m && m.nodePoseData && m.nodePoseData["/parent"];
            if (!pose) return false;
            return (
                Math.abs(pose.position[0] - expected[0]) < 1e-4 &&
                Math.abs(pose.position[1] - expected[1]) < 1e-4 &&
                Math.abs(pose.position[2] - expected[2]) < 1e-4
            );
        }""",
        arg=[1.0, 0.0, 1.0],
        timeout=5_000,
    )
    # The Python handle is still live; the author removes it explicitly.
    assert not child._impl.removed
    child.remove()
    wait_for_scene_node_removed(viser_page, "/parent/child")


def test_virtual_anchor_does_not_shadow_real_broadcast_node(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A client's auto-created ancestor anchor must not hide the server's
    real node of the same name."""
    client = get_client_handle(viser_server)

    viser_server.scene.add_frame("/anchor_parent", show_axes=True)
    wait_for_scene_node(viser_page, "/anchor_parent")

    # Deep client add auto-creates client-scoped anchors for /anchor_parent.
    client.scene.add_icosphere("/anchor_parent/mine", radius=0.3)
    wait_for_scene_node(viser_page, "/anchor_parent/mine")

    # The server's real frame is still the effective variant.
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/anchor_parent") == ""


def test_broadcast_child_under_client_parent_coexists(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A server add under a client-owned name is legal: the server's chain
    hangs from its own virtual anchor, which is shadowed by the client's
    real node on this client."""
    client = get_client_handle(viser_server)

    client.scene.add_frame("/cp", show_axes=False)
    wait_for_scene_node(viser_page, "/cp")

    viser_server.scene.add_icosphere("/cp/child", radius=0.3)
    wait_for_scene_node(viser_page, "/cp/child")

    # The client's real frame stays effective over the server's virtual
    # anchor for /cp.
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/cp") == str(client.client_id)
    assert viser_page.evaluate(JS_GET_EFFECTIVE_OWNER, "/cp/child") == ""


# ---------------------------------------------------------------------------
# World axes.
# ---------------------------------------------------------------------------


def test_world_axes_client_shadow_override(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The sanctioned per-client world-axes override: a client-scoped
    "/WorldAxes" frame shadows the server's, and removing it restores the
    server's state. (client.scene.world_axes itself raises AttributeError.)"""
    client = get_client_handle(viser_server)
    with pytest.raises(AttributeError, match="server.scene.world_axes"):
        _ = client.scene.world_axes

    viser_server.scene.world_axes.visible = True
    wait_for_scene_node_visible(viser_page, "/WorldAxes")

    override = client.scene.add_frame("/WorldAxes", show_axes=True, visible=False)
    wait_for_scene_node_hidden(viser_page, "/WorldAxes")

    override.remove()
    wait_for_scene_node_visible(viser_page, "/WorldAxes")


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


# ---------------------------------------------------------------------------
# Regression tests: owner routing + per-connection frontend state.
# ---------------------------------------------------------------------------


def _wait_drag_ready(page: Page) -> None:
    """The drag raycasts against the RENDERED scene: wait for the mounted
    mesh (store presence precedes the object existing for the raycaster),
    then for two animation frames (proof the render loop is producing
    frames, so pointer events will be processed). Both lag by seconds under
    CI's software-GL contention."""
    page.wait_for_function(
        "() => window.__viserMutable?.nodeRefFromName?.['/dragme'] != null",
        timeout=15_000,
    )
    page.evaluate(
        """() => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)))"""
    )


def test_drag_end_routes_to_owner_after_mid_drag_removal(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The final drag ``end`` echoes the owner captured at drag START.
    Regression: it was re-derived from the live store per phase, so removing
    the node mid-drag stamped the end with the broadcast owner ("") and the
    client scope's ``on_drag`` end callback never fired."""
    client = get_client_handle(viser_server)
    # Up must be set explicitly: the (0, 0, 4) -> origin view is parallel to
    # the server-default +Z up, and whether the browser's camera sync has
    # already replaced that default is a race.
    client.camera.up_direction = (0.0, 1.0, 0.0)
    client.camera.position = (0.0, 0.0, 4.0)
    client.camera.look_at = (0.0, 0.0, 0.0)

    box = client.scene.add_box("/dragme", dimensions=(4.0, 4.0, 0.2))
    started = threading.Event()
    ended = threading.Event()

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent) -> None:
        if event.phase == "start":
            started.set()
        elif event.phase == "end":
            ended.set()

    _wait_drag_ready(viser_page)
    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 40, steps=10)
    assert started.wait(timeout=5.0), "drag start never reached the client scope"

    # Remove the node MID-DRAG: the frontend synthesizes the end phase, which
    # must still route to the client scope that received the start.
    box.remove()
    assert ended.wait(timeout=5.0), "drag end was misrouted after removal"
    viser_page.mouse.up()


def test_pointer_filters_cleared_on_reconnect(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Per-owner scene-pointer filters are connection-scoped. Regression: an
    IN-PLACE reconnect (worker retry, no page reload) left the previous
    client's filter entry behind forever -- its owner id can never send a
    disable -- keeping click gestures engaged."""
    client = get_client_handle(viser_server)

    @client.scene.on_pointer_event(event_type="click")
    def _(event) -> None:
        pass

    viser_page.wait_for_function(
        "() => window.__viserPointer?.hasSceneClickFilter() === true",
        timeout=5_000,
    )

    # Kick the connection; the page's worker auto-reconnects WITHOUT a
    # reload, so all frontend state survives except what the reconnect
    # path deliberately resets. Nothing re-registers a pointer callback, so
    # no filter may survive -- and since only the reconnect path clears
    # filters, this wait doubles as the reconnect wait.
    viser_server._websock_server.disconnect_all_clients()
    viser_page.wait_for_function(
        "() => window.__viserPointer?.hasSceneClickFilter() === false",
        timeout=10_000,
    )


def test_skinned_mesh_bone_state_is_variant_scoped(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Bone state is keyed per (owner, name) variant. Regression: a single
    name-keyed entry let a shadowed server's bone stream corrupt the
    client's variant, and promotion deleted the promoted variant's state."""
    import numpy as np

    client = get_client_handle(viser_server)

    def add_skinned(scene_api):
        return scene_api.add_mesh_skinned(
            "/skin",
            vertices=np.array(
                [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                dtype=np.float32,
            ),
            faces=np.array([[0, 1, 2]], dtype=np.uint32),
            bone_wxyzs=((1.0, 0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0)),
            bone_positions=((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
            skin_weights=np.array(
                [[1.0, 0.0], [0.5, 0.5], [0.0, 1.0]], dtype=np.float32
            ),
        )

    server_mesh = add_skinned(viser_server.scene)
    wait_for_scene_node(viser_page, "/skin")

    # Client-scoped variant shadows the server's.
    add_skinned(client.scene)
    js_entry = """
    (owner) => {
        const state = window.__viserMutable?.skinnedMeshState;
        if (!state) return null;
        const entry = state[`${owner}\\u0000/skin`];
        return entry ? entry.poses[1].position : null;
    }
    """
    client_owner = str(client.client_id)
    viser_page.wait_for_function(
        f"() => ({js_entry})('') !== null && ({js_entry})('{client_owner}') !== null",
        timeout=10_000,
    )

    # A bone update from the (shadowed) server scope lands in the SERVER
    # variant's entry; the client's stays at its initial pose.
    server_mesh.bones[1].position = (5.0, 6.0, 7.0)
    viser_page.wait_for_function(
        f"() => String(({js_entry})('')) === '5,6,7'",
        timeout=10_000,
    )
    assert viser_page.evaluate(js_entry, client_owner) == [1, 0, 0]

    # Promotion: removing the client variant keeps the server variant's
    # accumulated bone state (entry survives; client entry is dropped).
    client.scene._handle_from_node_name["/skin"].remove()
    viser_page.wait_for_function(
        f"() => ({js_entry})('{client_owner}') === null",
        timeout=10_000,
    )
    assert viser_page.evaluate(js_entry, "") == [5, 6, 7]


def test_disconnect_mid_drag_fires_end_for_client_scope(
    two_client_setup: dict,
) -> None:
    """Regression: the disconnect teardown drained in-flight drags only from
    the server SceneApi, but owner-scoped dispatch routes drags on
    client-scoped nodes to the CLIENT's own scope -- so their synthesized
    ``phase="end"`` (which lets apps release per-drag state) never fired."""
    server = two_client_setup["server"]
    page1: Page = two_client_setup["page1"]
    client1 = two_client_setup["client1"]

    client1.camera.up_direction = (0.0, 1.0, 0.0)
    client1.camera.position = (0.0, 0.0, 4.0)
    client1.camera.look_at = (0.0, 0.0, 0.0)
    box = client1.scene.add_box("/dragme", dimensions=(4.0, 4.0, 0.2))
    started = threading.Event()
    ended = threading.Event()

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent) -> None:
        if event.phase == "start":
            started.set()
        elif event.phase == "end":
            ended.set()

    _wait_drag_ready(page1)
    cx, cy = canvas_center(page1)
    page1.mouse.move(cx, cy)
    page1.mouse.down()
    page1.mouse.move(cx + 80, cy + 40, steps=10)
    assert started.wait(timeout=5.0), "drag start never reached the client scope"

    # Disconnect mid-drag: the wire "end" will never arrive, so the
    # teardown must synthesize it for the CLIENT scope's registry.
    page1.context.close()
    deadline = time.time() + 5.0
    while client1.client_id in server._connected_clients:
        assert time.time() < deadline, "client 1 never disconnected"
        time.sleep(0.05)
    assert ended.wait(timeout=5.0), "synthesized drag end never fired"
