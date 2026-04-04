"""Arrow visualization

Create arrows for visualizing vectors, directions, and quantities in 3D space.

This example demonstrates viser's arrow rendering capabilities, which are useful for
visualizing directions, forces, velocities, and other vector quantities common in
robotics and computer vision applications.

**Use cases:**

* Perception rays in robotics and 3D sensing
* Force vectors (contact forces, thruster forces)
* Velocity vectors (commanded or actual velocities)
* Axes of rotation and angular velocities
* Coordinate frame directions

Arrows are batched into a single call for efficiency, similar to line segments.
Each arrow is defined by a start point and end point, with configurable shaft
radius, head radius, and head length.
"""

import time

import numpy as np

import viser


def main() -> None:
    server = viser.ViserServer()

    # Batched arrows.
    #
    # Create multiple arrows in a single call for efficiency.
    # Points shape: (N, 2, 3) where N is number of arrows,
    # 2 is start/end, and 3 is x, y, z.
    N = 200
    points = np.zeros((N, 2, 3), dtype=np.float32)
    colors = np.zeros((N, 2, 3), dtype=np.uint8)

    for i in range(N):
        # Distribute arrows in a spiral pattern
        theta = i * 0.3
        r = 1.0 + i * 0.02
        x = r * np.cos(theta)
        y = i * 0.05
        z = r * np.sin(theta)

        # Arrow from center to point
        points[i, 0] = [0, y, 0]  # start
        points[i, 1] = [x, y, z]  # end

        # Color gradient from blue to red based on height
        color_value = int(255 * (y / (N * 0.05)))
        colors[i, 0] = [color_value, 0, 255 - color_value]  # start color
        colors[i, 1] = [color_value, 0, 255 - color_value]  # end color

    server.scene.add_arrows(
        "/arrows/spiral",
        points=points,
        colors=colors,
        shaft_radius=0.02,
        head_radius=0.05,
        head_length=0.1,
    )

    # Coordinate frame arrows.
    #
    # Arrows are useful for visualizing coordinate frames and axes.
    origin = [0, 2, 0]
    frame_points = np.array(
        [
            [origin, [1, 2, 0]],  # X axis (red)
            [origin, [0, 3, 0]],  # Y axis (green)
            [origin, [0, 2, 1]],  # Z axis (blue)
        ],
        dtype=np.float32,
    )
    frame_colors = np.array(
        [
            [[255, 0, 0], [255, 0, 0]],  # X: red
            [[0, 255, 0], [0, 255, 0]],  # Y: green
            [[0, 0, 255], [0, 0, 255]],  # Z: blue
        ],
        dtype=np.uint8,
    )
    server.scene.add_arrows(
        "/arrows/frame",
        points=frame_points,
        colors=frame_colors,
        shaft_radius=0.03,
        head_radius=0.08,
        head_length=0.15,
    )

    # Force vectors example.
    #
    # Arrows can represent forces on an object. Here we show
    # contact forces on a simple object at position (0, 4, 0).
    contact_point = [0, 4, 0]
    force_vectors = np.array(
        [
            [contact_point, [0.5, 4.5, 0.3]],  # Force 1
            [contact_point, [-0.3, 4.8, -0.2]],  # Force 2
            [contact_point, [0.1, 5.2, -0.4]],  # Force 3 (largest)
            [contact_point, [-0.4, 4.3, 0.5]],  # Force 4
        ],
        dtype=np.float32,
    )
    force_colors = np.array(
        [
            [[255, 200, 0], [255, 200, 0]],  # Yellow
            [[255, 100, 0], [255, 100, 0]],  # Orange
            [[255, 50, 0], [255, 50, 0]],  # Red-orange (largest force)
            [[255, 150, 0], [255, 150, 0]],  # Orange-yellow
        ],
        dtype=np.uint8,
    )
    server.scene.add_arrows(
        "/arrows/forces",
        points=force_vectors,
        colors=force_colors,
        shaft_radius=0.04,
        head_radius=0.1,
        head_length=0.2,
    )

    # Uniform color arrows.
    #
    # For simple visualization, a single color can be applied to all arrows.
    N_velocities = 50
    velocity_points = np.zeros((N_velocities, 2, 3), dtype=np.float32)
    for i in range(N_velocities):
        # Random starting positions
        start = np.random.normal(size=(3,)) * 3
        # Random velocity direction
        velocity = np.random.normal(size=(3,)) * 0.5
        velocity_points[i, 0] = start
        velocity_points[i, 1] = start + velocity

    server.scene.add_arrows(
        "/arrows/velocities",
        points=velocity_points,
        colors=(100, 200, 255),  # Uniform light blue
        shaft_radius=0.015,
        head_radius=0.04,
        head_length=0.08,
    )

    while True:
        time.sleep(10.0)


if __name__ == "__main__":
    main()
