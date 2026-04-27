"""E2E tests for WebGL detection and browser warning notifications."""

from __future__ import annotations

from playwright.sync_api import Page, expect

import viser

from .utils import wait_for_connection

# Mock getContext to simulate WebGL being unavailable (returns null).
MOCK_WEBGL_UNAVAILABLE = """
(function() {
    const _orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (type === 'webgl2' || type === 'webgl') return null;
        return _orig.call(this, type, ...args);
    };
})();
"""

# Mock getContext to simulate context creation failure (throws).
MOCK_WEBGL_CONTEXT_FAILED = """
(function() {
    const _orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (type === 'webgl2' || type === 'webgl') throw new Error('WebGL unavailable');
        return _orig.call(this, type, ...args);
    };
})();
"""


def test_no_webgl_error_when_webgl_works(viser_page: Page) -> None:
    """No WebGL-failure notification should appear when WebGL is available."""
    viser_page.wait_for_timeout(2_000)
    expect(viser_page.get_by_text("WebGL unavailable")).not_to_be_visible()


def test_webgl_unavailable_shows_notification(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """When getContext returns null, a red 'WebGL unavailable' notification appears."""
    page.add_init_script(MOCK_WEBGL_UNAVAILABLE)
    wait_for_connection(page, viser_server.get_port())

    expect(page.get_by_text("WebGL unavailable")).to_be_visible(timeout=5_000)


def test_webgl_context_failed_shows_notification(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """When getContext throws, a red 'WebGL unavailable' notification appears."""
    page.add_init_script(MOCK_WEBGL_CONTEXT_FAILED)
    wait_for_connection(page, viser_server.get_port())

    expect(page.get_by_text("WebGL unavailable")).to_be_visible(timeout=5_000)


def test_webgl_notification_shown_only_once(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """The notification should appear exactly once (useEffect runs with [], not on every render)."""
    page.add_init_script(MOCK_WEBGL_UNAVAILABLE)
    wait_for_connection(page, viser_server.get_port())

    title = page.get_by_text("WebGL unavailable")
    expect(title).to_be_visible(timeout=5_000)
    page.wait_for_timeout(1_000)
    expect(title).to_have_count(1)
