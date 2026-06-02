"""E2E regression tests for GPU resource disposal leaks.

Each test removes or replaces a scene object and asserts that the GPU resources
it created are actually freed. They follow the same dispose-tracking strategy as
``test_dispose_resources.py`` and ``test_bug_texture_leak.py``: read
``window.__viserTestpoints.rendererInfo`` for live geometry/texture counts, and
monkeypatch ``dispose()`` on the live object to detect whether it is freed.

Covered:
- GLB geometry disposal on removal -> ``test_glb_dispose_geometry_leak``
- Background depth-texture disposal when depth is removed ->
  ``test_background_depth_texture_disposed_when_depth_removed``
"""

from __future__ import annotations

import numpy as np
import pytest
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node, wait_for_scene_node_removed

JS_GET_MEMORY_INFO = """
() => {
    const tp = window.__viserTestpoints;
    if (!tp || !tp.rendererInfo) return null;
    return {
        geometries: tp.rendererInfo.memory.geometries,
        textures: tp.rendererInfo.memory.textures,
        programs: tp.rendererInfo.programs ? tp.rendererInfo.programs.length : -1,
    };
}
"""


def _get_memory(page: Page) -> dict:
    info = page.evaluate(JS_GET_MEMORY_INFO)
    assert info is not None, "window.__viserTestpoints.rendererInfo not available"
    return info


# ---------------------------------------------------------------------------
# GLB geometry disposal (GlbLoaderUtils.ts)
# ---------------------------------------------------------------------------


def test_glb_dispose_geometry_leak(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a GLB should dispose the geometries it created.

    Regression: ``useGlbLoader``'s cleanup captured a stale ``gltf``, so the
    parsed GLB's geometries/materials could be left undisposed. Repeated
    add/remove cycles then leaked a BufferGeometry each time and the geometry
    count climbed monotonically.
    """
    trimesh = pytest.importorskip("trimesh")

    # A box exports to a tiny self-contained GLB with one primitive.
    glb_bytes: bytes = trimesh.Scene(
        trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    ).export(file_type="glb")

    # Let the scene fully initialize before baselining.
    viser_page.wait_for_timeout(2000)

    counts = []
    for _ in range(3):
        handle = viser_server.scene.add_glb("/test_glb_dispose", glb_data=glb_bytes)
        wait_for_scene_node(viser_page, "/test_glb_dispose")
        # Wait until the GLB has actually parsed into a rendered mesh (geometry
        # uploaded), otherwise the count read below is meaningless.
        viser_page.wait_for_function(
            """() => {
                const n = window.__viserMutable?.nodeRefFromName?.['/test_glb_dispose'];
                if (!n) return false;
                let hasMesh = false;
                n.traverse((o) => { if (o.isMesh && o.geometry) hasMesh = true; });
                return hasMesh;
            }""",
            timeout=10_000,
        )
        viser_page.wait_for_timeout(500)

        handle.remove()
        wait_for_scene_node_removed(viser_page, "/test_glb_dispose")
        viser_page.wait_for_timeout(700)

        counts.append(_get_memory(viser_page)["geometries"])

    assert counts[-1] <= counts[0], (
        f"Geometry count grew across GLB add/remove cycles (leak). Counts: {counts}"
    )


# ---------------------------------------------------------------------------
# Background depth-texture disposal (MessageHandler.tsx)
# ---------------------------------------------------------------------------

# Wait until the background material has a real depth texture bound and the
# `hasDepth` uniform is on.
JS_DEPTH_TEXTURE_READY = """
() => {
    const u = window.__viserMutable?.backgroundMaterial?.uniforms;
    if (!u) return false;
    const tex = u.depthMap?.value;
    return !!(tex && tex.isTexture && u.hasDepth?.value === true);
}
"""

# Patch the *current* depth texture's dispose() so we can detect whether it is
# disposed when depth is later removed.
JS_PATCH_DEPTH_DISPOSE = """
() => {
    const tex = window.__viserMutable.backgroundMaterial.uniforms.depthMap.value;
    window.__depthDisposed = false;
    const orig = tex.dispose.bind(tex);
    tex.dispose = function () {
        window.__depthDisposed = true;
        return orig();
    };
    return tex.uuid;
}
"""

JS_HAS_DEPTH_OFF = """
() => window.__viserMutable?.backgroundMaterial?.uniforms?.hasDepth?.value === false
"""


def test_background_depth_texture_disposed_when_depth_removed(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Switching the background from with-depth to without-depth should dispose
    the orphaned depth texture.

    Regression (MessageHandler.tsx ``BackgroundImageMessage``): when
    ``depth_data === null`` the handler set ``hasDepth = false`` but never
    disposed the existing ``depthMap`` texture, so the GPU depth texture was
    orphaned (kept alive by the uniform, never freed) until -- if ever -- depth
    was set again.
    """
    rgb = np.random.randint(0, 255, (64, 64, 3), dtype=np.uint8)
    depth = np.random.rand(64, 64).astype(np.float32)

    # 1. Background with depth.
    viser_server.scene.set_background_image(rgb, depth=depth)
    viser_page.wait_for_function(JS_DEPTH_TEXTURE_READY, timeout=10_000)

    # 2. Instrument the live depth texture's dispose().
    depth_uuid = viser_page.evaluate(JS_PATCH_DEPTH_DISPOSE)
    assert isinstance(depth_uuid, str) and depth_uuid

    # 3. Background without depth -- this should free the depth texture.
    viser_server.scene.set_background_image(rgb)
    viser_page.wait_for_function(JS_HAS_DEPTH_OFF, timeout=10_000)

    # Give any dispose() a chance to run.
    viser_page.wait_for_timeout(500)

    disposed = viser_page.evaluate("() => window.__depthDisposed === true")
    assert disposed, (
        "Depth texture was not disposed when the background switched to "
        "no-depth; it is orphaned on the GPU (MessageHandler leaves "
        "depthMap.value undisposed when depth_data is null)."
    )
