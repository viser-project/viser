"""Scene-node drag events with rigid-body physics

The box carries linear and angular velocity (both R^3), both damped. Drag
callbacks don't set pose directly — they apply forces and torques that
the physics loop integrates.

Three gestures:

* **Drag (no modifier)** — teleport. Bypasses the physics and rigidly
  snaps the box so the grab point tracks the cursor exactly. Linear and
  angular velocity are zeroed each tick, so the box doesn't keep moving
  after release.
* **Cmd/Ctrl + drag** — spring pulls the grabbed body-point toward the
  *cursor's* moving world-space target. Off-center grabs also produce
  torque (``tau = lever x force``), so yanking a corner makes the box
  tumble as it translates.
* **Cmd/Ctrl + Shift + drag** — spring pulls the grabbed body-point
  toward the *start* point and keeps it there (a stiff pin), while an
  external torque along the drag vector spins the box around the arrow.
  The net effect is rotation around the arrow axis: the click point
  stays fixed in world space, the arrow defines the rotation axis, and
  the drag length controls the spin rate.

When you release, the forces stop and the box coasts — damped linear
and angular velocity bleed off over ~1s.

SE(3) integration uses :mod:`viser.transforms`:
:meth:`viser.transforms.SO3.exp` takes a rotation vector (angular_velocity
* dt) and returns the incremental rotation, which is left-multiplied onto
the current orientation each tick.
"""

from __future__ import annotations

import threading
import time

import numpy as np

import viser
import viser.transforms as tf

# ----- Visual state ----------------------------------------------------------
IDLE_COLOR = (180, 180, 255)
TELEPORT_COLOR = (220, 120, 220)
TRANSLATE_COLOR = (255, 120, 60)
ROTATE_COLOR = (120, 220, 120)

# ----- Physics parameters ----------------------------------------------------
MASS = 1.0
# Moment of inertia for a uniform unit cube: m * a^2 / 6. Scalar because
# the box is cubic — symmetry gives equal principal moments.
INERTIA = 1.0 / 6.0

# Velocity damping (applied multiplicatively each tick). Equivalent to a
# drag force F = -damping * m * v.
LINEAR_DAMPING = 4.0  # 1/s
ANGULAR_DAMPING = 4.0  # 1/s

# Spring stiffness. The same spring is used for both modes — in translate
# it pulls the grab point toward the cursor; in rotate it pins the grab
# point to the click location so the body can orbit around it.
SPRING_K = 60.0

# Torque scale for the rotate gesture (world drag vector → torque along
# the same vector). With a ~1 world-unit drag, this puts the angular
# acceleration around ~6 rad/s² given the unit-cube inertia, so a
# sustained drag can reach ~1 rev/s before damping cuts in.
TORQUE_K = 1.5

# Physics step. Smaller is more stable; 60Hz is plenty for a demo.
DT = 1.0 / 60.0


def main() -> None:
    server = viser.ViserServer()
    server.scene.set_up_direction("+z")
    server.initial_camera.position = (0.0, -6.0, 3.5)
    server.initial_camera.look_at = (0.0, 0.0, 0.5)

    with server.gui.add_folder("Instructions"):
        server.gui.add_markdown(
            "**Drag** → teleport (rigid follow, no physics)  \n"
            "**Cmd/Ctrl + drag** → spring pull (off-center grabs torque too)  \n"
            "**Cmd/Ctrl + Shift + drag** → rotate around the drag arrow  \n"
            "Release: physics modes coast and damp; teleport stays put."
        )

    server.scene.add_grid("/grid", width=8.0, height=8.0, plane="xy")

    handle = server.scene.add_box(
        "/box",
        dimensions=(1.0, 1.0, 1.0),
        color=IDLE_COLOR,
        position=(0.0, 0.0, 0.5),
    )

    # ----- Physics state -----------------------------------------------------
    # Pose + velocities live here and are written to the handle each tick.
    # The lock protects against concurrent read/write between the physics
    # thread and the drag callbacks (which run in viser's thread pool).
    lock = threading.Lock()
    position = np.array([0.0, 0.0, 0.5], dtype=float)
    wxyz = np.array([1.0, 0.0, 0.0, 0.0], dtype=float)
    linear_v = np.zeros(3)
    angular_v = np.zeros(3)

    # Active-drag parameters. The spring mechanism drives both
    # Cmd-modified gestures — the difference is where `spring_target`
    # lives (moving with the cursor vs. locked to the click point) and
    # whether `ext_torque` is nonzero. The teleport path bypasses the
    # spring entirely and directly pins the pose.
    grab_body: np.ndarray | None = None  # body-frame grab point
    spring_target: np.ndarray | None = None  # world-space target for grab
    ext_torque = np.zeros(3)  # external torque (world frame)

    # Teleport mode: non-None means "skip physics, snap position by the
    # drag vector each tick." ``teleport_drag_offset`` is the vector from
    # the initial cursor to the initial box center, fixed at drag_start.
    teleport_cursor: np.ndarray | None = None
    teleport_drag_offset: np.ndarray | None = None

    shutdown = threading.Event()

    def physics_loop() -> None:
        nonlocal position, wxyz, linear_v, angular_v
        last_t = time.monotonic()
        while not shutdown.is_set():
            now = time.monotonic()
            dt = min(now - last_t, 0.05)  # cap to avoid blow-ups after pauses
            last_t = now

            with lock:
                if teleport_cursor is not None and teleport_drag_offset is not None:
                    # Kinematic teleport: snap position, freeze all
                    # velocities so the box doesn't drift after release.
                    # Orientation stays constant (no angular impulse is
                    # applied; angular velocity is zeroed).
                    position = teleport_cursor + teleport_drag_offset
                    linear_v = np.zeros(3)
                    angular_v = np.zeros(3)
                else:
                    R = tf.SO3(wxyz=wxyz)
                    R_mat = R.as_matrix()

                    # Accumulate accelerations.
                    linear_accel = np.zeros(3)
                    angular_accel = np.zeros(3)

                    # Spring force: pull the grabbed body point toward
                    # the world-space target. Generates both a linear
                    # force on the COM and a torque from the off-center
                    # lever arm.
                    if grab_body is not None and spring_target is not None:
                        grab_world = position + R_mat @ grab_body
                        force = SPRING_K * (spring_target - grab_world)
                        linear_accel += force / MASS
                        lever = grab_world - position
                        angular_accel += np.cross(lever, force) / INERTIA

                    # External torque (rotate gesture). Combined with the
                    # stationary pin above, this drives rotation around
                    # an axis through the pin point, along the torque
                    # direction.
                    angular_accel += ext_torque / INERTIA

                    # Integrate velocity, then damp.
                    linear_v = linear_v + linear_accel * dt
                    angular_v = angular_v + angular_accel * dt
                    linear_v *= np.exp(-LINEAR_DAMPING * dt)
                    angular_v *= np.exp(-ANGULAR_DAMPING * dt)

                    # Integrate pose. Angular velocity is in the world
                    # frame (torques come from world-frame lever x
                    # force), so the incremental rotation
                    # left-multiplies the current one.
                    position = position + linear_v * dt
                    R_new = tf.SO3.exp(angular_v * dt) @ R
                    wxyz = np.array(R_new.wxyz)

                pose_snapshot = (tuple(position), tuple(wxyz))

            handle.position = pose_snapshot[0]
            handle.wxyz = pose_snapshot[1]
            time.sleep(DT)

    threading.Thread(target=physics_loop, daemon=True).start()

    # Shared helper: compute body-frame offset of the click point.
    def compute_grab_body(grab_world: np.ndarray) -> np.ndarray:
        R_mat = tf.SO3(wxyz=wxyz).as_matrix()
        return R_mat.T @ (grab_world - position)

    # ==========================================================================
    # Drag (no modifier): teleport — rigid follow, no physics.
    # ==========================================================================

    @handle.on_drag_start("left", modifier="")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal teleport_cursor, teleport_drag_offset
        handle.color = TELEPORT_COLOR
        with lock:
            cursor = np.array(event.start_position)
            teleport_cursor = cursor
            # Fixed offset from cursor to box center. Re-adding this each
            # tick keeps the grab point under the cursor as it moves.
            teleport_drag_offset = position - cursor

    @handle.on_drag_update("left", modifier="")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal teleport_cursor
        with lock:
            teleport_cursor = np.array(event.end_position)

    @handle.on_drag_end("left", modifier="")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal teleport_cursor, teleport_drag_offset
        del event
        handle.color = IDLE_COLOR
        with lock:
            teleport_cursor = None
            teleport_drag_offset = None

    # ==========================================================================
    # Cmd/Ctrl + drag: spring pull on the grab point toward the cursor.
    # ==========================================================================

    @handle.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal grab_body, spring_target
        handle.color = TRANSLATE_COLOR
        with lock:
            grab_world = np.array(event.start_position)
            grab_body = compute_grab_body(grab_world)
            spring_target = grab_world

    @handle.on_drag_update("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal spring_target
        with lock:
            spring_target = np.array(event.end_position)

    @handle.on_drag_end("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal grab_body, spring_target
        del event
        handle.color = IDLE_COLOR
        with lock:
            grab_body = None
            spring_target = None

    # ==========================================================================
    # Cmd/Ctrl + Shift + drag: rotate *around* the drag arrow.
    #
    # The grab point is pinned in world space (spring_target locked to
    # start.position), and an external torque along the drag vector spins
    # the body around that pin. Geometrically, the rotation axis is the
    # line through ``start.position`` parallel to the drag arrow — i.e.
    # the arrow itself. Drag length scales spin speed.
    # ==========================================================================

    @handle.on_drag_start("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal grab_body, spring_target, ext_torque
        handle.color = ROTATE_COLOR
        with lock:
            grab_world = np.array(event.start_position)
            grab_body = compute_grab_body(grab_world)
            # Pin the grab point to where it was clicked. This stays put
            # for the duration of the drag — the body rotates around it.
            spring_target = grab_world
            ext_torque = np.zeros(3)

    @handle.on_drag_update("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal ext_torque
        # Drag vector (world space) used directly as the torque: its
        # direction is the rotation axis, its length the magnitude. The
        # visible drag arrow coincides with the instantaneous axis.
        # Use the *frozen* spring_target (the click point at drag-start)
        # rather than ``event.start_position``, which is live and tracks
        # the body's current pose — making the gesture independent of
        # spring stiffness.
        with lock:
            assert spring_target is not None
            drag_vec = np.array(event.end_position) - spring_target
            ext_torque = TORQUE_K * drag_vec

    @handle.on_drag_end("left", modifier="cmd/ctrl+shift")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        nonlocal grab_body, spring_target, ext_torque
        del event
        handle.color = IDLE_COLOR
        with lock:
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
