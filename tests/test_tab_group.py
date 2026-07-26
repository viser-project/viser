"""Unit tests for tab-group handle bookkeeping."""

from __future__ import annotations

import threading

import pytest

import viser


def test_tab_remove_keeps_labels_and_container_ids_in_sync() -> None:
    """Removing a tab must keep ``_tab_labels`` and ``_tab_container_ids`` aligned.

    Regression (``GuiTabHandle.remove``): the handle updated ``_tab_labels``,
    ``_tab_icons_html`` and ``_tab_handles`` but left ``_tab_container_ids``
    stale, so the client received a mismatched number of tab labels vs. tab
    panels and rendered an orphaned panel for the removed tab.
    """
    server = viser.ViserServer(port=0, verbose=False)
    try:
        group = server.gui.add_tab_group()
        tab_a = group.add_tab("A")
        tab_b = group.add_tab("B")
        group.add_tab("C")

        assert group._tab_labels == ("A", "B", "C")
        assert len(group._tab_container_ids) == 3
        ids_before = dict(zip(group._tab_labels, group._tab_container_ids))

        # Remove the middle tab.
        tab_b.remove()

        assert group._tab_labels == ("A", "C")
        assert len(group._tab_container_ids) == len(group._tab_labels)
        assert len(group._tab_icons_html) == len(group._tab_labels)
        # The surviving tabs keep their original container ids (no reshuffle).
        assert group._tab_container_ids[0] == ids_before["A"]
        assert group._tab_container_ids[1] == ids_before["C"]

        # Remove the first tab; the active selection on the client is keyed by
        # container id, so the remaining id must be exactly C's.
        tab_a.remove()
        assert group._tab_labels == ("C",)
        assert group._tab_container_ids == (ids_before["C"],)
    finally:
        server.stop()


def test_add_tab_after_remove_raises() -> None:
    """``add_tab`` on a removed tab group must raise instead of registering a
    live container entry for a group that no longer exists."""
    server = viser.ViserServer(port=0, verbose=False)
    try:
        group = server.gui.add_tab_group()
        group.add_tab("A")
        group.remove()
        keys_before = set(server.gui._container_handle_from_uuid)
        with pytest.raises(RuntimeError, match="removed"):
            group.add_tab("B")
        # No container entry may be left behind for the rejected tab.
        assert set(server.gui._container_handle_from_uuid) == keys_before
    finally:
        server.stop()


def test_concurrent_add_tab_during_remove_is_serialized() -> None:
    """``remove()``'s tombstone and ``add_tab``'s removed-check + append take the
    same lifecycle lock, so an ``add_tab`` racing a ``remove`` must either land
    before the tombstone or raise -- never register a container entry for a
    dead group.

    Regression: ``remove()`` tombstoned without the lock, so a concurrent
    ``add_tab`` could slip between the tab snapshot and the tombstone and leave
    a live container entry that silently accepted children forever.

    The window is widened deterministically by parking thread A at the FIRST
    message its ``remove()`` queues. That park point is version-agnostic: in
    the fixed code it is the ``GuiRemoveMessage`` queued inside the locked
    tombstone section (so ``add_tab`` blocks on the lock, then raises); in the
    buggy code it was the ``_rebuild_tab_props`` update queued mid-drain,
    BEFORE the tombstone (so ``add_tab`` slipped in and appended)."""
    server = viser.ViserServer(port=0, verbose=False)
    try:
        group = server.gui.add_tab_group()
        group.add_tab("A")

        in_critical = threading.Event()
        release = threading.Event()
        gui_api = server.gui
        real_queue_message = gui_api._websock_interface.queue_message
        remover = threading.Thread(target=group.remove)

        def blocking_queue_message(message) -> None:
            # Park remove() at its first queued message, once.
            if threading.current_thread() is remover and not in_critical.is_set():
                in_critical.set()
                assert release.wait(timeout=5.0)
            real_queue_message(message)

        gui_api._websock_interface.queue_message = blocking_queue_message  # type: ignore[method-assign]
        try:
            remover.start()
            assert in_critical.wait(timeout=5.0)

            add_tab_error: list[BaseException] = []

            def add_tab_job() -> None:
                try:
                    group.add_tab("B")
                except BaseException as e:  # noqa: BLE001
                    add_tab_error.append(e)

            adder = threading.Thread(target=add_tab_job)
            adder.start()
            release.set()
            remover.join(timeout=5.0)
            adder.join(timeout=5.0)
            assert not remover.is_alive() and not adder.is_alive()

            # add_tab started after the tombstone was set (thread A was parked
            # past it), so it must have raised rather than appending.
            assert len(add_tab_error) == 1
            assert isinstance(add_tab_error[0], RuntimeError)
            assert group._tab_handles == []
        finally:
            gui_api._websock_interface.queue_message = real_queue_message  # type: ignore[method-assign]
    finally:
        server.stop()
