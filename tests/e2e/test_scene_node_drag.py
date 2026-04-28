"""E2E tests for scene-node drag callbacks."""

from __future__ import annotations

import math
import threading

import numpy as np
import pytest
from playwright.sync_api import Page

import viser

from .utils import wait_for_connection, wait_for_scene_node

JS_HAS_VISIBLE_DRAG_ARROW = """
() => {
    const scene = window.__viserMutable?.scene;
    if (!scene) return false;
    let hasArrow = false;
    scene.traverse((obj) => {
        if (obj.type === "ArrowHelper" && obj.visible) hasArrow = true;
    });
    return hasArrow;
}
"""

JS_HAS_NO_VISIBLE_DRAG_ARROW = """
() => {
    const scene = window.__viserMutable?.scene;
    if (!scene) return true;
    let hasArrow = false;
    scene.traverse((obj) => {
        if (obj.type === "ArrowHelper" && obj.visible) hasArrow = true;
    });
    return !hasArrow;
}
"""

JS_CAMERA_POSITION = """
() => {
    const camera = window.__viserMutable?.camera;
    return camera ? camera.position.toArray() : null;
}
"""


def _get_canvas_drag_points(
    page: Page,
) -> tuple[tuple[float, float], tuple[float, float]]:
    canvas = page.locator("canvas").first
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None, "Canvas bounding box not found"

    center_x = canvas_box["x"] + canvas_box["width"] / 2
    center_y = canvas_box["y"] + canvas_box["height"] / 2
    return (center_x, center_y), (center_x + 120.0, center_y + 40.0)


def _perform_modifier_drag(page: Page, modifier_key: str) -> None:
    start, end = _get_canvas_drag_points(page)
    page.keyboard.down(modifier_key)
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=12)
    page.mouse.up()
    page.keyboard.up(modifier_key)


def test_scene_node_drag_callbacks(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """Modifier-drag on a bound scene node should fire start, update, and end
    callbacks, and the event should carry button + modifier state."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_updated = threading.Event()
    drag_ended = threading.Event()
    drag_events: dict[str, viser.SceneNodeDragEvent[viser.BoxHandle]] = {}
    lock = threading.Lock()

    box = viser_server.scene.add_box(
        "/drag_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(255, 120, 0),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        with lock:
            drag_events["start"] = event
        drag_started.set()

    @box.on_drag_update("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        with lock:
            drag_events["update"] = event
        drag_updated.set()

    @box.on_drag_end("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        with lock:
            drag_events["end"] = event
        drag_ended.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/drag_box")

    initial_camera_position = page.evaluate(JS_CAMERA_POSITION)
    assert initial_camera_position is not None

    start, end = _get_canvas_drag_points(page)
    page.keyboard.down("Control")
    page.mouse.move(*start)
    page.mouse.down()
    assert drag_started.wait(timeout=5.0), "Drag start callback was not triggered"

    page.mouse.move(*end, steps=12)
    assert drag_updated.wait(timeout=5.0), "Drag update callback was not triggered"
    page.wait_for_function(JS_HAS_VISIBLE_DRAG_ARROW, timeout=5_000)

    page.mouse.up()
    page.keyboard.up("Control")
    assert drag_ended.wait(timeout=5.0), "Drag end callback was not triggered"
    page.wait_for_function(JS_HAS_NO_VISIBLE_DRAG_ARROW, timeout=5_000)

    final_camera_position = page.evaluate(JS_CAMERA_POSITION)
    assert final_camera_position == initial_camera_position

    start_event = drag_events["start"]
    update_event = drag_events["update"]
    end_event = drag_events["end"]

    # At drag-start, end == start collapses onto the same world point.
    # Compare with tolerance: the live start_position is recovered via
    # ``startLocalOffset.applyMatrix4(currentInstanceWorld)``, which can
    # introduce ULP-level error from the invert-then-multiply round-trip
    # for non-identity instance transforms.
    assert start_event.start_position == pytest.approx(
        start_event.end_position, abs=1e-4
    )
    assert start_event.target is box
    assert update_event.target is box
    assert end_event.target is box

    assert start_event.start_screen_pos != end_event.end_screen_pos
    # Box stays put on the server, so the live grab point in world coords
    # doesn't move between events (modulo float roundoff).
    assert update_event.start_position == pytest.approx(
        start_event.start_position, abs=1e-4
    )
    assert update_event.end_position != update_event.start_position
    assert end_event.start_position == pytest.approx(
        start_event.start_position, abs=1e-4
    )
    assert end_event.end_position != end_event.start_position

    # Input state: left button + primary modifier, nothing else.
    for event in (start_event, update_event, end_event):
        assert event.button == "left"
        # Primary modifier: one of ctrl/meta is held, not both, not shift/alt.
        assert event.ctrl != event.meta, (event.ctrl, event.meta)
        assert not event.shift
        assert not event.alt


def test_scene_node_drag_filter_rejects_wrong_modifier(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """A binding with modifier="cmd/ctrl" should NOT fire for shift-only drag."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()

    box = viser_server.scene.add_box(
        "/filter_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(0, 170, 255),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/filter_box")

    # Shift-drag: should not match the "cmd/ctrl" binding.
    # Positive control: a cmd/ctrl drag must register *after* this — if
    # the drag never fires for this scene at all (e.g. the canvas isn't
    # ready, registration silently failed, or the pointer missed the
    # box), this test would pass trivially. We verify the binding IS
    # actually wired up by issuing a matching drag at the end.
    _perform_modifier_drag(page, "Shift")
    page.wait_for_timeout(500)
    assert not drag_started.is_set(), (
        "shift-drag should not trigger a binding that requires cmd/ctrl"
    )

    # Positive control: a matching cmd/ctrl drag MUST fire — proves the
    # rejection above wasn't due to an unrelated failure (canvas not
    # ready, missed click, broken registration).
    _perform_modifier_drag(page, "Control")
    assert drag_started.wait(timeout=5.0), (
        "positive control failed: cmd/ctrl drag did not fire either, "
        "so the rejection assertion above is vacuously true and the "
        "filter behavior is not actually verified by this test"
    )


def test_scene_node_drag_modifier_order_insensitive(
    viser_server: viser.ViserServer,
) -> None:
    """Non-canonical modifier orderings should runtime-canonicalize to the
    same binding on the wire. The canonical form (``"cmd/ctrl+shift"``) is
    the only one the type-checker accepts; non-canonical forms like
    ``"shift+cmd/ctrl"`` are a type error but the runtime parser accepts
    them (see `_normalize_drag_modifiers`)."""
    box = viser_server.scene.add_box(
        "/order_box",
        dimensions=(1.0, 1.0, 1.0),
    )

    # Two distinct function objects so the registry doesn't dedupe.
    # type: ignore below because "shift+cmd/ctrl" is not in DragModifier's
    # Literal union — intentionally exercising runtime leniency.
    @box.on_drag_start("left", modifier="shift+cmd/ctrl")  # type: ignore[arg-type]
    def _cb_noncanonical(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event

    @box.on_drag_start("left", modifier="cmd/ctrl+shift")
    def _cb_canonical(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event

    del _cb_noncanonical, _cb_canonical  # silence "unused" warnings

    # Both registrations should normalize to the same canonical tuple.
    entry_a = box._impl.drag_cb["start"][0]
    entry_b = box._impl.drag_cb["start"][1]
    assert entry_a.modifiers == entry_b.modifiers, (
        entry_a.modifiers,
        entry_b.modifiers,
    )
    assert entry_a.modifiers == ("cmd/ctrl", "shift")  # canonical wire tuple


def test_scene_node_drag_pointer_id_isolation(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """A stray pointerup from a different pointerId (e.g. a second finger
    on a multi-touch surface) should NOT end the active drag."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_ended = threading.Event()

    box = viser_server.scene.add_box(
        "/multitouch_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(0, 200, 0),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    @box.on_drag_end("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_ended.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/multitouch_box")

    # Start a real drag with the mouse (pointerId comes from Playwright).
    start, end = _get_canvas_drag_points(page)
    page.keyboard.down("Control")
    page.mouse.move(*start)
    page.mouse.down()
    assert drag_started.wait(timeout=5.0), "drag start didn't fire"
    page.mouse.move(*end, steps=4)

    # Synthesize a stray pointerup carrying a *different* pointerId.
    # If our DragLayer doesn't filter by pointerId, this would tear the
    # drag down here.
    page.evaluate(
        """
        () => {
            const evt = new PointerEvent("pointerup", {
                pointerId: 9999,  // wildly different from Playwright's mouse
                clientX: 0,
                clientY: 0,
                bubbles: true,
                cancelable: true,
            });
            window.dispatchEvent(evt);
        }
        """
    )
    # Negative-assertion settle window: long enough that a real
    # spurious teardown would round-trip (client → server → callback)
    # under CI load. Round-trip is ~throttle (50ms) + msgpack + WS +
    # asyncio dispatch ≈ 100-300ms typical, can exceed 500ms loaded.
    page.wait_for_timeout(800)
    assert not drag_ended.is_set(), (
        "drag_end fired from a stray pointerId — DragLayer didn't filter "
        "by pointer identity"
    )

    # Release the real pointer → drag should end normally.
    page.mouse.up()
    page.keyboard.up("Control")
    assert drag_ended.wait(timeout=5.0), "drag_end didn't fire on real release"


def test_scene_node_drag_continues_outside_canvas(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """Pulling the cursor past the canvas edge mid-drag must NOT stall the
    drag — drag_update should keep firing, and drag_end should fire when
    the pointer is released outside the canvas."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_ended = threading.Event()
    update_positions: list[tuple[float, float, float]] = []
    lock = threading.Lock()

    box = viser_server.scene.add_box(
        "/edge_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(255, 200, 0),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    @box.on_drag_update("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        with lock:
            update_positions.append(event.end_position)

    @box.on_drag_end("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_ended.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/edge_box")

    canvas = page.locator("canvas").first
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None

    center_x = canvas_box["x"] + canvas_box["width"] / 2
    center_y = canvas_box["y"] + canvas_box["height"] / 2

    # Start the drag at the center of the canvas, then move the cursor
    # well outside the canvas's right edge.
    outside_x = canvas_box["x"] + canvas_box["width"] + 200.0
    outside_y = canvas_box["y"] + canvas_box["height"] / 2

    page.keyboard.down("Control")
    page.mouse.move(center_x, center_y)
    page.mouse.down()
    assert drag_started.wait(timeout=5.0), "drag_start didn't fire"

    # Step out of the canvas — every step should produce a drag_update.
    page.mouse.move(outside_x, outside_y, steps=20)
    page.wait_for_timeout(200)

    with lock:
        positions = list(update_positions)
    assert positions, (
        "no drag_update fired after pointer left the canvas — "
        "out-of-canvas check probably stalled the gesture"
    )
    # The drag should have moved (positions strictly differ from start).
    assert any(p != positions[0] for p in positions[1:]), (
        "drag_update positions never changed; the drag stalled mid-gesture"
    )

    # Release outside the canvas.
    page.mouse.up()
    page.keyboard.up("Control")
    assert drag_ended.wait(timeout=5.0), (
        "drag_end didn't fire when releasing outside the canvas"
    )


def test_scene_node_drag_batched_axes(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """Drag callbacks must fire on a batched-axes scene node, with
    ``instance_index`` populated to identify which logical axis was hit.
    BatchedAxes uses a stock ``THREE.InstancedMesh`` that emits 3 mesh
    instances per logical axis (one per X/Y/Z cylinder); ``instance_index``
    on the wire is the *logical* axis index, not the raw mesh-instance ID."""
    viser_server.initial_camera.position = (0.0, 0.0, 6.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_ended = threading.Event()
    captured: dict[str, object] = {}
    lock = threading.Lock()

    # Single axis at the origin, generously sized so a click at the canvas
    # center reliably hits it from the head-on camera.
    handle = viser_server.scene.add_batched_axes(
        "/batched_axes",
        batched_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32),
        batched_positions=np.array([[0.0, 0.0, 0.0]], dtype=np.float32),
        axes_length=2.0,
        axes_radius=0.2,
    )

    @handle.on_drag_start("left", modifier="cmd/ctrl")
    def _(
        event: viser.SceneNodeDragEvent[viser.BatchedAxesHandle],
    ) -> None:
        with lock:
            captured["start_index"] = event.instance_index
        drag_started.set()

    @handle.on_drag_end("left", modifier="cmd/ctrl")
    def _(
        event: viser.SceneNodeDragEvent[viser.BatchedAxesHandle],
    ) -> None:
        with lock:
            captured["end_index"] = event.instance_index
        drag_ended.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/batched_axes")

    _perform_modifier_drag(page, "Control")

    assert drag_started.wait(timeout=5.0), "drag_start didn't fire on batched axes"
    assert drag_ended.wait(timeout=5.0), "drag_end didn't fire on batched axes"

    with lock:
        start_index = captured["start_index"]
        end_index = captured["end_index"]
    # We have only one logical axis, so the index must be 0 — not 1 or 2
    # (which would indicate the raw 3-per-axis mesh-instance ID had leaked
    # through instead of the logical batch index).
    assert start_index == 0, f"expected logical instance_index=0, got {start_index}"
    assert end_index == 0, f"expected logical instance_index=0, got {end_index}"


def test_scene_node_drag_start_position_tracks_moving_object(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """``start_position`` is *live* — when the object moves between
    drag events, ``start_position`` should track the click point on
    the object as it moves in world coords. We move the box from the
    drag_update callback (a typical translate-gesture pattern) and
    verify ``start_position`` shifts in the wire payload."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    update_events: list[viser.SceneNodeDragEvent[viser.BoxHandle]] = []
    lock = threading.Lock()

    box = viser_server.scene.add_box(
        "/tracking_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(80, 200, 255),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    @box.on_drag_update("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        with lock:
            update_events.append(event)
        # Translate the box by the incremental drag vector — this is
        # the typical "follow the cursor" gesture, and it makes the
        # object move between events.
        delta = tuple(e - s for e, s in zip(event.end_position, event.start_position))
        box.position = tuple(p + d for p, d in zip(box.position, delta))

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/tracking_box")

    canvas = page.locator("canvas").first
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    page.keyboard.down("Control")
    page.mouse.move(cx, cy)
    page.mouse.down()
    assert drag_started.wait(timeout=5.0)
    page.mouse.move(cx + 200, cy + 80, steps=24)
    page.wait_for_timeout(300)
    page.mouse.up()
    page.keyboard.up("Control")

    with lock:
        events = list(update_events)
    assert len(events) >= 3, f"expected multiple updates, got {len(events)}"
    # As we move the box from each update, its world position shifts;
    # ``start_position`` (the live grab point on the object) should
    # therefore also shift across events. The total shift should be
    # comparable in magnitude to the cursor movement on the drag plane
    # — well above any FP roundoff threshold.
    first_start = events[0].start_position
    last_start = events[-1].start_position
    shift = math.sqrt(sum((a - b) ** 2 for a, b in zip(last_start, first_start)))
    assert shift > 0.5, (
        f"start_position barely moved despite the box being translated "
        f"from drag_update: shift={shift:.4f}, first={first_start}, "
        f"last={last_start}"
    )


def test_scene_node_drag_batched_mesh_repeat_after_translate(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """After programmatically moving a batched-mesh instance to a new
    location, clicking on it at its new screen position must register
    a drag.

    Reproduces a bug where the vendor ``InstancedMesh2`` raycast
    early-exits at a cached union bounding sphere that's computed once
    and never invalidated when ``batched_positions`` updates. Symptoms
    (per user report): "after I move a mesh, I often can't click and
    drag on it a second time. But if I move the camera so its
    reprojected position is close to its original position, then I'm
    able to drag it again." — exactly consistent with a stale spatial
    cache: rays toward the new position miss because the cached sphere
    still encloses only the old positions; rays whose camera reprojects
    near the original position pass the sphere check and the per-
    instance check (which uses the live matrix) hits.

    The BVH path auto-updates via ``bvh.move(id)`` per ``updateMatrix``,
    but the BVH is only built for clickable meshes — a drag-only node
    falls through to the bounding-sphere path."""
    viser_server.initial_camera.position = (0.0, 0.0, 8.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    # A small box mesh; small radius makes the union sphere tight,
    # so even a modest translation moves the instance well outside the
    # cached sphere.
    h = 0.4
    vertices = np.array(
        [
            [-h, -h, -h],
            [h, -h, -h],
            [h, h, -h],
            [-h, h, -h],
            [-h, -h, h],
            [h, -h, h],
            [h, h, h],
            [-h, h, h],
        ],
        dtype=np.float32,
    )
    faces = np.array(
        [
            [0, 1, 2],
            [0, 2, 3],
            [4, 6, 5],
            [4, 7, 6],
            [0, 4, 5],
            [0, 5, 1],
            [2, 6, 7],
            [2, 7, 3],
            [0, 3, 7],
            [0, 7, 4],
            [1, 5, 6],
            [1, 6, 2],
        ],
        dtype=np.uint32,
    )

    handle = viser_server.scene.add_batched_meshes_simple(
        "/repeat_drag_box",
        vertices=vertices,
        faces=faces,
        batched_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32),
        batched_positions=np.array([[0.0, 0.0, 0.0]], dtype=np.float32),
        batched_colors=np.array([[120, 200, 80]], dtype=np.uint8),
        lod="off",
    )

    drag_starts: list[viser.SceneNodeDragEvent[viser.BatchedMeshHandle]] = []
    lock = threading.Lock()

    @handle.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BatchedMeshHandle]) -> None:
        with lock:
            drag_starts.append(event)

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/repeat_drag_box")

    # Helper: project a viser-world point through the THREE camera and
    # return canvas-relative (x, y) pixels. Done in the page so we use
    # the same coordinate-frame conversion the renderer uses (the
    # ``""`` root node carries the viser→three rotation, so we read
    # ``targetObj.matrixWorld`` to apply it).
    def project_viser_to_canvas_xy(
        viser_xyz: tuple[float, float, float],
    ) -> tuple[float, float]:
        result = page.evaluate(
            """([vx, vy, vz]) => {
                const m = window.__viserMutable;
                if (!m || !m.camera || !m.canvas || !m.nodeRefFromName) return null;
                // The viser root (node name "") carries the viser-Z-up
                // -> three-Y-up rotation. Look it up by name rather than
                // traversing — many three.js objects have name="" and
                // traversal would match the wrong one.
                const root = m.nodeRefFromName[""];
                if (!root) return null;
                root.updateWorldMatrix(true, false);
                // THREE isn't exposed as a global; reach into the camera
                // for a Vector3 constructor.
                const Vec3 = m.camera.position.constructor;
                const v = new Vec3(vx, vy, vz);
                v.applyMatrix4(root.matrixWorld);
                v.project(m.camera);
                const w = m.canvas.clientWidth;
                const h = m.canvas.clientHeight;
                return [(v.x + 1) * 0.5 * w, (1 - v.y) * 0.5 * h];
            }""",
            list(viser_xyz),
        )
        assert result is not None, (
            "page.evaluate failed to project viser coords; the test environment "
            "may be missing window.__viserMutable or THREE."
        )
        return float(result[0]), float(result[1])

    canvas = page.locator("canvas").first
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None

    # First drag: at the box's initial position (canvas center).
    _perform_modifier_drag(page, "Control")
    page.wait_for_timeout(300)

    with lock:
        first_count = len(drag_starts)
    assert first_count == 1, (
        f"first drag at the box's initial position should fire, got {first_count}"
    )

    # Programmatically translate the box to a new world position. This
    # exercises the ``batched_positions`` setter directly — no drag
    # callback involved — so any failure of the second drag is purely
    # about whether the raycast finds the instance at its new location.
    # In viser (Z-up), the camera at (0, 0, 8) looks straight down the
    # -Z axis and the screen-horizontal axis is viser-(-Y). We move the
    # box in viser-(-Y) so it shifts visibly to the right on screen.
    new_viser_pos = (0.0, -2.5, 0.0)
    handle.batched_positions = np.array([new_viser_pos], dtype=np.float32)
    page.wait_for_timeout(300)

    # Second drag: project the new world position to canvas pixels.
    initial_x, initial_y = project_viser_to_canvas_xy((0.0, 0.0, 0.0))
    new_x, new_y = project_viser_to_canvas_xy(new_viser_pos)
    new_canvas_x = canvas_box["x"] + new_x
    new_canvas_y = canvas_box["y"] + new_y
    # Sanity: new pixel position should be visibly different from initial.
    pixel_shift = math.sqrt((new_x - initial_x) ** 2 + (new_y - initial_y) ** 2)
    assert pixel_shift > 30.0, (
        f"projected pixel shift after translating to {new_viser_pos} is "
        f"only {pixel_shift:.1f}px — too small to differentiate stale-cache "
        f"behavior from a hit at the original position. Adjust new_viser_pos "
        f"or camera distance."
    )
    page.keyboard.down("Control")
    page.mouse.move(new_canvas_x, new_canvas_y)
    page.mouse.down()
    page.mouse.move(new_canvas_x + 20, new_canvas_y, steps=4)
    page.mouse.up()
    page.keyboard.up("Control")
    page.wait_for_timeout(300)

    with lock:
        second_count = len(drag_starts)
    assert second_count == 2, (
        f"after translating the instance to viser={new_viser_pos} (canvas "
        f"pixel shift {pixel_shift:.1f}px from the original), a second drag "
        f"at its new screen position ({new_canvas_x:.1f}, {new_canvas_y:.1f}) "
        f"should fire — got {second_count} total drag_starts. Root cause is "
        f"a stale union bounding sphere in the vendor InstancedMesh2 raycast: "
        f"it's computed lazily on first raycast and never invalidated when "
        f"``batched_positions`` updates. Fix: invalidate ``mesh.boundingSphere`` "
        f"in BatchedMeshBase's per-instance update effect."
    )


def test_scene_node_drag_no_spurious_update_before_end(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """A drag with no mouse motion (mousedown → mouseup at the same
    pixel) must NOT fire any ``on_drag_update`` callbacks — ``flush()``
    used to re-emit the last sent message even when nothing was
    throttled, duplicating the start as a spurious update before end."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_ended = threading.Event()
    update_count = [0]
    lock = threading.Lock()

    box = viser_server.scene.add_box(
        "/no_motion_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(120, 200, 255),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    @box.on_drag_update("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        with lock:
            update_count[0] += 1

    @box.on_drag_end("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_ended.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/no_motion_box")

    canvas = page.locator("canvas").first
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    # Mouse down at center, then immediately up — no motion in between,
    # so no pointermove → no throttled update queued.
    page.keyboard.down("Control")
    page.mouse.move(cx, cy)
    page.mouse.down()
    assert drag_started.wait(timeout=5.0), "drag_start didn't fire"
    page.mouse.up()
    page.keyboard.up("Control")
    assert drag_ended.wait(timeout=5.0), "drag_end didn't fire"

    # Settle: any in-flight updates would have arrived by now.
    page.wait_for_timeout(300)
    with lock:
        count = update_count[0]
    assert count == 0, (
        f"expected 0 update callbacks (no mouse motion), got {count}. "
        f"flush() likely re-sent the last message even though nothing "
        f"was throttled, materializing a spurious update before end."
    )


def test_scene_node_drag_end_fires_when_node_removed_midflight(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """If the dragged node is removed from the server scene mid-drag,
    the server's ``on_drag_end`` callback must still fire so user code
    can release per-drag state (otherwise it leaks). Previously, when
    the live grab point was unavailable ``buildDragMessage`` returned
    null and the end message was silently dropped."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_ended = threading.Event()

    box = viser_server.scene.add_box(
        "/disappearing_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(255, 100, 100),
    )

    @box.on_drag_start("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    @box.on_drag_end("left", modifier="cmd/ctrl")
    async def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_ended.set()

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/disappearing_box")

    canvas = page.locator("canvas").first
    canvas_box = canvas.bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    # Begin a drag, then remove the scene node mid-gesture. The end
    # callback must fire from the *removal* path (client's
    # ``stopIfNodeIs`` triggered by the visibility loss) — NOT from a
    # subsequent ``mouse.up()``, which would mask a regression in the
    # remove-driven teardown. We assert ``drag_ended.wait`` succeeds
    # BEFORE releasing the mouse; only after that do we clean up the
    # pointer state.
    page.keyboard.down("Control")
    page.mouse.move(cx, cy)
    page.mouse.down()
    assert drag_started.wait(timeout=5.0)

    page.mouse.move(cx + 50, cy + 20, steps=5)
    page.wait_for_timeout(150)
    box.remove()

    assert drag_ended.wait(timeout=5.0), (
        "drag_end did not fire after the dragged node was removed mid-drag — "
        "client likely dropped the end message because the live grab point "
        "was unavailable, leaking per-drag state on the server. (The mouse "
        "is still held down at this point — if the end fires only after "
        "mouseup, this assertion catches that the remove path didn't fire)"
    )

    # Now release the pointer so the test cleans up cleanly.
    page.mouse.up()
    page.keyboard.up("Control")


# Note: end-to-end coverage of "DragLayer disabled in embed/playback
# mode" is awkward — verifying the user-visible outcome (camera
# falls through, no callbacks fire) requires a separate fixture for
# embed mode AND a related fix in SceneTree's onPointerDown handler
# (which currently always ``stopPropagation`` for any node with
# ``interactive = clickable || draggable``, blocking the camera even
# when ``DragLayer`` exposes a null api). Tracked as future work.


def test_scene_node_drag_callback_removal(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """Removing drag callbacks should disable scene-node dragging callbacks."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    drag_started = threading.Event()
    drag_updated = threading.Event()
    drag_ended = threading.Event()

    box = viser_server.scene.add_box(
        "/removed_drag_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(0, 120, 255),
    )

    def on_drag_start(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_started.set()

    def on_drag_update(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_updated.set()

    def on_drag_end(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        drag_ended.set()

    box.on_drag_start("left", modifier="cmd/ctrl")(on_drag_start)
    box.on_drag_update("left", modifier="cmd/ctrl")(on_drag_update)
    box.on_drag_end("left", modifier="cmd/ctrl")(on_drag_end)

    box.remove_drag_start_callback(on_drag_start)
    box.remove_drag_update_callback(on_drag_update)
    box.remove_drag_end_callback(on_drag_end)

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/removed_drag_box")

    _perform_modifier_drag(page, "Control")
    # Negative-assertion settle window: if any callback were going to
    # fire, it would have round-tripped (client → server → callback)
    # within this window even under CI load.
    page.wait_for_timeout(1000)

    assert not drag_started.is_set()
    assert not drag_updated.is_set()
    assert not drag_ended.is_set()
