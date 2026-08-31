"""CJK label rendering.

The label renderer rasterizes glyphs with the system font stack, so CJK text
(unrepresentable in the previously-embedded Latin font) must render as real
glyphs rather than tofu. CJK also exercises the renderer's streaming path
harder than Latin text: every character is a unique grapheme cluster, so a
label's glyphs can arrive over multiple frames of the per-frame
rasterization budget before the label appears.

Reuses the dark-pixel harness from test_label_render_order: glyphs render
near-black over the label's white background quad, and the polling assert
tolerates budget-deferred frames while still failing loudly if glyphs never
arrive (or render washed out).
"""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Browser

import viser
import viser._client_autobuild

from .test_label_render_order import _assert_glyphs_dark_on_both_surfaces
from .utils import connect_client, find_free_port, wait_for_server_ready


@pytest.fixture()
def own_server() -> Generator[viser.ViserServer, None, None]:
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server: viser.ViserServer | None = None
    for attempt in range(3):
        try:
            server = viser.ViserServer(port=find_free_port(), verbose=False)
            break
        except OSError:
            if attempt == 2:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())
    yield server
    server.stop()


def test_cjk_label_renders(own_server: viser.ViserServer, browser: Browser) -> None:
    """A mixed Han/kana/hangul label renders dark glyphs on both surfaces."""
    client, page, context = connect_client(own_server, browser)
    try:
        own_server.scene.add_label(
            "/cjk",
            "点云 ポイント 포인트",
            position=(0.0, 0.0, 0.0),
            font_screen_scale=2.0,
        )
        _assert_glyphs_dark_on_both_surfaces(client, page, "for a CJK label")
    finally:
        context.close()


def test_cjk_glyphs_stream_to_completion(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A label with many unique CJK glyphs fully streams in.

    ~60 unique characters take several frames of the rasterization budget;
    this pins that deferred groups eventually build (no livelock, no lost
    glyphs) by requiring substantially more dark pixels than a short label
    produces.
    """
    import time

    client, page, context = connect_client(own_server, browser)
    try:
        # 60 unique Han characters across three lines.
        text = "".join(
            chr(0x4E00 + i * 13) + ("\n" if i % 20 == 19 else "") for i in range(60)
        )
        own_server.scene.add_label(
            "/cjk_many",
            text,
            position=(0.0, 0.0, 0.0),
            font_screen_scale=2.0,
            anchor="center-center",
        )
        # First wait for any glyphs, then for the pixel count to plateau
        # (streaming finished), then require a count consistent with the
        # full glyph set rather than a partial first batch.
        from .test_label_render_order import _live_dark_pixels

        deadline = time.monotonic() + 30.0
        last, stable_since = -1, time.monotonic()
        while time.monotonic() < deadline:
            count = _live_dark_pixels(page)
            if count != last:
                last, stable_since = count, time.monotonic()
            elif count > 0 and time.monotonic() - stable_since > 2.0:
                break
            time.sleep(0.25)
        assert last > 300, (
            f"only {last} near-black pixels after streaming settled -- "
            "expected a fully-streamed 60-glyph CJK label"
        )
    finally:
        context.close()
