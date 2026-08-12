"""Validation contracts for GUI inputs that take an options list.

Empty options previously produced a raw ``IndexError`` from ``options[0]``;
these now raise a descriptive ``ValueError``.

Also: container-context misuse (overlapping ``with`` blocks on one handle).
"""

import threading
from unittest.mock import patch

import pytest

import viser
import viser._client_autobuild

from .utils import viser_server


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


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_folder_context_rejects_overlapping_entry() -> None:
    """A container handle supports one active ``with`` block at a time: a
    second enter -- self-nesting or a concurrent enter from another thread --
    raises instead of corrupting the first block's restore slot. Sequential
    re-entry stays legal."""
    with viser_server() as server:
        folder = server.gui.add_folder("F")

        # Self-nesting.
        with folder:
            with pytest.raises(RuntimeError, match="one active"):
                with folder:
                    pass

        # Concurrent entry from another thread while the block is held open.
        entered = threading.Event()
        release = threading.Event()

        def hold_open() -> None:
            with folder:
                entered.set()
                release.wait(timeout=5.0)

        thread = threading.Thread(target=hold_open)
        thread.start()
        try:
            assert entered.wait(timeout=5.0)
            with pytest.raises(RuntimeError, match="another thread"):
                with folder:
                    pass
        finally:
            release.set()
            thread.join(timeout=5.0)
        assert not thread.is_alive()

        # Sequential re-entry after both blocks closed works, and elements
        # land in the folder.
        with folder:
            button = server.gui.add_button("ok")
        assert button._impl.parent_container_id == folder._impl.uuid


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_tab_context_rejects_overlapping_entry() -> None:
    """Same overlapping-entry contract for tab handles."""
    with viser_server() as server:
        tab = server.gui.add_tab_group().add_tab("T")
        with tab:
            with pytest.raises(RuntimeError, match="one active"):
                with tab:
                    pass
        with tab:  # Sequential re-entry is fine.
            server.gui.add_button("ok")
