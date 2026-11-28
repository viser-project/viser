"""Edits to inputs that are scrolled out of view need to build on the latest value
from the server, not on a stale one."""

from __future__ import annotations

import time

from playwright.sync_api import Page

import viser


def test_edit_after_server_update_offscreen(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    number = viser_server.gui.add_number("number", 5)
    vector = viser_server.gui.add_vector3("vector", (0.0, 0.0, 0.0), step=1.0)
    filler = [viser_server.gui.add_number(f"filler {i}", 0) for i in range(60)]
    last = viser_page.locator(f"[id='{filler[-1]._impl.uuid}']").first
    last.wait_for()

    for handle, value, expected in (
        (number, 1000, 1001),
        (vector, (1.0, 2.0, 3.0), (2.0, 2.0, 3.0)),
    ):
        box = viser_page.locator(f"[id='{handle._impl.uuid}']").first
        box.scroll_into_view_if_needed()
        box.focus()
        last.evaluate("e => e.scrollIntoView()")
        # Long enough for anything that depends on visibility to settle.
        viser_page.wait_for_timeout(900)
        handle.value = value  # type: ignore
        viser_page.wait_for_timeout(200)
        viser_page.keyboard.press("ArrowUp")
        deadline = time.monotonic() + 5.0
        while handle.value == value and time.monotonic() < deadline:
            time.sleep(0.05)
        assert handle.value == expected
