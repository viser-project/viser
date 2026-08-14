"""E2E tests for the slider number box's display precision.

Complement to ``test_bug_slider_precision.py`` (integer sliders must not emit
fractional values): precision is fed by the server-computed ``precision``
prop, which must cover the slider's VALUE GRID (``min + k * step``, clamped
to ``max``), not just ``step``. Regression: with ``min=0.5, step=1.0`` every
legal value ends in .5, but a step-derived precision of 0 displayed 2.5 as
"3" and swallowed the "." keystroke, so exact values could not be typed.
"""

from __future__ import annotations

from playwright.sync_api import Page, expect

import viser

from .utils import find_gui_input


def test_offgrid_slider_displays_and_accepts_exact_values(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    handle = viser_server.gui.add_slider(
        "frac", min=0.5, max=9.5, step=1.0, initial_value=2.5
    )

    box = find_gui_input(viser_page, "frac")
    box.wait_for(state="visible", timeout=5_000)
    # The initial value must DISPLAY exactly (regression: showed "3").
    expect(box).to_have_value("2.5", timeout=5_000)

    # Typing an exact on-grid value must be accepted (regression: rejected
    # decimals) and must round-trip to the server.
    box.click()
    box.press("Control+a")
    box.fill("4.5")
    box.press("Enter")
    expect(box).to_have_value("4.5")
    viser_page.wait_for_timeout(400)
    assert handle.value == 4.5, f"server value is {handle.value}, expected 4.5"


def test_integer_slider_box_stays_integer_display(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Integer grids keep precision 0: whole-number display, and (per the
    sibling test) fractional input stays rejected."""
    viser_server.gui.add_slider("int", min=0, max=10, step=1, initial_value=5)
    box = find_gui_input(viser_page, "int")
    box.wait_for(state="visible", timeout=5_000)
    expect(box).to_have_value("5", timeout=5_000)
