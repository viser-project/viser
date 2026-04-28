"""Drag events on batched scene nodes

Batched meshes, batched GLBs, and batched axes render many instances of
the same geometry from a single scene node. Drag callbacks fire as usual,
and the event includes ``instance_index`` — which instance the user
clicked on — so you can route the gesture to the right cube.

Each of the N x N cubes carries its own linear and angular velocity.
Drag-gestures feed forces and torques into the *active* instance's
velocity, and a vectorized physics loop integrates + damps every
instance every tick. Releasing the mouse lets the instance coast and
spin on momentum, independent of its neighbors.

Gestures:

* **Drag (no modifier)** — teleport the clicked instance rigidly.
  Velocity is zeroed on pick-up.
* **Cmd/Ctrl + drag** — spring-pull the clicked grab point toward the
  cursor. Off-center grabs naturally produce torque too, so dragging
  an edge yanks AND spins the cube.
* **Cmd/Ctrl + Shift + drag** — pin the clicked point and apply torque
  along the drag arrow, so the instance rotates around the arrow axis.
"""

from __future__ import annotations

import threading
import time

import numpy as np

import viser
import viser.transforms as tf

# ----- Grid config -----
GRID_N = 5  # N x N cubes
GRID_SPACING = 1.5

# ----- Colors -----
IDLE_COLOR = (90, 200, 255)
TELEPORT_COLOR = (220, 120, 220)
TRANSLATE_COLOR = (255, 120, 60)
ROTATE_COLOR = (120, 220, 120)

# ----- Physics -----
MASS = 1.0
# Moment of inertia for a uniform unit cube.
INERTIA = 1.0 / 6.0
LINEAR_DAMPING = 4.0  # 1/s
ANGULAR_DAMPING = 4.0  # 1/s
# Spring stiffness: higher for rotate-mode (needs a rigid pin) than for
# translate-mode (wants some elastic give).
SPRING_K_TRANSLATE = 40.0
SPRING_K_ROTATE = 80.0
TORQUE_K = 1.5
DT = 1.0 / 60.0


def cube_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Unit-cube (vertices, faces), centered on the origin."""
    v = np.array(
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
    f = np.array(
        [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [2, 3, 7],
            [2, 7, 6],
            [1, 2, 6],
            [1, 6, 5],
            [0, 4, 7],
            [0, 7, 3],
        ],
        dtype=np.int32,
    )
    return v, f


def main() -> None:
    server = viser.ViserServer()
    server.scene.set_up_direction("+z")
    server.initial_camera.position = (0.0, -10.0, 8.0)
    server.initial_camera.look_at = (0.0, 0.0, 0.0)

    with server.gui.add_folder("Instructions"):
        server.gui.add_markdown(
            "**Drag** → teleport the clicked cube  \n"
            "**Cmd/Ctrl + drag** → spring-pull (linear velocity)  \n"
            "**Cmd/Ctrl + Shift + drag** → rotate around the drag arrow"
            " (angular velocity)  \n"
            "Release to let the cube coast / spin on its own."
        )

    with server.gui.add_folder("Active drag"):
        active_idx_gui = server.gui.add_text("instance_index", initial_value="-")
        active_mode_gui = server.gui.add_text("mode", initial_value="idle")

    server.scene.add_grid(
        "/grid",
        width=GRID_N * GRID_SPACING + 2,
        height=GRID_N * GRID_SPACING + 2,
        plane="xy",
    )

    # Initial layout: N x N grid centered at origin, z = 0.5 so cubes
    # sit on the floor.
    n_instances = GRID_N * GRID_N
    positions = np.zeros((n_instances, 3), dtype=np.float32)
    for i in range(GRID_N):
        for j in range(GRID_N):
            idx = i * GRID_N + j
            positions[idx] = [
                (i - (GRID_N - 1) / 2) * GRID_SPACING,
                (j - (GRID_N - 1) / 2) * GRID_SPACING,
                0.5,
            ]
    wxyzs = np.tile(np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32), (n_instances, 1))
    colors = np.tile(np.array(IDLE_COLOR, dtype=np.uint8), (n_instances, 1))

    vertices, faces = cube_mesh()
    handle = server.scene.add_batched_meshes_simple(
        "/cubes",
        vertices=vertices,
        faces=faces,
        batched_wxyzs=wxyzs,
        batched_positions=positions,
        batched_colors=colors,
        flat_shading=True,
    )

    # ----- Per-instance state -----------------------------------------------
    # One linear + angular velocity per instance. Only the currently
    # active instance accumulates forces, but every instance integrates
    # + damps every tick (so post-release cubes coast independently).
    lock = threading.Lock()
    position_arr = positions.astype(np.float64)
    wxyz_arr = wxyzs.astype(np.float64)
    linear_v = np.zeros((n_instances, 3))
    angular_v = np.zeros((n_instances, 3))

    # Active drag. ``mode`` is one of "teleport" | "translate" | "rotate";
    # other fields are parameters specific to the active mode.
    active_idx: int | None = None
    active_mode: str | None = None
    grab_body: np.ndarray | None = None  # body-frame grab, for translate/rotate
    spring_target: np.ndarray | None = None  # world target for the spring
    teleport_offset: np.ndarray | None = None  # cursor → instance position
    ext_torque = np.zeros(3)

    shutdown = threading.Event()

    def physics_loop() -> None:
        nonlocal position_arr, wxyz_arr, linear_v, angular_v
        last_t = time.monotonic()
        while not shutdown.is_set():
            now = time.monotonic()
            dt = min(now - last_t, 0.05)
            last_t = now

            with lock:
                # --- Active-instance driving forces -----------------------
                if active_idx is not None:
                    i = active_idx
                    if active_mode == "teleport":
                        # Kinematic: snap position, zero both velocities
                        # on this instance so it doesn't coast after
                        # release from teleport mode.
                        if spring_target is not None and teleport_offset is not None:
                            position_arr[i] = spring_target + teleport_offset
                            linear_v[i] = 0.0
                            angular_v[i] = 0.0
                    elif active_mode == "translate":
                        # Spring acts on the *grab point* (body-frame
                        # ``grab_body`` mapped to world via the body's
                        # current pose). Off-center grabs naturally
                        # produce a torque (lever × force) on top of
                        # the linear pull, so dragging an edge yanks
                        # AND spins the body. Force is zero at drag
                        # start (grab_world == spring_target == click)
                        # so a static cmd-click doesn't perturb the body.
                        assert grab_body is not None and spring_target is not None
                        R_i = tf.SO3(wxyz=wxyz_arr[i])
                        R_mat = R_i.as_matrix()
                        grab_world = position_arr[i] + R_mat @ grab_body
                        force = SPRING_K_TRANSLATE * (spring_target - grab_world)
                        linear_v[i] += force / MASS * dt
                        lever = grab_world - position_arr[i]
                        angular_v[i] += np.cross(lever, force) / INERTIA * dt
                    elif active_mode == "rotate":
                        # Spring pins the grabbed body point to its
                        # drag-start location; torque along drag_vec
                        # spins the body around that pin.
                        assert grab_body is not None and spring_target is not None
                        R_i = tf.SO3(wxyz=wxyz_arr[i])
                        R_mat = R_i.as_matrix()
                        grab_world = position_arr[i] + R_mat @ grab_body
                        force = SPRING_K_ROTATE * (spring_target - grab_world)
                        linear_v[i] += force / MASS * dt
                        lever = grab_world - position_arr[i]
                        angular_v[i] += np.cross(lever, force) / INERTIA * dt
                        angular_v[i] += ext_torque / INERTIA * dt

                # --- Damping + integration, vectorized over all instances ---
                linear_v *= np.exp(-LINEAR_DAMPING * dt)
                angular_v *= np.exp(-ANGULAR_DAMPING * dt)

                position_arr = position_arr + linear_v * dt
                R_old = tf.SO3(wxyz=wxyz_arr)
                R_delta = tf.SO3.exp(angular_v * dt)
                wxyz_arr = np.asarray((R_delta @ R_old).wxyz)

                pos_snapshot = position_arr.astype(np.float32)
                wxyz_snapshot = wxyz_arr.astype(np.float32)

            handle.batched_positions = pos_snapshot
            handle.batched_wxyzs = wxyz_snapshot
            time.sleep(DT)

    threading.Thread(target=physics_loop, daemon=True).start()

    def set_instance_color(idx: int, color: tuple[int, int, int]) -> None:
        """Recolor one instance. Batched colors live in a single array
        prop — reassign the full array to push the update."""
        new_colors = np.array(handle.batched_colors)
        new_colors[idx] = color
        handle.batched_colors = new_colors

    def compute_grab_body(idx: int, grab_world: np.ndarray) -> np.ndarray:
        """Body-frame offset of a world-space grab point for instance ``idx``."""
        R_mat = tf.SO3(wxyz=wxyz_arr[idx]).as_matrix()
        return R_mat.T @ (grab_world - position_arr[idx])

    # ==========================================================================
    # Drag (no modifier): teleport.
    # ==========================================================================

    @handle.on_drag_start("left", modifier="")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal active_idx, active_mode, spring_target, teleport_offset
        i = event.instance_index
        if i is None:
            return
        set_instance_color(i, TELEPORT_COLOR)
        active_idx_gui.value = str(i)
        active_mode_gui.value = "teleport"
        with lock:
            active_idx = i
            active_mode = "teleport"
            cursor = np.array(event.start_position)
            teleport_offset = position_arr[i] - cursor
            spring_target = cursor

    @handle.on_drag_update("left", modifier="")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal spring_target
        with lock:
            spring_target = np.array(event.end_position)

    @handle.on_drag_end("left", modifier="")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal active_idx, active_mode, spring_target, teleport_offset
        i = event.instance_index
        if i is not None:
            set_instance_color(i, IDLE_COLOR)
        active_idx_gui.value = "-"
        active_mode_gui.value = "idle"
        with lock:
            active_idx = None
            active_mode = None
            spring_target = None
            teleport_offset = None

    # ==========================================================================
    # Cmd/Ctrl + drag: spring-pull that instance (linear velocity).
    # ==========================================================================

    @handle.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal active_idx, active_mode, grab_body, spring_target
        i = event.instance_index
        if i is None:
            return
        set_instance_color(i, TRANSLATE_COLOR)
        active_idx_gui.value = str(i)
        active_mode_gui.value = "translate"
        with lock:
            active_idx = i
            active_mode = "translate"
            grab_world = np.array(event.start_position)
            grab_body = compute_grab_body(i, grab_world)
            spring_target = grab_world

    @handle.on_drag_update("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal spring_target
        with lock:
            spring_target = np.array(event.end_position)

    @handle.on_drag_end("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal active_idx, active_mode, grab_body, spring_target
        i = event.instance_index
        if i is not None:
            set_instance_color(i, IDLE_COLOR)
        active_idx_gui.value = "-"
        active_mode_gui.value = "idle"
        with lock:
            active_idx = None
            active_mode = None
            grab_body = None
            spring_target = None

    # ==========================================================================
    # Cmd/Ctrl + Shift + drag: rotate that instance around the drag arrow
    # (angular velocity).
    # ==========================================================================

    @handle.on_drag_start("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal active_idx, active_mode, grab_body, spring_target, ext_torque
        i = event.instance_index
        if i is None:
            return
        set_instance_color(i, ROTATE_COLOR)
        active_idx_gui.value = str(i)
        active_mode_gui.value = "rotate"
        with lock:
            active_idx = i
            active_mode = "rotate"
            grab_world = np.array(event.start_position)
            grab_body = compute_grab_body(i, grab_world)
            # Pin the grab point to where it was clicked — the instance
            # rotates around this point.
            spring_target = grab_world
            ext_torque = np.zeros(3)

    @handle.on_drag_update("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal ext_torque
        # Drag vector = rotation axis (direction) × spin magnitude (length).
        # Use the *frozen* spring_target (click point at drag-start) rather
        # than ``event.start_position``, which is live and tracks the
        # instance's current pose — keeps the gesture independent of
        # spring stiffness.
        with lock:
            assert spring_target is not None
            drag_vec = np.array(event.end_position) - spring_target
            ext_torque = TORQUE_K * drag_vec

    @handle.on_drag_end("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        nonlocal active_idx, active_mode, grab_body, spring_target, ext_torque
        i = event.instance_index
        if i is not None:
            set_instance_color(i, IDLE_COLOR)
        active_idx_gui.value = "-"
        active_mode_gui.value = "idle"
        with lock:
            active_idx = None
            active_mode = None
            grab_body = None
            spring_target = None
            ext_torque = np.zeros(3)

    try:
        while True:
            time.sleep(10.0)
    finally:
        shutdown.set()


if __name__ == "__main__":
    main()
