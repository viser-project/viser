"""Shared scene builders for visual regression tests and reference generation.

Each scene builder takes a ViserServer and populates it with a deterministic
scene.  The SCENES list defines the canonical set of visual regression test
cases — it is used by both the test suite and the reference-image generator.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

import viser


def build_basic_scene(server: viser.ViserServer) -> None:
    """Icosphere + grid."""
    server.scene.set_up_direction("+z")
    server.scene.add_icosphere(
        "/icosphere",
        radius=0.5,
        color=(31, 119, 180),
        position=(0.0, 0.0, 0.5),
    )
    server.scene.add_grid(
        "/grid",
        width=4.0,
        height=4.0,
        plane="xy",
        cell_size=0.5,
        section_size=1.0,
    )


def build_gui_panel(server: viser.ViserServer) -> None:
    """Various GUI controls."""
    server.gui.add_button("Click Me", color="blue")
    server.gui.add_slider("Opacity", min=0.0, max=1.0, step=0.01, initial_value=0.75)
    server.gui.add_checkbox("Wireframe", initial_value=False)
    server.gui.add_dropdown("Material", options=["standard", "toon3", "toon5"])
    server.gui.add_text("Label", initial_value="Hello Viser")
    server.gui.add_number("Count", initial_value=42, min=0, max=100, step=1)


def build_complex_scene(server: viser.ViserServer) -> None:
    """Point cloud, labels, frames."""
    rng = np.random.default_rng(42)

    server.scene.set_up_direction("+z")

    num_points = 500
    points = rng.standard_normal((num_points, 3)).astype(np.float32) * 0.5
    colors = np.clip((points * 128 + 128), 0, 255).astype(np.uint8)
    server.scene.add_point_cloud(
        "/points",
        points=points,
        colors=colors,
        point_size=0.03,
        point_shape="circle",
    )

    for i, pos in enumerate([(1, 0, 0), (0, 1, 0), (0, 0, 1)]):
        server.scene.add_frame(
            f"/frame_{i}",
            show_axes=True,
            axes_length=0.3,
            axes_radius=0.015,
            position=pos,
        )

    server.scene.add_label("/label_x", "X", position=(1.0, 0.0, 0.3))
    server.scene.add_label("/label_y", "Y", position=(0.0, 1.0, 0.3))
    server.scene.add_label("/label_z", "Z", position=(0.0, 0.0, 1.3))


# Ordered list of (name, builder) pairs.
SCENES: list[tuple[str, Callable[[viser.ViserServer], None]]] = [
    ("basic_scene_icosphere", build_basic_scene),
    ("gui_panel_controls", build_gui_panel),
    ("complex_scene_pointcloud", build_complex_scene),
]
