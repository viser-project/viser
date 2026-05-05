"""E2E tests for StateSerializer.as_html() and SceneApi.as_html()."""

from __future__ import annotations

import tempfile
from pathlib import Path

from playwright.sync_api import Page

import viser

from .utils import JS_GET_SCENE_CHILD_NAMES, wait_for_scene_node


def test_as_html_returns_valid_html(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """as_html() should return a complete HTML document with embedded scene data."""
    viser_server.scene.add_icosphere("/html_sphere", radius=0.5, color=(255, 0, 0))

    # Wait for the scene to be populated on the server side.
    wait_for_scene_node(viser_page, "/html_sphere")

    html = viser_server.scene.as_html()

    assert isinstance(html, str)
    assert "<!doctype html>" in html.lower() or "<html" in html.lower()
    assert "__VISER_EMBED_DATA__" in html
    assert "__VISER_EMBED_CONFIG__" in html


def test_as_html_dark_mode(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """as_html(dark_mode=True) should inject darkMode:true in the config."""
    viser_server.scene.add_box("/dark_box", dimensions=(1.0, 1.0, 1.0))
    wait_for_scene_node(viser_page, "/dark_box")

    html_light = viser_server.scene.as_html(dark_mode=False)
    html_dark = viser_server.scene.as_html(dark_mode=True)

    assert "darkMode:false" in html_light
    assert "darkMode:true" in html_dark


def test_as_html_renders_scene(
    viser_server: viser.ViserServer,
    page: Page,
    viser_page: Page,
) -> None:
    """The standalone HTML from as_html() should render the scene when loaded."""
    viser_server.scene.add_icosphere("/render_sphere", radius=0.3, color=(0, 255, 0))
    viser_server.scene.add_box(
        "/render_box", dimensions=(0.5, 0.5, 0.5), color=(0, 0, 255)
    )
    wait_for_scene_node(viser_page, "/render_sphere")
    wait_for_scene_node(viser_page, "/render_box")

    html = viser_server.scene.as_html()

    # Write to a temp file and load it in a fresh page (no server needed).
    with tempfile.NamedTemporaryFile(
        "w", suffix=".html", delete=False, encoding="utf-8"
    ) as f:
        f.write(html)
        tmp_path = f.name

    page.goto(f"file://{tmp_path}")

    # The embedded viewer should render a canvas.
    canvas = page.locator("canvas")
    canvas.first.wait_for(state="visible", timeout=15_000)

    # The scene nodes from the serialized data should appear.
    page.wait_for_function(
        """() => {
            const m = window.__viserMutable;
            return m && m.nodeRefFromName
                && m.nodeRefFromName['/render_sphere'] != null
                && m.nodeRefFromName['/render_box'] != null;
        }""",
        timeout=15_000,
    )

    names = page.evaluate(JS_GET_SCENE_CHILD_NAMES)
    assert "/render_sphere" in names
    assert "/render_box" in names

    Path(tmp_path).unlink(missing_ok=True)


def test_serializer_as_html(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """StateSerializer.as_html() should work directly."""
    viser_server.scene.add_frame("/ser_frame", show_axes=True)
    wait_for_scene_node(viser_page, "/ser_frame")

    serializer = viser_server.get_scene_serializer()
    html = serializer.as_html(dark_mode=True)

    assert isinstance(html, str)
    assert "__VISER_EMBED_DATA__" in html
    assert "darkMode:true" in html
