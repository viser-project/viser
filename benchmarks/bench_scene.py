"""Heavy benchmark scene for the viser client.

Spawned by ``run_bench.py``; can also be run standalone for manual profiling:

    python benchmarks/bench_scene.py --port 8080 --mode idle

Modes:
  idle   -- static heavy scene, nothing changes after load.
  orbit  -- server orbits each connected client's camera at ~30 Hz.
  gui    -- server streams GUI-only updates (slider/progress/markdown) at ~30 Hz.
  scene  -- server streams pose updates to a subset of frames at ~30 Hz.
"""

from __future__ import annotations

import argparse
import math
import time

import numpy as np

import viser


def build_scene(server: viser.ViserServer, num_frames: int, num_meshes: int):
    """Populate a heavy scene: many coordinate frames, meshes, a point cloud."""
    rng = np.random.default_rng(0)

    frame_handles = []
    # Coordinate frames in a grid, with some nesting for tree depth.
    side = math.ceil(math.sqrt(num_frames))
    for i in range(num_frames):
        x, y = divmod(i, side)
        name = f"/frames/f{x}/n{y}" if y % 4 == 0 else f"/frames/f{x}/n{y - y % 4}/c{y % 4}"
        frame_handles.append(
            server.scene.add_frame(
                name,
                position=(x * 0.5, y * 0.5, 0.0),
                axes_length=0.2,
                axes_radius=0.01,
            )
        )

    # Simple meshes (icospheres + boxes).
    for i in range(num_meshes):
        angle = i * 2 * math.pi / max(num_meshes, 1)
        pos = (3.0 * math.cos(angle), 3.0 * math.sin(angle), 1.0 + 0.1 * i)
        if i % 2 == 0:
            server.scene.add_icosphere(
                f"/meshes/sphere_{i}", radius=0.1, position=pos, color=(200, 30, 30)
            )
        else:
            server.scene.add_box(
                f"/meshes/box_{i}",
                dimensions=(0.15, 0.15, 0.15),
                position=pos,
                color=(30, 30, 200),
            )

    # A moderately sized point cloud.
    server.scene.add_point_cloud(
        "/pointcloud",
        points=rng.uniform(-2, 2, size=(50_000, 3)).astype(np.float32),
        colors=rng.uniform(0, 255, size=(50_000, 3)).astype(np.uint8),
        point_size=0.01,
    )
    return frame_handles


def build_gui(server: viser.ViserServer, num_controls: int):
    """Populate a heavy GUI: folders of sliders/checkboxes/text + markdown."""
    handles = {}
    with server.gui.add_folder("Streaming"):
        handles["slider"] = server.gui.add_slider(
            "Stream slider", min=0.0, max=1.0, step=1e-4, initial_value=0.0
        )
        handles["progress"] = server.gui.add_progress_bar(20.0, animated=False)
        handles["markdown"] = server.gui.add_markdown("value: `0.0000`")

    n_folders = max(1, num_controls // 10)
    for f in range(n_folders):
        with server.gui.add_folder(f"Folder {f}"):
            for i in range(min(10, num_controls - f * 10)):
                kind = i % 5
                if kind == 0:
                    server.gui.add_slider(f"Slider {f}.{i}", min=0, max=100, step=1, initial_value=i)
                elif kind == 1:
                    server.gui.add_checkbox(f"Check {f}.{i}", initial_value=bool(i % 2))
                elif kind == 2:
                    server.gui.add_text(f"Text {f}.{i}", initial_value=f"value {i}")
                elif kind == 3:
                    server.gui.add_vector3(f"Vec {f}.{i}", initial_value=(0.0, 1.0, 2.0))
                else:
                    server.gui.add_markdown(f"Static markdown **{f}.{i}** with `code`.")
    return handles


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--mode", choices=["idle", "orbit", "gui", "scene"], default="idle")
    parser.add_argument("--num-frames", type=int, default=250)
    parser.add_argument("--num-meshes", type=int, default=50)
    parser.add_argument("--num-controls", type=int, default=100)
    parser.add_argument("--rate-hz", type=float, default=30.0)
    args = parser.parse_args()

    server = viser.ViserServer(port=args.port, verbose=False)
    frame_handles = build_scene(server, args.num_frames, args.num_meshes)
    gui_handles = build_gui(server, args.num_controls)
    print(f"BENCH_READY port={args.port}", flush=True)

    t0 = time.time()
    period = 1.0 / args.rate_hz
    while True:
        time.sleep(period)
        t = time.time() - t0
        if args.mode == "orbit":
            for client in server.get_clients().values():
                angle = 0.5 * t
                client.camera.position = (8 * math.cos(angle), 8 * math.sin(angle), 4.0)
                client.camera.look_at = (0.0, 0.0, 0.0)
        elif args.mode == "gui":
            v = 0.5 + 0.5 * math.sin(t)
            gui_handles["slider"].value = round(v, 4)
            gui_handles["progress"].value = 100 * v
            gui_handles["markdown"].content = f"value: `{v:.4f}`"
        elif args.mode == "scene":
            with server.atomic():
                for i, h in enumerate(frame_handles[:50]):
                    h.position = (
                        h.position[0],
                        h.position[1],
                        0.3 * math.sin(t + 0.3 * i),
                    )


if __name__ == "__main__":
    main()
