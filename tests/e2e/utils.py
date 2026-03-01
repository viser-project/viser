"""Shared utilities for viser E2E tests: helpers and JS snippets."""

from __future__ import annotations

import socket
import time

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
