"""Strict copy-on-add: mutating an array after passing it to ``add_*`` must never
retroactively change what was queued/persisted for the wire, nor the handle's
server-side state. Updates have an analogous guarantee (see
test_handle_lifecycle_bugs); this covers the creation path.
"""

from __future__ import annotations

import numpy as np

import viser


def _queued_props(server: viser.ViserServer, name: str):
    """Return the props of the most recent queued add-message for ``name``."""
    buf = server._websock_server._broadcast_buffer.message_from_id
    found = None
    for _id, message in buf.items():
        if getattr(message, "name", None) == name and hasattr(message, "props"):
            found = message.props
    return found


def _assert_independent(server, name, handle, arrays: dict[str, np.ndarray]) -> None:
    wire = _queued_props(server, name)
    assert wire is not None, f"no queued message for {name}"
    # Snapshot the wire + handle arrays BEFORE mutating the caller's arrays. This
    # is a pure aliasing test, independent of any dtype cast the add path applied.
    snapshots = {
        attr: (getattr(wire, attr).copy(), getattr(handle._impl.props, attr).copy())
        for attr in arrays
    }
    for attr, caller_array in arrays.items():
        caller_array[:] = 123.0  # caller reuses its buffer (e.g. animation loop)
        wire_before, handle_before = snapshots[attr]
        assert np.array_equal(getattr(wire, attr), wire_before), (
            f"{name}.{attr}: queued wire message aliased the caller's array"
        )
        assert np.array_equal(getattr(handle._impl.props, attr), handle_before), (
            f"{name}.{attr}: handle props aliased the caller's array"
        )


def test_mesh_strict_copy_on_add() -> None:
    server = viser.ViserServer(port=0)
    try:
        vertices = np.random.rand(1000, 3).astype(np.float32)
        faces = np.random.randint(0, 1000, (2000, 3)).astype(np.uint32)
        handle = server.scene.add_mesh_simple("/mesh", vertices, faces)
        _assert_independent(
            server, "/mesh", handle, {"vertices": vertices, "faces": faces}
        )
    finally:
        server.stop()


def test_point_cloud_strict_copy_on_add() -> None:
    server = viser.ViserServer(port=0)
    try:
        # float32 precision is the case that aliased before strict copy-on-add:
        # np.asarray(points, float32) on a float32 input returns the input.
        points = np.random.rand(5000, 3).astype(np.float32)
        colors = (np.random.rand(5000, 3) * 255).astype(np.uint8)
        handle = server.scene.add_point_cloud(
            "/pc", points, colors, precision="float32"
        )
        _assert_independent(
            server, "/pc", handle, {"points": points, "colors": colors}
        )
    finally:
        server.stop()


def test_gaussian_splats_strict_copy_on_add() -> None:
    server = viser.ViserServer(port=0)
    try:
        n = 2000
        centers = np.random.rand(n, 3).astype(np.float32)
        covariances = np.tile(np.eye(3, dtype=np.float32) * 0.01, (n, 1, 1))
        rgbs = np.random.rand(n, 3).astype(np.float32)
        opacities = np.random.rand(n, 1).astype(np.float32)
        server.scene.add_gaussian_splats(
            "/gs", centers, covariances, rgbs, opacities
        )
        wire = _queued_props(server, "/gs")
        assert wire is not None
        buffer_before = wire.buffer.copy()
        centers[:] = 9.9
        rgbs[:] = 0.1
        assert np.array_equal(wire.buffer, buffer_before), (
            "gaussian splat buffer aliased the caller's centers/rgbs"
        )
    finally:
        server.stop()
