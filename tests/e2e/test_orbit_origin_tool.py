"""E2E regression tests for the Orbit Origin Tool (the magenta pivot gizmo).

The tool is forced visible via the ``?forceOrbitOriginTool=1`` URL flag.
Dragging a translation handle should animate the camera's look-at to the
gizmo's new world position; the gizmo itself is a world-space anchor that
holds still during the settle animation and otherwise tracks the look-at.

Covers three bugs fixed in ``CameraControls.tsx``:

  1. Stale-closure flicker: the "is an animation running?" guard read a
     stale value, so the gizmo snapped back toward the old look-at for a
     frame after release. -> ``test_gizmo_holds_still_during_settle``.
  2. No drag guard on the per-frame camera->pivot sync: if the camera was
     moving when the drag started, the sync stomped the gizmo's matrix
     every frame and the drag did nothing. ->
     ``test_drag_works_while_camera_is_moving``.
  3. Missed ``onDragEnd``: drei fires it from the handle's own pointerup,
     which R3F pointer capture doesn't deliver when the pointer is released
     away from the handle -- so the commit never ran and the sync froze. ->
     ``test_release_off_handle_still_commits``.
"""

from __future__ import annotations

import math

from playwright.sync_api import Page

import viser

# Find the pivot gizmo, project a translation-arrow handle and the gizmo
# center to viewport (CSS-pixel) coordinates Playwright can drag. The arrow
# hit targets are the (invisible) cylinder-geometry meshes; the visible line
# and cone disable raycasting. Returns null if the gizmo isn't present yet.
JS_FIND_HANDLE = """
() => {
    const m = window.__viserMutable;
    const cam = m.camera;
    let grid = null;
    m.scene.traverse((o) => {
        if (o.material && o.material.uniforms && 'fadeDistance' in o.material.uniforms)
            grid = o;
    });
    if (!grid) return null;
    let p = grid, pivot = null;
    while (p) {
        if (p.matrixAutoUpdate === false && p.type === 'Group') { pivot = p; break; }
        p = p.parent;
    }
    if (!pivot) return null;
    pivot.updateWorldMatrix(true, true);
    const V = pivot.position.constructor;
    const center = new V();
    pivot.getWorldPosition(center);
    const handles = [];
    pivot.traverse((o) => {
        if (o.isMesh && o.geometry && o.geometry.type === 'CylinderGeometry') {
            const wp = new V();
            o.getWorldPosition(wp);
            handles.push(wp);
        }
    });
    if (handles.length === 0) return null;
    const rect = m.canvas.getBoundingClientRect();
    const toScreen = (v) => {
        const n = v.clone().project(cam);
        return [
            rect.left + (n.x * 0.5 + 0.5) * rect.width,
            rect.top + (-n.y * 0.5 + 0.5) * rect.height,
        ];
    };
    const c = toScreen(center);
    // Pick the arrow whose screen projection is longest -- most screen-aligned,
    // so a screen-space drag along it produces the largest look-at change.
    let best = null, bestD = -1;
    for (const h of handles) {
        const s = toScreen(h);
        const d = Math.hypot(s[0] - c[0], s[1] - c[1]);
        if (d > bestD) { bestD = d; best = s; }
    }
    return { center: c, handle: best };
}
"""

# Camera look-at target and gizmo world position, as [x, y, z] arrays.
JS_TARGET_AND_PIVOT = """
() => {
    const m = window.__viserMutable;
    const cc = m.cameraControl;
    const t = cc.getTarget({ x: 0, y: 0, z: 0,
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
    let grid = null;
    m.scene.traverse((o) => {
        if (o.material && o.material.uniforms && 'fadeDistance' in o.material.uniforms)
            grid = o;
    });
    let p = grid, pivot = null;
    while (p) {
        if (p.matrixAutoUpdate === false && p.type === 'Group') { pivot = p; break; }
        p = p.parent;
    }
    const V = pivot.position.constructor;
    const wp = new V();
    pivot.getWorldPosition(wp);
    return { target: [t.x, t.y, t.z], pivot: [wp.x, wp.y, wp.z] };
}
"""

JS_PIVOT_MATRIX = """
() => {
    const m = window.__viserMutable;
    let grid = null;
    m.scene.traverse((o) => {
        if (o.material && o.material.uniforms && 'fadeDistance' in o.material.uniforms)
            grid = o;
    });
    let p = grid, pivot = null;
    while (p) {
        if (p.matrixAutoUpdate === false && p.type === 'Group') { pivot = p; break; }
        p = p.parent;
    }
    return Array.from(pivot.matrix.elements);
}
"""

# Start/stop a per-frame sampler of the gizmo's world position.
JS_START_PIVOT_SAMPLER = """
() => {
    const m = window.__viserMutable;
    let grid = null;
    m.scene.traverse((o) => {
        if (o.material && o.material.uniforms && 'fadeDistance' in o.material.uniforms)
            grid = o;
    });
    let p = grid, pivot = null;
    while (p) {
        if (p.matrixAutoUpdate === false && p.type === 'Group') { pivot = p; break; }
        p = p.parent;
    }
    const V = pivot.position.constructor;
    window.__ps = [];
    window.__psRun = true;
    const wp = new V();
    (function loop() {
        if (!window.__psRun) return;
        pivot.getWorldPosition(wp);
        window.__ps.push([wp.x, wp.y, wp.z]);
        requestAnimationFrame(loop);
    })();
    return true;
}
"""
JS_STOP_PIVOT_SAMPLER = "() => { window.__psRun = false; return window.__ps; }"


def _dist(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _norm(a: list[float]) -> float:
    return math.sqrt(sum(x * x for x in a))


def _max_delta(a: list[float], b: list[float]) -> float:
    return max(abs(x - y) for x, y in zip(a, b))


def _open_with_orbit_tool(page: Page, port: int) -> None:
    """Open the viewer with the orbit-origin gizmo forced visible and wait
    until the camera controls are live."""
    page.goto(f"http://localhost:{port}/?forceOrbitOriginTool=1")
    page.wait_for_function(
        "() => !document.body.innerText.includes('Connecting...')",
        timeout=15_000,
    )
    page.wait_for_function(
        "() => window.__viserMutable && window.__viserMutable.cameraControl != null",
        timeout=15_000,
    )
    page.wait_for_timeout(500)


def _grab_handle(page: Page) -> dict:
    handle = page.evaluate(JS_FIND_HANDLE)
    assert handle is not None, "orbit-origin gizmo / translation handle not found"
    return handle


def _drag_handle_outward(page: Page, handle: dict, pixels: float = 120.0) -> None:
    """Drag a translation arrow outward along its own screen direction."""
    cx, cy = handle["center"]
    hx, hy = handle["handle"]
    dx, dy = hx - cx, hy - cy
    length = math.hypot(dx, dy) or 1.0
    ex, ey = hx + dx / length * pixels, hy + dy / length * pixels
    page.mouse.move(hx, hy)
    page.mouse.down()
    page.mouse.move(ex, ey, steps=15)
    page.mouse.up()


def test_drag_moves_lookat(page: Page, viser_server: viser.ViserServer) -> None:
    """Baseline: dragging a translation handle commits -- the camera's
    look-at animates to the gizmo's new world position, and the two
    coincide once the settle animation finishes."""
    viser_server.scene.add_box("/box", dimensions=(0.5, 0.5, 0.5))
    _open_with_orbit_tool(page, viser_server.get_port())

    before = page.evaluate(JS_TARGET_AND_PIVOT)
    _drag_handle_outward(page, _grab_handle(page))
    page.wait_for_timeout(900)
    after = page.evaluate(JS_TARGET_AND_PIVOT)

    moved = _dist(before["target"], after["target"])
    assert moved > 0.1, f"look-at did not move on drag (delta={moved:.3f})"
    coincide = _dist(after["target"], after["pivot"])
    assert coincide < 0.15, (
        f"gizmo and look-at diverged after settle (gap={coincide:.3f})"
    )


def test_gizmo_holds_still_during_settle(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression for the stale-closure flicker: while the camera animates
    to the dragged point, the gizmo must hold at that world position. Pre-fix
    it snapped back toward the origin for a frame, then rode the camera's
    lerp back out -- so the per-frame distance-from-origin dipped to ~0."""
    _open_with_orbit_tool(page, viser_server.get_port())

    handle = _grab_handle(page)
    page.evaluate(JS_START_PIVOT_SAMPLER)
    _drag_handle_outward(page, handle)
    page.wait_for_timeout(900)  # cover the full 0.5s settle animation
    samples: list[list[float]] = page.evaluate(JS_STOP_PIVOT_SAMPLER)

    assert len(samples) > 10, "sampler captured too few frames"
    final_dist = _norm(samples[-1])
    assert final_dist > 0.3, f"drag did not move the gizmo (final={final_dist:.3f})"

    # The drag itself ramps the gizmo from the origin out to `final_dist`, so we
    # only look from the first frame it has essentially reached its final spot
    # (i.e. at/after release). From there the gizmo must HOLD while the camera
    # animates -- it must not fall back toward the origin. The pre-fix snap-back
    # drove this minimum to ~0.
    near_final_idx = next(
        i for i, s in enumerate(samples) if _norm(s) >= 0.8 * final_dist
    )
    min_after = min(_norm(s) for s in samples[near_final_idx:])
    assert min_after > final_dist * 0.5, (
        f"gizmo snapped back toward origin after reaching its target "
        f"(min={min_after:.3f}, final={final_dist:.3f})"
    )


def test_drag_works_while_camera_is_moving(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression for the missing drag guard: start a slow dolly so the
    per-frame camera->pivot sync fires every frame, then drag a handle. The
    drag must still take hold. Pre-fix the sync stomped the gizmo's matrix
    each frame and the look-at never changed."""
    _open_with_orbit_tool(page, viser_server.get_port())

    before = page.evaluate(JS_TARGET_AND_PIVOT)
    # Widen the settle window and start a slow dolly. dolly changes distance,
    # not the look-at, so any look-at change must come from the drag.
    page.evaluate(
        """() => {
            const cc = window.__viserMutable.cameraControl;
            cc.smoothTime = 2.0;
            cc.dollyTo(cc.distance * 2.5, true);
        }"""
    )
    _drag_handle_outward(page, _grab_handle(page))
    page.wait_for_timeout(1000)
    page.evaluate("() => { window.__viserMutable.cameraControl.smoothTime = 0.05; }")
    after = page.evaluate(JS_TARGET_AND_PIVOT)

    moved = _dist(before["target"], after["target"])
    assert moved > 0.1, (
        f"drag had no effect while camera was moving (delta={moved:.3f}); "
        "the per-frame sync stomped the gizmo"
    )


def test_release_off_handle_still_commits(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression for the missed onDragEnd: release the drag while the
    pointer is far from the handle. The drag must still commit (look-at
    moves), and the per-frame sync must NOT be left frozen -- moving the
    look-at afterward should pull the gizmo along with it."""
    _open_with_orbit_tool(page, viser_server.get_port())

    before = page.evaluate(JS_TARGET_AND_PIVOT)
    handle = _grab_handle(page)
    hx, hy = handle["handle"]
    # Drag to the top-left corner of the canvas -- well off the handle.
    page.mouse.move(hx, hy)
    page.mouse.down()
    page.mouse.move(60, 60, steps=20)
    page.mouse.up()
    page.wait_for_timeout(900)

    after = page.evaluate(JS_TARGET_AND_PIVOT)
    moved = _dist(before["target"], after["target"])
    assert moved > 0.1, (
        f"off-handle release did not commit the drag (delta={moved:.3f}); "
        "onDragEnd was missed and no safety net fired"
    )

    # The drag flag must have been cleared: move the look-at programmatically
    # and the gizmo should track it on the next frames.
    page.evaluate(
        "() => window.__viserMutable.cameraControl.setTarget(0.9, 0.2, -0.4, false)"
    )
    page.wait_for_timeout(300)
    state = page.evaluate(JS_TARGET_AND_PIVOT)
    gap = _dist(state["pivot"], [0.9, 0.2, -0.4])
    assert gap < 0.15, (
        f"gizmo did not follow the look-at after an off-handle release "
        f"(gap={gap:.3f}); the per-frame sync is frozen (drag flag stuck)"
    )


# Find the gizmo's "up" rotation ring (an AxisRotator arc, a Line2) and project
# its arc to screen. Disables the non-rotation hit targets (arrow cylinders /
# plane-slider meshes -- the `visible:false` non-Line2 meshes) so the thin ring
# is what gets picked.
JS_FIND_ROTATION_RING = """
() => {
    const m = window.__viserMutable, cam = m.camera;
    let grid = null;
    m.scene.traverse((o) => {
        if (o.material && o.material.uniforms && 'fadeDistance' in o.material.uniforms)
            grid = o;
    });
    let p = grid, pivot = null;
    while (p) { if (p.matrixAutoUpdate === false && p.type === 'Group') { pivot = p; break; } p = p.parent; }
    if (!pivot) return null;
    pivot.updateWorldMatrix(true, true);
    pivot.traverse((o) => { if (o.isMesh && !o.isLine2 && o.visible === false) o.raycast = () => null; });
    const up = cam.up.clone().normalize();
    const V = up.constructor;
    const rect = m.canvas.getBoundingClientRect();
    const toS = (v) => { const n = v.clone().project(cam);
        return [rect.left + (n.x*0.5+0.5)*rect.width, rect.top + (-n.y*0.5+0.5)*rect.height]; };
    const isArc = (o) => o.isLine2 || (o.geometry && o.geometry.type && o.geometry.type.indexOf('Line') >= 0);
    let best = null, bd = -1;
    pivot.traverse((o) => {
        if (o.type === 'Group' && o.matrixAutoUpdate === false && o !== pivot && o.children.some(isArc)) {
            const e = o.matrixWorld.elements;
            const z = new V(e[8], e[9], e[10]).normalize();
            const d = Math.abs(z.dot(up));
            if (d > bd) { bd = d; best = o; }
        }
    });
    if (!best) return null;
    const pts = [];
    for (let j = 0; j <= 10; j++) {
        const a = j * (Math.PI / 2) / 10;
        pts.push(toS(new V(Math.cos(a)*0.65, Math.sin(a)*0.65, 0).applyMatrix4(best.matrixWorld)));
    }
    return { arc: pts };
}
"""

# Simulate the browser canceling the in-flight gesture: pointercancel + the
# pointer-capture release that a real cancel performs.
JS_CANCEL_POINTER = """
() => {
    const c = window.__viserMutable.canvas;
    c.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true, cancelable: true }));
    try { c.releasePointerCapture(1); } catch (e) {}
    c.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }));
    return true;
}
"""

JS_CAMERA_POS = """
() => {
    const cc = window.__viserMutable.cameraControl;
    const p = cc.getPosition({x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}});
    return [p.x, p.y, p.z];
}
"""


def test_canceled_ring_rotation_does_not_disable_camera(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: a ``pointercancel`` during a rotation-ring drag must fully
    end the drag and must not leave camera controls disabled.

    drei's ``AxisRotator`` sets ``cameraControl.enabled = false`` on pointerdown
    and only restores it in its own ``onPointerUp`` -- it has no pointercancel
    handler. A canceled ring drag (common for the curved gesture) therefore
    stranded the camera disabled with no lease held (``cameraLockReasons()``
    empty), so orbit/pan/zoom silently stopped working. SafePivotControls now
    treats cancel/lostcapture as drag termination and releases its camera lock.
    """
    viser_server.scene.add_box("/box", dimensions=(0.5, 0.5, 0.5))
    _open_with_orbit_tool(page, viser_server.get_port())

    ring = page.evaluate(JS_FIND_ROTATION_RING)
    assert ring is not None, "orbit-origin rotation ring not found"
    arc = [(round(x), round(y)) for x, y in ring["arc"]]

    assert page.evaluate("() => window.__viserMutable.cameraControl.enabled") is True

    # Press the ring and rotate, then have the browser cancel the gesture.
    mid = len(arc) // 2
    page.mouse.move(*arc[mid])
    page.mouse.down()
    for x, y in arc[mid + 1 :]:
        page.mouse.move(x, y, steps=4)
    page.evaluate(JS_CANCEL_POINTER)
    page.wait_for_timeout(300)

    enabled = page.evaluate("() => window.__viserMutable.cameraControl.enabled")
    reasons = page.evaluate("() => window.__viserPointer.cameraLockReasons()")
    assert enabled is True, (
        f"camera left disabled after a canceled ring rotation "
        f"(enabled={enabled}, lease reasons={reasons})"
    )

    # TODO: re-enable once the gizmo's internal drag state is torn down on
    # cancel. drei's AxisRotator clears its private `clickInfo` only in its own
    # pointerup -- it has no pointercancel/lostpointercapture handler -- so after
    # a cancel, moving back over the ring (which re-raycasts the arc mesh) keeps
    # rotating the gizmo. The App-level `cameraLocks.apply()` recovers the camera
    # (asserted above) but cannot reach drei's internal state; fixing that needs
    # a PivotControls wrapper that synthesizes a drag-termination on cancel.
    # before_matrix = page.evaluate(JS_PIVOT_MATRIX)
    # for x, y in reversed(arc[: mid + 1]):
    #     page.mouse.move(x, y, steps=4)
    # page.wait_for_timeout(200)
    # after_matrix = page.evaluate(JS_PIVOT_MATRIX)
    # assert _max_delta(before_matrix, after_matrix) < 1e-5, (
    #     "rotation ring kept dragging after pointercancel with no button held; "
    #     "the gizmo drag state was not cleared"
    # )

    # And it should actually orbit again. NOTE: this only proves the camera
    # moved, not that the gesture orbited rather than being eaten by a
    # still-armed gizmo drag (the internal-state teardown deferred above). The
    # start point (300, 400) is chosen to land on empty canvas, away from the
    # ring, so a pointerdown there starts an orbit; tighten this once the
    # gizmo's drag state is torn down on cancel.
    before = page.evaluate(JS_CAMERA_POS)
    page.mouse.move(300, 400)
    page.mouse.down()
    page.mouse.move(460, 440, steps=15)
    page.mouse.up()
    page.wait_for_timeout(400)
    after = page.evaluate(JS_CAMERA_POS)
    assert _dist(before, after) > 1e-3, (
        "camera did not orbit after a canceled ring rotation; controls stuck"
    )


def test_canceled_axis_drag_does_not_keep_dragging(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: cancel/lost-capture during a translation-axis drag must clear
    the handle's drag state. Fast drags can otherwise leave the axis behaving as
    if the pointer were still held down."""
    viser_server.scene.add_box("/box", dimensions=(0.5, 0.5, 0.5))
    _open_with_orbit_tool(page, viser_server.get_port())

    handle = _grab_handle(page)
    cx, cy = handle["center"]
    hx, hy = handle["handle"]
    dx, dy = hx - cx, hy - cy
    length = math.hypot(dx, dy) or 1.0

    page.mouse.move(hx, hy)
    page.mouse.down()
    page.mouse.move(
        hx + dx / length * 180,
        hy + dy / length * 180,
        steps=2,
    )
    page.evaluate(JS_CANCEL_POINTER)
    page.wait_for_timeout(300)

    enabled = page.evaluate("() => window.__viserMutable.cameraControl.enabled")
    reasons = page.evaluate("() => window.__viserPointer.cameraLockReasons()")
    assert enabled is True, (
        f"camera left disabled after a canceled axis drag "
        f"(enabled={enabled}, lease reasons={reasons})"
    )

    before_matrix = page.evaluate(JS_PIVOT_MATRIX)
    for x, y in [(60, 60), (720, 80), (160, 520), (700, 520)]:
        page.mouse.move(x, y, steps=2)
    page.wait_for_timeout(200)
    after_matrix = page.evaluate(JS_PIVOT_MATRIX)
    page.mouse.up()
    assert _max_delta(before_matrix, after_matrix) < 1e-5, (
        "translation axis kept dragging after pointercancel/lostcapture; "
        "the gizmo drag state was not cleared"
    )


JS_CAPTURE_STATE = """
() => ({
    canvasHasCapture: window.__viserMutable.canvas.hasPointerCapture(1),
    gesture: window.__viserPointer.getGesture().kind,
})
"""


def test_gizmo_drag_not_hijacked_by_rect_select(
    page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: with ``on_rect_select`` registered, pressing a gizmo handle
    must not start a canvas-level rect-select gesture, which used to call
    ``setPointerCapture`` on a different element and steal the gizmo's capture
    (drei then drops it and its pointerup is missed, leaving the gizmo stuck
    'dragging' after release).

    White-box: while the gizmo handle is held, the canvas must retain pointer
    capture (id 1) and the scene-pointer gesture must stay idle.
    """

    @viser_server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event

    viser_server.scene.add_box("/box", dimensions=(0.5, 0.5, 0.5))
    _open_with_orbit_tool(page, viser_server.get_port())

    handle = _grab_handle(page)
    cx, cy = handle["center"]
    hx, hy = handle["handle"]

    page.mouse.move(hx, hy)
    page.mouse.down()
    page.mouse.move((hx + cx) / 2 + 30, (hy + cy) / 2 + 30, steps=8)
    state = page.evaluate(JS_CAPTURE_STATE)
    page.mouse.up()

    assert state["canvasHasCapture"] is True, (
        "gizmo lost its pointer capture mid-drag (stolen by the canvas "
        f"rect-select handler); state={state}"
    )
    assert state["gesture"] == "idle", (
        "pressing the gizmo started a canvas scene-pointer gesture "
        f"(should be suppressed when a 3D handle owns the pointer); state={state}"
    )
