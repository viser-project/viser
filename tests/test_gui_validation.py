"""Validation contracts for GUI inputs that take an options list.

Empty options previously produced a raw ``IndexError`` from ``options[0]``;
these now raise a descriptive ``ValueError``.
"""

from unittest.mock import patch

import pytest

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_dropdown_rejects_empty_options() -> None:
    server = viser.ViserServer()
    with pytest.raises(ValueError, match="at least one option"):
        server.gui.add_dropdown("Empty", options=[])


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_button_group_rejects_empty_options() -> None:
    server = viser.ViserServer()
    with pytest.raises(ValueError, match="at least one option"):
        server.gui.add_button_group("Empty", options=[])


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_dropdown_options_setter_rejects_empty() -> None:
    server = viser.ViserServer()
    dropdown = server.gui.add_dropdown("D", options=["a", "b"])
    with pytest.raises(ValueError, match="at least one option"):
        dropdown.options = []
    # The prior (valid) options should be untouched after the rejected assignment.
    assert dropdown.options == ("a", "b")
