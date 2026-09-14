"""E2E tests for the on-demand render loop (``frameloop="demand"``).

Imperative scene mutations must call ``requestRender()``; otherwise the change
only shows up on the 1 Hz heartbeat. Each test here syncs to a heartbeat frame
first, performs one mutation, and requires a new frame well before the next
heartbeat would land. Frames are counted with ``scene.onBeforeRender``, which
the three.js renderer calls once per ``render()``.
"""

from __future__ import annotations

import numpy as np
import pytest
from playwright.sync_api import Page, expect
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

import viser

from .utils import (
    wait_for_connection,
    wait_for_mesh_children,
    wait_for_scene_node,
    wait_for_scene_node_hidden,
)

# Well under the 1000 ms heartbeat, well over a frame on slow software GL.
RESPONSE_BUDGET_MS = 500

JS_INSTALL_FRAME_COUNTER = """
() => {
    const m = window.__viserMutable;
    if (window.__frameCount === undefined) {
        window.__frameCount = 0;
        m.scene.onBeforeRender = () => { window.__frameCount++; };
    }
    return window.__frameCount;
}
"""

# Resolves (with the frame count) right after a heartbeat frame. The heartbeat
# is a free-running 1 s interval, so its phase is locked by observing two
# consecutive isolated frames ~1 s apart: wait until no frame has rendered for
# 400 ms (no settle window open), take the next frame, then require the frame
# after it to land 800-1500 ms later with nothing in between (an interval
# only drifts late under load). A stray frame from any other source breaks the
# spacing and restarts the search. The caller then has ~1 s before the
# heartbeat could mask a missing request.
JS_SYNC_TO_HEARTBEAT = """
() => new Promise((resolve, reject) => {
    const started = performance.now();
    let last = window.__frameCount;
    let quietSince = started;
    let firstAt = null;
    const tick = () => {
        const now = performance.now();
        if (now - started > 15000) return reject(new Error("could not lock heartbeat phase"));
        if (window.__frameCount !== last) {
            last = window.__frameCount;
            if (firstAt !== null) {
                const gap = now - firstAt;
                if (gap >= 800 && gap <= 1500) return resolve(window.__frameCount);
                firstAt = null;  // Not heartbeat spacing; start over.
            } else if (now - quietSince > 400) {
                firstAt = now;
            }
            quietSince = now;
        }
        setTimeout(tick, 2);
    };
    tick();
})
"""


JS_HAS_VISIBLE_DRAG_ARROW = """
() => {
    let visible = false;
    window.__viserMutable.scene.traverse((o) => {
        if (o.type === "ArrowHelper" && o.visible) visible = true;
    });
    return visible;
}
"""


def _expect_within_budget(page: Page, expression: str, message: str) -> None:
    """Require ``expression`` to hold within RESPONSE_BUDGET_MS."""
    try:
        page.wait_for_function(expression, timeout=RESPONSE_BUDGET_MS)
    except PlaywrightTimeoutError:
        pytest.fail(message)


def test_scene_tree_visibility_toggle_renders_promptly(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Clicking a node's eye icon must produce a frame with the node hidden
    within the response budget, not on the heartbeat."""
    viser_server.scene.add_box("/vis_box", dimensions=(1, 1, 1), color=(255, 0, 0))
    wait_for_scene_node(viser_page, "/vis_box")
    wait_for_mesh_children(viser_page, "/vis_box")

    row = viser_page.locator('[data-scene-node="/vis_box"]')
    expect(row).to_be_visible(timeout=10_000)
    eye = row.locator("svg.tabler-icon-eye")
    expect(eye).to_be_visible()
    eye.hover()  # Pointer parked on the icon; the click below adds no motion.

    viser_page.evaluate(JS_INSTALL_FRAME_COUNTER)
    viser_page.evaluate(JS_SYNC_TO_HEARTBEAT)
    viser_page.mouse.down()
    viser_page.mouse.up()

    # The store flips synchronously; this only confirms the click registered.
    viser_page.wait_for_function(
        "() => window.__viserSceneTree.getState()['/vis_box'].effectiveVisibility === false",
        timeout=200,
    )

    try:
        wait_for_scene_node_hidden(viser_page, "/vis_box", timeout=RESPONSE_BUDGET_MS)
    except PlaywrightTimeoutError:
        pytest.fail(
            f"node still visible on screen {RESPONSE_BUDGET_MS} ms after hiding "
            "it from the scene tree; the toggle did not request a render"
        )


def test_background_image_renders_promptly_after_slow_decode(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A background image whose decode outlasts the settle window must still
    be drawn promptly once installed, not on the heartbeat.

    Decode is made "slow" deterministically: the image's ``src`` assignment is
    held until just after a heartbeat frame, so the texture lands with no
    settle window open.
    """
    viser_page.evaluate(JS_INSTALL_FRAME_COUNTER)
    viser_page.evaluate(
        """() => {
            const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
            const sync = """
        + JS_SYNC_TO_HEARTBEAT
        + """;
            Object.defineProperty(HTMLImageElement.prototype, "src", {
                configurable: true,
                get() { return desc.get.call(this); },
                set(v) {
                    const img = this;
                    img.addEventListener("load", () => {
                        window.__bgLoadedAt = performance.now();
                        window.__bgLoadFrame = window.__frameCount;
                    }, { once: true });
                    sync().then(
                        () => desc.set.call(img, v),
                        (err) => { window.__syncError = String(err); desc.set.call(img, v); },
                    );
                },
            });
        }"""
    )

    image = np.full((64, 64, 3), (20, 200, 60), dtype=np.uint8)
    viser_server.scene.set_background_image(image, format="png")

    viser_page.wait_for_function(
        "() => window.__bgLoadedAt !== undefined", timeout=20_000
    )
    assert viser_page.evaluate("() => window.__syncError") is None
    _expect_within_budget(
        viser_page,
        "() => window.__frameCount > window.__bgLoadFrame",
        f"no frame within {RESPONSE_BUDGET_MS} ms of the background texture "
        "being installed; the load callback did not request a render",
    )


def test_drag_arrow_hides_promptly_on_release(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Releasing a scene-node drag hides the drag arrow imperatively; a frame
    must follow within the response budget.

    Contract test: this also passes without DragLayer's explicit request,
    because dropping the last camera-lock lease writes ``enabled`` through the
    proxied camera control, which requests a frame. It pins the observable
    behavior, not the mechanism.
    """
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)
    box = viser_server.scene.add_box(
        "/drag_box", dimensions=(4.0, 4.0, 0.2), color=(255, 120, 0)
    )
    box.on_drag("left", modifier="cmd/ctrl")(lambda _e: None)

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/drag_box")
    wait_for_mesh_children(page, "/drag_box")

    canvas_box = page.locator("canvas").first.bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    page.keyboard.down("Control")
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 120, cy + 40, steps=12)
    page.wait_for_function(JS_HAS_VISIBLE_DRAG_ARROW, timeout=5_000)

    page.evaluate(JS_INSTALL_FRAME_COUNTER)
    frame_at_sync = page.evaluate(JS_SYNC_TO_HEARTBEAT)
    page.mouse.up()
    page.keyboard.up("Control")

    _expect_within_budget(
        page,
        f"() => window.__frameCount > {frame_at_sync}",
        f"no frame within {RESPONSE_BUDGET_MS} ms of drag release; the arrow "
        "hide did not request a render",
    )
    assert not page.evaluate(JS_HAS_VISIBLE_DRAG_ARROW), "drag arrow still visible"
