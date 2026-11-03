"""Shared-geometry URDF instances, with independent joint and base poses.

No robot downloads are required. Install with ``pip install -e '.[urdf]'``.
Run ``python examples/04_demos/06_batched_urdf.py --num-robots 16``.
Use ``--record demo.html`` to export a standalone, three-second animation.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

import viser
import viser.transforms as tf
from viser.extras import BatchedViserUrdf


def main(num_robots: int = 16, port: int = 8080, record: Path | None = None) -> None:
    server = viser.ViserServer(port=port)
    side = int(np.ceil(np.sqrt(num_robots)))
    extent = max(2.0, side * 1.2)
    server.initial_camera.position = (extent * 0.85, -extent, extent * 0.9)
    server.initial_camera.look_at = (0.0, 0.0, 0.25)
    server.scene.add_grid("/grid", width=extent + 1, height=extent + 1, cell_size=0.2)
    server.scene.add_frame("/robots", show_axes=False)
    robots = BatchedViserUrdf(
        server,
        Path(__file__).parents[1] / "assets/batched_arm.urdf",
        num_robots,
        root_node_name="/robots",
    )
    indices = np.arange(num_robots)
    base_positions = np.stack(
        [indices % side, indices // side, np.zeros(num_robots)], axis=-1
    ).astype(float)
    base_positions[:, :2] = (base_positions[:, :2] - (side - 1) / 2) * 1.2
    robots.update_base_poses(
        batched_wxyzs=tf.SO3.from_z_radians(np.full(num_robots, 0.3)).wxyz,
        batched_positions=base_positions,
    )

    def configuration(t: float) -> np.ndarray:
        phase = t * 2.0 + indices * 0.45
        return np.stack([0.75 * np.sin(phase), 0.12 + 0.1 * np.cos(phase)], axis=-1)

    if record is not None:
        recording = server.get_scene_serializer()
        for frame in range(90):
            robots.update_cfg(configuration(frame / 30))
            recording.insert_sleep(1.0 / 30)
        record.write_text(recording.as_html())
        print(f"Saved animation to {record}")
        server.stop()
        return

    animate = server.gui.add_checkbox("Animate", initial_value=True)
    visible = server.gui.add_checkbox("Show robots", initial_value=True)
    shoulder = server.gui.add_slider(
        "Shoulder", min=-1.2, max=1.2, step=0.01, initial_value=0.0
    )
    extension = server.gui.add_slider(
        "Extension", min=0, max=0.3, step=0.01, initial_value=0.1
    )

    @visible.on_update
    def _(_) -> None:
        robots.show_visual = visible.value

    server.gui.add_markdown(
        f"**{num_robots} robots, 6 shared visual meshes**\n\n"
        "Turn off Animate to set every robot to the slider values. "
        "Joint FK still runs in a Python loop."
    )
    start = time.perf_counter()
    try:
        while True:
            cfg = (
                configuration(time.perf_counter() - start)
                if animate.value
                else np.tile([shoulder.value, extension.value], (num_robots, 1))
            )
            robots.update_cfg(cfg)
            time.sleep(1.0 / 30)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--num-robots", type=int, default=16)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--record", type=Path)
    args = parser.parse_args()
    if args.num_robots < 1:
        parser.error("num-robots must be positive")
    main(args.num_robots, args.port, args.record)
