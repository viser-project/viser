"""Dockable panels

Demonstrate :meth:`viser.GuiApi.add_panel` — dockable windows that can start
docked to a canvas edge or as free-floating windows.

**What to try in the viewer:**

* Drag a panel's tab strip to move or undock it.
* Drag a panel's edges/corners to resize it.
* Drag one panel's tab onto another's to combine them into one tabbed group.
* Drag a tab back out of a group to split it into its own window.

On mobile (narrow viewport), panels render inline in the main GUI panel.
"""

from __future__ import annotations

import time

import numpy as np

import viser


def main() -> None:
    server = viser.ViserServer()

    server.scene.add_grid("grid", width=10.0, height=10.0)
    transform_handle = server.scene.add_transform_controls("box_target")
    box_handle = server.scene.add_box(
        "/box_target/box",
        position=(0.0, 0.0, 0.5),
        dimensions=(1.0, 1.0, 1.0),
        color=(220, 100, 100),
    )

    # ---- Scene panel (docked to the right) --------------------------------
    with server.gui.add_panel("Scene", dock="right"):
        gui_box_color = server.gui.add_rgb("Box color", initial_value=(220, 100, 100))
        gui_box_size = server.gui.add_slider(
            "Box size", min=0.2, max=3.0, step=0.05, initial_value=1.0
        )
        gui_wireframe = server.gui.add_checkbox("Wireframe", initial_value=False)

        @gui_box_color.on_update
        def _(_: viser.GuiEvent) -> None:
            box_handle.color = gui_box_color.value

        @gui_box_size.on_update
        def _(_: viser.GuiEvent) -> None:
            s = gui_box_size.value
            box_handle.dimensions = (s, s, s)

        @gui_wireframe.on_update
        def _(_: viser.GuiEvent) -> None:
            box_handle.wireframe = gui_wireframe.value

    # ---- Wave panel (docked to the bottom) --------------------------------
    with server.gui.add_panel("Wave", dock="bottom"):
        gui_amp = server.gui.add_slider(
            "Amplitude", min=0.0, max=2.0, step=0.05, initial_value=0.5
        )
        gui_freq = server.gui.add_slider(
            "Frequency", min=0.1, max=4.0, step=0.05, initial_value=1.0
        )
        gui_phase = server.gui.add_slider(
            "Phase", min=0.0, max=2 * np.pi, step=0.05, initial_value=0.0
        )

    # ---- Stats panel (floating) -------------------------------------------
    with server.gui.add_panel("Stats", dock="floating"):
        gui_fps = server.gui.add_number("Server FPS", initial_value=0.0, disabled=True)
        gui_box_pos = server.gui.add_vector3(
            "Box position", initial_value=(0.0, 0.0, 0.5), disabled=True
        )
        gui_uptime = server.gui.add_text("Uptime", initial_value="0.0 s", disabled=True)

    # A wiggly line driven by the wave panel.
    xs = np.linspace(-5.0, 5.0, 101)

    def wave_points() -> np.ndarray:
        zs = gui_amp.value * np.sin(gui_freq.value * xs + gui_phase.value)
        ys = np.zeros_like(xs)
        return np.stack([xs, ys, zs + 1.5], axis=-1).astype(np.float32)

    wave_handle = server.scene.add_spline_catmull_rom(
        "wave", points=wave_points(), color=(80, 160, 220), line_width=3.0
    )
    for slider in (gui_amp, gui_freq, gui_phase):

        @slider.on_update
        def _(_: viser.GuiEvent) -> None:
            wave_handle.points = wave_points()

    # ---- Live stats updates -----------------------------------------------
    start = time.time()
    last = start
    frames = 0
    while True:
        time.sleep(1.0 / 30.0)
        frames += 1
        now = time.time()
        if now - last >= 0.5:
            gui_fps.value = round(frames / (now - last), 1)
            frames = 0
            last = now
        gui_uptime.value = f"{now - start:.1f} s"
        x, y, z = transform_handle.position
        gui_box_pos.value = (float(x), float(y), float(z) + 0.5)


if __name__ == "__main__":
    main()
