"""E2E test for the default camera + scene orientation BEFORE the client
connects to a server.

The client's default root orientation is hardcoded to equal
``set_up_direction("+z")`` (wxyz ``[0.5, -0.5, 0.5, 0.5]``). With the default
initial camera (viser-world ``[3, 3, 3]``) that should place the three.js camera
at ``[-3, 3, -3]`` looking at the origin, +Z up -- the standard view -- with the
client never having talked to a server.

To exercise the genuine pre-connect state we load the client from the server's
HTTP endpoint but override the websocket target (``?websocket=``) to a dead port,
so the React app fully mounts (camera, scene defaults) but never connects. The
``firstMessageBatch`` flag staying ``true`` confirms no server messages were
processed.

Suspects for the reported "axes look wrong before connect" symptom (see
``initial_pose_and_scene_orientation.md``):

  1. **Camera mount-ordering race.** If ``initialT`` is captured before the root
     node's default orientation is in the store, the camera is placed with
     ``T = identity`` -> three.js ``[3, 3, 3]`` and
     ``initialCameraDiagnostic.rootWxyzAtCapture == [1, 0, 0, 0]``. FAILS here.
  2. **Axes visibility, not orientation.** If this PASSES, the pre-connect
     orientation is correct and the symptom is the ``/WorldAxes`` visibility
     default flipping on connect, not a transform bug.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import find_free_port

JS_CAMERA_POS = """
() => {
    const cc = window.__viserMutable.cameraControl;
    const p = cc.getPosition({ x: 0, y: 0, z: 0,
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } });
    return [p.x, p.y, p.z];
}
"""
JS_DIAG = "() => window.__viserMutable.initialCameraDiagnostic"
JS_ROOT_WXYZ = "() => window.__viserSceneTree.getState()[''].wxyz"
JS_FIRST_BATCH = "() => window.__viserMutable.firstMessageBatch"
JS_NODE_WORLD_QUAT = """
(name) => {
    const o = window.__viserMutable.nodeRefFromName[name];
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    const Q = o.getWorldQuaternion(new o.quaternion.constructor());
    return [Q.w, Q.x, Q.y, Q.z];
}
"""

# +Z-up default == set_up_direction("+z").
DEFAULT_ROOT_WXYZ = [0.5, -0.5, 0.5, 0.5]
# viser-world [3,3,3] mapped through T_threeworld_world.
EXPECTED_THREE_CAMERA = [-3.0, 3.0, -3.0]


def _open_disconnected(page: Page, http_port: int) -> None:
    """Load the client from ``http_port`` but point its websocket at a dead
    port, so it mounts the viewer but never connects."""
    dead_ws_port = find_free_port()
    page.goto(f"http://localhost:{http_port}/?websocket=ws://localhost:{dead_ws_port}")
    # Wait until the viewer has mounted (camera controls live). This happens on
    # mount, independent of any websocket connection.
    page.wait_for_function(
        "() => window.__viserMutable && window.__viserMutable.cameraControl != null",
        timeout=15_000,
    )
    page.wait_for_timeout(500)


def _quat_same_rotation(a: list[float], b: list[float]) -> bool:
    """True if two quaternions represent the same rotation (handles q ~ -q)."""
    dot = sum(x * y for x, y in zip(a, b))
    return abs(abs(dot) - 1.0) < 1e-3


def _max_delta(a: list[float], b: list[float]) -> float:
    return max(abs(x - y) for x, y in zip(a, b))


def test_default_view_is_plus_z_up_before_connecting(
    page: Page, viser_server: viser.ViserServer
) -> None:
    _open_disconnected(page, viser_server.get_port())

    # Sanity: we are genuinely pre-connect -- no server message batch has been
    # processed (the flag only flips false once a batch lands).
    assert page.evaluate(JS_FIRST_BATCH) is True, (
        "expected to be pre-connect (firstMessageBatch == true); the client "
        "appears to have connected, so this isn't testing the pre-connect state"
    )

    # (1) Root orientation captured at initialT time must be the +Z-up default,
    # not identity. Identity would mean a mount-ordering race.
    diag = page.evaluate(JS_DIAG)
    assert diag is not None, "initialCameraDiagnostic was not exposed on window"
    captured = diag["rootWxyzAtCapture"]
    assert _quat_same_rotation(captured, DEFAULT_ROOT_WXYZ), (
        f"root orientation at initialT capture was {captured}, expected the "
        f"+Z-up default {DEFAULT_ROOT_WXYZ}. Identity [1,0,0,0] indicates the "
        f"root node wasn't in the store yet when initialT was captured "
        f"(mount-ordering race)."
    )

    # (2) The live root orientation must also be the +Z-up default.
    root_wxyz = page.evaluate(JS_ROOT_WXYZ)
    assert _quat_same_rotation(root_wxyz, DEFAULT_ROOT_WXYZ), (
        f"live root wxyz is {root_wxyz}, expected default {DEFAULT_ROOT_WXYZ}"
    )

    # (3) The camera must be at three.js [-3, 3, -3] (= world [3,3,3] through
    # T). [3, 3, 3] would mean the initial transform was applied with
    # T = identity.
    pos = page.evaluate(JS_CAMERA_POS)
    assert _max_delta(pos, EXPECTED_THREE_CAMERA) < 0.25, (
        f"camera is at three.js {pos}, expected {EXPECTED_THREE_CAMERA}. "
        f"[3, 3, 3] would indicate the initial camera transform was applied "
        f"with T = identity (mount-ordering race)."
    )

    # (4) The /WorldAxes gizmo (child of root, identity local transform) must
    # inherit the root orientation -- i.e. its WORLD orientation equals the
    # +Z-up default. If it's identity or anything else, the axes gizmo itself is
    # mis-oriented even when the camera and root frame are correct.
    wa_q = page.evaluate(JS_NODE_WORLD_QUAT, "/WorldAxes")
    assert wa_q is not None, "/WorldAxes Object3D not found in nodeRefFromName"
    assert _quat_same_rotation(wa_q, DEFAULT_ROOT_WXYZ), (
        f"/WorldAxes world orientation is {wa_q}, expected the root's +Z-up "
        f"default {DEFAULT_ROOT_WXYZ}. A mismatch means the world-axes gizmo is "
        f"mis-oriented relative to the scene frame."
    )
