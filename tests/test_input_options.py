"""Server-side tests for input options used by apps that bring their own
keyboard/drag handling (e.g. MuJoCo viewers):

- ``SceneApi.configure_keyboard_camera_controls``
- ``on_drag(..., show_arrow=...)``
- the extended ``HotkeyKey`` set
"""

from __future__ import annotations

import typing
from typing import Any, Generator
from unittest.mock import patch

import pytest

import viser
import viser._client_autobuild
from viser import _messages


@pytest.fixture
def server() -> Generator[viser.ViserServer, None, None]:
    with patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None):
        s = viser.ViserServer()
    try:
        yield s
    finally:
        s.stop()


def _capture(server: viser.ViserServer) -> list[Any]:
    sent: list[Any] = []
    original = server._websock_server.queue_message

    def capture(message: Any) -> None:
        sent.append(message)
        original(message)

    server._websock_server.queue_message = capture  # type: ignore[method-assign]
    return sent


def _latest_bindings(sent: list[Any], name: str) -> tuple[_messages.DragBinding, ...]:
    msgs = [
        m
        for m in sent
        if isinstance(m, _messages.SetSceneNodeDragBindingsMessage) and m.name == name
    ]
    assert msgs, f"no drag bindings published for {name}"
    return msgs[-1].bindings


def test_configure_keyboard_camera_controls_queues_message(
    server: viser.ViserServer,
) -> None:
    sent = _capture(server)
    server.scene.configure_keyboard_camera_controls(False)
    server.scene.configure_keyboard_camera_controls(True)
    msgs = [m for m in sent if isinstance(m, _messages.KeyboardCameraControlsMessage)]
    assert [m.enabled for m in msgs] == [False, True]


def test_keyboard_camera_controls_latest_wins_in_buffer(
    server: viser.ViserServer,
) -> None:
    """Late joiners should only see the most recent setting."""
    server.scene.configure_keyboard_camera_controls(False)
    server.scene.configure_keyboard_camera_controls(True)
    server.scene.configure_keyboard_camera_controls(False)
    buffered = [
        m
        for m in server._websock_server._broadcast_buffer.message_from_id.values()
        if isinstance(m, _messages.KeyboardCameraControlsMessage)
    ]
    assert len(buffered) == 1
    assert buffered[0].enabled is False


def test_keyboard_camera_controls_not_serialized() -> None:
    assert not _messages.KeyboardCameraControlsMessage.include_in_scene_serialization


def test_on_drag_show_arrow_defaults_true(server: viser.ViserServer) -> None:
    sent = _capture(server)
    box = server.scene.add_box("/box")

    @box.on_drag
    def _(event: Any) -> None: ...

    assert _latest_bindings(sent, "/box") == (
        _messages.DragBinding(button="left", modifier=None, show_arrow=True),
    )


def test_on_drag_show_arrow_false_is_published(server: viser.ViserServer) -> None:
    sent = _capture(server)
    box = server.scene.add_box("/box")

    @box.on_drag("left", show_arrow=False)
    def _(event: Any) -> None: ...

    @box.on_drag("left", modifier="shift")
    def _shift(event: Any) -> None: ...

    assert _latest_bindings(sent, "/box") == (
        _messages.DragBinding(button="left", modifier=None, show_arrow=False),
        _messages.DragBinding(button="left", modifier="shift", show_arrow=True),
    )


def test_on_drag_show_arrow_shared_combo_is_or(server: viser.ViserServer) -> None:
    """Two callbacks on the same combo: the arrow shows if either asks."""
    sent = _capture(server)
    box = server.scene.add_box("/box")

    def hidden(event: Any) -> None: ...
    def shown(event: Any) -> None: ...

    box.on_drag("left", show_arrow=False)(hidden)
    assert _latest_bindings(sent, "/box")[0].show_arrow is False
    box.on_drag("left", show_arrow=True)(shown)
    assert _latest_bindings(sent, "/box") == (
        _messages.DragBinding(button="left", modifier=None, show_arrow=True),
    )
    box.remove_drag_callback(shown)
    assert _latest_bindings(sent, "/box") == (
        _messages.DragBinding(button="left", modifier=None, show_arrow=False),
    )


def test_on_drag_reregister_updates_show_arrow(server: viser.ViserServer) -> None:
    """Re-registering the same callback with a new show_arrow updates it in
    place rather than adding a second (double-firing) entry."""
    sent = _capture(server)
    box = server.scene.add_box("/box")

    def cb(event: Any) -> None: ...

    box.on_drag("left")(cb)
    box.on_drag("left", show_arrow=False)(cb)
    assert len(box._impl.drag_cb) == 1
    assert _latest_bindings(sent, "/box") == (
        _messages.DragBinding(button="left", modifier=None, show_arrow=False),
    )


@pytest.mark.parametrize(
    "key",
    ["[", "]", "-", "=", "f1", "f6", "f7", "f12", "\\", "`"],
)
def test_extended_hotkeys_accepted(server: viser.ViserServer, key: str) -> None:
    assert key in typing.get_args(_messages.HotkeyKey)
    sent = _capture(server)
    handle = server.gui.add_command("Cmd", hotkey=key, modifier="shift")  # type: ignore[arg-type]
    assert handle.hotkey == key
    register = [m for m in sent if isinstance(m, _messages.RegisterCommandMessage)]
    assert register[-1].props.hotkey == key
    assert register[-1].props.modifier == "shift"


@pytest.mark.parametrize(
    "given, canonical",
    [("a", "A"), ("F6", "f6"), ("Space", "space"), ("ArrowUp", "arrowup")],
)
def test_hotkey_is_case_insensitive(
    server: viser.ViserServer, given: str, canonical: str
) -> None:
    """Mantine matched case-insensitively, so e.g. ``hotkey="a"`` worked
    before; the runtime canonicalizes instead of breaking it."""
    sent = _capture(server)
    handle = server.gui.add_command("Cmd", hotkey=given)  # type: ignore[arg-type]
    assert handle.hotkey == canonical
    register = [m for m in sent if isinstance(m, _messages.RegisterCommandMessage)]
    assert register[-1].props.hotkey == canonical

    handle.hotkey = "B"
    handle.hotkey = given  # type: ignore[assignment]
    assert handle.hotkey == canonical
    updates = [m for m in sent if isinstance(m, _messages.CommandUpdateMessage)]
    assert updates[-1].updates == {"hotkey": canonical}


@pytest.mark.parametrize("bad", ["F13", "f0", "!", "ctrl", "", "AB"])
def test_unknown_hotkey_raises(server: viser.ViserServer, bad: str) -> None:
    with pytest.raises(ValueError, match="Unknown hotkey"):
        server.gui.add_command("Cmd", hotkey=bad)  # type: ignore[arg-type]

    handle = server.gui.add_command("Cmd", hotkey="K")
    sent = _capture(server)
    with pytest.raises(ValueError, match="Unknown hotkey"):
        handle.hotkey = bad  # type: ignore[assignment]
    # A rejected assignment changes nothing, locally or on the wire.
    assert handle.hotkey == "K"
    assert not [m for m in sent if isinstance(m, _messages.CommandUpdateMessage)]


def test_modifier_assignment_is_canonicalized(server: viser.ViserServer) -> None:
    handle = server.gui.add_command("Cmd", hotkey="K")
    handle.modifier = "shift+cmd/ctrl"  # type: ignore[assignment]
    assert handle.modifier == "cmd/ctrl+shift"
    with pytest.raises(ValueError, match="Unknown modifier"):
        handle.modifier = "hyper"  # type: ignore[assignment]
    assert handle.modifier == "cmd/ctrl+shift"
