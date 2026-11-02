"""Vertex-color alpha from trimesh RGBA colors must render translucent (#525).

trimesh exports RGBA vertex/face colors as a VEC4 glTF ``COLOR_0`` attribute,
with no material entry. three.js blends the alpha into the fragment color, but
GLTFLoader never marks the material transparent, so the client has to.
"""

from __future__ import annotations

import numpy as np
import pytest
import trimesh
from playwright.sync_api import Browser, Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

import viser

from .utils import connect_client

# [transparent flag, COLOR_0 itemSize] for every mesh under a scene node,
# excluding the ShadowMaterial overlay that a float `receive_shadow` adds.
JS_MESH_MATERIAL_INFO = """
(nodeName) => {
    const m = window.__viserMutable;
    const obj = m && m.nodeRefFromName ? m.nodeRefFromName[nodeName] : null;
    if (!obj) return null;
    const out = [];
    obj.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        const color = child.geometry.getAttribute('color');
        for (const material of materials) {
            if (material.type === 'ShadowMaterial') continue;
            out.push([material.transparent, color ? color.itemSize : 0]);
        }
    });
    return out.length > 0 ? out : null;
}
"""


def _wait_for_mesh_info(page: Page, node_name: str) -> list[list]:
    try:
        page.wait_for_function(
            f"(nodeName) => ({JS_MESH_MATERIAL_INFO})(nodeName) !== null",
            arg=node_name,
            timeout=10_000,
        )
    except PlaywrightTimeoutError:
        pytest.fail(f"{node_name}: no loaded mesh found on the client")
    return page.evaluate(JS_MESH_MATERIAL_INFO, node_name)


def _cylinder(rgba: list[int]) -> trimesh.Trimesh:
    mesh = trimesh.creation.cylinder(radius=0.5, height=2.0, sections=16)
    mesh.visual.face_colors = rgba
    return mesh


@pytest.mark.parametrize("alpha", [76, 153])
def test_translucent_face_colors_mark_material_transparent(
    viser_server: viser.ViserServer, viser_page: Page, alpha: int
) -> None:
    """The repro from #525: RGBA face colors with alpha < 255."""
    viser_server.scene.add_mesh_trimesh("/translucent", _cylinder([255, 0, 0, alpha]))
    info = _wait_for_mesh_info(viser_page, "/translucent")
    assert info == [[True, 4]], info


def test_opaque_face_colors_stay_opaque(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Alpha 255 everywhere must not move the mesh into the transparent pass."""
    viser_server.scene.add_mesh_trimesh("/opaque", _cylinder([0, 0, 255, 255]))
    info = _wait_for_mesh_info(viser_page, "/opaque")
    assert info == [[False, 4]], info


def test_translucent_vertex_colors_mark_material_transparent(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Per-vertex RGBA takes the same glTF path as face colors."""
    mesh = trimesh.creation.box()
    colors = np.tile(
        np.array([[0, 255, 0, 153]], dtype=np.uint8), (len(mesh.vertices), 1)
    )
    mesh.visual.vertex_colors = colors
    viser_server.scene.add_mesh_trimesh("/vertex_rgba", mesh)
    info = _wait_for_mesh_info(viser_page, "/vertex_rgba")
    assert info == [[True, 4]], info


def _render_view_center(
    server: viser.ViserServer, browser: Browser, node_name: str
) -> np.ndarray:
    """Mean RGBA around the center of a fresh client's default view, once the
    GLB under ``node_name`` has finished its (async) parse on that client."""
    client, page, context = connect_client(server, browser)
    try:
        _wait_for_mesh_info(page, node_name)
        img = client.get_render(
            height=96, width=128, transport_format="png", timeout=30.0
        )
    finally:
        context.close()
    h, w = img.shape[:2]
    return (
        img[h // 2 - 8 : h // 2 + 8, w // 2 - 8 : w // 2 + 8]
        .reshape(-1, 4)
        .mean(axis=0)
    )


def test_translucent_mesh_renders_blended(
    viser_server: viser.ViserServer, browser: Browser
) -> None:
    """A 30%-alpha red box must not render the same as an opaque red box."""
    box = trimesh.creation.box(extents=(2.0, 2.0, 2.0))
    box.visual.face_colors = [255, 0, 0, 255]
    handle = viser_server.scene.add_mesh_trimesh("/box", box)
    opaque = _render_view_center(viser_server, browser, "/box")

    handle.remove()
    box.visual.face_colors = [255, 0, 0, 76]
    viser_server.scene.add_mesh_trimesh("/box", box)
    translucent = _render_view_center(viser_server, browser, "/box")

    # The render is composited over a transparent canvas and read back with
    # straight alpha, so the box's coverage lands in the alpha channel: an
    # opaque box fills it, a 30%-alpha box (76/255) leaves it mostly empty.
    assert opaque[0] > opaque[1] + 40 and opaque[0] > opaque[2] + 40, opaque
    assert opaque[3] > 250, opaque
    assert 40 < translucent[3] < 120, (opaque, translucent)


def test_mixed_glb_keeps_opaque_materials_opaque(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A translucent primitive must not flip materials shared with opaque ones.

    glTF primitives that carry COLOR_0 but no material share one material
    instance in the loader's cache, so a transparency flag set for one
    primitive reaches every other material-less mesh in the same GLB.
    """
    opaque = trimesh.creation.box(extents=(0.5, 0.5, 0.5))
    opaque.visual.face_colors = [0, 0, 255, 255]
    translucent = trimesh.creation.cylinder(radius=0.3, height=1.0, sections=16)
    translucent.visual.face_colors = [255, 0, 0, 76]

    glb = trimesh.Scene([opaque, translucent]).export(file_type="glb")
    viser_server.scene.add_glb("/mixed", glb)

    info = _wait_for_mesh_info(viser_page, "/mixed")
    assert sorted(info) == [[False, 4], [True, 4]], info
