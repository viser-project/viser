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
import threading
import time
import warnings
from contextlib import contextmanager
from typing import Generator, cast
from unittest.mock import MagicMock

import numpy as np
import pytest

import viser
from viser import _messages
from viser.infra import ClientId

from .thread_isolation import run_isolated


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
            assert "/parent/gizmo" not in scene._handle_from_transform_controls_name
            await scene._handle_transform_controls_drag_end(
                cid, _messages.TransformControlsDragEndMessage(name="/parent/gizmo")
            )

        run_isolated(lambda: asyncio.run(drive()))

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

        run_isolated(lambda: asyncio.run(drive()))

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


def test_rgb_value_normalizes_floats() -> None:
    """RGB/RGBA channels follow the matplotlib / colors_to_uint8 convention:
    float channels are [0, 1] (scaled to [0, 255]); int channels are absolute
    [0, 255]. So 1.0 -> 255 (white) but 1 -> 1. The typed API is int [0, 255];
    floats are accepted and normalized at runtime (hence the type: ignore)."""
    with _server() as server:
        # Creation normalizes float channels.
        white = server.gui.add_rgb("a", (1.0, 1.0, 1.0))  # type: ignore[arg-type]
        assert white.value == (255, 255, 255)
        assert server.gui.add_rgb("b", (255, 0, 0)).value == (255, 0, 0)
        rgba = server.gui.add_rgba("c", (1.0, 1.0, 1.0, 1.0))  # type: ignore[arg-type]
        assert rgba.value == (255, 255, 255, 255)

        # Assignment normalizes float numpy arrays.
        rgb = server.gui.add_rgb("d", (0, 0, 0))
        rgb.value = np.array([1.0, 0.0, 0.0])
        assert rgb.value == (255, 0, 0)
        assert all(isinstance(x, int) for x in rgb.value)

        # Integer channels stay absolute (1 stays 1, not 255).
        rgb.value = (1, 2, 3)
        assert rgb.value == (1, 2, 3)

        # Out-of-range channels are clamped to [0, 255] rather than producing a
        # wild value (e.g. a float 255.0 must not become 65025) -- AND float
        # channels > 1.0 warn: pre-1.1.0 float [0, 255] inputs passed through
        # unchanged, so old code silently clamping to white needs a signpost.
        with pytest.warns(UserWarning, match=r"\[0, 1\]") as record:
            assert server.gui.add_rgb("e", (255.0, 1.2, -0.1)).value == (255, 255, 0)  # type: ignore[arg-type]
        # The warning must point at USER code (this file), not at viser
        # internals or the deprecated_positional_shim wrapper -- each call
        # path threads its own warn_stacklevel and a wrong depth silently
        # blames the wrong frame.
        assert record[0].filename == __file__
        with pytest.warns(UserWarning, match=r"\[0, 1\]") as record:
            rgb.value = np.array([2.0, -5.0, 0.5])
        assert record[0].filename == __file__
        assert rgb.value == (255, 0, 127)
        # In-range floats stay silent.
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            rgb.value = np.array([0.25, 1.0, 0.0])
        assert rgb.value == (63, 255, 0)


def test_numpy_assignment_to_int_tuple_rounds_not_truncates() -> None:
    """Assigning float numpy values to an int-typed tuple handle must round to
    the nearest integer, not truncate toward zero (int(2.9) == 2). Rounding
    uses the round() builtin, i.e. round-half-even."""
    with _server() as server:
        ms = server.gui.add_multi_slider(
            "m", min=0, max=20, step=1, initial_value=(0, 1)
        )
        ms.value = np.array([2.9, 9.999])
        assert ms.value == (3, 10)
        assert all(type(x) is int for x in ms.value)


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
            "/m1",
            verts,
            faces,
            wxyzs,
            positions,
            batched_colors=np.zeros((n, 3), np.uint8),
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


def test_upload_part_after_button_removal_still_acks_and_completes() -> None:
    """A FileTransferPart arriving after button.remove() mid-upload must not
    assert (the handle is legitimately gone from the registry): parts keep
    being buffered and acked, and completion pops the transfer state (no leak)
    while _finish_file_upload no-ops on the removed handle."""
    with _server() as server:
        btn = server.gui.add_upload_button("up")
        uuid = btn._impl.uuid

        server.gui._handle_file_transfer_start(
            ClientId(0),
            _messages.FileTransferStartUpload(
                source_component_uuid=uuid,
                transfer_uuid="t1",
                filename="a.bin",
                mime_type="application/octet-stream",
                part_count=2,
                size_bytes=8,
            ),
        )
        server.gui._handle_file_transfer_part(
            ClientId(0),
            _messages.FileTransferPart(
                source_component_uuid=uuid,
                transfer_uuid="t1",
                part_index=0,
                content=b"1234",
            ),
        )
        btn.remove()  # Mid-upload removal.
        # The next part must not raise; it is still acked and completes the
        # transfer.
        server.gui._handle_file_transfer_part(
            ClientId(0),
            _messages.FileTransferPart(
                source_component_uuid=uuid,
                transfer_uuid="t1",
                part_index=1,
                content=b"5678",
            ),
        )

        # Transfer state was popped by completion -> no permanent leak.
        assert "t1" not in server.gui._current_file_upload_states
        # The final ack (all bytes) was queued despite the removed handle.
        buf = server._websock_server._broadcast_buffer.message_from_id
        acks = [
            msg
            for msg in buf.values()
            if isinstance(msg, _messages.FileTransferPartAck)
            and msg.transfer_uuid == "t1"
        ]
        assert acks and acks[-1].transferred_bytes == 8


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


def test_gui_update_callback_writeback_wins_in_broadcast_buffer() -> None:
    """An ``on_update`` callback that writes back (e.g. clamps the value) must
    win in the broadcast buffer. The client-update echo (``sync_cb``) used to
    be queued AFTER the awaited callbacks, so the callback's own broadcast was
    clobbered by the stale pre-clamp echo: every other client and every late
    joiner kept the un-clamped value while the server held the clamped one."""
    with _server() as server:
        slider = server.gui.add_slider(
            "s", min=0.0, max=10.0, step=0.1, initial_value=1.0
        )

        @slider.on_update
        async def _(event: viser.GuiEvent) -> None:
            # Clamp: anything above 5 snaps back to 5.
            slider.value = min(slider.value, 5.0)

        # Simulate a connected client editing the slider to 7.0.
        cid = ClientId(0)
        server._connected_clients[0] = cast(viser.ClientHandle, object())
        try:
            run_isolated(
                lambda: asyncio.run(
                    server.gui._handle_gui_updates(
                        cid,
                        _messages.GuiUpdateMessage(
                            uuid=slider._impl.uuid, updates={"value": 7.0}
                        ),
                    )
                )
            )
        finally:
            server._connected_clients.pop(0, None)

        assert slider.value == 5.0  # The clamp applied on the server.
        # The buffer's surviving update for this element carries the CLAMPED
        # value: it is what a late joiner replays.
        buffered = [
            m
            for m in server._websock_server._broadcast_buffer.message_from_id.values()
            if isinstance(m, _messages.GuiUpdateMessage)
            and m.uuid == slider._impl.uuid
            and "value" in m.updates
        ]
        assert buffered, "expected a buffered value update for the slider"
        assert buffered[-1].updates["value"] == 5.0, (
            f"late joiners would replay {buffered[-1].updates['value']}, but the "
            "server value is 5.0"
        )


def test_disconnect_drag_drain_survives_throwing_callback() -> None:
    """A throwing async drag-end callback must not strand the client's OTHER
    in-flight drag entries (each pins a handle and blocks a future remove()
    from clearing its callbacks) or abort the disconnect teardown."""
    cid = ClientId(0)
    with _server() as server:
        scene = server.scene
        scene.add_frame("/parent")
        tc_a = scene.add_transform_controls("/parent/giz_a")
        tc_b = scene.add_transform_controls("/parent/giz_b")
        fired: list[str] = []

        @tc_a.on_update
        async def _(event: viser.TransformControlsEvent) -> None:
            if event.phase == "end":
                fired.append("a")
                raise RuntimeError("boom")

        @tc_b.on_update
        async def _(event: viser.TransformControlsEvent) -> None:
            if event.phase == "end":
                fired.append("b")

        scene._get_client_handle = lambda *_a: None  # type: ignore[assignment, return-value]

        async def drive() -> None:
            await scene._handle_transform_controls_drag_start(
                cid, _messages.TransformControlsDragStartMessage(name="/parent/giz_a")
            )
            await scene._handle_transform_controls_drag_start(
                cid, _messages.TransformControlsDragStartMessage(name="/parent/giz_b")
            )
            await scene._drop_active_drags_for_client(cid)

        run_isolated(lambda: asyncio.run(drive()))

        assert fired == ["a", "b"], fired  # b fired despite a's exception.
        assert scene._active_transform_drag_handles == {}  # no strands.


def test_skinned_mesh_typed_handle_registered_and_bone_guard() -> None:
    """The registry must hold the typed MeshSkinnedHandle (click/drag events
    resolve their target through it, and it carries ``.bones``), and bone
    writes on a removed mesh must raise instead of queuing SetBone ghosts
    for the dead name."""
    with _server() as server:
        v = 5
        mesh = server.scene.add_mesh_skinned(
            "/skinned",
            np.random.rand(v, 3).astype(np.float32),
            np.array([[0, 1, 2]], np.uint32),
            bone_wxyzs=np.tile([1.0, 0.0, 0.0, 0.0], (2, 1)),
            bone_positions=np.zeros((2, 3)),
            skin_weights=np.random.rand(v, 2).astype(np.float32),
        )
        registered = server.scene._handle_from_node_name["/skinned"]
        assert registered is mesh, (
            "registry must hold the typed skinned handle, not the plain "
            "MeshHandle -- event dispatch resolves targets through it"
        )
        # A BARE name (no leading slash) must behave identically: _make
        # normalizes internally, so without upfront normalization the typed
        # swap keyed on the raw name silently missed and bone messages went
        # out addressed to a name no client node has.
        bare = server.scene.add_mesh_skinned(
            "bare_skinned",
            np.random.rand(v, 3).astype(np.float32),
            np.array([[0, 1, 2]], np.uint32),
            bone_wxyzs=np.tile([1.0, 0.0, 0.0, 0.0], (2, 1)),
            bone_positions=np.zeros((2, 3)),
            skin_weights=np.random.rand(v, 2).astype(np.float32),
        )
        assert server.scene._handle_from_node_name["/bare_skinned"] is bare
        bare.bones[1].position = (0.0, 0.0, 3.0)
        bone_msgs = [
            m
            for m in server._websock_server._broadcast_buffer.message_from_id.values()
            if isinstance(m, _messages.SetBonePositionMessage)
        ]
        assert bone_msgs and all(m.name == "/bare_skinned" for m in bone_msgs), (
            f"bone messages must use the normalized node name: "
            f"{[m.name for m in bone_msgs]}"
        )
        bare.remove()
        mesh.bones[0].position = (0.0, 0.0, 1.0)  # Fine while live.
        mesh.remove()
        with pytest.raises(RuntimeError, match="removed"):
            mesh.bones[0].position = (0.0, 0.0, 2.0)
        with pytest.raises(RuntimeError, match="removed"):
            mesh.bones[1].wxyz = (1.0, 0.0, 0.0, 0.0)
        # No SetBone message for the dead name lingers in the buffer.
        stale = [
            m
            for m in server._websock_server._broadcast_buffer.message_from_id.values()
            if isinstance(
                m,
                (_messages.SetBonePositionMessage, _messages.SetBoneOrientationMessage),
            )
        ]
        assert stale == [], stale


def test_gui_input_validation_rejects_degenerate_inputs() -> None:
    """Wrong-arity vectors, out-of-range initial values, inverted bounds, and
    unsorted multi-slider values raise ValueError instead of silently
    desyncing from the client's fixed-arity inputs / clamped controls."""
    with _server() as server:
        g = server.gui
        with pytest.raises(ValueError):
            g.add_vector3("v", (1.0, 2.0))  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            g.add_vector2("v2", (1.0, 2.0, 3.0))  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            g.add_vector3("v3", (1, 2, 3), min=(0, 0, 0, 0))  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            g.add_vector2("v4", (1, 1), min=(2, 2), max=(0, 0))
        with pytest.raises(ValueError):
            g.add_number("n", 100, min=0, max=10)
        with pytest.raises(ValueError):
            g.add_number("n2", 5, min=10, max=0)
        with pytest.raises(ValueError):
            g.add_slider("s", min=0, max=10, step=1, initial_value=20)
        with pytest.raises(ValueError):
            g.add_slider("s2", min=10, max=0, step=1, initial_value=5)
        with pytest.raises(ValueError):
            g.add_multi_slider("m", min=0, max=10, step=1, initial_value=(8, 2, 5))
        # A degenerate min == max slider stays legal, with a nonzero step.
        inert = g.add_slider("s3", min=5, max=5, step=1, initial_value=5)
        assert inert.value == 5
        assert inert.step > 0
        # NaN initial value (add_number) -- was accepted (bare < is False for
        # NaN); now rejected like add_slider.
        with pytest.raises(ValueError):
            g.add_number("nan", float("nan"), min=0, max=10)
        # step <= 0 on all three.
        with pytest.raises(ValueError):
            g.add_number("z1", 5, step=0)
        with pytest.raises(ValueError):
            g.add_slider("z2", min=0, max=10, step=0, initial_value=5)
        with pytest.raises(ValueError):
            g.add_multi_slider("z3", min=0, max=10, step=-1, initial_value=(2, 5))
        # multi_slider min_range exceeding the range.
        with pytest.raises(ValueError):
            g.add_multi_slider(
                "mr", min=0, max=10, step=1, min_range=999, initial_value=(2, 5)
            )
        # Vector component VALUES checked against bounds (not just min<=max).
        with pytest.raises(ValueError):
            g.add_vector3("vv", (100, 100, 100), min=(0, 0, 0), max=(1, 1, 1))
        # Valid forms still work.
        g.add_vector3("okv", (1.0, 2.0, 3.0), min=(0, 0, 0), max=(5, 5, 5))
        g.add_number("okn", 5, min=0, max=10)
        g.add_multi_slider(
            "okm", min=0, max=10, step=1, min_range=2, initial_value=(2, 5, 8)
        )


def test_camera_setter_rolls_back_on_invalid() -> None:
    """A degenerate/non-finite camera assignment must raise WITHOUT leaving the
    handle half-updated (state mutated, orientation stale, client desynced):
    the setter validates and rolls back before queuing its message."""

    class _Conn:
        def queue_message(self, m: object) -> None:
            raise AssertionError("no message must be queued on a failed set")

    class _Client:
        _websock_connection = _Conn()

    from viser._viser import CameraHandle, _CameraHandleState

    ch = CameraHandle.__new__(CameraHandle)
    ch._state = _CameraHandleState(
        client=_Client(),  # type: ignore[arg-type]
        wxyz=np.array([1.0, 0.0, 0.0, 0.0]),
        position=np.array([0.0, 0.0, 0.0]),
        fov=1.0,
        image_height=1,
        image_width=1,
        near=0.01,
        far=1000.0,
        min_orbit_distance=0.01,
        max_orbit_distance=1e4,
        look_at=np.array([0.0, 0.0, 5.0]),
        up_direction=np.array([0.0, 1.0, 0.0]),
        update_timestamp=1.0,
        camera_cb=[],
    )
    before = ch._state.look_at.copy()
    with pytest.raises(ValueError):
        ch.look_at = np.array([np.nan, 0.0, 0.0])
    assert np.array_equal(ch._state.look_at, before)  # rolled back, nothing queued


def test_color_tuple_is_clamped() -> None:
    """Tuple/scalar colors are clamped to [0, 255] like array colors. Out-of-
    range channels used to pass through verbatim (bleeding into adjacent bytes
    on the client via rgbToInt shifts), and an extreme float overflowed
    msgpack's int range at buffer-flush time -- a crash far from the call."""
    from viser._scene_api import _encode_rgb

    assert _encode_rgb((300, 0, 0)) == (255, 0, 0)
    assert _encode_rgb((-5, 0, 0)) == (0, 0, 0)
    assert _encode_rgb((2.0, 0, 0)) == (255, 0, 0)  # float > 1.0
    assert _encode_rgb((1e30, 0, 0)) == (255, 0, 0)  # no OverflowError at flush
    assert _encode_rgb((0.5, 0.5, 0.5)) == (127, 127, 127)  # int() truncation
    assert _encode_rgb((255, 128, 0)) == (255, 128, 0)
    # Non-finite channels match the array path (colors_to_uint8) instead of
    # crashing at int(): NaN -> 0, +Inf -> 255, -Inf -> 0.
    assert _encode_rgb((float("nan"), 0, 0)) == (0, 0, 0)
    assert _encode_rgb((float("inf"), 0, 0)) == (255, 0, 0)
    assert _encode_rgb((float("-inf"), 0, 0)) == (0, 0, 0)
    # A mesh with an out-of-range color no longer crashes at flush.
    with _server() as server:
        import numpy as np

        server.scene.add_mesh_simple(
            "/m",
            np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32),
            np.array([[0, 1, 2]], np.uint32),
            color=(300, 0, 0),
        )
        server.flush()


def test_folder_and_tab_not_reentrant_into_self() -> None:
    """Nesting a folder/tab context inside ITSELF raises clearly instead of
    corrupting the container pointer (a single restore slot can't nest), which
    used to silently misplace every subsequently-added element into the
    folder. Sequential re-entry stays valid."""
    with _server() as server:
        g = server.gui
        f = g.add_folder("F")
        with pytest.raises(RuntimeError, match="already active"):
            with f:
                with f:
                    pass
        # Sequential re-entry works, and the container pointer is restored to
        # root afterwards (no leaked nesting).
        with f:
            g.add_button("in1")
        with f:
            g.add_button("in2")
        assert g.add_button("stray")._impl.parent_container_id == "root"

        t = g.add_tab_group().add_tab("T")
        with pytest.raises(RuntimeError, match="already active"):
            with t:
                with t:
                    pass


def test_numpy_bool_serializes() -> None:
    """np.bool_ (from mask.any(), arr > 0, etc.) must serialize: it is neither
    np.floating nor np.integer, so it passed through unconverted and crashed
    the broadcast producer at encode -- tearing down every client, and
    re-crashing on reconnect (the message is persistent)."""
    import msgspec.msgpack

    from viser import _messages

    for val in (np.bool_(True), np.array([1, 0]).any(), np.False_):
        d = _messages.SetSceneNodeVisibilityMessage("/x", val).as_serializable_dict([])
        msgspec.msgpack.encode(d)  # must not raise
        assert isinstance(d["visible"], bool)
    d = _messages.GuiUpdateMessage("u", {"value": np.bool_(True)}).as_serializable_dict(
        []
    )
    msgspec.msgpack.encode(d)
    # Same crash class: np.str_ / np.bytes_ (from a numpy string array -- names,
    # labels) also can't be msgpack-encoded and bricked the producer.
    for val in (np.array(["frame_a"])[0], np.array([b"x"])[0]):
        d = _messages.SetSceneNodeVisibilityMessage(val, True).as_serializable_dict([])
        msgspec.msgpack.encode(d)  # must not raise
        assert type(d["name"]) in (str, bytes)
    with _server() as server:
        # End-to-end: setting visibility from a numpy bool does not crash flush,
        # and a numpy-string node name round-trips.
        f = server.scene.add_frame("/f")
        f.visible = np.array([True, False]).any()
        server.scene.add_frame(str(np.array(["/np_name"])[0]))
        server.flush()


def test_camera_update_rejects_degenerate_basis() -> None:
    """A degenerate camera basis (zero look distance, or up parallel to the
    view direction) raises instead of storing a NaN quaternion that every
    later camera read and on_update callback would silently see."""
    from viser._viser import CameraHandle, _CameraHandleState

    ch = CameraHandle.__new__(CameraHandle)
    ch._state = _CameraHandleState(
        client=None,  # type: ignore[arg-type]
        wxyz=np.zeros(4),
        position=np.array([1.0, 0.0, 0.0]),
        fov=1.0,
        image_height=1,
        image_width=1,
        near=0.01,
        far=1000.0,
        min_orbit_distance=0.01,
        max_orbit_distance=1e4,
        look_at=np.array([1.0, 0.0, 0.0]),  # == position
        up_direction=np.array([0.0, 0.0, 1.0]),
        update_timestamp=1.0,
        camera_cb=[],
    )
    with pytest.raises(ValueError, match="look_at cannot equal position"):
        ch._update_wxyz()
    ch._state.look_at = np.array([2.0, 0.0, 0.0])
    ch._state.up_direction = np.array([1.0, 0.0, 0.0])  # parallel to view
    with pytest.raises(ValueError, match="up_direction must be nonzero"):
        ch._update_wxyz()
    ch._state.up_direction = np.array([0.0, 0.0, 1.0])
    ch._update_wxyz()
    assert np.all(np.isfinite(ch._state.wxyz))
    # Non-finite inputs must ALSO raise (a NaN/Inf norm is nonzero, so it
    # slipped past the degeneracy checks and stored a NaN quaternion).
    ch._state.position = np.array([np.nan, 0.0, 0.0])
    with pytest.raises(ValueError, match="must be finite"):
        ch._update_wxyz()
    ch._state.position = np.array([np.inf, 0.0, 0.0])
    with pytest.raises(ValueError, match="must be finite"):
        ch._update_wxyz()


def test_request_share_url_creates_single_tunnel_under_concurrency() -> None:
    """Concurrent request_share_url() calls must build exactly ONE tunnel. The
    share handlers run on pool threads (not serialized on the event loop), so
    two requests could both observe `_share_tunnel is None` and each construct
    a tunnel, orphaning (leaking) the first. The slot is now claimed under a
    lock; every caller returns the same URL."""
    from viser import _viser

    created: list[object] = []
    created_lock = threading.Lock()

    class FakeTunnel:
        def __init__(self, host: str, port: int) -> None:
            with created_lock:
                created.append(self)
            # Widen the check-then-act window so an unlocked slot claim
            # reliably double-creates here rather than only under a rare
            # interleaving.
            time.sleep(0.05)

        def on_connect(self, fn):
            # ViserTunnel invokes this once the control connection is up; call
            # it inline so the creator's connect_event is set and it returns.
            fn(1)
            return fn

        def on_disconnect(self, fn):
            return fn

        def get_url(self) -> str:
            return "https://fake.share/url"

        def get_status(self) -> str:
            # Non-creator waiters loop while "ready"/"connecting"; "connected"
            # is the established terminal state that lets them return.
            return "connected"

        def close(self) -> None:
            pass

    with _server() as server:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(_viser, "ViserTunnel", FakeTunnel)
            barrier = threading.Barrier(4)
            results: list[object] = []
            results_lock = threading.Lock()

            def worker() -> None:
                barrier.wait()
                url = server.request_share_url(verbose=False)
                with results_lock:
                    results.append(url)

            threads = [threading.Thread(target=worker) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10.0)
            assert all(not t.is_alive() for t in threads), "request_share_url hung"

    assert len(created) == 1, f"expected exactly one tunnel, got {len(created)}"
    assert results == ["https://fake.share/url"] * 4


def test_request_share_url_returns_none_on_failed_tunnel() -> None:
    """A tunnel that FAILS to connect must make request_share_url() return
    None (as documented), not block the creator forever: on_connect only
    fires on success, and status="failed" never set connect_event."""
    from viser import _viser

    class FailingTunnel:
        def __init__(self, host: str, port: int) -> None:
            pass

        def on_connect(self, fn):
            return fn  # Never invoked: connection failed.

        def on_disconnect(self, fn):
            return fn

        def get_url(self) -> None:
            return None

        def get_status(self) -> str:
            return "failed"

        def close(self) -> None:
            pass

    with _server() as server:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(_viser, "ViserTunnel", FailingTunnel)
            box: dict[str, object] = {}

            def worker() -> None:
                box["url"] = server.request_share_url(verbose=False)

            t = threading.Thread(target=worker, daemon=True)
            t.start()
            t.join(timeout=5.0)
            assert not t.is_alive(), "request_share_url hung on a failed tunnel"
            assert box["url"] is None


def test_get_render_times_out_on_silent_client() -> None:
    """get_render(timeout=...) must raise TimeoutError when a still-connected
    client never returns a frame (frozen/backgrounded tab, wedged capture),
    instead of blocking the caller -- and, from a sync callback, its pool
    worker -- forever. The disconnect path is covered in
    tests/e2e/test_get_render.py; this pins the timeout bound without a
    browser. Camera args are passed explicitly so the fabricated client's
    zero-timestamp camera getters are never read."""
    from viser._viser import ClientHandle

    with _server() as server:
        client = ClientHandle.__new__(ClientHandle)
        client.client_id = 918273
        client._websock_connection = MagicMock()
        client._viser_server = server
        server._connected_clients[client.client_id] = cast(viser.ClientHandle, client)

        start = time.time()
        with pytest.raises(TimeoutError, match="did not return a frame"):
            client.get_render(
                height=32,
                width=32,
                wxyz=(1.0, 0.0, 0.0, 0.0),
                position=(0.0, 0.0, 0.0),
                fov=1.0,
                timeout=0.3,
            )
        elapsed = time.time() - start
        assert 0.3 <= elapsed < 3.0, f"timeout not honored, took {elapsed}s"


def _make_real_conn(stall_after_unregister: float = 0.0):
    """A ClientHandle connection with a REAL handler registry (register/
    unregister actually mutate state -- a MagicMock's no-ops can't surface
    double-unregister bugs). Optionally stalls after each unregister to widen
    the got_render_cb unregister -> event.set() window deterministically."""
    from viser.infra._infra import WebsockMessageHandler

    class _Conn(WebsockMessageHandler):
        def __init__(self) -> None:
            super().__init__()
            self.sent: list[object] = []
            self._stalled = False

        def get_message_buffer(self):  # pragma: no cover - unused
            raise NotImplementedError()

        def queue_message(self, message) -> None:
            self.sent.append(message)

        def unregister_handler(self, message_cls, callback=None):
            super().unregister_handler(message_cls, callback)
            if stall_after_unregister and not self._stalled:
                self._stalled = True
                time.sleep(stall_after_unregister)

    return _Conn()


def test_get_render_timeout_exits_do_not_double_unregister() -> None:
    """The three get_render() exits (frame arrival, disconnect, timeout) race
    to unregister the response handler, and infra's unregister_handler raises
    ValueError on a second remove. Regression from the timeout feature: unlike
    disconnect (a dead client never delivers late), a timed-out client is
    still connected and CAN deliver -- so the exits must share a once-guard.

    Case A: a frame delivered after TimeoutError already unregistered (the
    dispatch loop can snapshot the handler list before removal) must be
    dropped silently, not raise ValueError inside the dispatch.
    Case B: a frame that beats the deadline into got_render_cb's
    unregister -> set() window must be RETURNED, not clobbered by the caller
    double-unregistering (ValueError) or raising TimeoutError."""
    from viser import _messages
    from viser._viser import ClientHandle

    def render_kwargs(timeout: float) -> dict:
        return dict(
            height=8,
            width=8,
            wxyz=(1.0, 0.0, 0.0, 0.0),
            position=(0.0, 0.0, 0.0),
            fov=1.0,
            timeout=timeout,
        )

    def wait_for_request(conn):
        deadline = time.time() + 5.0
        while time.time() < deadline:
            handlers = conn._incoming_handlers.get(
                _messages.GetRenderResponseMessage, []
            )
            reqs = [
                m for m in conn.sent if isinstance(m, _messages.GetRenderRequestMessage)
            ]
            if handlers and reqs:
                return handlers[0], reqs[0].render_uuid
            time.sleep(0.002)
        raise AssertionError("get_render never registered/queued its request")

    with _server() as server:

        def make_client(conn) -> ClientHandle:
            client = ClientHandle.__new__(ClientHandle)
            client.client_id = len(server._connected_clients) + 700_000
            client._websock_connection = conn
            client._viser_server = server
            server._connected_clients[client.client_id] = cast(
                viser.ClientHandle, client
            )
            return client

        # Case A: late frame after timeout.
        conn_a = _make_real_conn()
        client_a = make_client(conn_a)
        box_a: dict[str, BaseException] = {}

        def run_a() -> None:
            try:
                client_a.get_render(**render_kwargs(timeout=0.2))
            except BaseException as e:  # noqa: BLE001
                box_a["err"] = e

        t = threading.Thread(target=run_a)
        t.start()
        cb, uuid = wait_for_request(conn_a)
        t.join(timeout=5.0)
        assert not t.is_alive()
        assert isinstance(box_a.get("err"), TimeoutError)
        # Deliver the frame late, as the dispatch loop would from its
        # pre-removal snapshot. Pre-fix: ValueError (list.remove).
        cb(client_a.client_id, _messages.GetRenderResponseMessage(b"", uuid))

        # Case B: frame beats the deadline into the unregister/set window.
        conn_b = _make_real_conn(stall_after_unregister=0.5)
        client_b = make_client(conn_b)
        result_b: dict[str, object] = {}

        def run_b() -> None:
            try:
                result_b["out"] = client_b.get_render(**render_kwargs(timeout=0.2))
            except BaseException as e:  # noqa: BLE001
                result_b["err"] = e

        t = threading.Thread(target=run_b)
        t.start()
        cb, uuid = wait_for_request(conn_b)
        time.sleep(0.15)  # Just before the 0.2s deadline.
        import io as _io

        import imageio.v3 as iio

        buf = _io.BytesIO()
        iio.imwrite(buf, np.zeros((8, 8, 3), dtype=np.uint8), extension=".jpeg")
        threading.Thread(
            target=lambda: cb(
                client_b.client_id,
                _messages.GetRenderResponseMessage(buf.getvalue(), uuid),
            )
        ).start()
        t.join(timeout=5.0)
        assert not t.is_alive()
        assert "err" not in result_b, f"caller raised: {result_b.get('err')!r}"
        assert cast(np.ndarray, result_b["out"]).shape == (8, 8, 3)
