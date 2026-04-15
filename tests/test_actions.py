from unittest.mock import patch

import viser
import viser._client_autobuild
from viser._messages import RegisterActionMessage, RemoveActionMessage


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_action_returns_handle() -> None:
    """add_action() should return an ActionHandle with correct properties."""
    server = viser.ViserServer()
    handle = server.gui.add_action("My Action", description="Does a thing")

    assert handle.label == "My Action"
    assert handle.description == "Does a thing"
    assert handle.hotkey is None
    assert handle.icon is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_action_with_hotkey_and_icon() -> None:
    """add_action() with hotkey and icon should store them correctly."""
    server = viser.ViserServer()
    handle = server.gui.add_action(
        "Save",
        description="Save the file",
        hotkey=("mod", "S"),
        icon=viser.Icon.DEVICE_FLOPPY,
    )

    assert handle.label == "Save"
    assert handle.hotkey == ("mod", "S")
    assert handle.icon == viser.Icon.DEVICE_FLOPPY


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_on_trigger_callback() -> None:
    """on_trigger decorator should register a callback that can be inspected."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Run")

    calls: list[str] = []

    @handle.on_trigger
    def _(event: viser.ActionEvent) -> None:
        calls.append("triggered")

    # Verify the callback was registered.
    assert len(handle._impl.trigger_cb) == 1


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_update_label() -> None:
    """Updating the label should modify the handle's state."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Old Label")

    handle.label = "New Label"
    assert handle.label == "New Label"
    assert handle._impl.props.label == "New Label"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_update_description() -> None:
    """Updating the description should modify the handle's state."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Action", description="Original")

    handle.description = "Updated"
    assert handle.description == "Updated"
    assert handle._impl.props.description == "Updated"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_update_icon() -> None:
    """Updating the icon should modify the handle's state and update icon HTML."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Action")
    assert handle.icon is None

    handle.icon = viser.Icon.CHECK
    assert handle.icon == viser.Icon.CHECK
    assert handle._impl.props._icon_html is not None

    handle.icon = None
    assert handle.icon is None
    assert handle._impl.props._icon_html is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_remove() -> None:
    """Removing an action should mark it as removed and remove from registry."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Removable")

    uuid = handle._impl.uuid
    assert uuid in server.gui._action_handle_from_uuid

    handle.remove()
    assert handle._impl.removed is True
    assert uuid not in server.gui._action_handle_from_uuid


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_remove_warns_on_double_remove() -> None:
    """Removing an action twice should emit a warning."""
    import warnings

    server = viser.ViserServer()
    handle = server.gui.add_action("Double Remove")

    handle.remove()

    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        handle.remove()
        assert len(w) == 1
        assert "already removed" in str(w[0].message)


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_multiple_actions() -> None:
    """Multiple actions can be registered and tracked independently."""
    server = viser.ViserServer()
    h1 = server.gui.add_action("Action 1")
    h2 = server.gui.add_action("Action 2")
    h3 = server.gui.add_action("Action 3")

    assert len(server.gui._action_handle_from_uuid) == 3

    h2.remove()
    assert len(server.gui._action_handle_from_uuid) == 2
    assert h1._impl.uuid in server.gui._action_handle_from_uuid
    assert h3._impl.uuid in server.gui._action_handle_from_uuid


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_disabled_toggle() -> None:
    """Setting disabled should round-trip correctly."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Action")

    assert handle.disabled is False

    handle.disabled = True
    assert handle.disabled is True
    assert handle._impl.props.disabled is True

    handle.disabled = False
    assert handle.disabled is False
    assert handle._impl.props.disabled is False


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_register_disabled() -> None:
    """add_action() with disabled=True should set the property."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Disabled Action", disabled=True)

    assert handle.disabled is True
    assert handle._impl.props.disabled is True


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_update_hotkey() -> None:
    """Updating the hotkey should modify the handle's state."""
    server = viser.ViserServer()
    handle = server.gui.add_action("Action", hotkey=("mod", "K"))

    assert handle.hotkey == ("mod", "K")

    handle.hotkey = ("mod", "shift", "K")
    assert handle.hotkey == ("mod", "shift", "K")
    assert handle._impl.props.hotkey == ("mod", "shift", "K")

    handle.hotkey = None
    assert handle.hotkey is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_reset_clears_actions() -> None:
    """reset() should remove all registered actions."""
    server = viser.ViserServer()
    server.gui.add_action("Action 1")
    server.gui.add_action("Action 2")

    assert len(server.gui._action_handle_from_uuid) == 2

    server.gui.reset()
    assert len(server.gui._action_handle_from_uuid) == 0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_sends_register_message() -> None:
    """add_action() should queue a RegisterActionMessage."""
    server = viser.ViserServer()

    # Capture messages sent through the websocket interface.
    sent: list = []
    original_queue = server._websock_server.queue_message

    def capture_queue(msg):
        sent.append(msg)
        return original_queue(msg)

    server._websock_server.queue_message = capture_queue

    server.gui.add_action("Test", description="A test", hotkey=("mod", "T"))

    register_msgs = [m for m in sent if isinstance(m, RegisterActionMessage)]
    assert len(register_msgs) == 1
    assert register_msgs[0].props.label == "Test"
    assert register_msgs[0].props.description == "A test"
    assert register_msgs[0].props.hotkey == ("mod", "T")


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_action_remove_sends_remove_message() -> None:
    """remove() should queue a RemoveActionMessage."""
    server = viser.ViserServer()

    sent: list = []
    original_queue = server._websock_server.queue_message

    def capture_queue(msg):
        sent.append(msg)
        return original_queue(msg)

    server._websock_server.queue_message = capture_queue

    handle = server.gui.add_action("Temp")
    sent.clear()

    handle.remove()

    remove_msgs = [m for m in sent if isinstance(m, RemoveActionMessage)]
    assert len(remove_msgs) == 1
    assert remove_msgs[0].uuid == handle._impl.uuid
