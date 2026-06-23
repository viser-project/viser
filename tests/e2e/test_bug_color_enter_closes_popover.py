"""E2E regression test for the color picker not closing on Enter.

Regression (``components/Rgb.tsx`` and ``components/Rgba.tsx``): pressing Enter
in an RGB/RGBA input committed the value but left the Mantine ``ColorInput``
popover (the color picker) open. Every other GUI input dismisses its editor on
Enter, so the fix blurs the input -- which closes the popover -- on Enter.
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

import viser

from .utils import find_gui_input


@pytest.mark.parametrize("kind", ["rgb", "rgba"])
def test_color_input_enter_closes_popover(
    viser_server: viser.ViserServer,
    viser_page: Page,
    kind: str,
) -> None:
    """Clicking the input opens the picker; pressing Enter should close it."""
    if kind == "rgb":
        viser_server.gui.add_rgb("Color", initial_value=(255, 0, 0))
    else:
        viser_server.gui.add_rgba("Color", initial_value=(255, 0, 0, 255))

    inp = find_gui_input(viser_page, "Color")
    inp.wait_for(state="visible", timeout=5_000)

    # The ColorInput's saturation area is mounted only while the picker
    # popover is open.
    picker = viser_page.locator('[class*="ColorInput-saturation"]')

    # Clicking the input opens the popover.
    inp.click()
    expect(picker.first).to_be_visible(timeout=5_000)

    # Pressing Enter commits and closes the popover.
    inp.press("Enter")
    expect(picker).to_have_count(0, timeout=5_000)
