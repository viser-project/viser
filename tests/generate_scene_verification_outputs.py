"""Generate visual verification outputs for viser scene rendering.

Creates a gallery of screenshots and interactive .viser files for manual
inspection of rendering correctness.

Usage:
    python generate_scene_verification_outputs.py

The script starts a local HTTP server and opens the gallery in your browser.
Screenshots and .viser files appear progressively as each test case completes.
"""

from __future__ import annotations

import dataclasses
import math
import shutil
import socket
import threading
import time
import webbrowser
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Literal

import numpy as np
from playwright.sync_api import Browser, Page, sync_playwright

import viser
import viser._client_autobuild

NUM_WORKERS = 4

OUTPUT_DIR = Path(__file__).parent / "scene_verification_outputs"
SCREENSHOTS_DIR = OUTPUT_DIR / "screenshots"
VISER_FILES_DIR = OUTPUT_DIR / "viser_files"
CLIENT_BUILD_DIR = Path(__file__).parent.parent / "src" / "viser" / "client" / "build"


# ---------------------------------------------------------------------------
# Test case registry
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class TestCase:
    """A single scene verification test case."""

    name: str
    category: str
    title: str
    description: str
    populate: Callable[[viser.ViserServer], None]
    camera_position: tuple[float, float, float] = (3.0, 3.0, 3.0)
    camera_look_at: tuple[float, float, float] = (0.0, 0.0, 0.0)
    camera_fov: float = 75.0 * math.pi / 180.0


_REGISTRY: list[TestCase] = []


Category = Literal[
    "Primitives",
    "Lighting & Shadows",
    "Meshes",
    "Point Clouds",
    "Lines & Splines",
    "Camera Frustums",
    "Labels & Frames",
    "Scene Composition",
]


def test_case(
    *,
    category: Category,
    title: str,
    description: str = "",
    name: str | None = None,
    camera_position: tuple[float, float, float] = (3.0, 3.0, 3.0),
    camera_look_at: tuple[float, float, float] = (0.0, 0.0, 0.0),
    camera_fov: float = 75.0 * math.pi / 180.0,
) -> Callable[
    [Callable[[viser.ViserServer], None]],
    Callable[[viser.ViserServer], None],
]:
    """Decorator to register a scene verification test case."""

    def decorator(
        fn: Callable[[viser.ViserServer], None],
    ) -> Callable[[viser.ViserServer], None]:
        _REGISTRY.append(
            TestCase(
                name=name or fn.__name__,
                category=category,
                title=title,
                description=description,
                populate=fn,
                camera_position=camera_position,
                camera_look_at=camera_look_at,
                camera_fov=camera_fov,
            )
        )
        return fn

    return decorator


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


@test_case(
    category="Primitives", title="Box", description="Single red box on a grid plane."
)
def primitives_box(server: viser.ViserServer) -> None:
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Primitives",
    title="Icosphere",
    description="Smooth-shaded blue icosphere.",
)
def primitives_icosphere(server: viser.ViserServer) -> None:
    server.scene.add_icosphere(
        "/sphere",
        radius=0.5,
        color=(80, 120, 200),
        subdivisions=3,
        position=(0, 0, 0.5),
    )
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Primitives", title="Cylinder", description="Green cylinder on a grid."
)
def primitives_cylinder(server: viser.ViserServer) -> None:
    server.scene.add_cylinder(
        "/cylinder", radius=0.4, height=1.0, color=(80, 200, 120), position=(0, 0, 0.5)
    )
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Primitives",
    title="Grid",
    description="Grid with cells and section lines.",
)
def primitives_grid(server: viser.ViserServer) -> None:
    server.scene.add_grid(
        "/grid", width=8, height=8, plane="xy", cell_size=0.5, section_size=2.0
    )


@test_case(
    category="Primitives",
    title="Multiple Primitives",
    description="Box, sphere, and cylinder side by side.",
)
def primitives_mixed(server: viser.ViserServer) -> None:
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(0.8, 0.8, 0.8), position=(-1.5, 0, 0.4)
    )
    server.scene.add_icosphere(
        "/sphere", radius=0.4, color=(80, 120, 200), position=(0, 0, 0.4)
    )
    server.scene.add_cylinder(
        "/cylinder",
        radius=0.3,
        height=0.8,
        color=(80, 200, 120),
        position=(1.5, 0, 0.4),
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy")


@test_case(
    category="Primitives",
    title="Wireframe",
    description="Box and sphere in wireframe mode.",
)
def primitives_wireframe(server: viser.ViserServer) -> None:
    server.scene.add_box(
        "/box",
        color=(200, 80, 80),
        dimensions=(1.0, 1.0, 1.0),
        wireframe=True,
        position=(-1.2, 0, 0.5),
    )
    server.scene.add_icosphere(
        "/sphere",
        radius=0.5,
        color=(80, 120, 200),
        wireframe=True,
        position=(1.2, 0, 0.5),
    )
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Primitives",
    title="Opacity",
    description="Solid box (left) vs transparent box at opacity=0.4 (right).",
)
def primitives_opacity(server: viser.ViserServer) -> None:
    server.scene.add_box(
        "/box_solid",
        color=(200, 80, 80),
        dimensions=(0.8, 0.8, 0.8),
        position=(-1.0, 0, 0.4),
    )
    server.scene.add_box(
        "/box_transparent",
        color=(200, 80, 80),
        dimensions=(0.8, 0.8, 0.8),
        opacity=0.4,
        position=(1.0, 0, 0.4),
    )
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Primitives",
    title="Materials",
    description="Standard, toon3, and toon5 materials on icospheres.",
    camera_position=(3.0, 2.0, 2.5),
)
def primitives_materials(server: viser.ViserServer) -> None:
    server.scene.add_icosphere(
        "/standard",
        radius=0.4,
        color=(200, 80, 80),
        material="standard",
        position=(-1.5, 0, 0.4),
    )
    server.scene.add_icosphere(
        "/toon3",
        radius=0.4,
        color=(200, 80, 80),
        material="toon3",
        position=(0, 0, 0.4),
    )
    server.scene.add_icosphere(
        "/toon5",
        radius=0.4,
        color=(200, 80, 80),
        material="toon5",
        position=(1.5, 0, 0.4),
    )
    server.scene.add_label("/label_standard", "standard", position=(-1.5, 0, 1.0))
    server.scene.add_label("/label_toon3", "toon3", position=(0, 0, 1.0))
    server.scene.add_label("/label_toon5", "toon5", position=(1.5, 0, 1.0))
    server.scene.add_grid("/grid", width=6, height=6, plane="xy")


# ---------------------------------------------------------------------------
# Lighting & Shadows
# ---------------------------------------------------------------------------


@test_case(
    category="Lighting & Shadows",
    title="Default Shadows",
    description="Default lights with shadow casting enabled. Shadows should appear on the grid.",
)
def lighting_default_shadows(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=True, cast_shadow=True)
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_icosphere(
        "/sphere", radius=0.3, color=(80, 120, 200), position=(1.2, 0.5, 0.3)
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy", shadow_opacity=0.4)


@test_case(
    category="Lighting & Shadows",
    title="Directional Light",
    description="Single directional light casting shadows.",
)
def lighting_directional(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=False)
    server.scene.add_light_ambient("/ambient", intensity=0.3)
    server.scene.add_light_directional(
        "/dir_light",
        color=(255, 240, 220),
        intensity=2.0,
        cast_shadow=True,
        position=(2.0, 2.0, 3.0),
    )
    server.scene.add_box(
        "/box", color=(200, 200, 200), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy", shadow_opacity=0.5)


@test_case(
    category="Lighting & Shadows",
    title="Point Light",
    description="Point light casting shadows. Small sphere marks light position.",
)
def lighting_point(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=False)
    server.scene.add_light_ambient("/ambient", intensity=0.3)
    server.scene.add_light_point(
        "/point_light",
        color=(255, 200, 150),
        intensity=5.0,
        cast_shadow=True,
        position=(1.0, 1.0, 2.5),
    )
    server.scene.add_icosphere(
        "/light_marker",
        radius=0.05,
        color=(255, 255, 200),
        cast_shadow=False,
        position=(1.0, 1.0, 2.5),
    )
    server.scene.add_box(
        "/box", color=(200, 200, 200), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy", shadow_opacity=0.3)


@test_case(
    category="Lighting & Shadows",
    title="Spot Light",
    description="Spotlight pointing down onto a box. Should see a cone of light.",
)
def lighting_spot(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=False)
    server.scene.add_light_ambient("/ambient", intensity=0.2)
    server.scene.add_light_spot(
        "/spot_light",
        color=(255, 255, 255),
        intensity=30.0,
        cast_shadow=True,
        angle=0.6,
        penumbra=0.5,
        position=(0.0, 0.0, 3.0),
    )
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy", shadow_opacity=0.5)


@test_case(
    category="Lighting & Shadows",
    title="Multiple Lights",
    description="Warm (right) and cool (left) directional lights with shadows.",
)
def lighting_multiple(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=False)
    server.scene.add_light_ambient("/ambient", intensity=0.15)
    server.scene.add_light_directional(
        "/warm_light",
        color=(255, 200, 150),
        intensity=1.5,
        cast_shadow=True,
        position=(3.0, 1.0, 4.0),
    )
    server.scene.add_light_directional(
        "/cool_light",
        color=(150, 200, 255),
        intensity=1.0,
        cast_shadow=True,
        position=(-2.0, -1.0, 3.0),
    )
    server.scene.add_box(
        "/box", color=(220, 220, 220), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_icosphere(
        "/sphere", radius=0.35, color=(220, 220, 220), position=(1.5, 0, 0.35)
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy", shadow_opacity=0.4)


@test_case(
    category="Lighting & Shadows",
    title="Shadow Receive Modes",
    description="Three planes: receive_shadow=False, True, and 0.3. Sphere casts shadow from above.",
    camera_position=(4.0, 3.0, 3.0),
)
def lighting_receive_shadow(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=True, cast_shadow=True)
    # A box floating above each plane to cast a shadow onto it.
    server.scene.add_box(
        "/caster_a",
        color=(200, 80, 80),
        dimensions=(0.6, 0.6, 0.6),
        position=(-1.5, 0, 1.0),
    )
    server.scene.add_box(
        "/caster_b",
        color=(200, 80, 80),
        dimensions=(0.6, 0.6, 0.6),
        position=(0, 0, 1.0),
    )
    server.scene.add_box(
        "/caster_c",
        color=(200, 80, 80),
        dimensions=(0.6, 0.6, 0.6),
        position=(1.5, 0, 1.0),
    )
    # Three ground planes with different receive_shadow settings.
    server.scene.add_box(
        "/no_shadow",
        color=(180, 180, 180),
        dimensions=(1.3, 1.3, 0.05),
        receive_shadow=False,
        position=(-1.5, 0, 0.025),
    )
    server.scene.add_box(
        "/full_shadow",
        color=(180, 180, 180),
        dimensions=(1.3, 1.3, 0.05),
        receive_shadow=True,
        position=(0, 0, 0.025),
    )
    server.scene.add_box(
        "/partial_shadow",
        color=(180, 180, 180),
        dimensions=(1.3, 1.3, 0.05),
        receive_shadow=0.3,
        position=(1.5, 0, 0.025),
    )
    server.scene.add_label("/label_none", "receive=False", position=(-1.5, -0.8, 0.15))
    server.scene.add_label("/label_full", "receive=True", position=(0, -0.8, 0.15))
    server.scene.add_label("/label_partial", "receive=0.3", position=(1.5, -0.8, 0.15))
    server.scene.add_grid("/grid", width=6, height=4, plane="xy")


@test_case(
    category="Lighting & Shadows",
    title="No Shadows",
    description="Default lights with shadows disabled. No shadows should appear.",
)
def lighting_no_shadows(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=True, cast_shadow=False)
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(1.0, 1.0, 1.0), position=(0, 0, 0.5)
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy")


# ---------------------------------------------------------------------------
# Meshes
# ---------------------------------------------------------------------------


def _make_tetrahedron() -> tuple[np.ndarray, np.ndarray]:
    """Create a tetrahedron mesh (vertices, faces)."""
    vertices = (
        np.array(
            [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]],
            dtype=np.float32,
        )
        * 0.5
    )
    faces = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]], dtype=np.uint32)
    return vertices, faces


@test_case(
    category="Meshes",
    title="Simple Mesh",
    description="Hand-coded tetrahedron mesh.",
    camera_position=(2.0, 2.0, 2.0),
)
def mesh_simple(server: viser.ViserServer) -> None:
    vertices, faces = _make_tetrahedron()
    server.scene.add_mesh_simple(
        "/tetra",
        vertices=vertices,
        faces=faces,
        color=(100, 180, 255),
        side="double",
        position=(0, 0, 0.5),
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


@test_case(
    category="Meshes",
    title="Wireframe Mesh",
    description="Solid tetrahedron (left) vs wireframe (right).",
    camera_position=(2.0, 2.0, 2.0),
)
def mesh_wireframe(server: viser.ViserServer) -> None:
    vertices, faces = _make_tetrahedron()
    server.scene.add_mesh_simple(
        "/tetra_solid",
        vertices=vertices,
        faces=faces,
        color=(100, 180, 255),
        side="double",
        position=(-1, 0, 0.5),
    )
    server.scene.add_mesh_simple(
        "/tetra_wire",
        vertices=vertices,
        faces=faces,
        color=(100, 180, 255),
        wireframe=True,
        position=(1, 0, 0.5),
    )
    server.scene.add_label("/label_solid", "solid", position=(-1, 0, 1.2))
    server.scene.add_label("/label_wire", "wireframe", position=(1, 0, 1.2))
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Meshes",
    title="Flat vs Smooth Shading",
    description="Flat-shaded icosphere (left) vs smooth (right), both subdivisions=2.",
)
def mesh_flat_vs_smooth(server: viser.ViserServer) -> None:
    server.scene.add_icosphere(
        "/flat",
        radius=0.5,
        color=(100, 180, 255),
        flat_shading=True,
        subdivisions=2,
        position=(-1, 0, 0.5),
    )
    server.scene.add_icosphere(
        "/smooth",
        radius=0.5,
        color=(100, 180, 255),
        flat_shading=False,
        subdivisions=2,
        position=(1, 0, 0.5),
    )
    server.scene.add_label("/label_flat", "flat_shading", position=(-1, 0, 1.2))
    server.scene.add_label("/label_smooth", "smooth", position=(1, 0, 1.2))
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Meshes",
    title="Batched Meshes",
    description="8 instanced cubes in a rainbow of colors.",
    camera_position=(3.0, 3.0, 2.5),
)
def mesh_batched(server: viser.ViserServer) -> None:
    vertices = (
        np.array(
            [
                [-0.5, -0.5, -0.5],
                [0.5, -0.5, -0.5],
                [0.5, 0.5, -0.5],
                [-0.5, 0.5, -0.5],
                [-0.5, -0.5, 0.5],
                [0.5, -0.5, 0.5],
                [0.5, 0.5, 0.5],
                [-0.5, 0.5, 0.5],
            ],
            dtype=np.float32,
        )
        * 0.3
    )
    # Vertices: 0-3 = back face (z=-), 4-7 = front face (z=+).
    # CCW winding when viewed from outside.
    faces = np.array(
        [
            [0, 2, 1],
            [0, 3, 2],  # back (-Z)
            [4, 5, 6],
            [4, 6, 7],  # front (+Z)
            [0, 1, 5],
            [0, 5, 4],  # bottom (-Y)
            [2, 3, 7],
            [2, 7, 6],  # top (+Y)
            [0, 4, 7],
            [0, 7, 3],  # left (-X)
            [1, 2, 6],
            [1, 6, 5],  # right (+X)
        ],
        dtype=np.uint32,
    )
    n = 8
    positions = np.array(
        [(i * 0.8 - (n - 1) * 0.4, 0, 0.3) for i in range(n)], dtype=np.float32
    )
    wxyzs = np.tile([1.0, 0.0, 0.0, 0.0], (n, 1)).astype(np.float32)
    colors = np.array(
        [
            (255, 80, 80),
            (255, 160, 80),
            (255, 255, 80),
            (80, 255, 80),
            (80, 255, 255),
            (80, 80, 255),
            (160, 80, 255),
            (255, 80, 255),
        ],
        dtype=np.uint8,
    )
    server.scene.add_batched_meshes_simple(
        "/cubes",
        vertices=vertices,
        faces=faces,
        batched_wxyzs=wxyzs,
        batched_positions=positions,
        batched_colors=colors,
    )
    server.scene.add_grid("/grid", width=6, height=6, plane="xy")


# ---------------------------------------------------------------------------
# Point Clouds
# ---------------------------------------------------------------------------


@test_case(
    category="Point Clouds",
    title="Basic Point Cloud",
    description="500 random points with random colors.",
)
def pointcloud_basic(server: viser.ViserServer) -> None:
    rng = np.random.default_rng(0)
    points = rng.standard_normal((500, 3)).astype(np.float32) * 0.5
    points[:, 2] = np.abs(points[:, 2])
    colors = rng.integers(50, 255, size=(500, 3), dtype=np.uint8, endpoint=False)
    server.scene.add_point_cloud(
        "/cloud", points=points, colors=colors, point_size=0.04
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


@test_case(
    category="Point Clouds",
    title="Point Shapes",
    description="Four point shapes: square, circle, diamond, sparkle.",
    camera_position=(3.0, 3.0, 2.5),
)
def pointcloud_shapes(server: viser.ViserServer) -> None:
    rng = np.random.default_rng(42)
    shapes: list[str] = ["square", "circle", "diamond", "sparkle"]
    for i, shape in enumerate(shapes):
        pts = rng.standard_normal((200, 3)).astype(np.float32) * 0.3
        pts[:, 0] += i * 1.2 - 1.8
        pts[:, 2] = np.abs(pts[:, 2]) + 0.2
        server.scene.add_point_cloud(
            f"/cloud_{shape}",
            points=pts,
            colors=(100, 180, 255),
            point_size=0.06,
            point_shape=shape,
        )  # type: ignore
        server.scene.add_label(
            f"/label_{shape}", shape, position=(i * 1.2 - 1.8, 0, 1.2)
        )
    server.scene.add_grid("/grid", width=7, height=4, plane="xy")


@test_case(
    category="Point Clouds",
    title="Fibonacci Sphere",
    description="2000 points on a sphere surface, colored by normal direction.",
    camera_position=(2.0, 2.0, 1.5),
)
def pointcloud_sphere(server: viser.ViserServer) -> None:
    n = 2000
    indices = np.arange(n, dtype=np.float32)
    phi = np.arccos(1 - 2 * (indices + 0.5) / n)
    theta = np.pi * (1 + np.sqrt(5)) * indices
    x = np.cos(theta) * np.sin(phi)
    y = np.sin(theta) * np.sin(phi)
    z = np.cos(phi)
    points = np.stack([x, y, z], axis=-1).astype(np.float32)
    colors = ((points * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
    server.scene.add_point_cloud(
        "/sphere_cloud",
        points=points,
        colors=colors,
        point_size=0.025,
        point_shape="circle",
    )


# ---------------------------------------------------------------------------
# Lines & Splines
# ---------------------------------------------------------------------------


@test_case(
    category="Lines & Splines",
    title="Line Segments",
    description="20 random line segments with per-vertex colors.",
    camera_position=(2.0, 2.0, 2.0),
)
def lines_segments(server: viser.ViserServer) -> None:
    rng = np.random.default_rng(7)
    n = 20
    starts = rng.standard_normal((n, 3)).astype(np.float32) * 0.8
    ends = starts + rng.standard_normal((n, 3)).astype(np.float32) * 0.4
    points = np.stack([starts, ends], axis=1)
    colors = rng.integers(50, 255, size=(n, 2, 3), dtype=np.uint8, endpoint=False)
    server.scene.add_line_segments(
        "/lines", points=points, colors=colors, line_width=2.0
    )


@test_case(
    category="Lines & Splines",
    title="Catmull-Rom Spline",
    description="Helix curve using Catmull-Rom interpolation.",
)
def spline_catmull_rom(server: viser.ViserServer) -> None:
    t = np.linspace(0, 4 * np.pi, 20)
    points = np.stack(
        [np.cos(t) * 0.8, np.sin(t) * 0.8, t / (4 * np.pi) * 2], axis=-1
    ).astype(np.float32)
    server.scene.add_spline_catmull_rom(
        "/helix", points=points, color=(200, 60, 60), line_width=3.0
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


@test_case(
    category="Lines & Splines",
    title="Cubic Bezier Spline",
    description="S-curve with control points shown as red spheres.",
    camera_position=(3.0, 3.0, 2.0),
)
def spline_cubic_bezier(server: viser.ViserServer) -> None:
    # 4 knots require 2*4 - 2 = 6 control points.
    knots = np.array(
        [[-1.5, 0, 0], [-0.5, 0, 1.0], [0.5, 0, -1.0], [1.5, 0, 0]], dtype=np.float32
    )
    control_points = np.array(
        [
            [-1.0, 0, 0.5],
            [-0.8, 0, 1.0],  # between knot 0-1
            [-0.2, 0, 0.5],
            [0.2, 0, -0.5],  # between knot 1-2
            [0.8, 0, -1.0],
            [1.0, 0, -0.5],  # between knot 2-3
        ],
        dtype=np.float32,
    )
    server.scene.add_spline_cubic_bezier(
        "/bezier", knots, control_points, color=(60, 60, 200), line_width=3.0
    )
    for i, p in enumerate(knots):
        server.scene.add_icosphere(
            f"/knot_{i}", radius=0.05, color=(200, 60, 60), position=tuple(p.tolist())
        )  # type: ignore
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


# ---------------------------------------------------------------------------
# Camera Frustums
# ---------------------------------------------------------------------------


@test_case(
    category="Camera Frustums",
    title="Wireframe Frustum",
    description="Camera frustum in wireframe mode.",
)
def frustum_wireframe(server: viser.ViserServer) -> None:
    server.scene.add_camera_frustum(
        "/frustum",
        fov=1.0,
        aspect=1.5,
        scale=0.5,
        color=(60, 60, 200),
        variant="wireframe",
        position=(0, 0, 0.5),
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


@test_case(
    category="Camera Frustums",
    title="Filled Frustum",
    description="Camera frustum with filled faces.",
)
def frustum_filled(server: viser.ViserServer) -> None:
    server.scene.add_camera_frustum(
        "/frustum",
        fov=1.0,
        aspect=1.5,
        scale=0.5,
        color=(60, 60, 200),
        variant="filled",
        position=(0, 0, 0.5),
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


@test_case(
    category="Camera Frustums",
    title="Frustum with Image",
    description="Camera frustum displaying a synthetic gradient image.",
)
def frustum_with_image(server: viser.ViserServer) -> None:
    img = np.zeros((64, 96, 3), dtype=np.uint8)
    img[:, :, 0] = np.linspace(0, 255, 96, dtype=np.uint8)[None, :]
    img[:, :, 1] = np.linspace(0, 255, 64, dtype=np.uint8)[:, None]
    img[:, :, 2] = 128
    server.scene.add_camera_frustum(
        "/frustum",
        fov=1.0,
        aspect=1.5,
        scale=0.5,
        color=(60, 60, 200),
        image=img,
        position=(0, 0, 0.5),
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


# ---------------------------------------------------------------------------
# Labels & Frames
# ---------------------------------------------------------------------------


@test_case(
    category="Labels & Frames",
    title="Coordinate Frame",
    description="Single coordinate frame with XYZ axes.",
    camera_position=(2.0, 2.0, 2.0),
)
def frame_axes(server: viser.ViserServer) -> None:
    server.scene.add_frame("/frame", axes_length=0.8, axes_radius=0.03)
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


@test_case(
    category="Labels & Frames",
    title="Batched Axes",
    description="6 coordinate frames with increasing rotation.",
    camera_position=(3.0, 3.0, 2.0),
)
def frame_batched(server: viser.ViserServer) -> None:
    n = 6
    positions = np.array([(i * 1.0 - 2.5, 0, 0) for i in range(n)], dtype=np.float32)
    angles = np.linspace(0, np.pi / 2, n)
    wxyzs = np.stack(
        [np.cos(angles / 2), np.zeros(n), np.zeros(n), np.sin(angles / 2)], axis=-1
    ).astype(np.float32)
    server.scene.add_batched_axes(
        "/axes",
        batched_wxyzs=wxyzs,
        batched_positions=positions,
        axes_length=0.4,
        axes_radius=0.02,
    )
    server.scene.add_grid("/grid", width=7, height=4, plane="xy")


@test_case(
    category="Labels & Frames",
    title="Labels",
    description="Screen-space and scene-space labels near a box.",
)
def labels_test(server: viser.ViserServer) -> None:
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(0.6, 0.6, 0.6), position=(0, 0, 0.3)
    )
    server.scene.add_label(
        "/label_screen",
        "Screen-space label",
        position=(0, 0, 0.8),
        font_size_mode="screen",
    )
    server.scene.add_label(
        "/label_scene",
        "Scene-space label",
        position=(0, 0, 1.2),
        font_size_mode="scene",
        font_scene_height=0.1,
    )
    server.scene.add_grid("/grid", width=4, height=4, plane="xy")


# ---------------------------------------------------------------------------
# Scene Composition
# ---------------------------------------------------------------------------


@test_case(
    category="Scene Composition",
    title="Hierarchical Transforms",
    description="Parent frame rotated 30 deg, children inherit transform.",
)
def composition_hierarchy(server: viser.ViserServer) -> None:
    angle = math.pi / 6
    wxyz: tuple[float, float, float, float] = (
        math.cos(angle / 2),
        0.0,
        0.0,
        math.sin(angle / 2),
    )
    server.scene.add_frame("/parent", axes_length=0.6, axes_radius=0.02, wxyz=wxyz)
    server.scene.add_box(
        "/parent/box",
        color=(200, 80, 80),
        dimensions=(0.5, 0.5, 0.5),
        position=(1.0, 0, 0.25),
    )
    server.scene.add_icosphere(
        "/parent/sphere", radius=0.25, color=(80, 120, 200), position=(0, 1.0, 0.25)
    )
    server.scene.add_grid("/grid", width=5, height=5, plane="xy")


@test_case(
    category="Scene Composition",
    title="Fog",
    description="Boxes at increasing distances fading into fog.",
    camera_position=(2.0, 0.0, 2.0),
    camera_look_at=(0.0, 5.0, 0.0),
)
def composition_fog(server: viser.ViserServer) -> None:
    server.scene.configure_fog(near=2.0, far=10.0, color=(230, 230, 240))
    for i in range(8):
        server.scene.add_box(
            f"/box_{i}",
            color=(200, 80, 80),
            dimensions=(0.5, 0.5, 0.5),
            position=(0, i * 1.5, 0.25),
        )
    server.scene.add_grid("/grid", width=4, height=15, plane="xy")


@test_case(
    category="Scene Composition",
    title="Kitchen Sink",
    description="Many element types together: box, sphere, cylinder, point cloud, frame, label, spline.",
    camera_position=(4.0, 4.0, 3.0),
)
def composition_kitchen_sink(server: viser.ViserServer) -> None:
    server.scene.configure_default_lights(enabled=True, cast_shadow=True)
    server.scene.add_grid("/grid", width=8, height=8, plane="xy", shadow_opacity=0.3)
    server.scene.add_box(
        "/box", color=(200, 80, 80), dimensions=(0.6, 0.6, 0.6), position=(-1.5, 0, 0.3)
    )
    server.scene.add_icosphere(
        "/sphere", radius=0.3, color=(80, 120, 200), position=(0, 0, 0.3)
    )
    server.scene.add_cylinder(
        "/cylinder",
        radius=0.2,
        height=0.6,
        color=(80, 200, 120),
        position=(1.5, 0, 0.3),
    )
    rng = np.random.default_rng(0)
    pts = rng.standard_normal((300, 3)).astype(np.float32) * 0.4
    pts[:, 0] -= 1.5
    pts[:, 1] += 2.0
    pts[:, 2] = np.abs(pts[:, 2]) + 0.1
    server.scene.add_point_cloud(
        "/cloud", points=pts, colors=(255, 180, 80), point_size=0.03
    )
    server.scene.add_frame(
        "/frame", axes_length=0.4, axes_radius=0.015, position=(1.5, 2.0, 0)
    )
    server.scene.add_label("/label", "Kitchen Sink", position=(0, 0, 1.2))
    t = np.linspace(0, 2 * np.pi, 30)
    helix_pts = np.stack(
        [np.cos(t) * 0.5, np.sin(t) * 0.5 + 2, t / (2 * np.pi) + 0.1], axis=-1
    ).astype(np.float32)
    server.scene.add_spline_catmull_rom(
        "/spline", points=helix_pts, color=(200, 60, 200), line_width=2.0
    )


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _find_free_port() -> int:
    """Find a free TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def _wait_for_server_ready(port: int, timeout: float = 5.0) -> None:
    """Poll until the server is accepting TCP connections."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("localhost", port), timeout=0.5):
                return
        except (ConnectionRefusedError, OSError):
            time.sleep(0.05)
    raise RuntimeError(f"Server on port {port} not ready within {timeout}s")


def _start_file_server(directory: Path, port: int) -> HTTPServer:
    """Start a background HTTP file server for the output directory."""
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    httpd = HTTPServer(("localhost", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


# ---------------------------------------------------------------------------
# HTML generation (progressive)
# ---------------------------------------------------------------------------


def _auto_refresh_js(enabled: bool) -> str:
    """Return JS snippet for auto-refreshing, paused when lightbox is open."""
    if not enabled:
        return ""
    return """
// Auto-refresh every 3s, but not while the lightbox is open.
setInterval(function() {
  if (!lightbox.classList.contains('active')) {
    window.location.reload();
  }
}, 3000);
"""


def _generate_gallery_html(
    all_cases: list[TestCase],
    completed_names: set[str],
    failed_names: dict[str, str] | None = None,
) -> str:
    """Generate the gallery HTML, marking incomplete cases as pending."""
    if failed_names is None:
        failed_names = {}
    seen_categories: list[str] = []
    for tc in all_cases:
        if tc.category not in seen_categories:
            seen_categories.append(tc.category)
    grouped: dict[str, list[TestCase]] = {cat: [] for cat in seen_categories}
    for tc in all_cases:
        grouped[tc.category].append(tc)

    cards_html = ""
    for category in seen_categories:
        cards_html += f'<h2 class="category-heading">{category}</h2>\n'
        cards_html += '<div class="grid">\n'
        for tc in grouped[category]:
            if tc.name in completed_names:
                cards_html += f"""  <div class="card">
    <h3>{tc.title}</h3>
    <p class="description">{tc.description}</p>
    <img src="screenshots/{tc.name}.png" alt="{tc.title}" loading="lazy" />
    <a href="#" class="view-link" data-viser="viser_files/{tc.name}.viser">View Interactive Scene</a>
  </div>
"""
            elif tc.name in failed_names:
                error_msg = (
                    failed_names[tc.name].replace("&", "&amp;").replace("<", "&lt;")
                )
                cards_html += f"""  <div class="card failed">
    <h3>{tc.title}</h3>
    <p class="description">{tc.description}</p>
    <div class="placeholder" style="color:#c00">FAILED: {error_msg}</div>
  </div>
"""
            else:
                cards_html += f"""  <div class="card pending">
    <h3>{tc.title}</h3>
    <p class="description">{tc.description}</p>
    <div class="placeholder">Generating...</div>
  </div>
"""
        cards_html += "</div>\n"

    total = len(all_cases)
    done_count = len(completed_names)
    progress_pct = int(done_count / total * 100) if total > 0 else 0
    progress_html = (
        f'<div class="progress-bar"><div class="progress-fill" style="width:{progress_pct}%"></div></div>'
        f'<p class="progress-text">{done_count}/{total} scenes generated'
        + (" — auto-refreshing every 3s" if done_count < total else " — all done!")
        + "</p>"
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Viser Scene Verification</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #fff; color: #222; padding: 24px; max-width: 1400px; margin: 0 auto; }}
  h1 {{ font-size: 1.6rem; margin-bottom: 4px; }}
  .subtitle {{ color: #666; font-size: 0.9rem; margin-bottom: 8px; }}
  .progress-bar {{ height: 6px; background: #eee; border-radius: 3px; margin-bottom: 4px; overflow: hidden; }}
  .progress-fill {{ height: 100%; background: #0066cc; border-radius: 3px; transition: width 0.3s; }}
  .progress-text {{ font-size: 0.8rem; color: #888; margin-bottom: 20px; }}
  .category-heading {{ font-size: 1.2rem; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #ddd; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }}
  .card {{ border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; background: #fafafa; }}
  .card.pending {{ opacity: 0.5; }}
  .card h3 {{ font-size: 0.95rem; margin-bottom: 4px; }}
  .card .description {{ font-size: 0.8rem; color: #555; margin-bottom: 8px; line-height: 1.4; }}
  .card img {{ width: 100%; border-radius: 4px; border: 1px solid #eee; display: block; }}
  .card .placeholder {{ width: 100%; aspect-ratio: 16/9; background: #eee; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #999; font-size: 0.85rem; }}
  .card .view-link {{ display: inline-block; margin-top: 8px; font-size: 0.8rem; color: #0066cc; text-decoration: none; }}
  .card .view-link:hover {{ text-decoration: underline; }}
  .lightbox {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; align-items: center; justify-content: center; }}
  .lightbox.active {{ display: flex; }}
  .lightbox-content {{ position: relative; width: 90vw; height: 85vh; background: #fff; border-radius: 8px; overflow: hidden; }}
  .lightbox-content iframe {{ width: 100%; height: 100%; border: none; }}
  .lightbox-close {{ position: absolute; top: 8px; right: 12px; font-size: 1.5rem; cursor: pointer; color: #666; z-index: 1001; background: rgba(255,255,255,0.8); border: none; border-radius: 4px; padding: 2px 8px; }}
  .lightbox-close:hover {{ color: #000; }}
</style>
</head>
<body>
<h1>Viser Scene Verification</h1>
<p class="subtitle">Visual inspection gallery. Click "View Interactive Scene" to load the 3D viewer.</p>
{progress_html}

{cards_html}

<div class="lightbox" id="lightbox">
  <div class="lightbox-content">
    <button class="lightbox-close" id="lightbox-close">&times;</button>
    <iframe id="lightbox-iframe"></iframe>
  </div>
</div>

<script>
const CLIENT_PATH = "client/index.html";
const lightbox = document.getElementById("lightbox");
const iframe = document.getElementById("lightbox-iframe");
const closeBtn = document.getElementById("lightbox-close");

document.querySelectorAll(".view-link").forEach(link => {{
  link.addEventListener("click", e => {{
    e.preventDefault();
    const viserFile = link.dataset.viser;
    iframe.src = CLIENT_PATH + "?playbackPath=/" + encodeURIComponent(viserFile);
    lightbox.classList.add("active");
  }});
}});

closeBtn.addEventListener("click", () => {{
  lightbox.classList.remove("active");
  iframe.src = "";
}});

lightbox.addEventListener("click", e => {{
  if (e.target === lightbox) {{
    lightbox.classList.remove("active");
    iframe.src = "";
  }}
}});

{_auto_refresh_js(done_count < total)}
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------


def _process_test_case(case: TestCase, page: Page) -> str:
    """Process a single test case: start server, populate, screenshot, serialize.

    Uses a headless Playwright browser as the viser client, then calls
    client.get_render() for a clean screenshot (bypasses canvas fade-in).

    Returns the case name on success.
    """
    import imageio.v3 as iio

    port = _find_free_port()
    server = viser.ViserServer(port=port, verbose=False)
    _wait_for_server_ready(port)

    server.initial_camera.position = case.camera_position
    server.initial_camera.look_at = case.camera_look_at
    server.initial_camera.fov = case.camera_fov

    case.populate(server)

    serializer = server.get_scene_serializer()
    viser_bytes = serializer.serialize()
    (VISER_FILES_DIR / f"{case.name}.viser").write_bytes(viser_bytes)

    # Wait for a client to connect via callback (avoids get_clients race).
    client_event = threading.Event()
    client_ref: list[viser.ClientHandle] = []

    @server.on_client_connect
    def _on_connect(client: viser.ClientHandle) -> None:
        client_ref.append(client)
        client_event.set()

    # Connect a headless browser as a viser client.
    page.goto(f"http://localhost:{port}")
    page.wait_for_function(
        "() => !document.body.innerText.includes('Connecting...')",
        timeout=15_000,
    )

    assert client_event.wait(timeout=10.0), "No client connected"
    client = client_ref[0]

    # Wait for the HDR environment map to load (provides ambient lighting).
    page.wait_for_function(
        "() => window.__viserMutable && window.__viserMutable.scene "
        "&& window.__viserMutable.scene.environment !== null",
        timeout=15_000,
    )

    # Render via the viser API (bypasses canvas opacity/fade).
    render = client.get_render(height=720, width=1280, transport_format="png")
    iio.imwrite(str(SCREENSHOTS_DIR / f"{case.name}.png"), render)

    server.stop()
    return case.name


def main() -> None:
    """Generate all verification scenes and serve the gallery."""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    # Prepare output directories.
    OUTPUT_DIR.mkdir(exist_ok=True)
    SCREENSHOTS_DIR.mkdir(exist_ok=True)
    VISER_FILES_DIR.mkdir(exist_ok=True)

    # Symlink the client build into the output directory.
    client_dest = OUTPUT_DIR / "client"
    if client_dest.exists():
        if client_dest.is_symlink():
            client_dest.unlink()
        else:
            shutil.rmtree(client_dest)
    client_dest.symlink_to(CLIENT_BUILD_DIR.resolve(), target_is_directory=True)

    test_cases = list(_REGISTRY)
    completed: set[str] = set()
    failed: dict[str, str] = {}
    html_lock = threading.Lock()

    def _update_gallery() -> None:
        with html_lock:
            (OUTPUT_DIR / "index.html").write_text(
                _generate_gallery_html(test_cases, completed, failed)
            )

    # Write initial HTML with all cases pending.
    _update_gallery()

    # Start file server and open browser.
    gallery_port = _find_free_port()
    httpd = _start_file_server(OUTPUT_DIR, gallery_port)
    gallery_url = f"http://localhost:{gallery_port}/index.html"
    print(f"Gallery server running at {gallery_url}")
    webbrowser.open(gallery_url)

    print(
        f"Generating {len(test_cases)} verification scenes ({NUM_WORKERS} workers)..."
    )
    print()

    # Playwright's sync API uses greenlets and is single-threaded per instance.
    # Each worker thread gets its own playwright -> browser -> page.
    _local = threading.local()

    def _get_page() -> Page:
        """Get or create a thread-local playwright browser page."""
        page: Page | None = getattr(_local, "page", None)
        if page is None:
            pw = sync_playwright().start()
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            _local.pw = pw
            _local.browser = browser
            _local.page = page
        return page

    def _cleanup_page() -> None:
        """Clean up thread-local playwright resources."""
        browser: Browser | None = getattr(_local, "browser", None)
        if browser is not None:
            browser.close()
        pw = getattr(_local, "pw", None)
        if pw is not None:
            pw.stop()

    def _worker(case: TestCase) -> str:
        page = _get_page()
        return _process_test_case(case, page)

    done_count = 0
    with ThreadPoolExecutor(max_workers=NUM_WORKERS) as executor:
        futures = {executor.submit(_worker, case): case for case in test_cases}
        for future in as_completed(futures):
            case = futures[future]
            try:
                future.result()
                completed.add(case.name)
                done_count += 1
                print(
                    f"  [{done_count}/{len(test_cases)}] {case.category} / {case.title} done"
                )
                _update_gallery()
            except Exception as e:
                failed[case.name] = str(e)
                done_count += 1
                print(
                    f"  [{done_count}/{len(test_cases)}] {case.category} / {case.title} FAILED: {e}"
                )
                _update_gallery()

        # Clean up all thread-local browsers.
        cleanup_futures = [executor.submit(_cleanup_page) for _ in range(NUM_WORKERS)]
        for f in cleanup_futures:
            f.result()

    httpd.shutdown()

    print()
    print("All done! To re-serve the gallery:")
    print(f"  cd {OUTPUT_DIR} && python -m http.server")
    breakpoint()


if __name__ == "__main__":
    main()
