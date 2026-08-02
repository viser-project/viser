"""Boids flocking simulation

Hundreds of birds — or a school of fish — flock in 3D using Craig Reynolds'
classic boids rules, with a draggable predator to scatter them.

**Features:**

* :meth:`viser.SceneApi.add_batched_meshes_simple` for rendering the whole
  flock as a single instanced mesh
* Vectorized separation, alignment, and cohesion rules with NumPy
* A predator controlled with :meth:`viser.SceneApi.add_transform_controls`
  that the flock flees from
* A bird / fish species toggle that swaps the instanced mesh geometry
  in-place and restyles the scene with :meth:`viser.SceneApi.configure_fog`
  and :meth:`viser.SceneApi.set_background_image`
* GUI sliders for live-tuning the flocking behavior
"""

from __future__ import annotations

import time

import numpy as np

import viser


def make_bird_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Build a small swept-wing dart pointing along +X."""
    vertices = np.array(
        [
            [0.35, 0.0, 0.0],  # Nose.
            [-0.15, 0.25, 0.05],  # Left wingtip.
            [-0.15, -0.25, 0.05],  # Right wingtip.
            [-0.05, 0.0, -0.05],  # Keel.
            [-0.20, 0.0, 0.02],  # Tail notch.
        ],
        dtype=np.float32,
    )
    faces = np.array(
        [
            [0, 1, 4],  # Left wing.
            [0, 4, 2],  # Right wing.
            [0, 3, 1],  # Left keel.
            [0, 2, 3],  # Right keel.
            [4, 3, 2],  # Tail underside, right.
            [4, 1, 3],  # Tail underside, left.
        ],
        dtype=np.uint32,
    )
    return vertices, faces


def make_fish_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Build a small fish pointing along +X: a diamond body with a vertical tail fin."""
    vertices = np.array(
        [
            [0.30, 0.0, 0.0],  # Nose.
            [0.02, 0.0, 0.10],  # Back.
            [0.02, 0.07, 0.0],  # Left flank.
            [0.02, 0.0, -0.08],  # Belly.
            [0.02, -0.07, 0.0],  # Right flank.
            [-0.18, 0.0, 0.0],  # Tail root.
            [-0.34, 0.0, 0.12],  # Tail fin, top.
            [-0.30, 0.0, 0.0],  # Tail fin, notch.
            [-0.34, 0.0, -0.10],  # Tail fin, bottom.
        ],
        dtype=np.float32,
    )
    faces = np.array(
        [
            [0, 2, 1],  # Front upper-left.
            [0, 3, 2],  # Front lower-left.
            [0, 4, 3],  # Front lower-right.
            [0, 1, 4],  # Front upper-right.
            [5, 1, 2],  # Rear upper-left.
            [5, 2, 3],  # Rear lower-left.
            [5, 3, 4],  # Rear lower-right.
            [5, 4, 1],  # Rear upper-right.
            [5, 6, 7],  # Tail fin, upper lobe.
            [5, 7, 8],  # Tail fin, lower lobe.
        ],
        dtype=np.uint32,
    )
    return vertices, faces


def headings_to_wxyzs(directions: np.ndarray) -> np.ndarray:
    """Compute quaternions rotating +X to each (unit) direction. Shape (N, 3) -> (N, 4)."""
    n = directions.shape[0]
    x_axis = np.array([1.0, 0.0, 0.0])
    wxyzs = np.zeros((n, 4), dtype=np.float32)
    wxyzs[:, 0] = 1.0 + directions @ x_axis
    wxyzs[:, 1:] = np.cross(np.broadcast_to(x_axis, (n, 3)), directions)

    # Boids flying exactly along -X get an arbitrary 180 degree rotation.
    degenerate = wxyzs[:, 0] < 1e-6
    wxyzs[degenerate] = (0.0, 0.0, 0.0, 1.0)

    wxyzs /= np.linalg.norm(wxyzs, axis=1, keepdims=True)
    return wxyzs


def headings_to_colors(
    directions: np.ndarray, hue_start: float = 0.0, hue_span: float = 1.0
) -> np.ndarray:
    """Color each boid by its heading: hue from yaw, brightness from pitch.

    Birds use the full rainbow (`hue_span=1.0`); fish compress the hues into a
    silvery blue-green band.
    """
    yaw_fraction = (
        np.arctan2(directions[:, 1], directions[:, 0]) / (2.0 * np.pi)
    ) % 1.0
    hue = (hue_start + hue_span * yaw_fraction) % 1.0
    value = 0.75 + 0.25 * directions[:, 2]

    # Vectorized HSV -> RGB with full saturation.
    h6 = hue * 6.0
    x = 1.0 - np.abs(h6 % 2.0 - 1.0)
    zeros = np.zeros_like(hue)
    ones = np.ones_like(hue)
    sector = np.minimum(h6.astype(np.int32), 5)
    rgb_by_sector = np.array(
        [
            [ones, x, zeros],
            [x, ones, zeros],
            [zeros, ones, x],
            [zeros, x, ones],
            [x, zeros, ones],
            [ones, zeros, x],
        ]
    )  # (6, 3, N)
    rgb = rgb_by_sector[sector, :, np.arange(hue.shape[0])] * value[:, None]
    return (rgb * 255).astype(np.uint8)


def make_underwater_gradient() -> np.ndarray:
    """A vertical gradient from sunlit teal down to deep blue."""
    top = np.array([40.0, 110.0, 140.0])
    bottom = np.array([4.0, 18.0, 42.0])
    t = np.linspace(0.0, 1.0, 256)[:, None, None]
    return (top * (1.0 - t) + bottom * t).astype(np.uint8)  # (256, 1, 3)


def main() -> None:
    server = viser.ViserServer()
    server.scene.configure_default_lights()
    server.scene.add_grid("/grid", width=20, height=20)
    server.initial_camera.position = (14.0, 14.0, 10.0)
    server.initial_camera.look_at = (0.0, 0.0, 5.0)

    # Flocking controls.
    species_dropdown = server.gui.add_dropdown(
        "Species", options=("Birds", "Fish"), initial_value="Birds"
    )
    num_boids_slider = server.gui.add_slider(
        "# of boids", min=10, max=1000, step=10, initial_value=400
    )
    separation_slider = server.gui.add_slider(
        "Separation", min=0.0, max=3.0, step=0.05, initial_value=1.2
    )
    alignment_slider = server.gui.add_slider(
        "Alignment", min=0.0, max=3.0, step=0.05, initial_value=1.0
    )
    cohesion_slider = server.gui.add_slider(
        "Cohesion", min=0.0, max=3.0, step=0.05, initial_value=0.8
    )
    max_speed_slider = server.gui.add_slider(
        "Max speed", min=1.0, max=12.0, step=0.5, initial_value=6.0
    )
    paused_checkbox = server.gui.add_checkbox("Pause", initial_value=False)
    scatter_button = server.gui.add_button("Scatter!")

    # Simulation constants.
    home = np.array([0.0, 0.0, 5.0])  # Center of the flock's territory.
    home_radius = 7.0  # Soft boundary; boids steer back once outside.
    neighbor_radius = 1.8
    separation_radius = 0.7
    predator_radius = 3.5
    min_speed = 2.0
    rng = np.random.default_rng(0)

    def spawn(n: int) -> tuple[np.ndarray, np.ndarray]:
        positions = home + rng.uniform(-3.0, 3.0, size=(n, 3))
        velocities = rng.normal(size=(n, 3))
        velocities *= 4.0 / np.linalg.norm(velocities, axis=1, keepdims=True)
        return positions, velocities

    positions, velocities = spawn(num_boids_slider.value)

    @scatter_button.on_click
    def _(_) -> None:
        nonlocal velocities
        velocities = rng.normal(size=velocities.shape)
        velocities *= max_speed_slider.value / np.linalg.norm(
            velocities, axis=1, keepdims=True
        )

    # The predator: drag it into the flock to scare the boids. It plays a hawk
    # for birds and a shark for fish.
    predator = server.scene.add_transform_controls(
        "/predator",
        position=(0.0, -12.0, 5.0),
        scale=1.5,
        disable_rotations=True,
    )
    predator_body = server.scene.add_icosphere(
        "/predator/body", radius=0.4, color=(220, 30, 30), subdivisions=2
    )

    bird_vertices, bird_faces = make_bird_mesh()
    fish_vertices, fish_faces = make_fish_mesh()
    underwater_gradient = make_underwater_gradient()

    directions = velocities / np.linalg.norm(velocities, axis=1, keepdims=True)
    flock = server.scene.add_batched_meshes_simple(
        "/flock",
        vertices=bird_vertices,
        faces=bird_faces,
        batched_positions=positions.astype(np.float32),
        batched_wxyzs=headings_to_wxyzs(directions),
        batched_colors=headings_to_colors(directions),
        side="double",
    )

    def apply_species(species: str) -> None:
        """Swap the instanced mesh and restyle the scene for the chosen species."""
        with server.atomic():
            if species == "Fish":
                flock.vertices = fish_vertices
                flock.faces = fish_faces
                predator_body.color = (90, 100, 110)  # Shark gray.
                server.scene.configure_fog(near=6.0, far=45.0, color=(10, 40, 70))
                server.scene.set_background_image(underwater_gradient)
                # Fish school tighter and slower than birds fly.
                alignment_slider.value = 1.4
                cohesion_slider.value = 1.4
                max_speed_slider.value = 4.0
            else:
                flock.vertices = bird_vertices
                flock.faces = bird_faces
                predator_body.color = (220, 30, 30)  # Hawk red.
                server.scene.configure_fog(near=0.0, far=1.0, enabled=False)
                server.scene.set_background_image(None)
                alignment_slider.value = 1.0
                cohesion_slider.value = 0.8
                max_speed_slider.value = 6.0

    prev_species = species_dropdown.value

    while True:
        start = time.perf_counter()

        species = species_dropdown.value
        if species != prev_species:
            apply_species(species)
            prev_species = species

        n = num_boids_slider.value
        if positions.shape[0] != n:
            positions, velocities = spawn(n)

        if not paused_checkbox.value:
            dt = 1.0 / 60.0
            max_speed = max_speed_slider.value

            # Pairwise offsets and distances, with self-distance masked out.
            offsets = positions[None, :, :] - positions[:, None, :]  # (N, N, 3)
            dists = np.linalg.norm(offsets, axis=-1)
            np.fill_diagonal(dists, np.inf)

            # Separation: steer away from close neighbors, weighted by 1/distance^2.
            close = dists < separation_radius
            push = np.where(
                close[:, :, None], -offsets / (dists[:, :, None] ** 2 + 1e-6), 0.0
            ).sum(axis=1)

            # Alignment and cohesion over the (larger) neighbor radius.
            near = dists < neighbor_radius
            num_near = np.maximum(near.sum(axis=1, keepdims=True), 1)
            mean_velocity = (near[:, :, None] * velocities[None, :, :]).sum(
                axis=1
            ) / num_near
            mean_position = (
                positions + (near[:, :, None] * offsets).sum(axis=1) / num_near
            )
            has_neighbors = near.any(axis=1, keepdims=True)
            align = np.where(has_neighbors, mean_velocity - velocities, 0.0)
            cohere = np.where(has_neighbors, mean_position - positions, 0.0)

            # Soft containment: pull back toward home once outside the boundary.
            from_home = positions - home
            dist_home = np.linalg.norm(from_home, axis=1, keepdims=True)
            contain = np.where(
                dist_home > home_radius, -from_home * (dist_home - home_radius), 0.0
            )

            # Flee the predator.
            from_predator = positions - np.asarray(predator.position)
            dist_predator = np.linalg.norm(from_predator, axis=1, keepdims=True)
            flee = np.where(
                dist_predator < predator_radius,
                from_predator / (dist_predator**2 + 1e-6) * 40.0,
                0.0,
            )

            acceleration = (
                separation_slider.value * 8.0 * push
                + alignment_slider.value * 2.0 * align
                + cohesion_slider.value * 2.0 * cohere
                + 2.0 * contain
                + flee
            )
            velocities = velocities + dt * acceleration

            # Fish keep to flatter, more horizontal schools.
            if species == "Fish":
                velocities[:, 2] *= 1.0 - 0.8 * dt

            # Clamp speeds to [min_speed, max_speed].
            speeds = np.linalg.norm(velocities, axis=1, keepdims=True)
            velocities *= np.clip(speeds, min_speed, max_speed) / (speeds + 1e-9)
            positions = positions + dt * velocities

            directions = velocities / np.linalg.norm(velocities, axis=1, keepdims=True)
            if species == "Fish":
                colors = headings_to_colors(directions, hue_start=0.42, hue_span=0.22)
            else:
                colors = headings_to_colors(directions)
            with server.atomic():
                flock.batched_positions = positions.astype(np.float32)
                flock.batched_wxyzs = headings_to_wxyzs(directions)
                flock.batched_colors = colors

        # Aim for 60 fps, minus however long the update took.
        time.sleep(max(1.0 / 60.0 - (time.perf_counter() - start), 0.0))


if __name__ == "__main__":
    main()
