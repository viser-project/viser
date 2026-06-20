"""E2E regression test for global-visibility propagation on recompute.

Regression (``SceneTreeState.ts`` ``computeEffectiveVisibility``): the
parent-effective check was on ``parentName === ""`` (true for the root AND its
direct children), so a direct child recomputed after
``set_global_visibility(False)`` wrongly became ``effectiveVisibility = true``,
ignoring the globally-hidden root -- leaving it clickable / not unmounting its
Html content. The guard must be on ``name === ""`` (the root itself).
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node

JS_EFFECTIVE_VISIBILITY = """
(name) => {
    const tree = window.__viserSceneTree;
    if (!tree) return null;
    const node = tree.getState()[name];
    return node ? node.effectiveVisibility : 'MISSING';
}
"""


def test_child_stays_hidden_when_root_globally_hidden(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    frame = viser_server.scene.add_frame("/foo")
    wait_for_scene_node(viser_page, "/foo")

    viser_server.scene.set_global_visibility(False)
    viser_page.wait_for_function(
        "() => window.__viserSceneTree.getState()[''].effectiveVisibility === false",
        timeout=5_000,
    )
    viser_page.wait_for_function(
        "() => window.__viserSceneTree.getState()['/foo'].effectiveVisibility "
        "=== false",
        timeout=5_000,
    )

    # Toggling the child's own visibility triggers computeEffectiveVisibility for
    # the child; it must still respect the globally-hidden root.
    frame.visible = True
    viser_page.wait_for_timeout(500)
    eff = viser_page.evaluate(JS_EFFECTIVE_VISIBILITY, "/foo")
    assert eff is False, (
        f"child effectiveVisibility should remain False while the root is "
        f"globally hidden, got {eff!r}"
    )
