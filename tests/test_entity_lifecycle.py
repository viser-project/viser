"""Tests that pin add -> update -> remove lifecycle semantics across every
removable entity type."""

from unittest.mock import patch

import viser
import viser._client_autobuild


# ---------------------------------------------------------------------------
# GUI components
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_gui_add_update_remove_roundtrip() -> None:
    server = viser.ViserServer()
    handle = server.gui.add_number("x", 0.0)
    assert handle.value == 0.0

    handle.value = 1.5
    assert handle.value == 1.5

    handle.remove()
    # Double remove should warn, not raise.
    import warnings

    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        handle.remove()
        assert any("already removed" in str(rec.message) for rec in w)


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_gui_reset_clears_all_registries() -> None:
    server = viser.ViserServer()
    server.gui.add_number("a", 0.0)
    server.gui.add_button("b")
    with server.gui.add_folder("grp"):
        server.gui.add_checkbox("c", False)

    assert len(server.gui._gui_input_handle_from_uuid) > 0

    server.gui.reset()
    assert len(server.gui._gui_input_handle_from_uuid) == 0


# ---------------------------------------------------------------------------
# Scene nodes
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_scene_add_update_remove_roundtrip() -> None:
    server = viser.ViserServer()
    handle = server.scene.add_frame("/frame")
    handle.position = (1.0, 2.0, 3.0)

    handle.remove()
    # Lookup after remove returns None.
    assert server.scene._handle_from_node_name.get("/frame") is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_scene_parent_remove_cascades() -> None:
    server = viser.ViserServer()
    parent = server.scene.add_frame("/parent")
    server.scene.add_frame("/parent/child")
    server.scene.add_frame("/parent/child/grandchild")

    parent.remove()
    assert server.scene._handle_from_node_name.get("/parent") is None
    assert server.scene._handle_from_node_name.get("/parent/child") is None
    assert server.scene._handle_from_node_name.get("/parent/child/grandchild") is None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_add_update_remove_roundtrip() -> None:
    server = viser.ViserServer()
    handle = server.gui.add_command("test", description="desc")
    assert handle.label == "test"

    handle.label = "renamed"
    assert handle.label == "renamed"

    handle.remove()
    assert handle._impl.uuid not in server.gui._command_handle_from_uuid


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_reset_clears_registry() -> None:
    server = viser.ViserServer()
    server.gui.add_command("a")
    server.gui.add_command("b")
    server.gui.add_command("c")
    assert len(server.gui._command_handle_from_uuid) == 3

    server.gui.reset()
    assert len(server.gui._command_handle_from_uuid) == 0


# Notifications are attached to ClientHandle, so they require a connected
# client to exercise. They're covered in test_entity_lifecycle_contracts.py.


# ---------------------------------------------------------------------------
# Modals
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_modal_open_children_close() -> None:
    server = viser.ViserServer()
    with server.gui.add_modal("title") as modal:
        server.gui.add_button("inside")
    assert modal._uuid in server.gui._modal_handle_from_uuid

    modal.close()
    assert modal._uuid not in server.gui._modal_handle_from_uuid


# ---------------------------------------------------------------------------
# Cross-entity: message buffer coalesces Create + Remove
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_create_remove_coalesce_across_entities() -> None:
    """A Create followed by a Remove (with GC) should leave the buffer at
    starting size for every entity type."""
    server = viser.ViserServer()
    buffer = server._websock_server._broadcast_buffer.message_from_id
    baseline = len(buffer)

    # Scene
    frame = server.scene.add_frame("/gc_test")
    frame.remove()
    server._run_garbage_collector(force=True)
    assert len(buffer) == baseline, "scene create+remove did not coalesce"

    # GUI
    btn = server.gui.add_button("gc_test")
    btn.remove()
    server._run_garbage_collector(force=True)
    assert len(buffer) == baseline, "gui create+remove did not coalesce"

    # Modal
    with server.gui.add_modal("gc_test") as modal:
        pass
    modal.close()
    server._run_garbage_collector(force=True)
    assert len(buffer) == baseline, "modal create+remove did not coalesce"
