"""Large groups of similar scene nodes are automatically drawn as batches. This
shouldn't be observable."""

from __future__ import annotations

import threading
from typing import Any, Callable

import numpy as np
import pytest
import trimesh
from playwright.sync_api import Page

import viser

from .utils import canvas_center, get_client_handle, wait_for_scene_node

Q = (0.9238795, 0.3826834, 0.0, 0.0)

# Groups need to have this many members to be batched.
ACTIVATE_AT = 64
NUM_NODES = 80

# Groups for batches are children of a group with this name.
JS_NUM_BATCHES = """
() => window.__viserMutable.scene.getObjectByName("autoInstancer").children.length
"""


def _position(i: int) -> tuple[float, float, float]:
    return ((i % 10) * 0.6 - 2.7, (i // 10) * 0.6 - 2.1, 0.0)


# Adds a node. The final argument is used to create groups that can't be batched
# together, without any changes to appearance.
AddFn = Callable[[viser.ViserServer, str, int, int], Any]


def _add_box(server: viser.ViserServer, name: str, i: int, group: int) -> Any:
    return server.scene.add_box(
        name,
        dimensions=(0.3, 0.2, 0.1),
        color=(i * 3, 255 - i * 3, 100),
        material="unlit",
        cast_shadow=False,
        receive_shadow=False,
        flat_shading=group == 1,
        wxyz=Q,
        position=_position(i),
    )


def _add_cylinder(server: viser.ViserServer, name: str, i: int, group: int) -> Any:
    return server.scene.add_cylinder(
        name,
        radius=0.1,
        height=0.4,
        scale=(1.0, 2.0, 0.5),
        color=(i * 3, 255 - i * 3, 100),
        material="unlit",
        cast_shadow=False,
        receive_shadow=False,
        flat_shading=group == 1,
        wxyz=Q,
        position=_position(i),
    )


def _add_mesh(server: viser.ViserServer, name: str, i: int, group: int) -> Any:
    return server.scene.add_mesh_simple(
        name,
        vertices=np.array(
            [[0, 0, 0], [0.3, 0, 0], [0, 0.2 + 0.003 * i, 0], [0, 0, 0.2]]
        ),
        faces=np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]),
        color=(i * 3, 255 - i * 3, 100),
        material="unlit",
        side="double",
        cast_shadow=False,
        receive_shadow=False,
        flat_shading=group == 1,
        wxyz=Q,
        position=_position(i),
    )


def _add_frame(server: viser.ViserServer, name: str, i: int, group: int) -> Any:
    return server.scene.add_frame(
        name,
        axes_length=0.3,
        axes_radius=0.02 + group * 1e-6,
        wxyz=Q,
        position=_position(i),
    )


def _add_frustum(server: viser.ViserServer, name: str, i: int, group: int) -> Any:
    return server.scene.add_camera_frustum(
        name,
        fov=1.0,
        aspect=1.5,
        scale=0.2,
        # World-space lines have a transparent antialiasing skirt. How it's sorted
        # depends on how it's batched.
        thickness_units="screen",
        thickness=2.0 + group * 1e-6,
        color=(i * 3, 255 - i * 3, 100),
        wxyz=Q,
        position=_position(i),
    )


def _render(
    client: viser.ClientHandle, origin: tuple[float, float, float] = (0.0, 0.0, 0.0)
) -> np.ndarray:
    # Explicit camera: looking down along -Z, with X to the right, and tilted.
    tilt = 0.5
    return client.get_render(
        height=200,
        width=300,
        wxyz=(np.cos((np.pi + tilt) / 2), np.sin((np.pi + tilt) / 2), 0.0, 0.0),
        position=(origin[0], origin[1] - 3.5, origin[2] + 6.0),
        fov=1.0,
        transport_format="png",
    ).astype(np.int32)


@pytest.mark.parametrize(
    "add", [_add_box, _add_cylinder, _add_mesh, _add_frame, _add_frustum]
)
def test_batched_matches_individual(
    viser_server: viser.ViserServer, viser_page: Page, add: AddFn
) -> None:
    client = get_client_handle(viser_server)
    # Adaptive resolution would affect renders.
    viser_page.evaluate("window.__viserTestpoints.devSettings.set({ fixedDpr: 1 })")

    def scenario(batched: bool) -> list[np.ndarray]:
        prefix = f"/batched_{batched}"
        root = viser_server.scene.add_frame(prefix, show_axes=False)
        handles = [
            add(viser_server, f"{prefix}/{i}", i, 0 if batched else i % 2)
            for i in range(NUM_NODES)
        ]
        wait_for_scene_node(viser_page, f"{prefix}/{NUM_NODES - 1}")
        out = [_render(client)]
        assert (viser_page.evaluate(JS_NUM_BATCHES) > 0) == batched

        for i, handle in enumerate(handles):
            if i % 3 == 0:
                handle.visible = False
            if i % 3 == 1:
                handle.position = (*_position(i)[:2], 0.5)
            if i % 5 == 0 and hasattr(handle, "color"):
                handle.color = (0, 0, 255)
            if i % 5 == 1:
                handle.scale = 1.5
        out.append(_render(client))

        root.wxyz = Q
        root.position = (0.5, 0.0, 0.0)
        for i, handle in enumerate(handles):
            if i % 3 == 0:
                handle.visible = True
            if i % 7 == 0:
                handle.remove()
        out.append(_render(client))

        root.visible = False
        out.append(_render(client))
        root.visible = True
        # Added below a parent with a non-identity pose.
        for i in range(0, NUM_NODES, 7):
            add(viser_server, f"{prefix}/extra_{i}", i, 0 if batched else 1)
        out.append(_render(client))

        # Too few for batching.
        for i, handle in enumerate(handles):
            if i % 7 != 0 and i > 20:
                handle.remove()
        out.append(_render(client))
        assert viser_page.evaluate(JS_NUM_BATCHES) == 0
        root.remove()
        out.append(_render(client))
        return out

    batched = scenario(True)
    individual = scenario(False)
    assert (batched[0][..., 3] > 0).mean() > 0.01
    assert (batched[0] != batched[1]).any()
    for step, (a, b) in enumerate(zip(batched, individual)):
        # Allow for differences in how ties in depth are resolved.
        assert (np.abs(a - b).max(axis=-1) > 16).mean() < 0.002, step


@pytest.mark.parametrize("add", [_add_box, _add_mesh, _add_frame, _add_frustum])
def test_batches_are_precise_far_from_origin(
    viser_server: viser.ViserServer, viser_page: Page, add: AddFn
) -> None:
    """Like geographic coordinates, in meters. Single precision isn't enough."""
    client = get_client_handle(viser_server)
    viser_page.evaluate("window.__viserTestpoints.devSettings.set({ fixedDpr: 1 })")
    origin = (500_000.0, 4_100_000.0, 100.0)

    def render(batched: bool) -> np.ndarray:
        prefix = f"/batched_{batched}"
        root = viser_server.scene.add_frame(prefix, show_axes=False, position=origin)
        for i in range(NUM_NODES):
            add(viser_server, f"{prefix}/{i}", i, 0 if batched else i % 2)
        wait_for_scene_node(viser_page, f"{prefix}/{NUM_NODES - 1}")
        out = _render(client, origin)
        assert (viser_page.evaluate(JS_NUM_BATCHES) > 0) == batched
        root.remove()
        return out

    a, b = render(True), render(False)
    assert (a[..., 3] > 0).mean() > 0.01
    assert (np.abs(a - b).max(axis=-1) > 16).mean() < 0.002


def test_visibility_does_not_change_draw_order(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The order that coincident objects are drawn in determines which is visible."""
    client = get_client_handle(viser_server)
    handles = [
        viser_server.scene.add_box(
            f"/boxes/{i}",
            color=(i * 3, 255 - i * 3, 100),
            material="unlit",
            cast_shadow=False,
        )
        for i in range(NUM_NODES)
    ]
    wait_for_scene_node(viser_page, f"/boxes/{NUM_NODES - 1}")
    before = _render(client)
    assert viser_page.evaluate(JS_NUM_BATCHES) > 0
    for hidden in (handles[:40], handles[40:], handles[::3]):
        for handle in hidden:
            handle.visible = False
        _render(client)
        for handle in hidden:
            handle.visible = True
        np.testing.assert_array_equal(_render(client), before)


def test_coplanar_meshes_are_drawn_in_order(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The order shouldn't depend on the camera."""
    client = get_client_handle(viser_server)
    viser_page.evaluate("window.__viserTestpoints.devSettings.set({ fixedDpr: 1 })")
    rng = np.random.default_rng(0)
    centers = rng.uniform(-2.0, 2.0, (NUM_NODES, 3)) * (1.0, 1.0, 0.0)

    def render(batched: bool) -> np.ndarray:
        prefix = f"/batched_{batched}"
        root = viser_server.scene.add_frame(prefix, show_axes=False)
        for i in range(NUM_NODES):
            viser_server.scene.add_mesh_simple(
                f"{prefix}/{i}",
                centers[i] + [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]],
                np.array([[0, 1, 2], [0, 2, 3]]),
                color=(i * 3, 255 - i * 3, 100),
                material="unlit",
                side="double",
                cast_shadow=False,
                receive_shadow=False,
                flat_shading=not batched and i % 2 == 1,
            )
        wait_for_scene_node(viser_page, f"{prefix}/{NUM_NODES - 1}")
        out = client.get_render(
            height=200,
            width=300,
            wxyz=(0.0, 1.0, 0.0, 0.0),
            position=(0.5, 0.3, 6.0),
            fov=1.0,
            transport_format="png",
        ).astype(np.int32)
        assert (viser_page.evaluate(JS_NUM_BATCHES) > 0) == batched
        root.remove()
        return out

    a, b = render(True), render(False)
    assert (np.abs(a - b).max(axis=-1) > 16).mean() < 0.002


def test_invalid_faces_are_not_batched(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Indices that are out of range would refer to vertices of other meshes."""
    client = get_client_handle(viser_server)
    for i in range(NUM_NODES):
        viser_server.scene.add_mesh_simple(
            f"/meshes/{i}", np.eye(3), np.array([[0, 1, 2], [0, 1, 9]])
        )
    wait_for_scene_node(viser_page, f"/meshes/{NUM_NODES - 1}")
    _render(client)
    assert viser_page.evaluate(JS_NUM_BATCHES) == 0


@pytest.mark.parametrize("kind", ["vertices", "faces", "subdivisions", "scale"])
def test_unsuitable_nodes_are_not_batched(
    viser_server: viser.ViserServer, viser_page: Page, kind: str
) -> None:
    """Batching dense nodes would cost memory and prevent culling. Shaders would
    underflow for tiny scales."""
    client = get_client_handle(viser_server)

    def add(i: int, suitable: bool) -> None:
        name = f"/{suitable}/{i}"
        if kind == "subdivisions":
            viser_server.scene.add_icosphere(name, subdivisions=3 if suitable else 9)
            return
        num_vertices, num_faces, scale = 1024, 2048, 1.0
        if not suitable:
            num_vertices += kind == "vertices"
            num_faces += kind == "faces"
            scale = 1e-13 if kind == "scale" else 1.0
        viser_server.scene.add_mesh_simple(
            name,
            0.01 * np.random.default_rng(i).uniform(size=(num_vertices, 3)),
            np.tile([[0, 1, 2]], (num_faces, 1)),
            scale=scale,
        )

    for suitable in (False, True):
        for i in range(ACTIVATE_AT):
            add(i, suitable)
        wait_for_scene_node(viser_page, f"/{suitable}/{ACTIVATE_AT - 1}")
        _render(client)
        assert (viser_page.evaluate(JS_NUM_BATCHES) > 0) == suitable


@pytest.mark.parametrize(
    "kind", ["filled", "shadow", "opacity", "image", "grid", "glb"]
)
def test_lines_are_not_batched_with_transparent_surfaces(
    viser_server: viser.ViserServer, viser_page: Page, kind: str
) -> None:
    """Antialiased edges need to be sorted relative to transparent surfaces."""
    client = get_client_handle(viser_server)
    for i in range(NUM_NODES):
        viser_server.scene.add_camera_frustum(
            f"/frustums/{i}",
            fov=1.0,
            aspect=1.0,
            scale=0.2,
            thickness=0.01,
            thickness_units="world",
            position=_position(i),
        )
    wait_for_scene_node(viser_page, f"/frustums/{NUM_NODES - 1}")
    _render(client)
    assert viser_page.evaluate(JS_NUM_BATCHES) > 0
    surface: viser.SceneNodeHandle
    if kind == "filled":
        surface = viser_server.scene.add_camera_frustum(
            "/surface", fov=1.0, aspect=1.0, variant="filled"
        )
    elif kind == "shadow":
        surface = viser_server.scene.add_box("/surface", receive_shadow=0.5)
    elif kind == "opacity":
        surface = viser_server.scene.add_box("/surface", opacity=0.5)
    elif kind == "image":
        surface = viser_server.scene.add_image(
            "/surface", np.zeros((4, 4, 4), np.uint8), 1.0, 1.0, format="png"
        )
    elif kind == "grid":
        surface = viser_server.scene.add_grid("/surface", plane_opacity=0.5)
    else:
        mesh = trimesh.creation.box()
        mesh.visual.vertex_colors = np.full((len(mesh.vertices), 4), 100, np.uint8)
        surface = viser_server.scene.add_mesh_trimesh("/surface", mesh)
    wait_for_scene_node(viser_page, "/surface")
    _render(client)
    assert viser_page.evaluate(JS_NUM_BATCHES) == 0
    surface.remove()
    _render(client)
    assert viser_page.evaluate(JS_NUM_BATCHES) > 0


def _click_until(
    page: Page, position: tuple[float, float], event: threading.Event
) -> None:
    for _ in range(20):
        page.mouse.move(*position)
        page.wait_for_timeout(300)
        page.mouse.click(*position)
        if event.wait(0.5):
            return
    raise AssertionError("Click wasn't received.")


def test_batched_nodes_are_clickable(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    client = get_client_handle(viser_server)
    client.camera.position = (0.0, 0.01, 10.0)
    client.camera.look_at = (0.0, 0.0, 0.0)
    clicked: list[str] = []
    event = threading.Event()

    def on_click(e: viser.SceneNodePointerEvent) -> None:
        clicked.append(e.target.name)
        event.set()

    for i in range(NUM_NODES):
        _add_box(viser_server, f"/box_{i}", i, 0)
    big = viser_server.scene.add_box(
        "/center",
        dimensions=(2.0, 2.0, 0.5),
        position=(0.0, 0.0, 2.0),
        material="unlit",
        cast_shadow=False,
        receive_shadow=False,
        flat_shading=False,
    )
    big.on_click(on_click)
    wait_for_scene_node(viser_page, "/center")
    _render(client)
    # Let the camera settle.
    viser_page.wait_for_timeout(500)
    assert viser_page.evaluate(JS_NUM_BATCHES) == 1

    center = canvas_center(viser_page)
    _click_until(viser_page, center, event)
    assert set(clicked) == {"/center"}

    # Hidden nodes shouldn't receive events.
    event.clear()
    big.visible = False
    _render(client)
    viser_page.mouse.click(*center)
    assert not event.wait(0.5)


def test_children_of_batched_nodes_bubble_clicks(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Clicks on non-interactive descendants are handled by interactive
    ancestors, so batched descendants still need to be raycast against."""
    client = get_client_handle(viser_server)
    client.camera.position = (0.0, 0.01, 10.0)
    client.camera.look_at = (0.0, 0.0, 0.0)
    event = threading.Event()

    parent = viser_server.scene.add_icosphere("/parent", radius=0.01)
    parent.position = (30.0, 0.0, 0.0)  # Offscreen.
    parent.on_click(lambda _: event.set())
    for i in range(NUM_NODES):
        x, y, z = _position(i)
        child = _add_box(viser_server, f"/parent/{i}", i, 0)
        child.position = (x - 30.0, y, z)
    viser_server.scene.add_box(
        "/parent/center",
        dimensions=(2.0, 2.0, 0.5),
        position=(-30.0, 0.0, 2.0),
        material="unlit",
        cast_shadow=False,
        receive_shadow=False,
        flat_shading=False,
    )
    wait_for_scene_node(viser_page, "/parent/center")
    _render(client)
    # Let the camera settle.
    viser_page.wait_for_timeout(500)
    assert viser_page.evaluate(JS_NUM_BATCHES) == 1

    center = canvas_center(viser_page)
    _click_until(viser_page, center, event)


def test_removed_nodes_are_not_retained(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Buffers of removed nodes used to be retained by the initial state of
    R3F's store."""
    client = get_client_handle(viser_server)
    num_points = 300_000
    viser_server.scene.add_point_cloud(
        "/points",
        np.zeros((num_points, 3), dtype=np.float32),
        np.zeros((num_points, 3), dtype=np.uint8),
        precision="float32",
        point_size=1e-5,
    )
    wait_for_scene_node(viser_page, "/points")
    _render(client)
    cdp = viser_page.context.new_cdp_session(viser_page)

    def heap_mb() -> float:
        for _ in range(3):
            cdp.send("HeapProfiler.collectGarbage")
            viser_page.wait_for_timeout(100)
        usage = cdp.send("Runtime.getHeapUsage")
        return (usage["usedSize"] + usage["backingStorageSize"]) / 1e6

    before = heap_mb()
    viser_server.scene.remove_by_name("/points")
    viser_page.wait_for_function(
        "() => !('/points' in window.__viserMutable.nodeRefFromName)"
    )
    expected = 0.8 * num_points * 15 / 1e6
    for i in range(20):
        # Flush dispose callbacks, React's alternate fibers, etc.
        viser_server.scene.add_frame(f"/frame_{i}")
        viser_page.wait_for_timeout(300)
        if before - heap_mb() > expected:
            return
    raise AssertionError("Buffers are still retained.")


JS_DRAWN_MATERIALS = """
(prefix) => {
  const out = [];
  for (const [name, node] of Object.entries(window.__viserMutable.nodeRefFromName)) {
    if (!name.startsWith(prefix)) continue;
    node.traverse((o) => {
      if (o.isMesh && o.layers.isEnabled(0))
        out.push([o.material.type, o.material.color.getHex()]);
    });
  }
  return out;
}
"""


def test_clickable_nodes_keep_their_materials(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Clickable from the first render, and then falling out of a batch."""
    client = get_client_handle(viser_server)
    with viser_server.atomic():
        for i in range(3):
            viser_server.scene.add_box(f"/few/{i}", color=(255, 0, 0)).on_click(
                lambda _: None
            )
        handles = []
        for i in range(NUM_NODES):
            handle = viser_server.scene.add_icosphere(f"/many/{i}", color=(255, 0, 0))
            handle.on_click(lambda _: None)
            handles.append(handle)
    wait_for_scene_node(viser_page, f"/many/{NUM_NODES - 1}")
    _render(client)
    red = ["MeshStandardMaterial", 0xFF0000]
    assert viser_page.evaluate(JS_DRAWN_MATERIALS, "/few/") == [red] * 3
    assert viser_page.evaluate(JS_DRAWN_MATERIALS, "/many/") == []
    for handle in handles[10:]:
        handle.remove()
    _render(client)
    assert viser_page.evaluate(JS_DRAWN_MATERIALS, "/many/") == [red] * 10


def test_point_clouds_bubble_clicks(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    client = get_client_handle(viser_server)
    client.camera.position = (0.0, 0.01, 10.0)
    client.camera.look_at = (0.0, 0.0, 0.0)
    event = threading.Event()
    parent = viser_server.scene.add_icosphere("/parent", radius=1e-3)
    parent.position = (30.0, 0.0, 0.0)  # Offscreen.
    parent.on_click(lambda _: event.set())
    viser_server.scene.add_point_cloud(
        "/parent/points",
        np.random.default_rng(0).uniform(-1, 1, (1000, 3)),
        (255, 0, 0),
        position=(-30.0, 0.0, 0.0),
    )
    wait_for_scene_node(viser_page, "/parent/points")
    _click_until(viser_page, canvas_center(viser_page), event)


def test_batched_axes_outline_follows_instance(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    client = get_client_handle(viser_server)
    client.camera.position = (0.0, 0.01, 10.0)
    client.camera.look_at = (0.0, 0.0, 0.0)
    axes = viser_server.scene.add_batched_axes(
        "/axes",
        batched_wxyzs=np.tile([1.0, 0.0, 0.0, 0.0], (2, 1)),
        batched_positions=np.array([[0.0, 0.0, 0.0], [30.0, 0.0, 0.0]]),
        axes_length=1.0,
        axes_radius=0.5,
        position=(0.0, 0.0, 0.5),
    )
    axes.on_click(lambda _: None)
    wait_for_scene_node(viser_page, "/axes")
    x, y = canvas_center(viser_page)
    for i in range(20):
        viser_page.mouse.move(x + i % 2, y)
        viser_page.wait_for_timeout(200)
        stale = viser_page.evaluate(
            """() => {
              let hovered = 0, stale = 0;
              window.__viserMutable.nodeRefFromName["/axes"].traverse((o) => {
                if (!o.isMesh || o.isInstancedMesh || !o.visible) return;
                hovered++;
                const expected = o.matrix.clone().compose(
                  o.position, o.quaternion, o.scale
                ).premultiply(o.parent.matrixWorld);
                if (o.matrixWorld.elements.some(
                    (v, i) => Math.abs(v - expected.elements[i]) > 1e-4))
                  stale++;
              });
              return hovered === 0 ? null : stale;
            }"""
        )
        if stale is not None:
            assert stale == 0
            return
    raise AssertionError("Never hovered.")
