from unittest.mock import patch

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_scene_node() -> None:
    """Test that viser's internal message buffer is cleaned up properly when we
    remove scene nodes."""

    server = viser.ViserServer()

    internal_message_dict = server._websock_server._broadcast_buffer.message_from_id
    orig_len = len(internal_message_dict)

    for i in range(50):
        server.scene.add_frame(f"/frame_{i}")

    assert len(internal_message_dict) > orig_len
    server.scene.reset()
    assert len(internal_message_dict) > orig_len
    server._run_garbage_collector(force=True)
    assert len(internal_message_dict) == orig_len


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_gui_element() -> None:
    """Test that viser's internal message buffer is cleaned up properly when we
    remove GUI elements."""

    server = viser.ViserServer()

    internal_message_dict = server._websock_server._broadcast_buffer.message_from_id
    orig_len = len(internal_message_dict)

    for i in range(50):
        server.gui.add_button(f"Button {i}")

    with server.gui.add_folder("Buttons in folder"):
        for i in range(50):
            server.gui.add_button(f"Button {i}")

    assert len(internal_message_dict) > orig_len
    server.gui.reset()
    assert len(internal_message_dict) > orig_len
    server._run_garbage_collector(force=True)
    assert len(internal_message_dict) == orig_len


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_gui_in_modal() -> None:
    """Test that viser's internal message buffer is cleaned up properly when we
    remove GUI elements."""

    server = viser.ViserServer()

    internal_message_dict = server._websock_server._broadcast_buffer.message_from_id
    orig_len = len(internal_message_dict)

    with server.gui.add_modal("Buttons in folder") as modal:
        for i in range(50):
            server.gui.add_button(f"Button {i}")

    assert len(internal_message_dict) > orig_len
    modal.close()
    assert len(internal_message_dict) > orig_len
    server._run_garbage_collector(force=True)
    assert len(internal_message_dict) == orig_len
