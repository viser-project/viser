"""E2E test for spotlight direction (GitHub issue #645).

SpotLight should respect a ``direction`` parameter instead of always
pointing at the world origin.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node

# JavaScript snippet that returns the spotlight target's position in the
# group's local frame. This avoids viser's coordinate-system transform.
JS_GET_SPOTLIGHT_TARGET_LOCAL_POS = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return null;
    const obj = m.nodeRefFromName[nodeName];
    if (!obj) return null;

    // Find the SpotLight in the subtree.
    let spotlight = null;
    obj.traverse((child) => {
        if (child.isSpotLight) spotlight = child;
    });
    if (!spotlight || !spotlight.target) return null;

    // Return the target's local position within the group.
    const t = spotlight.target.position;
    return [t.x, t.y, t.z];
}
"""


def test_spotlight_direction_default(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A spotlight with default direction should have target at (0, 0, -1)
    in its local frame (i.e. NOT at the world origin)."""
    viser_server.scene.add_light_spot(
        "/test_spot_default",
        position=(5.0, 5.0, 5.0),
        intensity=50.0,
    )

    wait_for_scene_node(viser_page, "/test_spot_default")
    viser_page.wait_for_timeout(500)

    target_pos = viser_page.evaluate(
        JS_GET_SPOTLIGHT_TARGET_LOCAL_POS, "/test_spot_default"
    )
    assert target_pos is not None, "Could not find SpotLight or its target"

    # Default direction is (0, 0, -1), so target should be at (0, 0, -1)
    # in the group's local frame.
    tx, ty, tz = target_pos
    assert abs(tx) < 0.01, f"Expected tx~0, got {tx}"
    assert abs(ty) < 0.01, f"Expected ty~0, got {ty}"
    assert abs(tz - (-1.0)) < 0.01, f"Expected tz~-1, got {tz}"


def test_spotlight_direction_custom(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A spotlight with direction=(1, 0, 0) should have target at (1, 0, 0)."""
    viser_server.scene.add_light_spot(
        "/test_spot_custom",
        position=(0.0, 5.0, 5.0),
        intensity=50.0,
        direction=(1.0, 0.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_spot_custom")
    viser_page.wait_for_timeout(500)

    target_pos = viser_page.evaluate(
        JS_GET_SPOTLIGHT_TARGET_LOCAL_POS, "/test_spot_custom"
    )
    assert target_pos is not None, "Could not find SpotLight or its target"

    tx, ty, tz = target_pos
    assert abs(tx - 1.0) < 0.01, f"Expected tx~1, got {tx}"
    assert abs(ty) < 0.01, f"Expected ty~0, got {ty}"
    assert abs(tz) < 0.01, f"Expected tz~0, got {tz}"
