"""Regression tests for Python server-side handle bugs.

Covers:
- GuiTabGroupHandle.remove() on a populated group (and gui.reset() with one).
- add_dropdown initial_value validation.
- add_mesh_skinned with fewer than 4 bones.
- CameraFrustumHandle.image = None actually clearing the image.
- add_transform_controls name normalization + registry cleanup on remove /
  reset / cascade.
- add_3d_gui_container re-add dedup + cascade cleanup of contained GUI elements.
"""

from __future__ import annotations

import asyncio
import warnings
from contextlib import contextmanager
from typing import Generator

import numpy as np
import pytest

import viser
from viser import _messages
from viser.infra import ClientId


@contextmanager
def _server() -> Generator[viser.ViserServer, None, None]:
    server = viser.ViserServer(port=0, verbose=False)
    try:
        yield server
    finally:
        server.stop()


def _setup_gizmo_recorder(server: viser.ViserServer):
    """Add ``/parent`` + ``/parent/gizmo``, record ``on_update`` phases, and stub
    the (headless) client-handle lookup. Returns ``(scene, phases)``."""
    scene = server.scene
    scene.add_frame("/parent")
    tc = scene.add_transform_controls("/parent/gizmo")
    phases: list[str] = []

    @tc.on_update
    async def _(event: viser.TransformControlsEvent) -> None:
        phases.append(event.phase)

    scene._get_client_handle = lambda *_a: None  # type: ignore[assignment, return-value]
    return scene, phases


def test_tab_group_remove_populated() -> None:
    """Removing a tab group that still has tabs must not raise."""
    with _server() as server:
        tg = server.gui.add_tab_group()
        tg.add_tab("A")
        tg.add_tab("B")
        tg.remove()  # Previously raised RuntimeError (removed-handle guard).
        assert tg._impl.removed


def test_gui_reset_with_populated_tab_group() -> None:
    """gui.reset() must terminate (not infinite-loop) with a populated group."""
    with _server() as server:
        tg = server.gui.add_tab_group()
        tg.add_tab("A")
        server.gui.reset()
        # The tab group should be gone from the root container.
        root = server.gui._container_handle_from_uuid["root"]
        assert tg._impl.uuid not in root._children


def test_dropdown_initial_value_must_be_in_options() -> None:
    with _server() as server:
        with pytest.raises(ValueError):
            server.gui.add_dropdown("d", ("a", "b", "c"), initial_value="zzz")
        # Valid initial value still works.
        d = server.gui.add_dropdown("d2", ("a", "b", "c"), initial_value="b")
        assert d.value == "b"


@pytest.mark.parametrize("num_bones", [1, 2, 3, 4, 6])
def test_add_mesh_skinned_any_bone_count(num_bones: int) -> None:
    """Skinned meshes with <4 bones must not crash, and the wire payload always
    carries exactly four influences per vertex."""
    with _server() as server:
        v = 5
        handle = server.scene.add_mesh_skinned(
            "/m",
            np.random.rand(v, 3).astype(np.float32),
            np.array([[0, 1, 2]], np.uint32),
            bone_wxyzs=np.tile([1.0, 0.0, 0.0, 0.0], (num_bones, 1)),
            bone_positions=np.zeros((num_bones, 3)),
            skin_weights=np.random.rand(v, num_bones).astype(np.float32),
        )
        assert handle._impl.props.skin_indices.shape == (v, 4)
        assert handle._impl.props.skin_weights.shape == (v, 4)


def test_add_mesh_skinned_zero_bones_rejected() -> None:
    """A skinned mesh with no bones is degenerate and must raise (not silently
    emit all-zero skin indices against an empty bone list)."""
    with _server() as server:
        v = 5
        with pytest.raises(ValueError):
            server.scene.add_mesh_skinned(
                "/m",
                np.random.rand(v, 3).astype(np.float32),
                np.array([[0, 1, 2]], np.uint32),
                bone_wxyzs=np.zeros((0, 4)),
                bone_positions=np.zeros((0, 3)),
                skin_weights=np.zeros((v, 0), np.float32),
            )


def test_camera_frustum_image_clear() -> None:
    with _server() as server:
        img = np.zeros((4, 4, 3), np.uint8)
        f = server.scene.add_camera_frustum("/f", fov=1.0, aspect=1.0, image=img)
        f.image = None
        assert f.image is None
        # A later format change must not resurrect the cleared image.
        f.format = "png"
        assert f._image_data is None


def test_transform_controls_unnormalized_name() -> None:
    with _server() as server:
        tc = server.scene.add_transform_controls("gizmo")  # no leading slash
        assert list(server.scene._handle_from_transform_controls_name) == ["/gizmo"]
        tc.remove()  # Previously raised KeyError.
        assert "/gizmo" not in server.scene._handle_from_transform_controls_name
        assert "/gizmo" not in server.scene._handle_from_node_name


def test_transform_controls_cleanup_on_reset_and_cascade() -> None:
    with _server() as server:
        server.scene.add_transform_controls("/giz")
        server.scene.reset()
        assert "/giz" not in server.scene._handle_from_transform_controls_name

        server.scene.add_frame("/a")
        server.scene.add_transform_controls("/a/giz")
        server.scene.remove_by_name("/a")  # cascade
        assert "/a/giz" not in server.scene._handle_from_transform_controls_name


def test_transform_controls_drag_end_after_mid_drag_removal() -> None:
    """Removing a gizmo's ancestor mid-drag must still deliver ``phase="end"``.

    Regression: the unified cascade cleanup pops the gizmo from
    ``_handle_from_transform_controls_name``; without active-drag tracking the
    later end message can't resolve the handle, so ``on_update(phase="end")`` /
    ``on_drag_end`` never fire.
    """
    cid = ClientId(0)
    with _server() as server:
        scene, phases = _setup_gizmo_recorder(server)

        async def drive() -> None:
            await scene._handle_transform_controls_drag_start(
                cid, _messages.TransformControlsDragStartMessage(name="/parent/gizmo")
            )
            # Remove the parent mid-drag: cascade-removes the gizmo from the live
            # registry, but the in-flight drag must still be resolvable.
            scene.remove_by_name("/parent")
            assert (
                "/parent/gizmo" not in scene._handle_from_transform_controls_name
            )
            await scene._handle_transform_controls_drag_end(
                cid, _messages.TransformControlsDragEndMessage(name="/parent/gizmo")
            )

        asyncio.run(drive())

        assert phases == ["start", "end"], phases
        # The active-drag entry is released on end (no leak).
        assert scene._active_transform_drag_handles == {}


def test_transform_controls_late_update_leaves_no_stale_pose() -> None:
    """A late ``update`` for a removed gizmo must still fire its callback but
    must NOT broadcast pose: sync_cb queues persistent Set{Orientation,Position}
    messages keyed by name, which would linger for the removed name and corrupt
    a re-added same-name node's pose.
    """
    cid = ClientId(0)
    with _server() as server:
        scene, phases = _setup_gizmo_recorder(server)

        def stale_pose_messages() -> list[str]:
            buf = server._websock_server._broadcast_buffer.message_from_id
            return [
                type(m).__name__
                for m in buf.values()
                if isinstance(
                    m,
                    (_messages.SetOrientationMessage, _messages.SetPositionMessage),
                )
                and m.name == "/parent/gizmo"
            ]

        async def drive() -> None:
            await scene._handle_transform_controls_drag_start(
                cid, _messages.TransformControlsDragStartMessage(name="/parent/gizmo")
            )
            scene.remove_by_name("/parent")
            await scene._handle_transform_controls_updates(
                cid,
                _messages.TransformControlsUpdateMessage(
                    name="/parent/gizmo",
                    wxyz=(1.0, 0.0, 0.0, 0.0),
                    position=(5.0, 5.0, 5.0),
                ),
            )
            await scene._handle_transform_controls_drag_end(
                cid, _messages.TransformControlsDragEndMessage(name="/parent/gizmo")
            )

        asyncio.run(drive())

        # The update + end callbacks still fire for the user.
        assert phases == ["start", "update", "end"], phases
        # ...but no stale pose-sync messages were left for the removed gizmo.
        assert stale_pose_messages() == []
        assert scene._active_transform_drag_handles == {}

        # Re-adding the gizmo at default pose must not inherit a stale pose.
        scene.add_frame("/parent")
        scene.add_transform_controls("/parent/gizmo")
        assert stale_pose_messages() == []


def test_3d_gui_container_readd_and_cascade_cleanup() -> None:
    with _server() as server:
        # Re-add dedup must free the old container's registry entry.
        g1 = server.scene.add_3d_gui_container("/gui")
        old_id = g1._container_id
        server.scene.add_3d_gui_container("/gui")
        assert old_id not in server.gui._container_handle_from_uuid

        # Cascade removal of an ancestor must free the container + its GUI kids.
        server.scene.add_frame("/p")
        g = server.scene.add_3d_gui_container("/p/c")
        with g:
            btn = server.gui.add_button("inside")
        cid = g._container_id
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            server.scene.remove_by_name("/p")
        assert cid not in server.gui._container_handle_from_uuid
        assert btn._impl.removed


def test_array_prop_update_does_not_alias_caller_array() -> None:
    """Updating an array prop must queue a server-owned copy, so a caller that
    mutates its array afterwards can't corrupt the still-unsent message."""
    with _server() as server:
        pc = server.scene.add_point_cloud(
            "/pc",
            points=np.zeros((4, 3), np.float32),
            colors=np.zeros((4, 3), np.uint8),
        )
        arr = np.ones((4, 3), np.float32)
        pc.points = arr
        arr[:] = 7.0  # caller reuses its buffer (e.g. next animation frame)

        buf = server._websock_server._broadcast_buffer.message_from_id
        msg = next(
            m
            for m in buf.values()
            if type(m).__name__ == "SceneNodeUpdateMessage"
            and "points" in getattr(m, "updates", {})
        )
        assert np.all(pc.points == 1.0)  # prop stays correct
        # queued message not corrupted by the caller's later mutation
        assert np.all(getattr(msg, "updates")["points"] == 1.0)


def test_numpy_value_assignment_preserves_element_types() -> None:
    """Assigning a numpy array to a GUI handle must keep int color channels int
    and vector components float (not blanket-float everything)."""
    with _server() as server:
        rgb = server.gui.add_rgb("c", (255, 0, 0))
        rgb.value = np.array([10, 20, 30])
        assert rgb.value == (10, 20, 30)
        assert all(isinstance(x, int) for x in rgb.value)

        rgba = server.gui.add_rgba("c2", (255, 0, 0, 255))
        rgba.value = np.array([1, 2, 3, 4])
        assert all(isinstance(x, int) for x in rgba.value)

        vec = server.gui.add_vector3("v", (1.0, 2.0, 3.0))
        vec.value = np.array([4.0, 5.0, 6.0])
        assert all(isinstance(x, float) for x in vec.value)


def test_scene_node_wxyz_is_normalized() -> None:
    """A non-unit quaternion assigned to a node must be normalized before it is
    stored and sent (the client applies it without normalizing)."""
    with _server() as server:
        f = server.scene.add_frame("/f")
        sent: list[object] = []
        orig = f._impl.api._websock_interface.queue_message
        f._impl.api._websock_interface.queue_message = lambda message: (
            sent.append(message),
            orig(message),
        )[1]

        f.wxyz = (0.0, 3.0, 4.0, 0.0)  # norm 5 -> unit (0, 0.6, 0.8, 0)
        assert np.isclose(np.linalg.norm(f.wxyz), 1.0), f.wxyz
        msg = [m for m in sent if type(m).__name__ == "SetOrientationMessage"][-1]
        assert np.isclose(np.linalg.norm(msg.wxyz), 1.0)  # type: ignore[attr-defined]

        # A unit quaternion is left intact.
        f.wxyz = (1.0, 0.0, 0.0, 0.0)
        assert tuple(f.wxyz) == (1.0, 0.0, 0.0, 0.0)


def test_gui_container_target_is_per_instance() -> None:
    """A folder context on one GuiApi must not leak its container target into a
    different GuiApi instance (the thread map must be per-instance)."""
    with _server() as server:
        with _server() as server2:
            # Inside server.gui's folder, adding to server2.gui must target
            # server2's root, not raise KeyError on the foreign folder uuid.
            with server.gui.add_folder("F"):
                server2.gui.add_text("t", "x")
            # The unrelated instance's container stack is untouched.
            assert server2.gui._get_container_uuid() == "root"
        # Same-instance folder nesting still parents correctly.
        with server.gui.add_folder("G"):
            assert server.gui._get_container_uuid() != "root"
        assert server.gui._get_container_uuid() == "root"


def test_add_batched_meshes_validates_color_length() -> None:
    """batched_colors must be validated against the instance count (like the
    other per-instance arrays), not sent verbatim for the client to drop."""
    with _server() as server:
        n = 5
        verts = np.zeros((3, 3), np.float32)
        faces = np.array([[0, 1, 2]], np.uint32)
        wxyzs = np.tile([1.0, 0.0, 0.0, 0.0], (n, 1))
        positions = np.zeros((n, 3))
        with pytest.raises(AssertionError):
            server.scene.add_batched_meshes_simple(
                "/m",
                verts,
                faces,
                wxyzs,
                positions,
                batched_colors=np.zeros((2, 3), np.uint8),  # wrong length
            )
        # Valid shapes still accepted.
        server.scene.add_batched_meshes_simple(
            "/m1", verts, faces, wxyzs, positions, batched_colors=np.zeros((n, 3), np.uint8)
        )
        server.scene.add_batched_meshes_simple(
            "/m2", verts, faces, wxyzs, positions, batched_colors=(255, 0, 0)
        )


def test_gaussian_splat_subprop_update_does_not_alias_buffer() -> None:
    """Splat sub-property setters (centers/rgbs/opacities/covariances) must queue
    a private copy of the buffer, not the live server-owned array -- otherwise a
    later in-place sub-property write corrupts a still-unsent earlier message."""
    with _server() as server:
        n = 5
        s = server.scene.add_gaussian_splats(
            "/s",
            centers=np.zeros((n, 3), np.float32),
            covariances=np.tile(np.eye(3) * 0.01, (n, 1, 1)).astype(np.float32),
            rgbs=np.zeros((n, 3), np.uint8),
            opacities=np.ones((n, 1), np.float32),
        )

        def latest_buffer_update() -> np.ndarray:
            buf = server._websock_server._broadcast_buffer.message_from_id
            return [
                getattr(m, "updates")["buffer"]
                for m in buf.values()
                if type(m).__name__ == "SceneNodeUpdateMessage"
                and "buffer" in getattr(m, "updates", {})
            ][-1]

        s.centers = np.ones((n, 3), np.float32)
        queued = latest_buffer_update()
        # The queued message must not alias the live server-owned buffer.
        assert queued is not s._impl.props.buffer
        before = queued.copy()
        # A later sub-property write mutates the stored buffer in place; the
        # already-queued message must stay untouched.
        s.centers = np.full((n, 3), 7.0, np.float32)
        assert np.array_equal(queued, before)


def test_zero_byte_upload_completes() -> None:
    """A zero-byte file is sent with part_count == 0 (no parts ever follow), so
    the upload must be finalized at start -- otherwise on_upload never fires and
    the transfer state leaks forever."""
    with _server() as server:
        btn = server.gui.add_upload_button("up")
        uuid = btn._impl.uuid

        server.gui._handle_file_transfer_start(
            ClientId(0),
            _messages.FileTransferStartUpload(
                source_component_uuid=uuid,
                transfer_uuid="t0",
                filename="empty.bin",
                mime_type="application/octet-stream",
                part_count=0,
                size_bytes=0,
            ),
        )

        # State must not leak.
        assert "t0" not in server.gui._current_file_upload_states
        # The handle value is updated to the (empty) uploaded file even with no
        # client connected (the value is set before client resolution).
        assert btn.value.name == "empty.bin"
        assert btn.value.content == b""
        # An ack is queued so the client notification can resolve.
        buf = server._websock_server._broadcast_buffer.message_from_id
        assert any(
            type(m).__name__ == "FileTransferPartAck"
            and getattr(m, "transfer_uuid", None) == "t0"
            for m in buf.values()
        )
