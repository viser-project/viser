"""Floating user panels.

``add_panel`` opens a floating, draggable, resizable panel as a sibling of
the main control panel. Use it to arrange GUI groups side-by-side rather
than stacked vertically inside a single panel.

``initial_position`` accepts ``(x, y)`` pixel offsets:
- Positive integers are measured from the top-left edge.
- Negative integers anchor to the right/bottom edge
  (e.g. ``(-20, 20)`` is 20 pixels from the top-right corner).
- ``"center"`` centers the panel along that axis.

``layout="row"`` renders children side-by-side with equal flex share —
useful for rows of camera/video feeds.

Run with:

    python examples/02_gui/11_panels.py

Then open http://localhost:8080 in your browser. Drag panel headers to
move, drag the right edge to resize. Try narrowing your browser window to
see how ``"center"`` keeps the camera panel centered.
"""

import time

import numpy as np

import viser


def _fake_frame(t: float, hue_shift: float, zoom: float) -> np.ndarray:
    """Generate a 120x160 RGB frame — a moving sine gradient. `zoom`
    controls the gradient's spatial frequency (1=coarse, high=dense)."""
    h, w = 120, 160
    xs = np.linspace(0, zoom * np.pi, w)
    ys = np.linspace(0, zoom * np.pi, h)
    grid = np.sin(xs[None, :] + t) + np.cos(ys[:, None] + t * 0.7)
    grid = ((grid + 2) / 4 * 255).astype(np.uint8)  # 0..255
    rgb = np.stack(
        [
            np.roll(grid, int(hue_shift * 20), axis=1),
            np.roll(grid, int(hue_shift * 40), axis=0),
            grid,
        ],
        axis=-1,
    )
    return rgb


def main() -> None:
    server = viser.ViserServer()

    # The main control panel still works as before.
    with server.gui.add_folder("Main controls"):
        playing = server.gui.add_checkbox("Animate", initial_value=True)
        server.gui.add_markdown("Drag headers to move. Drag right edges to resize.")

    # A user panel pinned to the top-left.
    with server.gui.add_panel(
        "Controls", initial_position=(20, 20), initial_width_px=240
    ):
        zoom = server.gui.add_slider("Zoom", min=1, max=40, step=1, initial_value=8)
        reset = server.gui.add_button("Reset animation")

    # A row-layout panel centered horizontally. We place it below the
    # Controls panel (y=180) rather than at the top so that on narrow
    # windows (where the centered Cameras panel is wide enough to touch
    # the Controls panel at y=20), they stack instead of overlapping.
    with server.gui.add_panel(
        "Cameras",
        initial_position=("center", 180),
        initial_width_px=540,
        layout="row",
    ):
        camera_handles = [
            server.gui.add_image(
                np.zeros((120, 160, 3), dtype=np.uint8), label=f"Camera {name}"
            )
            for name in ("left", "top", "right")
        ]

    # A third panel pinned near the bottom-right — negative values in
    # `initial_position` anchor to the right (x) and bottom (y) edges.
    with server.gui.add_panel(
        "Status", initial_position=(-280, -120), initial_width_px=260
    ):
        fps_text = server.gui.add_markdown("FPS: ...")

    start = [time.time()]  # one-element list so the button's callback can mutate it

    @reset.on_click
    def _(_event: viser.GuiEvent) -> None:
        start[0] = time.time()

    frame_count = 0
    last_fps_update = time.time()
    while True:
        if playing.value:
            t = time.time() - start[0]
            for i, handle in enumerate(camera_handles):
                handle.image = _fake_frame(t, hue_shift=float(i), zoom=zoom.value)
            frame_count += 1
        now = time.time()
        if now - last_fps_update > 0.5:
            fps = frame_count / (now - last_fps_update)
            fps_text.content = f"FPS: **{fps:.1f}**"
            frame_count = 0
            last_fps_update = now
        time.sleep(1 / 30)


if __name__ == "__main__":
    main()
