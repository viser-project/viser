"""E2E test for ShadowMaterial disposal in BasicMesh.

Uses dispose-tracking monkey-patches to verify that ShadowMaterial objects
are properly disposed when meshes are removed or their shadow opacity changes.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node, wait_for_scene_node_removed

# JS: find the ShadowMaterial under a node and monkey-patch its dispose().
JS_PATCH_SHADOW_MATERIAL_DISPOSE = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return false;
    const obj = m.nodeRefFromName[nodeName];
    if (!obj) return false;
    let patched = false;
    obj.traverse((child) => {
        if (child.isMesh && child.material &&
            child.material.type === 'ShadowMaterial' &&
            !child.material.__disposePatched) {
            child.material.__disposePatched = true;
            child.material.__wasDisposed = false;
            const origDispose = child.material.dispose.bind(child.material);
            child.material.dispose = function() {
                this.__wasDisposed = true;
                origDispose();
            };
            // Store a global reference so we can check it after the node is removed.
            window.__trackedShadowMaterial = child.material;
            patched = true;
        }
    });
    return patched;
}
"""

# JS: check whether a node has a ShadowMaterial child.
JS_NODE_HAS_SHADOW_MATERIAL = """
(nodeName) => {
    const m = window.__viserMutable;
    if (!m || !m.nodeRefFromName) return false;
    const obj = m.nodeRefFromName[nodeName];
    if (!obj) return false;
    let found = false;
    obj.traverse((child) => {
        if (child.isMesh && child.material &&
            child.material.type === 'ShadowMaterial') found = true;
    });
    return found;
}
"""

# JS: check whether the tracked ShadowMaterial had its dispose() called.
JS_TRACKED_MATERIAL_WAS_DISPOSED = """
() => {
    const mat = window.__trackedShadowMaterial;
    return mat ? mat.__wasDisposed === true : false;
}
"""


def test_shadow_material_disposed_on_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a mesh with receive_shadow should dispose its ShadowMaterial."""
    handle = viser_server.scene.add_box(
        "/shadow_box",
        color=(255, 0, 0),
        dimensions=(1.0, 1.0, 1.0),
        receive_shadow=0.5,
        position=(0.0, 0.0, 0.0),
    )

    # Wait for the node and its ShadowMaterial to appear.
    wait_for_scene_node(viser_page, "/shadow_box")
    viser_page.wait_for_function(
        JS_NODE_HAS_SHADOW_MATERIAL, arg="/shadow_box", timeout=10_000
    )

    # Monkey-patch the ShadowMaterial's dispose() to track disposal.
    patched = viser_page.evaluate(JS_PATCH_SHADOW_MATERIAL_DISPOSE, "/shadow_box")
    assert patched, "Failed to find and patch ShadowMaterial on the box."

    # Remove the box.
    handle.remove()
    wait_for_scene_node_removed(viser_page, "/shadow_box")

    # The tracked ShadowMaterial should have been disposed.
    viser_page.wait_for_function(JS_TRACKED_MATERIAL_WAS_DISPOSED, timeout=10_000)


def test_shadow_material_disposed_on_opacity_change(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Changing shadow opacity should dispose the old ShadowMaterial."""
    viser_server.scene.add_box(
        "/opacity_box",
        color=(0, 255, 0),
        dimensions=(1.0, 1.0, 1.0),
        receive_shadow=0.3,
        position=(0.0, 0.0, 0.0),
    )

    # Wait for the node and its ShadowMaterial to appear.
    wait_for_scene_node(viser_page, "/opacity_box")
    viser_page.wait_for_function(
        JS_NODE_HAS_SHADOW_MATERIAL, arg="/opacity_box", timeout=10_000
    )

    # Monkey-patch the current ShadowMaterial's dispose().
    patched = viser_page.evaluate(JS_PATCH_SHADOW_MATERIAL_DISPOSE, "/opacity_box")
    assert patched, "Failed to find and patch ShadowMaterial on the box."

    # Change the opacity, which should create a new ShadowMaterial and dispose the old one.
    viser_server.scene.add_box(
        "/opacity_box",
        color=(0, 255, 0),
        dimensions=(1.0, 1.0, 1.0),
        receive_shadow=0.7,
        position=(0.0, 0.0, 0.0),
    )

    # The old ShadowMaterial should have been disposed.
    viser_page.wait_for_function(JS_TRACKED_MATERIAL_WAS_DISPOSED, timeout=10_000)
