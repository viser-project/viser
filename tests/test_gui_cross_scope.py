"""Tests for cross-scope GUI container nesting.

GUI container nesting across scopes is DIRECTIONAL: a ``client.gui`` element
added inside a ``with server.gui.<container>`` context nests in the server
container (its audience is a subset of the container's), while the reverse
raises. Cross-nested elements are the one deliberate exception to
scope-local removal: server-container teardown cascades into them, and
``client.gui.reset()`` / disconnect teardown reach them through per-scope
foreign-nesting bookkeeping.

Browser-facing behavior (rendering inside the folder, per-client visibility,
DOM containment) is covered by ``tests/e2e/test_cross_scope_handles.py``;
this file pins the Python-side wiring on a headless server with synthetic
in-process clients.
"""

from __future__ import annotations

import warnings as warnings_module
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


def _add_uuids(messages: list) -> set[str]:
    """uuids of GUI element-creation messages (they carry container_uuid)."""
    return {msg.uuid for msg in messages if hasattr(msg, "container_uuid")}


def _remove_uuids(messages: list) -> set[str]:
    return {msg.uuid for msg in messages if isinstance(msg, m.GuiRemoveMessage)}


# ---------------------------------------------------------------------------
# Where elements land: the allowed direction.
# ---------------------------------------------------------------------------


def test_client_element_nests_in_server_folder(server: viser.ViserServer) -> None:
    """The core wiring: a client add inside a server folder context parents
    into the server folder's subtree, is tracked as foreign by the client
    scope, and its add message targets the folder but travels on the
    CLIENT's own connection (never the broadcast buffer)."""
    client = make_synthetic_client(server, 0)

    with server.gui.add_folder("SrvFolder") as folder:
        button = client.gui.add_button("mine")

    assert button._impl.parent_container_id == folder._impl.uuid
    assert folder._children[button._impl.uuid] is button
    assert button._impl.uuid in client.gui._handles_in_foreign_containers

    client_adds = [
        msg
        for msg in client_buffer_messages(client)
        if getattr(msg, "uuid", None) == button._impl.uuid
        and hasattr(msg, "container_uuid")
    ]
    assert len(client_adds) == 1
    assert client_adds[0].container_uuid == folder._impl.uuid
    assert button._impl.uuid not in _add_uuids(broadcast_messages(server))


def test_other_server_container_types_nest_and_teardown(
    server: viser.ViserServer,
) -> None:
    """The directional rule holds for the other server container context
    types -- tabs, modals, and scene-node-backed 3D GUI containers -- and
    each type's (distinct) teardown path also cascades into cross-nested
    client elements."""
    client = make_synthetic_client(server, 0)

    tab_group = server.gui.add_tab_group()
    tab = tab_group.add_tab("Tab")
    with tab:
        in_tab = client.gui.add_button("in tab")
    assert in_tab._impl.parent_container_id == tab._id
    assert tab._children[in_tab._impl.uuid] is in_tab

    modal = server.gui.add_modal("Modal")
    with modal:
        in_modal = client.gui.add_button("in modal")
    assert in_modal._impl.parent_container_id == modal._uuid
    assert modal._children[in_modal._impl.uuid] is in_modal

    container_3d = server.scene.add_3d_gui_container("/gui3d")
    with container_3d:
        in_3d = client.gui.add_button("in 3d container")
    assert in_3d._impl.parent_container_id == container_3d._container_id
    assert container_3d._children[in_3d._impl.uuid] is in_3d

    for handle in (in_tab, in_modal, in_3d):
        assert handle._impl.uuid in client.gui._handles_in_foreign_containers

    tab_group.remove()
    assert in_tab._impl.removed
    modal.close()
    assert in_modal._impl.removed
    container_3d.remove()  # Scene-node removal path (_on_remove).
    assert in_3d._impl.removed
    assert not client.gui._handles_in_foreign_containers


# ---------------------------------------------------------------------------
# The rejected directions.
# ---------------------------------------------------------------------------


def test_server_element_into_client_container_raises(
    server: viser.ViserServer,
) -> None:
    client = make_synthetic_client(server, 0)

    with client.gui.add_folder("CliFolder"):
        with pytest.raises(RuntimeError, match="not vice versa"):
            server.gui.add_button("stray")
    # Outside the context, both scopes add at their own roots again.
    assert server.gui.add_button("ok")._impl.parent_container_id == "root"
    assert client.gui.add_button("ok")._impl.parent_container_id == "root"


def test_cross_client_nesting_raises(server: viser.ViserServer) -> None:
    """One client's element cannot nest in another client's container: the
    audiences are disjoint, not nested."""
    client_a = make_synthetic_client(server, 0)
    client_b = make_synthetic_client(server, 1)

    with client_a.gui.add_folder("A's folder"):
        with pytest.raises(RuntimeError):
            client_b.gui.add_button("stray")


# ---------------------------------------------------------------------------
# Removal cascades.
# ---------------------------------------------------------------------------


def test_server_folder_removal_cascades_through_client_subtree(
    server: viser.ViserServer,
) -> None:
    """Removing a server folder removes its server children AND cross-nested
    client subtrees (the one exception to scope-local removal). Each remove
    message travels on its owner's connection."""
    client = make_synthetic_client(server, 0)

    with server.gui.add_folder("SrvFolder") as folder:
        srv_child = server.gui.add_button("shared")
        with client.gui.add_folder("CliFolder") as cli_folder:
            leaf = client.gui.add_button("leaf")

    # Only the subtree ROOT is foreign-tracked: the leaf is an ordinary
    # same-scope element parented under the client folder.
    assert cli_folder._impl.parent_container_id == folder._impl.uuid
    assert leaf._impl.parent_container_id == cli_folder._impl.uuid
    assert cli_folder._impl.uuid in client.gui._handles_in_foreign_containers
    assert leaf._impl.uuid not in client.gui._handles_in_foreign_containers

    folder.remove()

    assert srv_child._impl.removed
    assert cli_folder._impl.removed
    assert leaf._impl.removed
    assert not client.gui._handles_in_foreign_containers

    client_removes = _remove_uuids(client_buffer_messages(client))
    broadcast_removes = _remove_uuids(broadcast_messages(server))
    assert {cli_folder._impl.uuid, leaf._impl.uuid} <= client_removes
    assert {folder._impl.uuid, srv_child._impl.uuid} <= broadcast_removes
    assert not {cli_folder._impl.uuid, leaf._impl.uuid} & broadcast_removes


def test_client_remove_detaches_without_touching_others(
    server: viser.ViserServer,
) -> None:
    """A client removing its own cross-nested element detaches it from the
    server folder; the folder and a second client's element are untouched."""
    client_a = make_synthetic_client(server, 0)
    client_b = make_synthetic_client(server, 1)

    with server.gui.add_folder("SrvFolder") as folder:
        a_button = client_a.gui.add_button("a")
        b_button = client_b.gui.add_button("b")

    a_button.remove()

    assert a_button._impl.removed
    assert a_button._impl.uuid not in folder._children
    assert a_button._impl.uuid not in client_a.gui._handles_in_foreign_containers
    assert not folder._impl.removed
    assert not b_button._impl.removed
    assert folder._children[b_button._impl.uuid] is b_button


# ---------------------------------------------------------------------------
# reset().
# ---------------------------------------------------------------------------


def test_client_reset_drains_cross_nested_subtree(server: viser.ViserServer) -> None:
    """client.gui.reset() reaches cross-nested subtrees, which the root
    container walk alone can't see; the server folder and other clients'
    elements are untouched."""
    client_a = make_synthetic_client(server, 0)
    client_b = make_synthetic_client(server, 1)

    with server.gui.add_folder("SrvFolder") as folder:
        with client_a.gui.add_folder("CliFolder") as cli_folder:
            leaf = client_a.gui.add_button("leaf")
        b_button = client_b.gui.add_button("b")

    client_a.gui.reset()

    assert cli_folder._impl.removed
    assert leaf._impl.removed
    assert cli_folder._impl.uuid not in folder._children
    assert not client_a.gui._handles_in_foreign_containers
    assert not folder._impl.removed
    assert not b_button._impl.removed


# ---------------------------------------------------------------------------
# Thread-context restore across nested cross-scope `with` blocks.
# ---------------------------------------------------------------------------


def test_server_adds_ok_after_nested_client_context_exits(
    server: viser.ViserServer,
) -> None:
    """Regression: exiting a client container context that was nested inside
    a server container context must hand the thread marker back to the
    server scope -- a server add afterwards used to be misread as nesting
    inside a client container and raised."""
    client = make_synthetic_client(server, 0)

    with server.gui.add_folder("SrvFolder") as srv_folder:
        with client.gui.add_folder("CliFolder"):
            client.gui.add_button("leaf")
        # Back in the server context: both scopes target the server folder.
        srv_button = server.gui.add_button("shared")
        cli_button = client.gui.add_button("mine")

    assert srv_button._impl.parent_container_id == srv_folder._impl.uuid
    assert cli_button._impl.parent_container_id == srv_folder._impl.uuid


def test_container_context_is_task_local(server: viser.ViserServer) -> None:
    """Async callbacks interleave on ONE event-loop thread, each running in
    a copied Context. Regression: a thread-keyed context marker made a
    `with` block suspended at an await leak into unrelated callbacks -- a
    sibling task's server add spuriously raised the cross-scope error.
    Contexts copied before the block entered must see no marker."""
    import contextvars

    client_a = make_synthetic_client(server, 0)
    client_b = make_synthetic_client(server, 1)
    sibling = contextvars.copy_context()  # Stands in for another asyncio task.

    folder = client_a.gui.add_folder("F")
    folder.__enter__()
    try:
        # Inside the block, cross-scope nesting is live...
        inside = client_a.gui.add_button("in")
        assert inside._impl.parent_container_id == folder._impl.uuid
        # ...but the sibling context is unaffected: no spurious raise, no
        # cross-scope capture.
        srv = sibling.run(server.gui.add_button, "s")
        assert srv._impl.parent_container_id == "root"
        other = sibling.run(client_b.gui.add_button, "b")
        assert other._impl.parent_container_id == "root"
    finally:
        folder.__exit__(None, None, None)


def test_no_stale_target_after_server_context_exits(
    server: viser.ViserServer,
) -> None:
    """Regression: the cross-scope restore must not record the server
    folder's uuid in the CLIENT's own target map -- after the server's
    `with` block exits, adds from both scopes land at their own roots."""
    client = make_synthetic_client(server, 0)

    with server.gui.add_folder("SrvFolder"):
        with client.gui.add_folder("CliFolder"):
            pass

    assert server.gui.add_button("s")._impl.parent_container_id == "root"
    assert client.gui.add_button("c")._impl.parent_container_id == "root"


# ---------------------------------------------------------------------------
# Forms.
# ---------------------------------------------------------------------------


def test_form_nesting_rules_apply_across_scopes(server: viser.ViserServer) -> None:
    """The no-nested-forms rule sees through scope boundaries: a client form
    inside a server form is invalid, while a client form inside a plain
    server folder is fine."""
    client = make_synthetic_client(server, 0)

    with server.gui.add_form("SrvForm"):
        with pytest.raises(ValueError, match="Nested forms"):
            client.gui.add_form("CliForm")

    with server.gui.add_folder("SrvFolder") as folder:
        form = client.gui.add_form("CliForm")
    assert form._impl.parent_container_id == folder._impl.uuid


# ---------------------------------------------------------------------------
# Disconnect teardown.
# ---------------------------------------------------------------------------


def test_disconnect_releases_cross_nested_elements(
    server: viser.ViserServer,
) -> None:
    """The disconnect teardown detaches cross-nested client subtrees from the
    server's container tree without sending messages -- including
    DESCENDANTS of the cross-nested root, so surviving user references get
    the ordinary already-removed warning instead of a KeyError."""
    client = make_synthetic_client(server, 0)
    with server.gui.add_folder("SrvFolder") as folder:
        with client.gui.add_folder("CliFolder") as cli_folder:
            leaf = client.gui.add_button("leaf")

    # Simulate the disconnect teardown (buffer shutdown + release call).
    client._websock_connection._state.message_buffer.set_done()
    client.gui._release_cross_scope_nesting()

    assert cli_folder._impl.removed
    assert leaf._impl.removed
    assert cli_folder._impl.uuid not in folder._children

    # A surviving reference to a DESCENDANT degrades gracefully.
    with pytest.warns(UserWarning, match="already removed"):
        leaf.remove()

    # Removing the server folder afterwards is clean: no cascade into the
    # dead connection, so no "closed connection" warning.
    with warnings_module.catch_warnings(record=True) as caught:
        warnings_module.simplefilter("always")
        folder.remove()
    assert not any("closed connection" in str(w.message) for w in caught)


def test_second_server_context_does_not_break_first(
    server: viser.ViserServer,
) -> None:
    """Regression: container-context markers are per-server, so an inner
    `with` block on an unrelated ViserServer must not clobber the first
    server's still-open context."""
    server_b = viser.ViserServer(port=0, verbose=False)
    try:
        client = make_synthetic_client(server, 0)
        with server.gui.add_folder("FA") as fa:
            with server_b.gui.add_folder("FB"):
                pass
            # Server A's context is still active for both of its scopes.
            cli_button = client.gui.add_button("x")
            srv_button = server.gui.add_button("y")
        assert cli_button._impl.parent_container_id == fa._impl.uuid
        assert srv_button._impl.parent_container_id == fa._impl.uuid
    finally:
        server_b.stop()


def test_client_scope_dangling_restore_stays_client_local(
    server: viser.ViserServer,
) -> None:
    """Regression: a CLIENT container removed while an inner client context
    is open is a same-scope affair -- the dangling uuid must not be handed
    to the server's target map (which would poison the thread for both
    scopes permanently). After the outer context exits, both scopes add at
    their roots again."""
    client = make_synthetic_client(server, 0)

    with client.gui.add_folder("Outer") as outer:
        with client.gui.add_folder("Inner"):
            outer.remove()

    assert server.gui.add_button("s")._impl.parent_container_id == "root"
    assert client.gui.add_button("c")._impl.parent_container_id == "root"


def test_removed_server_container_restore_does_not_poison_thread(
    server: viser.ViserServer,
) -> None:
    """Regression: if the server container is removed while a nested client
    context is open, the client context's exit must still hand the thread
    marker back cleanly -- afterwards neither scope spuriously raises and
    adds land at their own roots."""
    client = make_synthetic_client(server, 0)

    with server.gui.add_folder("F") as f:
        with client.gui.add_folder("C"):
            f.remove()

    assert server.gui.add_button("s")._impl.parent_container_id == "root"
    assert client.gui.add_button("c")._impl.parent_container_id == "root"


def test_disconnect_cycles_leave_no_server_residue(
    server: viser.ViserServer,
) -> None:
    """Repeated connect / cross-nest / disconnect cycles must not accumulate
    entries in the server-side GUI registries or the host container's
    children (leak check for the release path)."""
    folder = server.gui.add_folder("Host")
    gui = server.gui

    def registry_sizes() -> tuple[int, int, int]:
        return (
            len(gui._container_handle_from_uuid),
            len(gui._gui_input_handle_from_uuid),
            len(folder._children),
        )

    baseline = registry_sizes()
    for i in range(20):
        client = make_synthetic_client(server, i)
        with folder:
            with client.gui.add_folder(f"F{i}"):
                client.gui.add_button(f"b{i}")
            client.gui.add_slider(
                f"s{i}", min=0.0, max=1.0, step=0.1, initial_value=0.5
            )
        client.scene.add_frame(f"/c{i}")

        # Disconnect teardown.
        client._websock_connection._state.message_buffer.set_done()
        client.gui._release_cross_scope_nesting()

        assert registry_sizes() == baseline, f"registry residue after cycle {i}"
        assert len(client.gui._handles_in_foreign_containers) == 0
