"""GUI callbacks

Attach event handlers to GUI elements for real-time interaction.

This example demonstrates how to create responsive interfaces using GUI callbacks. Callbacks are functions that execute automatically when users interact with controls, enabling real-time updates to the 3D scene.

**Key callback methods:**

* :meth:`viser.GuiInputHandle.on_update` for input changes (sliders, dropdowns, checkboxes)
* :meth:`viser.GuiButtonHandle.on_click` for button press events
* :meth:`viser.GuiUploadButtonHandle.on_upload` for file upload events

**Features demonstrated:**

* Dynamic scene updates using :meth:`viser.SceneApi.add_grid` and :meth:`viser.SceneApi.add_point_cloud`
* Conditional GUI state changes (dynamically updating dropdown options)
* Global scene visibility control with :meth:`viser.SceneApi.set_global_visibility`
* Coordinated updates where multiple controls affect the same scene objects

The pattern shown here—connecting GUI controls to scene updates via callbacks—is fundamental for building interactive 3D applications with viser.
"""

import time

import numpy as np
from typing_extensions import assert_never

import viser


def main() -> None:
    server = viser.ViserServer()

    gui_reset_scene_click = server.gui.add_button("Reset Scene on Click")

    gui_reset_scene_hold = server.gui.add_button("Reset Scene on Hold")

    gui_plane = server.gui.add_dropdown(
        "Grid plane", ("xz", "xy", "yx", "yz", "zx", "zy")
    )

    def update_plane() -> None:
        server.scene.add_grid("/grid", width=10.0, height=20.0, plane=gui_plane.value)

    gui_plane.on_update(lambda _: update_plane())

    with server.gui.add_folder("Control"):
        gui_show_frame = server.gui.add_checkbox("Show Frame", initial_value=True)
        gui_show_everything = server.gui.add_checkbox(
            "Show Everything", initial_value=True
        )
        gui_axis = server.gui.add_dropdown("Axis", ("x", "y", "z"))
        gui_include_z = server.gui.add_checkbox("Z in dropdown", initial_value=True)

        @gui_include_z.on_update
        def _(_) -> None:
            gui_axis.options = ("x", "y", "z") if gui_include_z.value else ("x", "y")

        with server.gui.add_folder("Sliders"):
            gui_location = server.gui.add_slider(
                "Location", min=-5.0, max=5.0, step=0.05, initial_value=0.0
            )
            gui_num_points = server.gui.add_slider(
                "# Points", min=1000, max=200_000, step=1000, initial_value=10_000
            )

    def draw_frame() -> None:
        axis = gui_axis.value
        if axis == "x":
            pos = (gui_location.value, 0.0, 0.0)
        elif axis == "y":
            pos = (0.0, gui_location.value, 0.0)
        elif axis == "z":
            pos = (0.0, 0.0, gui_location.value)
        else:
            assert_never(axis)

        server.scene.add_frame(
            "/frame",
            wxyz=(1.0, 0.0, 0.0, 0.0),
            position=pos,
            show_axes=gui_show_frame.value,
            axes_length=5.0,
        )

    def draw_points() -> None:
        num_points = gui_num_points.value
        server.scene.add_point_cloud(
            "/frame/point_cloud",
            points=np.random.normal(size=(num_points, 3)),
            colors=np.random.randint(0, 256, size=(num_points, 3)),
        )

    # We can (optionally) also attach callbacks!
    # Here, we update the point clouds + frames whenever any of the GUI items are updated.
    gui_show_frame.on_update(lambda _: draw_frame())
    gui_show_everything.on_update(
        lambda _: server.scene.set_global_visibility(gui_show_everything.value)
    )
    gui_axis.on_update(lambda _: draw_frame())
    gui_location.on_update(lambda _: draw_frame())
    gui_num_points.on_update(lambda _: draw_points())

    @gui_reset_scene_click.on_click
    def _(_) -> None:
        """Reset the scene when the reset button is clicked."""
        gui_show_frame.value = True
        gui_location.value = 0.0
        gui_axis.value = "x"
        gui_num_points.value = 10_000

        draw_frame()
        draw_points()

    @gui_reset_scene_hold.on_hold
    def _(_) -> None:
        """Reset the scene when the reset button is held."""
        gui_show_frame.value = True
        gui_location.value = 0.0
        gui_axis.value = "x"
        gui_num_points.value = 10_000

        draw_frame()
        draw_points()

    # Finally, let's add the initial frame + point cloud and just loop infinitely. :)
    update_plane()
    draw_frame()
    draw_points()
    while True:
        time.sleep(1.0)


if __name__ == "__main__":
    main()
