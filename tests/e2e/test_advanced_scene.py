"""E2E tests for advanced scene objects: meshes, frustums, line segments, etc."""

from __future__ import annotations

import math
import threading

import numpy as np
from playwright.sync_api import Page

import viser

from .utils import (
    JS_GET_MESH_CHILD_COUNT,
    wait_for_scene_node,
    wait_for_scene_node_hidden,
    wait_for_scene_node_removed,
    wait_for_scene_node_visible,
)

# --- Mesh rendering ---


def test_mesh_simple_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A simple mesh with vertices and faces should appear in the scene graph."""
    vertices = np.array(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, 0.0]], dtype=np.float32
    )
    faces = np.array([[0, 1, 2]], dtype=np.uint32)

    viser_server.scene.add_mesh_simple(
        "/test_mesh",
        vertices=vertices,
        faces=faces,
        color=(200, 100, 50),
    )

    wait_for_scene_node(viser_page, "/test_mesh")

    mesh_count = viser_page.evaluate(JS_GET_MESH_CHILD_COUNT, "/test_mesh")
    assert mesh_count > 0, f"Expected mesh children, got {mesh_count}"


def test_mesh_simple_wireframe(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A wireframe mesh should appear in the scene graph."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=np.float32)
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)

    viser_server.scene.add_mesh_simple(
        "/test_wireframe_mesh",
        vertices=vertices,
        faces=faces,
        wireframe=True,
        color=(0, 255, 0),
    )

    wait_for_scene_node(viser_page, "/test_wireframe_mesh")


def test_mesh_simple_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a mesh should remove it from the scene graph."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [0.5, 1, 0]], dtype=np.float32)
    faces = np.array([[0, 1, 2]], dtype=np.uint32)

    handle = viser_server.scene.add_mesh_simple(
        "/removable_mesh",
        vertices=vertices,
        faces=faces,
    )

    wait_for_scene_node(viser_page, "/removable_mesh")
    handle.remove()
    wait_for_scene_node_removed(viser_page, "/removable_mesh")


# --- Camera frustum ---


def test_camera_frustum_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A camera frustum should appear in the scene graph."""
    viser_server.scene.add_camera_frustum(
        "/test_frustum",
        fov=math.radians(60),
        aspect=1.5,
        scale=0.5,
        color=(255, 200, 0),
        position=(0.0, 0.0, 1.0),
    )

    wait_for_scene_node(viser_page, "/test_frustum")


def test_camera_frustum_visibility(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Toggling visibility on a camera frustum should update the Three.js object."""
    handle = viser_server.scene.add_camera_frustum(
        "/vis_frustum",
        fov=math.radians(45),
        aspect=1.0,
        scale=0.3,
    )

    wait_for_scene_node(viser_page, "/vis_frustum")

    handle.visible = False
    wait_for_scene_node_hidden(viser_page, "/vis_frustum")

    handle.visible = True
    wait_for_scene_node_visible(viser_page, "/vis_frustum")


# --- Line segments ---


def test_line_segments_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Line segments should appear in the scene graph."""
    points = np.array(
        [
            [[0, 0, 0], [1, 0, 0]],
            [[0, 0, 0], [0, 1, 0]],
            [[0, 0, 0], [0, 0, 1]],
        ],
        dtype=np.float32,
    )
    colors = np.array(
        [
            [[255, 0, 0], [255, 0, 0]],
            [[0, 255, 0], [0, 255, 0]],
            [[0, 0, 255], [0, 0, 255]],
        ],
        dtype=np.uint8,
    )

    viser_server.scene.add_line_segments(
        "/test_lines",
        points=points,
        colors=colors,
        line_width=2.0,
    )

    wait_for_scene_node(viser_page, "/test_lines")


def test_line_segments_single_color(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Line segments with a single color tuple should render."""
    points = np.array(
        [[[0, 0, 0], [1, 1, 1]], [[1, 1, 1], [2, 0, 0]]],
        dtype=np.float32,
    )

    viser_server.scene.add_line_segments(
        "/test_lines_single_color",
        points=points,
        colors=(255, 128, 0),
    )

    wait_for_scene_node(viser_page, "/test_lines_single_color")


# --- Transform controls ---

JS_FIND_TRANSFORM_HANDLE = """
() => {
    const m = window.__viserMutable;
    const cam = m.camera;
    const rect = m.canvas.getBoundingClientRect();
    const Vector3 = cam.position.constructor;
    const toScreen = (v) => {
        const n = v.clone().project(cam);
        return [
            rect.left + (n.x * 0.5 + 0.5) * rect.width,
            rect.top + (-n.y * 0.5 + 0.5) * rect.height,
        ];
    };

    m.scene.updateWorldMatrix(true, true);
    let bestRoot = null;
    let bestHandles = [];
    m.scene.traverse((root) => {
        if (root.type !== "Group" || root.matrixAutoUpdate !== false) return;
        const handles = [];
        root.traverse((o) => {
            if (o.isMesh && o.geometry?.type === "CylinderGeometry") {
                const worldPosition = new Vector3();
                o.getWorldPosition(worldPosition);
                handles.push(worldPosition);
            }
        });
        if (handles.length > bestHandles.length) {
            bestRoot = root;
            bestHandles = handles;
        }
    });
    if (bestRoot === null || bestHandles.length === 0) return null;

    const centerWorld = new Vector3();
    bestRoot.getWorldPosition(centerWorld);
    const center = toScreen(centerWorld);
    let handle = null;
    let bestDistance = -1;
    for (const worldPosition of bestHandles) {
        const screen = toScreen(worldPosition);
        const distance = Math.hypot(screen[0] - center[0], screen[1] - center[1]);
        if (distance > bestDistance) {
            bestDistance = distance;
            handle = screen;
        }
    }
    return { center, handle };
}
"""


def test_transform_controls_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Transform controls should appear in the scene graph."""
    viser_server.scene.add_transform_controls(
        "/test_transform",
        scale=0.5,
        position=(0.0, 0.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_transform")


def test_transform_controls_with_options(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Transform controls with specific options should appear in the scene graph."""
    viser_server.scene.add_transform_controls(
        "/test_transform_opts",
        scale=0.3,
        disable_rotations=True,
        active_axes=(True, True, False),
        position=(1.0, 0.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_transform_opts")


def test_fixed_transform_controls_first_drag_works(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A fixed-size transform control added to an already-open viewer should be
    draggable on the first attempt, before any prior interaction has forced a
    render-frame scale update."""
    handle = viser_server.scene.add_transform_controls(
        "/first_drag_transform",
        fixed=True,
        scale=20.0,
        disable_sliders=True,
        disable_rotations=True,
    )
    wait_for_scene_node(viser_page, "/first_drag_transform")

    screen_handle = viser_page.evaluate(JS_FIND_TRANSFORM_HANDLE)
    assert screen_handle is not None, "transform control handle not found"
    cx, cy = screen_handle["center"]
    hx, hy = screen_handle["handle"]
    dx, dy = hx - cx, hy - cy
    length = math.hypot(dx, dy) or 1.0

    viser_page.mouse.move(hx, hy)
    viser_page.mouse.down()
    viser_page.mouse.move(
        hx + dx / length * 120,
        hy + dy / length * 120,
        steps=15,
    )
    viser_page.mouse.up()
    viser_page.wait_for_timeout(500)

    moved = math.sqrt(sum(float(x) ** 2 for x in handle.position))
    assert moved > 0.1, (
        "first transform-control drag did not move the control; "
        "fixed-size handle matrices were likely initialized lazily"
    )


def test_transform_controls_drag_end_after_mid_drag_removal(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a gizmo's ancestor mid-drag must still deliver ``on_drag_end``.

    Real-browser coverage for the server-side active-drag tracking: the cascade
    removal pops the gizmo from the live registry, so without the active-drag
    map the late ``end`` message (sent by the client after the gizmo unmounts)
    would not resolve a handle and ``on_update(phase="end")`` would be dropped.
    """
    viser_server.scene.add_frame("/tc_parent")
    handle = viser_server.scene.add_transform_controls(
        "/tc_parent/gizmo",
        fixed=True,
        scale=20.0,
        disable_sliders=True,
        disable_rotations=True,
    )

    phases: list[str] = []
    end_fired = threading.Event()

    @handle.on_update
    def _(event: viser.TransformControlsEvent) -> None:
        phases.append(event.phase)
        if event.phase == "end":
            end_fired.set()

    wait_for_scene_node(viser_page, "/tc_parent/gizmo")

    screen_handle = viser_page.evaluate(JS_FIND_TRANSFORM_HANDLE)
    assert screen_handle is not None, "transform control handle not found"
    cx, cy = screen_handle["center"]
    hx, hy = screen_handle["handle"]
    dx, dy = hx - cx, hy - cy
    length = math.hypot(dx, dy) or 1.0

    # Grab a handle and start dragging (engages the gizmo -> "start").
    viser_page.mouse.move(hx, hy)
    viser_page.mouse.down()
    viser_page.mouse.move(
        hx + dx / length * 120, hy + dy / length * 120, steps=15
    )

    # Remove the gizmo's parent WHILE the pointer is still held, then release
    # immediately -- the gizmo is still mounted client-side, so the browser
    # sends a final ``end`` message, but the server has already popped it from
    # the live registry, so delivering ``on_drag_end`` relies on the active-drag
    # map. (We must NOT wait for the client to unmount first: a fully-unmounted
    # gizmo never fires drei's onDragEnd, so no end would be sent at all.)
    viser_server.scene.remove_by_name("/tc_parent")
    viser_page.mouse.up()

    assert end_fired.wait(timeout=5.0), (
        f"on_drag_end never fired after mid-drag removal; phases={phases}"
    )
    assert "start" in phases, phases
    wait_for_scene_node_removed(viser_page, "/tc_parent/gizmo")


# Recompute the instanced mesh's bounding sphere from its *current* instance
# matrices and report its center -- this is what a raycast would test against.
JS_BATCHED_AXES_BOUND_CENTER = """
(name) => {
    const obj = window.__viserMutable.nodeRefFromName[name];
    if (!obj) return null;
    let info = null;
    obj.traverse((o) => {
        if (o.isInstancedMesh) {
            // The cached sphere (what raycast uses if non-null); null means it
            // will be recomputed fresh on the next raycast.
            const c = o.boundingSphere ? o.boundingSphere.center : null;
            info = {
                frustumCulled: o.frustumCulled,
                cachedCenterX: c ? c.x : null,
            };
        }
    });
    return info;
}
"""


def test_batched_axes_invalidate_bounds_on_position_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Moving batched axes (same instance count) must not leave a stale bounding
    sphere -- otherwise raycasting (clicks) and frustum culling use the old
    positions, so clicks miss and the axes can pop out of view."""
    p0 = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], np.float32)
    wxyzs = np.tile([1.0, 0.0, 0.0, 0.0], (2, 1)).astype(np.float32)
    handle = viser_server.scene.add_batched_axes(
        "/ax", batched_wxyzs=wxyzs, batched_positions=p0
    )
    wait_for_scene_node(viser_page, "/ax")
    viser_page.wait_for_timeout(500)

    info0 = viser_page.evaluate(JS_BATCHED_AXES_BOUND_CENTER, "/ax")
    assert info0 is not None, "instanced axes mesh not found"
    # Culling is disabled so the renderer never caches a stale sphere.
    assert info0["frustumCulled"] is False

    # Move the axes far away (+10 in x), keeping the same instance count.
    handle.batched_positions = p0 + np.array([10.0, 0.0, 0.0], np.float32)
    viser_page.wait_for_timeout(700)

    info1 = viser_page.evaluate(JS_BATCHED_AXES_BOUND_CENTER, "/ax")
    assert info1["frustumCulled"] is False
    # The cached bounding sphere must not be left stale at the old position: it
    # is either invalidated (null -> recomputed fresh on next raycast) or already
    # recomputed at the new (~+10) location. With the bug it stays near x=0.
    cx = info1["cachedCenterX"]
    assert cx is None or cx > 5.0, (
        f"bounding sphere left stale at the old position (center.x={cx})"
    )


JS_NODE_CHILD_COUNT = """
(name) => {
    const o = window.__viserMutable.nodeRefFromName[name];
    return o ? o.children.length : -1;
}
"""


def test_skinned_mesh_readd_does_not_leak_bones(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Re-adding a skinned mesh under the same name must not accumulate stale
    bones on the parent node (the cleanup must remove the old bones)."""
    v, b = 4, 4
    faces = np.array([[0, 1, 2]], np.uint32)

    def add() -> None:
        viser_server.scene.add_mesh_skinned(
            "/sk",
            np.random.rand(v, 3).astype(np.float32),
            faces,
            bone_wxyzs=np.tile([1.0, 0.0, 0.0, 0.0], (b, 1)),
            bone_positions=np.random.rand(b, 3),
            skin_weights=np.random.rand(v, b).astype(np.float32),
        )

    add()
    wait_for_scene_node(viser_page, "/sk")
    viser_page.wait_for_timeout(900)
    base = viser_page.evaluate(JS_NODE_CHILD_COUNT, "/sk")
    assert base > 0

    for _ in range(4):
        add()  # re-add the same name with fresh buffers
        viser_page.wait_for_timeout(700)

    after = viser_page.evaluate(JS_NODE_CHILD_COUNT, "/sk")
    assert after <= base, f"bones leaked on re-add: {base} -> {after}"


def test_transform_controls_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing transform controls should remove them from the scene graph."""
    handle = viser_server.scene.add_transform_controls(
        "/removable_transform",
        scale=0.5,
    )

    wait_for_scene_node(viser_page, "/removable_transform")
    handle.remove()
    wait_for_scene_node_removed(viser_page, "/removable_transform")


# --- Spline Catmull-Rom ---


def test_spline_catmull_rom_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A Catmull-Rom spline should appear in the scene graph."""
    points = np.array(
        [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]],
        dtype=np.float32,
    )

    viser_server.scene.add_spline_catmull_rom(
        "/test_spline",
        points=points,
        tension=0.5,
        line_width=2.0,
        color=(255, 0, 128),
    )

    wait_for_scene_node(viser_page, "/test_spline")


# --- Batched axes ---


def test_batched_axes_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Batched axes should appear in the scene graph."""
    wxyzs = np.array(
        [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
        dtype=np.float32,
    )
    positions = np.array(
        [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        dtype=np.float32,
    )

    viser_server.scene.add_batched_axes(
        "/test_batched_axes",
        batched_wxyzs=wxyzs,
        batched_positions=positions,
        axes_length=0.3,
        axes_radius=0.01,
    )

    wait_for_scene_node(viser_page, "/test_batched_axes")
