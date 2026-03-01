"""E2E test for hover count resetting when visibility is toggled.

This test verifies that when a clickable node is hidden while hovered,
the hoveredElementsCount properly resets to 0 and the cursor returns to "auto".
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node, wait_for_scene_node_hidden


def test_hover_count_resets_on_visibility_toggle(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Test that hoveredElementsCount resets to 0 when a hovered clickable node is hidden.

    This test verifies the fix for the bug where the onPointerOut handler would return
    early without decrementing hoveredElementsCount when the node is not displayed.
    The fix ensures hover state is properly cleaned up when visibility changes.
    """
    # Create a clickable box with an on_click callback.
    click_counter = {"count": 0}

    def on_click_handler(event: viser.ScenePointerEvent) -> None:
        click_counter["count"] += 1

    # Create a large box that fills most of the viewport for easier targeting.
    box_handle = viser_server.scene.add_box(
        "/test_clickable_box",
        dimensions=(5.0, 5.0, 5.0),
        position=(0.0, 0.0, 0.0),
        color=(255, 0, 0),
    )
    box_handle.on_click(on_click_handler)

    # Wait for the box to appear in the scene.
    wait_for_scene_node(viser_page, "/test_clickable_box")

    # Wait for hoveredElementsCount to be initialized (confirms mutable state is ready).
    viser_page.wait_for_function(
        "() => window.__viserMutable && window.__viserMutable.hoveredElementsCount === 0",
        timeout=5_000,
    )

    # Find the canvas element.
    canvas = viser_page.locator("canvas").first

    # Get canvas center position for hovering.
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None, "Canvas bounding box not found"

    center_x = canvas_box["x"] + canvas_box["width"] / 2
    center_y = canvas_box["y"] + canvas_box["height"] / 2

    # Move mouse to the center of the canvas to hover over the box.
    viser_page.mouse.move(center_x, center_y)

    # Poll until hoveredElementsCount becomes > 0 (hover event processed).
    viser_page.wait_for_function(
        "() => window.__viserMutable.hoveredElementsCount > 0",
        timeout=5_000,
    )

    # Also verify cursor changed to pointer.
    viser_page.wait_for_function(
        "() => document.body.style.cursor === 'pointer'",
        timeout=5_000,
    )

    # Now hide the box while the mouse is still hovering over its position.
    box_handle.visible = False

    # Wait for the visibility change to propagate to the Three.js scene.
    wait_for_scene_node_hidden(viser_page, "/test_clickable_box")

    # Verify that hoveredElementsCount resets to 0 when the node is hidden.
    viser_page.wait_for_function(
        "() => window.__viserMutable.hoveredElementsCount === 0",
        timeout=5_000,
    )

    # Verify that cursor returns to auto.
    viser_page.wait_for_function(
        "() => document.body.style.cursor === 'auto'",
        timeout=5_000,
    )
