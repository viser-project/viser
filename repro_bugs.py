"""Interactive reproductions for the bugs found (and fixed) in this branch.

Run it, open the printed URL, and follow the on-screen instructions in each
folder. Every folder has a Markdown block describing the steps, the original
(buggy) behavior, and the expected (fixed) behavior.

    python repro_bugs.py

Note on "reproducing the errors":
- Against the CURRENT (fixed) client/server, every scenario below behaves
  correctly -- so this doubles as a fix-verification tool.
- To watch the ORIGINAL bugs happen, check out a commit from before the fixes
  (or `git stash` the changes), rebuild the client
  (`cd src/viser/client && npm run build`), and re-run this script.

The "Python server-side bugs" section runs each scenario in an isolated
throwaway ViserServer and reports the result as a notification, so a buggy
build raises a caught exception instead of an OK message.
"""

from __future__ import annotations

import asyncio
import itertools
import threading
import time

import numpy as np

import viser


def notify(event: viser.GuiEvent, title: str, body: str, *, error: bool) -> None:
    """Show a notification on the clicking client (and print to the console)."""
    print(f"[{'ERROR' if error else 'OK'}] {title}: {body}")
    client = event.client
    if client is not None:
        client.add_notification(
            title=title,
            body=body,
            color="red" if error else "green",
            auto_close_seconds=8.0,
        )


def main() -> None:
    server = viser.ViserServer()

    server.gui.add_markdown(
        "# Viser bug reproductions\n"
        "Each folder below reproduces one bug. Expand it and follow the "
        "**Steps**. On the current (fixed) build everything should behave as "
        "described under **Expected**; on a pre-fix build you'll see **Bug**.\n\n"
        "*Open your browser's dev console for extra logging from the "
        "server-side checks.*"
    )

    # ------------------------------------------------------------------
    # 1. RGBA input resets while typing  (components/Rgba.tsx)
    # ------------------------------------------------------------------
    with server.gui.add_folder("1. RGBA input resets while typing"):
        server.gui.add_markdown(
            "**Steps**\n"
            "1. Click the text part of the color input below.\n"
            "2. Select all, type a new hex color e.g. `#00ff00`, press Enter.\n\n"
            "**Bug:** each keystroke snapped the field back to the old color, so "
            "you could never type a new value.\n\n"
            "**Expected:** the field keeps what you type and the swatch turns "
            "green on Enter."
        )
        server.gui.add_rgba("Color", (255, 0, 0, 255))

    # ------------------------------------------------------------------
    # 2. Tab group loses its selection when a sibling tab is removed
    #    (components/TabGroup.tsx + _gui_handles.py)
    # ------------------------------------------------------------------
    with server.gui.add_folder("2. Tab group selection lost on tab removal"):
        server.gui.add_markdown(
            "**Steps**\n"
            "1. Click the **Beta** tab so its content shows.\n"
            "2. Click *Remove the 'Alpha' tab* below.\n\n"
            "**Bug:** Beta lost its highlight / its content vanished (selection "
            "pointed at a now-missing tab index).\n\n"
            "**Expected:** Beta stays selected and its content stays visible."
        )
        tabs = server.gui.add_tab_group()
        tab_a = tabs.add_tab("Alpha")
        with tab_a:
            server.gui.add_markdown("This is **Alpha** content.")
        with tabs.add_tab("Beta"):
            server.gui.add_markdown("This is **Beta** content.")

        remove_alpha = server.gui.add_button("Remove the 'Alpha' tab")

        @remove_alpha.on_click
        def _(event: viser.GuiEvent) -> None:
            try:
                tab_a.remove()
                notify(event, "Tab removed", "Removed 'Alpha'.", error=False)
            except Exception as e:  # noqa: BLE001
                notify(event, "remove() failed", f"{type(e).__name__}: {e}", error=True)

    # ------------------------------------------------------------------
    # 3. Scene-tree prop editor ignores server updates / discards edits
    #    (ControlPanel/SceneTreeTable.tsx)
    # ------------------------------------------------------------------
    with server.gui.add_folder("3. Scene-tree prop editor sync"):
        server.gui.add_markdown(
            "**Setup:** a frame `/demo_frame` is in the scene. Open the scene "
            "tree (left panel), hover the `/demo_frame` row, and click the "
            "pencil to open its props editor.\n\n"
            "**Steps A (server overwrites):**\n"
            "1. With the editor open, click *Set axes_length = 2.0*.\n"
            "2. The `axes_length` field should update to `2`.\n\n"
            "**Steps B (don't clobber edits):**\n"
            "1. Type a new (uncommitted) value into `axes_radius`, do NOT press "
            "Enter.\n"
            "2. Click *Set axes_length = 3.0*.\n"
            "3. `axes_length` updates to `3` but your `axes_radius` edit is kept.\n\n"
            "**Bug:** (A) the field stayed stale; later a remount-based fix "
            "discarded the in-progress `axes_radius` edit in (B).\n\n"
            "**Expected:** both work."
        )
        frame = server.scene.add_frame(
            "/demo_frame", axes_length=0.5, axes_radius=0.025
        )

        set_len_2 = server.gui.add_button("Set axes_length = 2.0")

        @set_len_2.on_click
        def _(event: viser.GuiEvent) -> None:
            frame.axes_length = 2.0
            notify(event, "Server update", "axes_length = 2.0", error=False)

        set_len_3 = server.gui.add_button("Set axes_length = 3.0")

        @set_len_3.on_click
        def _(event: viser.GuiEvent) -> None:
            frame.axes_length = 3.0
            notify(event, "Server update", "axes_length = 3.0", error=False)

    # ------------------------------------------------------------------
    # 4. Multi-slider ignores a mid-drag disable
    #    (components/MultiSliderComponent.tsx)
    # ------------------------------------------------------------------
    with server.gui.add_folder("4. Multi-slider ignores mid-drag disable"):
        server.gui.add_markdown(
            "Needs a mid-drag disable -- triggered on a timer so one hand is "
            "enough.\n\n"
            "**Steps** (single hand):\n"
            "1. Click *Disable slider in 3s*.\n"
            "2. Immediately grab the middle thumb and drag it back and forth, "
            "and keep dragging past 3 seconds.\n"
            "3. At ~3s the slider disables mid-drag.\n\n"
            "**Bug:** the value kept changing after it was disabled (and the "
            "drag listeners leaked if the slider was removed mid-drag).\n\n"
            "**Expected:** dragging stops the instant it disables (the value "
            "freezes). Click *Enable slider* to reset."
        )
        multi = server.gui.add_multi_slider(
            "Range", min=0, max=10, step=1, initial_value=(0, 3, 10)
        )

        disable_btn = server.gui.add_button("Disable slider in 3s")

        @disable_btn.on_click
        def _(event: viser.GuiEvent) -> None:
            threading.Timer(3.0, lambda: setattr(multi, "disabled", True)).start()
            notify(
                event,
                "Disabling in 3s",
                "Grab a thumb and keep dragging.",
                error=False,
            )

        enable_btn = server.gui.add_button("Enable slider")

        @enable_btn.on_click
        def _(event: viser.GuiEvent) -> None:
            multi.disabled = False
            notify(event, "Slider enabled", "", error=False)

    # ------------------------------------------------------------------
    # 5. A theme change cancels an in-flight scene-pointer gesture
    #    (App.tsx)
    # ------------------------------------------------------------------
    with server.gui.add_folder("5. Theme change cancels active gesture"):
        server.gui.add_markdown(
            "A rectangle-select handler is registered, so dragging on the 3D "
            "canvas draws a selection rectangle. The theme change is fired on a "
            "timer so one hand is enough.\n\n"
            "**Steps** (single hand):\n"
            "1. Click *Change theme in 3s*.\n"
            "2. Immediately press and HOLD on the empty canvas and drag out a "
            "selection rectangle; keep holding past 3 seconds.\n"
            "3. At ~3s the brand color changes mid-gesture.\n\n"
            "**Bug:** the in-flight selection was silently cancelled (overlay "
            "cleared, no rect-select event sent) on the theme change.\n\n"
            "**Expected:** the rectangle survives; releasing fires the "
            "selection (watch the console)."
        )

        @server.scene.on_rect_select()
        def _(event: viser.SceneRectSelectEvent) -> None:
            print("[rect-select] received:", event.screen_min, event.screen_max)

        # Alternate between two brand colors on each click.
        brand_cycle = itertools.cycle([(255, 100, 0), (40, 120, 255)])
        change_theme = server.gui.add_button("Change theme in 3s")

        @change_theme.on_click
        def _(event: viser.GuiEvent) -> None:
            color = next(brand_cycle)
            threading.Timer(
                3.0, lambda: server.gui.configure_theme(brand_color=color)
            ).start()
            notify(
                event,
                "Theme changing in 3s",
                "Start a rect-select drag on the canvas and hold.",
                error=False,
            )

    # ------------------------------------------------------------------
    # 6. Non-unit quaternion distorts a scene node  (_scene_handles.py)
    # ------------------------------------------------------------------
    with server.gui.add_folder("6. Non-unit quaternion distorts a node"):
        server.gui.add_markdown(
            "**Steps**\n"
            "1. Find the axes triad `/quat_demo` in the scene.\n"
            "2. Click *Set non-unit wxyz = (0, 3, 4, 0)*.\n\n"
            "**Bug:** the client applied the raw quaternion without normalizing, "
            "so a non-unit value scaled/sheared the triad (axes grew and skewed).\n\n"
            "**Expected:** the triad just rotates (undistorted), and reading "
            "`frame.wxyz` back returns a unit quaternion."
        )
        quat_frame = server.scene.add_frame(
            "/quat_demo", axes_length=0.5, position=(0.0, 0.0, 0.0)
        )

        set_quat = server.gui.add_button("Set non-unit wxyz = (0, 3, 4, 0)")

        @set_quat.on_click
        def _(event: viser.GuiEvent) -> None:
            quat_frame.wxyz = (0.0, 3.0, 4.0, 0.0)
            stored = tuple(np.round(quat_frame.wxyz, 3))
            notify(event, "wxyz set", f"stored (normalized) = {stored}", error=False)

    # ------------------------------------------------------------------
    # 7. Zero-byte file upload  (UploadButton.tsx + _gui_api.py)
    # ------------------------------------------------------------------
    with server.gui.add_folder("7. Zero-byte file upload"):
        server.gui.add_markdown(
            "**Steps**\n"
            "1. Make an empty file: `touch empty.bin`.\n"
            "2. Click the button below and pick `empty.bin`.\n\n"
            "**Bug:** an empty file sent zero chunks, so the upload notification "
            "spun forever and `on_upload` never fired.\n\n"
            "**Expected:** the notification resolves to 'uploaded successfully' "
            "and the callback reports a 0-byte file."
        )
        upload = server.gui.add_upload_button("Upload a (0-byte) file")

        @upload.on_upload
        def _(event: viser.GuiEvent) -> None:
            f = upload.value
            notify(
                event,
                "on_upload fired",
                f"name={f.name!r}, bytes={len(f.content)}",
                error=False,
            )

    # ------------------------------------------------------------------
    # 8. Dark-mode load flashes light  (App.tsx + GuiState.ts)
    # ------------------------------------------------------------------
    with server.gui.add_folder("8. Dark-mode load flashes light"):
        server.gui.add_markdown(
            "This one needs a reload with a query parameter.\n\n"
            "**Steps**\n"
            "1. Append `?darkMode` to the URL and reload the page.\n\n"
            "**Bug:** dark mode was applied in a post-mount effect, so the first "
            "paint was light and then flipped to dark -- a one-frame white flash.\n\n"
            "**Expected:** the page is dark from the very first frame (no flash)."
        )

    # ------------------------------------------------------------------
    # 9. Python server-side bugs -- each runs in an isolated throwaway server
    #    and reports the result.
    # ------------------------------------------------------------------
    with server.gui.add_folder("9. Python server-side bugs"):
        server.gui.add_markdown(
            "Each button runs one scenario in a *separate* temporary "
            "`ViserServer` and reports OK (fixed) or the raised error (buggy) as "
            "a notification + console line. These exercise server-side logic, so "
            "they don't depend on the browser build."
        )

        def run_check(event: viser.GuiEvent, title: str, fn) -> None:
            temp = viser.ViserServer(port=0, verbose=False)
            try:
                msg = fn(temp)
                notify(event, title, msg, error=False)
            except Exception as e:  # noqa: BLE001
                notify(event, title, f"{type(e).__name__}: {e}", error=True)
            finally:
                temp.stop()

        def run_async_check(event: viser.GuiEvent, title: str, coro_fn) -> None:
            run_check(event, title, lambda s: asyncio.run(coro_fn(s)))

        # 6a. Removing a populated tab group.
        def _tab_remove(s: viser.ViserServer) -> str:
            tg = s.gui.add_tab_group()
            tg.add_tab("A")
            tg.add_tab("B")
            tg.remove()
            s.gui.reset()  # also exercises the reset() path
            return "Removed a populated tab group and reset the GUI."

        b = server.gui.add_button("Remove populated tab group + reset()")
        b.on_click(lambda e: run_check(e, "Tab group remove", _tab_remove))

        # 6b. Dropdown with an out-of-options initial value.
        def _dropdown(s: viser.ViserServer) -> str:
            try:
                s.gui.add_dropdown("d", ("a", "b", "c"), initial_value="zzz")
            except ValueError as e:
                return f"Correctly rejected bad initial_value ({e})."
            return "BUG: accepted an initial_value not in options."

        b = server.gui.add_button("Dropdown: invalid initial_value")
        b.on_click(lambda e: run_check(e, "Dropdown validation", _dropdown))

        # 6c. Skinned mesh with fewer than four bones.
        def _skinned(s: viser.ViserServer) -> str:
            v, bones = 5, 2
            s.scene.add_mesh_skinned(
                "/m",
                np.random.rand(v, 3).astype(np.float32),
                np.array([[0, 1, 2]], np.uint32),
                bone_wxyzs=np.tile([1.0, 0.0, 0.0, 0.0], (bones, 1)),
                bone_positions=np.zeros((bones, 3)),
                skin_weights=np.random.rand(v, bones).astype(np.float32),
            )
            return f"Added a skinned mesh with {bones} bones (<4)."

        b = server.gui.add_button("Skinned mesh with <4 bones")
        b.on_click(lambda e: run_check(e, "Skinned mesh", _skinned))

        # 6c'. Skinned mesh with zero bones must be rejected.
        def _skinned_zero(s: viser.ViserServer) -> str:
            v = 5
            try:
                s.scene.add_mesh_skinned(
                    "/m",
                    np.random.rand(v, 3).astype(np.float32),
                    np.array([[0, 1, 2]], np.uint32),
                    bone_wxyzs=np.zeros((0, 4)),
                    bone_positions=np.zeros((0, 3)),
                    skin_weights=np.zeros((v, 0), np.float32),
                )
            except ValueError as e:
                return f"Correctly rejected zero-bone mesh ({e})."
            return "BUG: accepted a degenerate zero-bone skinned mesh."

        b = server.gui.add_button("Skinned mesh with 0 bones (must reject)")
        b.on_click(lambda e: run_check(e, "Zero-bone mesh", _skinned_zero))

        # 6d. Camera frustum image cleared with None.
        def _frustum(s: viser.ViserServer) -> str:
            f = s.scene.add_camera_frustum(
                "/f", fov=1.0, aspect=1.0, image=np.zeros((4, 4, 3), np.uint8)
            )
            f.image = None
            assert f.image is None, "image not cleared"
            f.format = "png"
            assert f._image_data is None, "image resurrected by format change"
            return "image=None cleared the image and it stayed cleared."

        b = server.gui.add_button("Camera frustum: clear image")
        b.on_click(lambda e: run_check(e, "Frustum image clear", _frustum))

        # 6e. Transform controls with an un-normalized name.
        def _tc(s: viser.ViserServer) -> str:
            tc = s.scene.add_transform_controls("gizmo")  # no leading slash
            keys = list(s.scene._handle_from_transform_controls_name)
            assert keys == ["/gizmo"], f"registry keyed by {keys}"
            tc.remove()
            return "Un-slashed name normalized to /gizmo and removed cleanly."

        b = server.gui.add_button("Transform controls: un-slashed name")
        b.on_click(lambda e: run_check(e, "Transform controls", _tc))

        # 6f. 3D GUI container leak on re-add / cascade.
        def _container(s: viser.ViserServer) -> str:
            g1 = s.scene.add_3d_gui_container("/gui")
            old = g1._container_id
            s.scene.add_3d_gui_container("/gui")  # re-add same name
            assert old not in s.gui._container_handle_from_uuid, "old container leaked"
            s.scene.add_frame("/p")
            g = s.scene.add_3d_gui_container("/p/c")
            with g:
                s.gui.add_button("inside")
            cid = g._container_id
            s.scene.remove_by_name("/p")  # cascade
            assert cid not in s.gui._container_handle_from_uuid, "cascade leaked"
            return "Re-add and cascade both freed the container + its children."

        b = server.gui.add_button("3D GUI container: re-add + cascade")
        b.on_click(lambda e: run_check(e, "3D GUI container", _container))

        # 6g. Gizmo drag-end still fires after the gizmo is removed mid-drag.
        async def _tc_drag_end(s: viser.ViserServer) -> str:
            from viser import _messages
            from viser.infra import ClientId

            cid = ClientId(0)
            scene = s.scene
            scene.add_frame("/parent")
            tc = scene.add_transform_controls("/parent/gizmo")
            phases: list[str] = []

            @tc.on_update
            async def _(event: viser.TransformControlsEvent) -> None:
                phases.append(event.phase)

            scene._get_client_handle = lambda *_a: None  # type: ignore[assignment, return-value]
            await scene._handle_transform_controls_drag_start(
                cid, _messages.TransformControlsDragStartMessage(name="/parent/gizmo")
            )
            scene.remove_by_name("/parent")  # remove ancestor mid-drag
            await scene._handle_transform_controls_drag_end(
                cid, _messages.TransformControlsDragEndMessage(name="/parent/gizmo")
            )
            assert phases == ["start", "end"], phases
            assert scene._active_transform_drag_handles == {}, "active map leaked"
            return "on_drag_end fired after mid-drag removal; active map cleared."

        b = server.gui.add_button("Gizmo: drag-end after mid-drag removal")
        b.on_click(lambda e: run_async_check(e, "Gizmo drag-end", _tc_drag_end))

        # 6h. A late gizmo update after removal leaves no stale pose messages.
        async def _tc_stale_pose(s: viser.ViserServer) -> str:
            from viser import _messages
            from viser.infra import ClientId

            cid = ClientId(0)
            scene = s.scene
            scene.add_frame("/parent")
            scene.add_transform_controls("/parent/gizmo")
            scene._get_client_handle = lambda *_a: None  # type: ignore[assignment, return-value]

            def stale() -> list[str]:
                buf = s._websock_server._broadcast_buffer.message_from_id
                return [
                    type(m).__name__
                    for m in buf.values()
                    if isinstance(
                        m,
                        (
                            _messages.SetOrientationMessage,
                            _messages.SetPositionMessage,
                        ),
                    )
                    and m.name == "/parent/gizmo"
                ]

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
            assert stale() == [], f"stale pose messages: {stale()}"
            return "Late update after removal left no stale pose broadcast."

        b = server.gui.add_button("Gizmo: late update leaves no stale pose")
        b.on_click(lambda e: run_async_check(e, "Gizmo stale pose", _tc_stale_pose))

        # 9i. Non-unit quaternion is normalized before it is stored/sent.
        def _quat_norm(s: viser.ViserServer) -> str:
            f = s.scene.add_frame("/f")
            f.wxyz = (0.0, 3.0, 4.0, 0.0)  # norm 5
            norm = float(np.linalg.norm(f.wxyz))
            assert abs(norm - 1.0) < 1e-6, f"not normalized: norm={norm}"
            return f"Non-unit quaternion normalized on assignment (norm={norm:.6f})."

        b = server.gui.add_button("Quaternion: normalized on assignment")
        b.on_click(lambda e: run_check(e, "Quaternion normalize", _quat_norm))

        # 9j. Splat sub-property update queues a private copy (no aliasing).
        def _splat_alias(s: viser.ViserServer) -> str:
            n = 5
            g = s.scene.add_gaussian_splats(
                "/s",
                centers=np.zeros((n, 3), np.float32),
                covariances=np.tile(np.eye(3) * 0.01, (n, 1, 1)).astype(np.float32),
                rgbs=np.zeros((n, 3), np.uint8),
                opacities=np.ones((n, 1), np.float32),
            )
            g.centers = np.ones((n, 3), np.float32)
            buf = s._websock_server._broadcast_buffer.message_from_id

            def latest() -> np.ndarray:
                return [
                    m.updates["buffer"]  # type: ignore[attr-defined]
                    for m in buf.values()
                    if type(m).__name__ == "SceneNodeUpdateMessage"
                    and "buffer" in getattr(m, "updates", {})
                ][-1]

            queued = latest()
            assert queued is not g._impl.props.buffer, "queued message aliases live buffer"
            before = queued.copy()
            g.centers = np.full((n, 3), 7.0, np.float32)  # mutate the stored buffer
            assert np.array_equal(queued, before), "earlier queued message corrupted"
            return "Splat sub-property update queued a private copy (no torn read)."

        b = server.gui.add_button("Gaussian splats: buffer not aliased")
        b.on_click(lambda e: run_check(e, "Splat buffer alias", _splat_alias))

        # 9k. Array-prop update is decoupled from the caller's array.
        def _array_alias(s: viser.ViserServer) -> str:
            pc = s.scene.add_point_cloud(
                "/pc",
                points=np.zeros((4, 3), np.float32),
                colors=np.zeros((4, 3), np.uint8),
            )
            arr = np.ones((4, 3), np.float32)
            pc.points = arr
            arr[:] = 7.0  # caller reuses its buffer (e.g. next animation frame)
            buf = s._websock_server._broadcast_buffer.message_from_id
            msg = next(
                m
                for m in buf.values()
                if type(m).__name__ == "SceneNodeUpdateMessage"
                and "points" in getattr(m, "updates", {})
            )
            assert np.all(msg.updates["points"] == 1.0), "caller mutation corrupted message"  # type: ignore[attr-defined]
            return "Point-cloud update is decoupled from the caller's array."

        b = server.gui.add_button("Array prop: caller array not aliased")
        b.on_click(lambda e: run_check(e, "Array prop alias", _array_alias))

        # 9l. numpy assignment to a GUI handle preserves element types.
        def _numpy_types(s: viser.ViserServer) -> str:
            rgb = s.gui.add_rgb("c", (255, 0, 0))
            rgb.value = np.array([10, 20, 30])
            assert all(isinstance(x, int) for x in rgb.value), "rgb channels not int"
            vec = s.gui.add_vector3("v", (1.0, 2.0, 3.0))
            vec.value = np.array([4.0, 5.0, 6.0])
            assert all(isinstance(x, float) for x in vec.value), "vector comps not float"
            return "Int color channels stay int; float vector components stay float."

        b = server.gui.add_button("Numpy assignment preserves element types")
        b.on_click(lambda e: run_check(e, "Numpy element types", _numpy_types))

        # 9m. GUI container target is per-server-instance (no cross-leak).
        def _container_per_instance(s: viser.ViserServer) -> str:
            other = viser.ViserServer(port=0, verbose=False)
            try:
                with s.gui.add_folder("F"):
                    # Must target `other`'s root, not raise on the foreign folder.
                    other.gui.add_text("t", "x")
                assert other.gui._get_container_uuid() == "root"
            finally:
                other.stop()
            return "A folder context on one server didn't leak into another instance."

        b = server.gui.add_button("GUI container target is per-instance")
        b.on_click(lambda e: run_check(e, "Container per-instance", _container_per_instance))

        # 9n. Batched-mesh colors validated against the instance count.
        def _batched_colors(s: viser.ViserServer) -> str:
            n = 5
            verts = np.zeros((3, 3), np.float32)
            faces = np.array([[0, 1, 2]], np.uint32)
            wxyzs = np.tile([1.0, 0.0, 0.0, 0.0], (n, 1))
            positions = np.zeros((n, 3))
            try:
                s.scene.add_batched_meshes_simple(
                    "/m", verts, faces, wxyzs, positions,
                    batched_colors=np.zeros((2, 3), np.uint8),  # wrong length
                )
            except AssertionError as e:
                return f"Correctly rejected mismatched batched_colors ({e})."
            return "BUG: accepted batched_colors with the wrong length."

        b = server.gui.add_button("Batched mesh: color length validated")
        b.on_click(lambda e: run_check(e, "Batched colors", _batched_colors))

        # 9o. Zero-byte upload finalizes server-side (no leak; value set).
        def _zero_upload(s: viser.ViserServer) -> str:
            from viser import _messages
            from viser.infra import ClientId

            btn = s.gui.add_upload_button("up")
            s.gui._handle_file_transfer_start(
                ClientId(0),
                _messages.FileTransferStartUpload(
                    source_component_uuid=btn._impl.uuid,
                    transfer_uuid="t0",
                    filename="empty.bin",
                    mime_type="application/octet-stream",
                    part_count=0,
                    size_bytes=0,
                ),
            )
            assert "t0" not in s.gui._current_file_upload_states, "upload state leaked"
            assert btn.value.name == "empty.bin" and btn.value.content == b"", "value not set"
            return "Zero-byte upload finalized (no leaked state; handle value set)."

        b = server.gui.add_button("Zero-byte upload completes")
        b.on_click(lambda e: run_check(e, "Zero-byte upload", _zero_upload))

    print("\nViser running. Open the URL above and follow the on-screen folders.")
    print("Press Ctrl+C to stop.\n")
    while True:
        time.sleep(10.0)


if __name__ == "__main__":
    main()
