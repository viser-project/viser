from unittest.mock import patch

import viser
import viser._client_autobuild
from viser._messages import RegisterCommandMessage, RemoveCommandMessage


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_command_returns_handle() -> None:
    """add_command() should return a CommandHandle with correct properties."""
    server = viser.ViserServer()
    handle = server.gui.add_command("My Command", description="Does a thing")

    assert handle.label == "My Command"
    assert handle.description == "Does a thing"
    assert handle.hotkey is None
    assert handle.icon is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_command_with_hotkey_and_icon() -> None:
    """add_command() with hotkey and icon should store them correctly."""
    server = viser.ViserServer()
    handle = server.gui.add_command(
        "Save",
        description="Save the file",
        hotkey=("mod", "S"),
        icon=viser.Icon.DEVICE_FLOPPY,
    )

    assert handle.label == "Save"
    assert handle.hotkey == ("mod", "S")
    assert handle.icon == viser.Icon.DEVICE_FLOPPY


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_on_trigger_callback() -> None:
    """on_trigger decorator should register a callback that can be inspected."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Run")

    calls: list[str] = []

    @handle.on_trigger
    def _(event: viser.CommandEvent) -> None:
        calls.append("triggered")

    # Verify the callback was registered.
    assert len(handle._impl.trigger_cb) == 1


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_update_label() -> None:
    """Updating the label should modify the handle's state."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Old Label")

    handle.label = "New Label"
    assert handle.label == "New Label"
    assert handle._impl.props.label == "New Label"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_update_description() -> None:
    """Updating the description should modify the handle's state."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Command", description="Original")

    handle.description = "Updated"
    assert handle.description == "Updated"
    assert handle._impl.props.description == "Updated"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_update_icon() -> None:
    """Updating the icon should modify the handle's state and update icon HTML."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Command")
    assert handle.icon is None

    handle.icon = viser.Icon.CHECK
    assert handle.icon == viser.Icon.CHECK
    assert handle._impl.props._icon_html is not None

    handle.icon = None
    assert handle.icon is None
    assert handle._impl.props._icon_html is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_remove() -> None:
    """Removing a command should mark it as removed and remove from registry."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Removable")

    uuid = handle._impl.uuid
    assert uuid in server.gui._command_handle_from_uuid

    handle.remove()
    assert handle._impl.removed is True
    assert uuid not in server.gui._command_handle_from_uuid


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_remove_warns_on_double_remove() -> None:
    """Removing a command twice should emit a warning."""
    import warnings

    server = viser.ViserServer()
    handle = server.gui.add_command("Double Remove")

    handle.remove()

    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        handle.remove()
        assert len(w) == 1
        assert "already removed" in str(w[0].message)


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_multiple_commands() -> None:
    """Multiple commands can be registered and tracked independently."""
    server = viser.ViserServer()
    h1 = server.gui.add_command("Command 1")
    h2 = server.gui.add_command("Command 2")
    h3 = server.gui.add_command("Command 3")

    assert len(server.gui._command_handle_from_uuid) == 3

    h2.remove()
    assert len(server.gui._command_handle_from_uuid) == 2
    assert h1._impl.uuid in server.gui._command_handle_from_uuid
    assert h3._impl.uuid in server.gui._command_handle_from_uuid


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_disabled_toggle() -> None:
    """Setting disabled should round-trip correctly."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Command")

    assert handle.disabled is False

    handle.disabled = True
    assert handle.disabled is True
    assert handle._impl.props.disabled is True

    handle.disabled = False
    assert handle.disabled is False
    assert handle._impl.props.disabled is False


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_register_disabled() -> None:
    """add_command() with disabled=True should set the property."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Disabled Command", disabled=True)

    assert handle.disabled is True
    assert handle._impl.props.disabled is True


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_update_hotkey() -> None:
    """Updating the hotkey should modify the handle's state."""
    server = viser.ViserServer()
    handle = server.gui.add_command("Command", hotkey=("mod", "K"))

    assert handle.hotkey == ("mod", "K")

    handle.hotkey = ("mod", "shift", "K")
    assert handle.hotkey == ("mod", "shift", "K")
    assert handle._impl.props.hotkey == ("mod", "shift", "K")

    handle.hotkey = None
    assert handle.hotkey is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_reset_clears_commands() -> None:
    """reset() should remove all registered commands."""
    server = viser.ViserServer()
    server.gui.add_command("Command 1")
    server.gui.add_command("Command 2")

    assert len(server.gui._command_handle_from_uuid) == 2

    server.gui.reset()
    assert len(server.gui._command_handle_from_uuid) == 0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_sends_register_message() -> None:
    """add_command() should queue a RegisterCommandMessage."""
    server = viser.ViserServer()

    # Capture messages sent through the websocket interface.
    sent: list = []
    original_queue = server._websock_server.queue_message

    def capture_queue(msg):
        sent.append(msg)
        return original_queue(msg)

    server._websock_server.queue_message = capture_queue

    server.gui.add_command("Test", description="A test", hotkey=("mod", "T"))

    register_msgs = [m for m in sent if isinstance(m, RegisterCommandMessage)]
    assert len(register_msgs) == 1
    assert register_msgs[0].props.label == "Test"
    assert register_msgs[0].props.description == "A test"
    assert register_msgs[0].props.hotkey == ("mod", "T")


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_remove_sends_remove_message() -> None:
    """remove() should queue a RemoveCommandMessage."""
    server = viser.ViserServer()

    sent: list = []
    original_queue = server._websock_server.queue_message

    def capture_queue(msg):
        sent.append(msg)
        return original_queue(msg)

    server._websock_server.queue_message = capture_queue

    handle = server.gui.add_command("Temp")
    sent.clear()

    handle.remove()

    remove_msgs = [m for m in sent if isinstance(m, RemoveCommandMessage)]
    assert len(remove_msgs) == 1
    assert remove_msgs[0].uuid == handle._impl.uuid
