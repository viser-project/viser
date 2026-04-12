from unittest.mock import patch

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_form_submit_fires_callback() -> None:
    """Calling form.submit() should fire all registered on_submit callbacks."""
    server = viser.ViserServer()

    with server.gui.add_form("Profile") as form:
        name = server.gui.add_text("Name", initial_value="")
        age = server.gui.add_number("Age", initial_value=0)

    calls: list[tuple[str, int]] = []

    @form.on_submit
    def _(_) -> None:
        calls.append((name.value, age.value))

    # Simulate some edits (as if the client sent GuiUpdateMessages).
    name.value = "alice"
    age.value = 30

    form.submit()
    assert calls == [("alice", 30)]

    # Submitting again should fire again with the current state.
    name.value = "bob"
    form.submit()
    assert calls == [("alice", 30), ("bob", 30)]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_form_child_on_update_not_suppressed() -> None:
    """on_update callbacks on form children fire as normal (forms are additive)."""
    server = viser.ViserServer()

    with server.gui.add_form("Quiz") as form:
        text = server.gui.add_text("Answer", initial_value="")

    keystrokes: list[str] = []

    @text.on_update
    def _(_) -> None:
        keystrokes.append(text.value)

    text.value = "hello"
    assert keystrokes == ["hello"]

    form.submit()
    # form.submit() does not re-fire on_update for children.
    assert keystrokes == ["hello"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_nested_forms_raise() -> None:
    """Nested forms would produce invalid HTML on the client."""
    import pytest

    server = viser.ViserServer()
    with server.gui.add_form("Outer"):
        with pytest.raises(ValueError, match="Nested forms"):
            with server.gui.add_form("Inner"):
                pass

    # A form inside a folder inside a form should also raise.
    with server.gui.add_form("Outer2"):
        with server.gui.add_folder("Middle"):
            with pytest.raises(ValueError, match="Nested forms"):
                with server.gui.add_form("Inner2"):
                    pass


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_submit_callback() -> None:
    """remove_submit_callback should support 'all' and specific callbacks."""
    server = viser.ViserServer()

    with server.gui.add_form("F") as form:
        pass

    calls: list[int] = []

    def cb1(_):
        calls.append(1)

    def cb2(_):
        calls.append(2)

    form.on_submit(cb1)
    form.on_submit(cb2)
    form.submit()
    assert calls == [1, 2]

    form.remove_submit_callback(cb1)
    calls.clear()
    form.submit()
    assert calls == [2]

    form.remove_submit_callback("all")
    calls.clear()
    form.submit()
    assert calls == []
