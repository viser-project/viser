"""E2E test for long underscore-separated label wrapping."""

from __future__ import annotations

from playwright.sync_api import Page

import viser


def test_long_underscore_label_wraps_within_container(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A long underscore-separated label should wrap and not overflow its container."""
    long_label = "this_is_a_very_long_label_with_underscores"
    viser_server.gui.add_checkbox(long_label, initial_value=True)

    label = viser_page.locator("label", has_text=long_label)
    label.wait_for(state="visible", timeout=5_000)

    # Brief reflow buffer before reading bounding boxes.
    viser_page.wait_for_timeout(300)

    label_box = label.bounding_box()
    assert label_box is not None

    # The label's container is the Box with a fixed em-based width.
    container = label.locator("xpath=ancestor::div[1]")
    container_box = container.bounding_box()
    assert container_box is not None

    # The label text should not extend beyond its container's right edge.
    label_right = label_box["x"] + label_box["width"]
    container_right = container_box["x"] + container_box["width"]
    assert label_right <= container_right + 1, (
        f"Label overflows container: label right edge ({label_right:.1f}) > "
        f"container right edge ({container_right:.1f})"
    )
