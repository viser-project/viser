"""Unit tests for tab-group handle bookkeeping."""

from __future__ import annotations

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
