"""Shared utilities for viser E2E tests: helpers, JS snippets, image comparison."""

from __future__ import annotations

import io
import socket
import time
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import Locator, Page

# ---------------------------------------------------------------------------
# Network utilities
# ---------------------------------------------------------------------------


def find_free_port() -> int:
    """Find a free TCP port by binding to port 0 and reading the assigned port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def wait_for_server_ready(port: int, timeout: float = 5.0) -> None:
    """Poll until the server is accepting TCP connections."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("localhost", port), timeout=0.5):
                return
        except (ConnectionRefusedError, OSError):
            time.sleep(0.05)
    raise RuntimeError(f"Server on port {port} not ready within {timeout}s")


def find_gui_input(page: Page, label_text: str) -> Locator:
    """Find the input element in the same GUI control row as a label.

    Navigates from the label up to the Mantine Flex row and finds the
    ``<input>`` within.  More robust than using the label's ``for``
    attribute because some Mantine components assign internal IDs that
    don't match the ``for`` value.
    """
    label = page.locator("label", has_text=label_text)
    gui_row = label.locator("xpath=ancestor::div[contains(@class, 'Flex-root')][1]")
    return gui_row.locator("input:not([type='hidden'])")


def wait_for_connection(page: Page, port: int) -> None:
    """Navigate to the viser server and wait for WebSocket connection.

    The ConnectionStatus component displays "Connecting..." while disconnected
    and switches once the WebSocket handshake completes.
    """
    page.goto(f"http://localhost:{port}")
    page.wait_for_function(
        """() => {
            const body = document.body.innerText;
            return !body.includes('Connecting...');
        }""",
        timeout=15_000,
    )
    page.wait_for_timeout(500)


# ---------------------------------------------------------------------------
# JavaScript snippets for Three.js scene graph inspection
#
# These are injected via page.wait_for_function() or page.evaluate().
# They inspect window.__viserMutable and window.__viserSceneTree which are
# exposed by the viser client's SceneContextSetter component.
# ---------------------------------------------------------------------------

JS_SCENE_HAS_NODE = """
(nodeName) => {
    const m = window.__viserMutable;
    if (m && m.nodeRefFromName && m.nodeRefFromName[nodeName] != null) return true;
    const tree = window.__viserSceneTree;
    if (tree) {
        const state = tree.getState();
        if (state && state[nodeName]) return true;
    }
    return false;
}
"""

JS_SCENE_NODE_REMOVED = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return true;
    return m.nodeRefFromName[nodeName] == null;
}
"""

JS_SCENE_NODE_VISIBLE = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return false;
    const obj = m.nodeRefFromName[nodeName];
    return obj && obj.visible;
}
"""

JS_SCENE_NODE_HIDDEN = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return false;
    const obj = m.nodeRefFromName[nodeName];
    return obj && !obj.visible;
}
"""

JS_GET_MESH_CHILD_COUNT = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return -1;
    const obj = m.nodeRefFromName[nodeName];
    if (!obj) return -1;
    let count = 0;
    obj.traverse((child) => {
        if (child.isMesh) count++;
    });
    return count;
}
"""

JS_GET_SCENE_CHILD_NAMES = """
() => {
    const names = new Set();
    const m = window.__viserMutable;
    if (m && m.nodeRefFromName) {
        for (const k of Object.keys(m.nodeRefFromName)) {
            if (m.nodeRefFromName[k] != null) names.add(k);
        }
    }
    const tree = window.__viserSceneTree;
    if (tree) {
        const state = tree.getState();
        for (const k of Object.keys(state)) {
            if (k.startsWith('/')) names.add(k);
        }
    }
    return Array.from(names);
}
"""


def wait_for_scene_node(page: Page, node_name: str, timeout: int = 10_000) -> None:
    """Wait until a scene node with the given name exists in the Three.js graph."""
    page.wait_for_function(JS_SCENE_HAS_NODE, arg=node_name, timeout=timeout)


def wait_for_scene_node_removed(
    page: Page, node_name: str, timeout: int = 10_000
) -> None:
    """Wait until a scene node has been removed from the Three.js graph."""
    page.wait_for_function(JS_SCENE_NODE_REMOVED, arg=node_name, timeout=timeout)


def wait_for_scene_node_visible(
    page: Page, node_name: str, timeout: int = 10_000
) -> None:
    """Wait until a scene node's ``visible`` flag is ``true``."""
    page.wait_for_function(JS_SCENE_NODE_VISIBLE, arg=node_name, timeout=timeout)


def wait_for_scene_node_hidden(
    page: Page, node_name: str, timeout: int = 10_000
) -> None:
    """Wait until a scene node's ``visible`` flag is ``false``."""
    page.wait_for_function(JS_SCENE_NODE_HIDDEN, arg=node_name, timeout=timeout)


# ---------------------------------------------------------------------------
# Image comparison utilities
# ---------------------------------------------------------------------------


def pixel_diff(img1: Image.Image, img2: Image.Image) -> float:
    """Compute a normalised pixel difference ratio between two images.

    Both images are converted to RGB before comparison. If the images have
    different sizes, they are resized to the smaller dimensions.

    Returns:
        A float in [0, 1] where 0 means identical and 1 means every pixel
        differs by the maximum amount (255 per channel).
    """
    img1 = img1.convert("RGB")
    img2 = img2.convert("RGB")

    # Resize to common dimensions if needed.
    w = min(img1.width, img2.width)
    h = min(img1.height, img2.height)
    if img1.size != (w, h):
        img1 = img1.resize((w, h))
    if img2.size != (w, h):
        img2 = img2.resize((w, h))

    arr1 = np.asarray(img1, dtype=np.int16)
    arr2 = np.asarray(img2, dtype=np.int16)

    total_diff = int(np.abs(arr1 - arr2).sum())
    max_diff = w * h * 3 * 255
    return total_diff / max_diff if max_diff > 0 else 0.0


def screenshot_to_image(screenshot_bytes: bytes) -> Image.Image:
    """Convert Playwright screenshot bytes to a PIL Image."""
    return Image.open(io.BytesIO(screenshot_bytes))


def assert_images_similar(
    actual: Image.Image,
    reference: Image.Image,
    threshold: float = 0.02,
) -> None:
    """Assert that two images are similar within a pixel-diff threshold.

    Args:
        actual: The screenshot captured during the test.
        reference: The reference image to compare against.
        threshold: Maximum allowed normalised pixel difference (default 2%).

    Raises:
        AssertionError: If the diff exceeds the threshold.
    """
    diff = pixel_diff(actual, reference)
    assert diff <= threshold, f"Image diff {diff:.4f} exceeds threshold {threshold:.4f}"


def save_debug_screenshot(screenshot_bytes: bytes, name: str, output_dir: Path) -> Path:
    """Save a screenshot for debugging failed tests.

    Returns the path to the saved file.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{name}.png"
    path.write_bytes(screenshot_bytes)
    return path


# ---------------------------------------------------------------------------
# Visual regression: viewport constants and screenshot capture
# ---------------------------------------------------------------------------

# Fixed viewport for deterministic screenshots.
VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 720


def capture_screenshot(page: Page) -> bytes:
    """Capture a full-page screenshot at the fixed viewport size."""
    page.set_viewport_size({"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT})
    # Extra wait for rendering to settle after viewport resize.
    page.wait_for_timeout(500)
    return page.screenshot()
