"""Screenshot comparison tests for viser visual regression."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image
from playwright.sync_api import Page, expect

import viser

from .scenes import build_basic_scene, build_complex_scene, build_gui_panel
from .utils import (
    assert_images_similar,
    capture_screenshot,
    screenshot_to_image,
    wait_for_scene_node,
)


def _compare_or_save(
    screenshot_bytes: bytes,
    reference_images_dir: Path,
    name: str,
    *,
    update_baselines: bool,
    threshold: float = 0.02,
) -> None:
    """Compare a screenshot against its reference, or save as new baseline."""
    reference_images_dir.mkdir(parents=True, exist_ok=True)
    ref_path = reference_images_dir / f"{name}.png"
    actual = screenshot_to_image(screenshot_bytes)

    if update_baselines:
        actual.save(ref_path)
        return

    if not ref_path.exists():
        actual.save(ref_path)
        pytest.skip(
            f"No reference image '{ref_path.name}', run update-baselines workflow"
        )

    reference = Image.open(ref_path)
    assert_images_similar(actual, reference, threshold=threshold)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_basic_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
    reference_images_dir: Path,
    update_baselines: bool,
) -> None:
    """Render an icosphere + grid and compare to reference screenshot."""
    build_basic_scene(viser_server)

    wait_for_scene_node(viser_page, "/icosphere")
    wait_for_scene_node(viser_page, "/grid")
    viser_page.wait_for_timeout(1000)

    screenshot = capture_screenshot(viser_page)
    _compare_or_save(
        screenshot,
        reference_images_dir,
        "basic_scene_icosphere",
        update_baselines=update_baselines,
    )


def test_gui_panel(
    viser_server: viser.ViserServer,
    viser_page: Page,
    reference_images_dir: Path,
    update_baselines: bool,
) -> None:
    """Render a panel with various GUI controls and compare to reference."""
    build_gui_panel(viser_server)

    expect(viser_page.get_by_role("button", name="Click Me")).to_be_visible(
        timeout=5_000
    )
    expect(viser_page.locator("label", has_text="Count")).to_be_visible(timeout=5_000)
    viser_page.wait_for_timeout(1000)

    screenshot = capture_screenshot(viser_page)
    _compare_or_save(
        screenshot,
        reference_images_dir,
        "gui_panel_controls",
        update_baselines=update_baselines,
    )


def test_complex_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
    reference_images_dir: Path,
    update_baselines: bool,
) -> None:
    """Render a point cloud, labels, and frames, then compare to reference."""
    build_complex_scene(viser_server)

    for name in [
        "/points",
        "/frame_0",
        "/frame_1",
        "/frame_2",
        "/label_x",
        "/label_y",
        "/label_z",
    ]:
        wait_for_scene_node(viser_page, name)
    viser_page.wait_for_timeout(1500)

    screenshot = capture_screenshot(viser_page)
    _compare_or_save(
        screenshot,
        reference_images_dir,
        "complex_scene_pointcloud",
        update_baselines=update_baselines,
    )
