"""E2E regression test: ?darkMode must override a server-sent theme.

A server that calls ``configure_theme()`` sends ``dark_mode=False`` (the
default), which must NOT override an explicit ``?darkMode`` in the URL.

Regression history: dark mode was first applied in a post-mount effect (a
one-frame light flash), then seeded at store creation -- but a server theme
message then overrode it back to light. The URL flag now wins at the rendered
color-scheme consumption point, so it beats the server theme and is correct on
the first paint.
"""

from __future__ import annotations

from playwright.sync_api import Page, expect

import viser


def test_darkmode_url_overrides_server_theme(
    viser_server: viser.ViserServer,
    page: Page,
) -> None:
    # The server configures a theme (e.g. a brand color); dark_mode defaults to
    # False, which previously clobbered the URL's ?darkMode.
    viser_server.gui.configure_theme(brand_color=(255, 100, 0))
    viser_server.gui.add_button("hi")

    port = viser_server.get_port()
    page.goto(f"http://localhost:{port}/?darkMode")
    page.wait_for_function(
        "() => !document.body.innerText.includes('Connecting...')",
        timeout=15_000,
    )

    # The rendered color scheme must be dark despite the server theme...
    html = page.locator("html")
    expect(html).to_have_attribute(
        "data-mantine-color-scheme", "dark", timeout=5_000
    )
    # ...and must stay dark after the server's theme message has applied.
    page.wait_for_timeout(800)
    assert (
        page.evaluate(
            "document.documentElement.getAttribute('data-mantine-color-scheme')"
        )
        == "dark"
    )
