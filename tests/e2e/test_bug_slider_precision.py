"""E2E regression test for the slider's companion number box precision.

Regression (``components/Slider.tsx``): the right-hand ``NumberInput`` had its
``decimalScale`` commented out, so typing a fractional value into an INTEGER
slider's box sent a float to the server. It now mirrors ``NumberInput.tsx``
(`decimalScale={precision}`), so an integer slider (precision 0) can't emit a
fractional value.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import find_gui_input


def test_integer_slider_box_does_not_send_fractional(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    handle = viser_server.gui.add_slider("n", min=0, max=10, step=1, initial_value=2)
    seen: list[float] = []
    handle.on_update(lambda _: seen.append(handle.value))

    box = find_gui_input(viser_page, "n")
    box.wait_for(state="visible", timeout=5_000)
    box.click()
    box.press("Control+a")
    box.fill("2.5")
    box.press("Enter")
    viser_page.wait_for_timeout(400)

    assert 2.5 not in seen, f"integer slider box sent a fractional value: {seen}"
    assert handle.value == int(handle.value), handle.value
