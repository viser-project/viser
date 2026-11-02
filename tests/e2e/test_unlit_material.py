"""E2E tests for ``material="unlit"`` on the mesh primitives (issue #620).

An unlit mesh must render with a ``MeshBasicMaterial``, which ignores scene
lighting, so its color shows exactly as given with no shading.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pytest
import trimesh
from playwright.sync_api import Browser, Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

import viser

from .utils import connect_client

# Material types of the meshes under a scene node, excluding the ShadowMaterial
# overlay that a float `receive_shadow` adds.
JS_MATERIAL_TYPES = """
(nodeName) => {
    const m = window.__viserMutable;
    const obj = m && m.nodeRefFromName ? m.nodeRefFromName[nodeName] : null;
    if (!obj) return null;
    const types = new Set();
    obj.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            if (material.type !== 'ShadowMaterial') types.add(material.type);
        }
    });
    return [...types].sort();
}
"""


def _wait_for_material_types(page: Page, node_name: str, expected: list[str]) -> None:
    try:
        page.wait_for_function(
            f"""([nodeName, expected]) => {{
                const types = ({JS_MATERIAL_TYPES})(nodeName);
                return types !== null && JSON.stringify(types) === JSON.stringify(expected);
            }}""",
            arg=[node_name, expected],
            timeout=10_000,
        )
    except PlaywrightTimeoutError:
        actual = page.evaluate(JS_MATERIAL_TYPES, node_name)
        pytest.fail(f"{node_name}: expected materials {expected}, found {actual}")


_VERTICES = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
_FACES = np.array([[0, 1, 2]], dtype=np.uint32)

# One entry per scene API that accepts `material=`.
_ADD_UNLIT: dict[str, Callable[[viser.SceneApi], Any]] = {
    "mesh_simple": lambda scene: scene.add_mesh_simple(
        "/unlit", _VERTICES, _FACES, material="unlit"
    ),
    "mesh_skinned": lambda scene: scene.add_mesh_skinned(
        "/unlit",
        _VERTICES,
        _FACES,
        bone_wxyzs=((1.0, 0.0, 0.0, 0.0),),
        bone_positions=((0.0, 0.0, 0.0),),
        skin_weights=np.ones((3, 1), dtype=np.float32),
        material="unlit",
    ),
    "batched_meshes_simple": lambda scene: scene.add_batched_meshes_simple(
        "/unlit",
        _VERTICES,
        _FACES,
        batched_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0]] * 2),
        batched_positions=np.array([[0.0, 0.0, 0.0], [2.0, 0.0, 0.0]]),
        material="unlit",
    ),
    "box": lambda scene: scene.add_box("/unlit", material="unlit"),
    "icosphere": lambda scene: scene.add_icosphere("/unlit", material="unlit"),
    "cylinder": lambda scene: scene.add_cylinder("/unlit", material="unlit"),
}


@pytest.mark.parametrize("api", sorted(_ADD_UNLIT))
def test_unlit_material_renders_as_mesh_basic_material(
    viser_server: viser.ViserServer, viser_page: Page, api: str
) -> None:
    _ADD_UNLIT[api](viser_server.scene)
    _wait_for_material_types(viser_page, "/unlit", ["MeshBasicMaterial"])


@pytest.mark.parametrize("api", ["mesh_simple", "batched_meshes_simple"])
def test_material_switches_between_lit_and_unlit_live(
    viser_server: viser.ViserServer, viser_page: Page, api: str
) -> None:
    """Covers both the declarative (React) material and the imperative one that
    batched meshes rebuild when their props change."""
    handle = _ADD_UNLIT[api](viser_server.scene)
    _wait_for_material_types(viser_page, "/unlit", ["MeshBasicMaterial"])

    handle.material = "standard"
    _wait_for_material_types(viser_page, "/unlit", ["MeshStandardMaterial"])

    handle.material = "unlit"
    _wait_for_material_types(viser_page, "/unlit", ["MeshBasicMaterial"])


def _render_view_center(server: viser.ViserServer, browser: Browser) -> np.ndarray:
    """RGBA pixels around the center of a fresh client's default view, as (N, 4)."""
    client, _, context = connect_client(server, browser)
    try:
        img = client.get_render(
            height=96, width=128, transport_format="png", timeout=30.0
        )
    finally:
        context.close()
    h, w = img.shape[:2]
    return img[h // 2 - 8 : h // 2 + 8, w // 2 - 8 : w // 2 + 8].reshape(-1, 4)


# A 2x2x2 box at the origin: from the default camera, three of its faces meet at
# the center of the view, so any shading would vary across the center pixels.
_BOX_COLOR = (200, 80, 80)


def test_unlit_renders_exact_color_without_shading(
    viser_server: viser.ViserServer, browser: Browser
) -> None:
    """Like point clouds and images, unlit meshes skip tone mapping, so the
    rendered pixels match the requested color exactly."""
    viser_server.scene.add_box(
        "/box", color=_BOX_COLOR, dimensions=(2.0, 2.0, 2.0), material="unlit"
    )
    rgb = _render_view_center(viser_server, browser)[:, :3]
    assert np.all(np.abs(rgb.astype(np.int32) - _BOX_COLOR) <= 1), (
        f"expected every center pixel to be {_BOX_COLOR}; got RGB range "
        f"{rgb.min(axis=0)}..{rgb.max(axis=0)}"
    )


def test_unlit_batched_meshes_render_flat(
    viser_server: viser.ViserServer, browser: Browser
) -> None:
    """Batched meshes draw through InstancedMesh2's patched shaders, so check
    that an unlit one actually renders, opaque and without shading. (Its exact
    color is off by a pre-existing sRGB issue in batched per-instance colors.)"""
    box = trimesh.creation.box(extents=(2.0, 2.0, 2.0))
    viser_server.scene.add_batched_meshes_simple(
        "/box",
        box.vertices,
        box.faces,
        batched_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0]]),
        batched_positions=np.zeros((1, 3)),
        batched_colors=_BOX_COLOR,
        material="unlit",
    )
    center = _render_view_center(viser_server, browser)
    assert np.all(center[:, 3] == 255), "the unlit batched mesh did not render"
    rgb = center[:, :3].astype(np.int32)
    assert np.all(rgb.max(axis=0) - rgb.min(axis=0) <= 1), (
        f"expected uniform center pixels; got RGB range "
        f"{rgb.min(axis=0)}..{rgb.max(axis=0)}"
    )
