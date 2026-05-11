"""E2E tests for the InputManager pure functions.

Exercises the pointerdown classifier, pointermove transitions,
pointerup finaliser, and the derive-camera/cursor/contextmenu reducers
through the ``window.__viserInputManager__`` shim installed by
``inputManager/devTestApi.ts``. Single Playwright session boots the
viewer once and runs all cells of the design doc's behavior table
in-page via ``page.evaluate``.

The shim is the stable test contract; do not break it without
updating the assertions here. See ``input_manager_design_merged.md``
for the gesture / classification policy this verifies.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

# ---------------------------------------------------------------------------
# classifyPointerDown
# ---------------------------------------------------------------------------


def test_classifier_camera_when_no_match(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Rule 4: input that matches no node binding and no scene filter
    classifies as plain ``camera``."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            return im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [10, 20],
                hit: null,
                registrations: {
                    nodes: new Map(),
                    scenePointerFilters: new Map(),
                },
            }).kind;
        }
        """,
    )
    assert out == "camera"


def test_classifier_click_and_drag_starts_as_candidate(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """When a node has BOTH a click and a drag binding for the same
    input, the gesture starts as ``node-click-candidate`` (not
    ``node-drag``). ``dragBindingsToCommit`` carries the matching
    drag bindings so a subsequent move past threshold can transition
    to ``node-drag``. A stationary release dispatches click.

    This is the "tap fires click, drag fires drag" rule: drag does
    NOT win at pointerdown anymore; it wins only after motion."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const nodes = new Map();
            const clickB = { button: "left", modifier: null };
            const dragB = { button: "left", modifier: null };
            nodes.set("n", {
                clickBindings: [clickB],
                dragBindings: [dragB],
            });
            const g = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [0, 0],
                hit: { nodeName: "n", instanceIndex: null,
                       targetObj: null, pointWorld: null,
                       ray: null, distance: 0 },
                registrations: { nodes, scenePointerFilters: new Map() },
            });
            return {
                kind: g.kind,
                hasDragBindings: g.dragBindingsToCommit !== null,
                dragBindingCount: g.dragBindingsToCommit?.length ?? 0,
                cameraMayAlsoHandle: g.cameraMayAlsoHandle,
            };
        }
        """,
    )
    # cameraMayAlsoHandle is false because we're going to commit to a
    # drag on motion -- camera-controls would race the drag.
    assert out == {
        "kind": "node-click-candidate",
        "hasDragBindings": True,
        "dragBindingCount": 1,
        "cameraMayAlsoHandle": False,
    }


def test_classifier_drag_only_node_commits_at_pointerdown(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A node with a drag binding but NO click binding still commits
    to ``node-drag`` at pointerdown -- there's no tap-vs-drag
    ambiguity to resolve."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const nodes = new Map();
            nodes.set("n", {
                clickBindings: [],
                dragBindings: [{ button: "left", modifier: null }],
            });
            return im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [0, 0],
                hit: { nodeName: "n", instanceIndex: null,
                       targetObj: null, pointWorld: null,
                       ray: null, distance: 0 },
                registrations: { nodes, scenePointerFilters: new Map() },
            }).kind;
        }
        """,
    )
    assert out == "node-drag"


def test_apply_pointer_move_promotes_candidate_to_drag(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A ``node-click-candidate`` with ``dragBindingsToCommit`` set
    transitions to ``node-drag`` once the caller reports motion past
    threshold. Without ``dragBindingsToCommit``, the same threshold
    crossing just sets ``moved=true`` (camera-compatible orbit)."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const hit = { nodeName: "n", instanceIndex: null,
                          targetObj: null, pointWorld: null,
                          ray: null, distance: 0 };

            // Click + drag: motion promotes to node-drag.
            const both = new Map();
            both.set("n", {
                clickBindings: [{ button: "left", modifier: null }],
                dragBindings: [{ button: "left", modifier: null }],
            });
            const gBoth = im.applyPointerMove(
                im.classifyPointerDown({
                    input: { button: "left", modifier: null },
                    pointerId: 1, startXy: [0, 0], hit,
                    registrations: { nodes: both, scenePointerFilters: new Map() },
                }),
                [50, 50], true,
            );

            // Click only: motion just sets moved=true; stays as candidate.
            const clickOnly = new Map();
            clickOnly.set("n", {
                clickBindings: [{ button: "left", modifier: null }],
                dragBindings: [],
            });
            const gClickOnly = im.applyPointerMove(
                im.classifyPointerDown({
                    input: { button: "left", modifier: null },
                    pointerId: 1, startXy: [0, 0], hit,
                    registrations: { nodes: clickOnly, scenePointerFilters: new Map() },
                }),
                [50, 50], true,
            );
            return [gBoth.kind, gClickOnly.kind, gClickOnly.moved];
        }
        """,
    )
    assert out == ["node-drag", "node-click-candidate", True]


def test_classifier_node_click_candidate(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Rule 2: clickable node, no drag binding match -> candidate.
    cameraMayAlsoHandle=true so motion past threshold becomes orbit."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const nodes = new Map();
            nodes.set("n", {
                clickBindings: [{ button: "left", modifier: null }],
                dragBindings: [],
            });
            const g = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [0, 0],
                hit: { nodeName: "n", instanceIndex: 3,
                       targetObj: null, pointWorld: null,
                       ray: null, distance: 0 },
                registrations: { nodes, scenePointerFilters: new Map() },
            });
            return [g.kind, g.cameraMayAlsoHandle, g.instanceIndex];
        }
        """,
    )
    assert out == ["node-click-candidate", True, 3]


def test_classifier_legacy_clickable_null_treats_any_input_as_click(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """``clickBindings: null`` is the legacy sentinel for nodes whose
    server hasn't been upgraded to the click-bindings protocol. Any
    pointerdown on such a node lands in node-click-candidate.

    Once SetSceneNodeClickBindingsMessage is shipped (step 6) every
    clickable node will carry exact bindings; this branch will narrow."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const nodes = new Map();
            nodes.set("n", { clickBindings: null, dragBindings: [] });
            return im.classifyPointerDown({
                input: { button: "right", modifier: "shift" },
                pointerId: 1,
                startXy: [0, 0],
                hit: { nodeName: "n", instanceIndex: null,
                       targetObj: null, pointWorld: null,
                       ray: null, distance: 0 },
                registrations: { nodes, scenePointerFilters: new Map() },
            }).kind;
        }
        """,
    )
    assert out == "node-click-candidate"


def test_classifier_scene_pointer_click_only_is_candidate(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Rule 3: scene click filter only -> scene-pointer-candidate with
    cameraMayAlsoHandle=true. Press+drag becomes orbit, stationary
    press fires click on release."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const filters = new Map();
            filters.set("click", [{ button: "left", modifier: null }]);
            const g = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [5, 7],
                hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: filters },
            });
            return [g.kind, g.cameraMayAlsoHandle, [...g.eligible]];
        }
        """,
    )
    assert out == ["scene-pointer-candidate", True, ["click"]]


def test_classifier_scene_rect_select_commits(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Rule 3: any rect-select match commits to scene-rect-select
    (committed gesture; camera disabled immediately)."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const filters = new Map();
            filters.set("rect-select", [{ button: "left", modifier: "shift" }]);
            return im.classifyPointerDown({
                input: { button: "left", modifier: "shift" },
                pointerId: 1,
                startXy: [0, 0],
                hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: filters },
            }).kind;
        }
        """,
    )
    assert out == "scene-rect-select"


def test_classifier_rect_and_click_match_rect_wins_eligible_carries_click(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """When both click and rect-select match the same input,
    scene-rect-select wins for motion, but the eligible set keeps
    ``"click"`` so a stationary release still fires the click."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const filters = new Map();
            filters.set("click", [{ button: "left", modifier: null }]);
            filters.set("rect-select", [{ button: "left", modifier: null }]);
            const g = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [0, 0],
                hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: filters },
            });
            return [g.kind, [...g.eligible].sort()];
        }
        """,
    )
    assert out == ["scene-rect-select", ["click", "rect-select"]]


def test_classifier_modifier_filter_must_match(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A modifier mismatch falls through to camera, even if a filter
    is registered for a different modifier."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const filters = new Map();
            filters.set("click", [{ button: "left", modifier: "shift" }]);
            return im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1,
                startXy: [0, 0],
                hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: filters },
            }).kind;
        }
        """,
    )
    assert out == "camera"


def test_classifier_freezes_modifier_at_pointerdown(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The classifier is pure: it captures whatever is passed in,
    which the InputManager will feed from a single ``keyModifierFromEvent``
    call at pointerdown. Mid-gesture key changes never re-enter
    classification, so the stored ``input.modifier`` is the contract."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const g = im.classifyPointerDown({
                input: { button: "left", modifier: "cmd/ctrl+shift" },
                pointerId: 1,
                startXy: [0, 0],
                hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: new Map() },
            });
            return g.input.modifier;
        }
        """,
    )
    assert out == "cmd/ctrl+shift"


# ---------------------------------------------------------------------------
# applyPointerMove
# ---------------------------------------------------------------------------


def test_apply_pointer_move_marks_candidate_moved(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """``scene-pointer-candidate.moved`` becomes true once the caller
    reports motion past threshold."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const filters = new Map();
            filters.set("click", [{ button: "left", modifier: null }]);
            let g = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1, startXy: [0, 0], hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: filters },
            });
            g = im.applyPointerMove(g, [10, 0], false);
            const beforeMoved = g.moved;
            g = im.applyPointerMove(g, [10, 0], true);
            return [beforeMoved, g.moved, g.endXy];
        }
        """,
    )
    assert out == [False, True, [10, 0]]


def test_apply_pointer_move_passthrough_for_idle_and_camera(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """``idle``, ``camera``, and ``node-drag`` ignore pointermove --
    InputManager state is unchanged for those kinds (camera-controls
    owns motion in the first two cases; DragLayer in the third)."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const idle = im.applyPointerMove({ kind: "idle" }, [10, 10], true);
            const cam = im.applyPointerMove(
                { kind: "camera", pointerId: 1,
                  input: { button: "left", modifier: null }, startXy: [0, 0] },
                [50, 50], true,
            );
            return [idle.kind, cam.kind];
        }
        """,
    )
    assert out == ["idle", "camera"]


# ---------------------------------------------------------------------------
# finalizePointerUp
# ---------------------------------------------------------------------------


def test_finalize_stationary_scene_pointer_dispatches_scene_click(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Stationary release on a click-only candidate -> dispatch
    scene-click. Drag motion -> dispatch none."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const filters = new Map();
            filters.set("click", [{ button: "left", modifier: null }]);
            const g0 = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1, startXy: [0, 0], hit: null,
                registrations: { nodes: new Map(), scenePointerFilters: filters },
            });
            const stationary = im.finalizePointerUp(g0).dispatch.kind;
            const moved = im.finalizePointerUp(
                im.applyPointerMove(g0, [50, 50], true),
            ).dispatch.kind;
            return [stationary, moved];
        }
        """,
    )
    assert out == ["scene-click", "none"]


def test_finalize_rect_select_motion_vs_stationary(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """scene-rect-select: motion -> rect-select dispatch; stationary
    with click in eligible -> scene-click; stationary without click ->
    none."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const fAll = new Map();
            fAll.set("click", [{ button: "left", modifier: null }]);
            fAll.set("rect-select", [{ button: "left", modifier: null }]);
            const fRectOnly = new Map();
            fRectOnly.set("rect-select", [{ button: "left", modifier: null }]);

            const reg = (m) => ({ nodes: new Map(), scenePointerFilters: m });

            const gAllMoved = im.applyPointerMove(
                im.classifyPointerDown({
                    input: { button: "left", modifier: null },
                    pointerId: 1, startXy: [0, 0], hit: null,
                    registrations: reg(fAll),
                }),
                [50, 50], true,
            );
            const gAllStill = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1, startXy: [0, 0], hit: null,
                registrations: reg(fAll),
            });
            const gRectStill = im.classifyPointerDown({
                input: { button: "left", modifier: null },
                pointerId: 1, startXy: [0, 0], hit: null,
                registrations: reg(fRectOnly),
            });
            return [
                im.finalizePointerUp(gAllMoved).dispatch.kind,
                im.finalizePointerUp(gAllStill).dispatch.kind,
                im.finalizePointerUp(gRectStill).dispatch.kind,
            ];
        }
        """,
    )
    assert out == ["scene-rect-select", "scene-click", "none"]


def test_finalize_node_click_candidate(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """node-click-candidate stationary -> node-click; moved -> none
    (camera owns motion, no click on release)."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const nodes = new Map();
            nodes.set("n", { clickBindings: null, dragBindings: [] });
            const reg = { nodes, scenePointerFilters: new Map() };
            const args = {
                input: { button: "left", modifier: null },
                pointerId: 1, startXy: [0, 0],
                hit: { nodeName: "n", instanceIndex: null,
                       targetObj: null, pointWorld: null, ray: null, distance: 0 },
                registrations: reg,
            };
            const stationary = im.finalizePointerUp(im.classifyPointerDown(args)).dispatch.kind;
            const moved = im.finalizePointerUp(
                im.applyPointerMove(im.classifyPointerDown(args), [99, 99], true),
            ).dispatch.kind;
            return [stationary, moved];
        }
        """,
    )
    assert out == ["node-click", "none"]


def test_cancel_returns_idle(viser_server: viser.ViserServer, viser_page: Page) -> None:
    """cancelGesture is the terminal idle state. It takes no argument
    and unconditionally returns ``{kind: "idle"}`` -- the InputManager's
    cancellation policy is gesture-agnostic at this layer (per-gesture
    finalisation, like ``DragLayer``'s ``drag_end`` dispatch on
    pointercancel, lives in the call site)."""
    del viser_server
    out = viser_page.evaluate(
        "() => window.__viserInputManager__.cancelGesture().kind",
    )
    assert out == "idle"


# ---------------------------------------------------------------------------
# Reducers.
# ---------------------------------------------------------------------------


def test_derive_camera_control_enabled_table(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Coverage of every gesture kind through deriveCameraControlEnabled."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const inp = { button: "left", modifier: null };
            return {
                idle: im.deriveCameraControlEnabled({ kind: "idle" }),
                camera: im.deriveCameraControlEnabled({
                    kind: "camera", pointerId: 1, input: inp, startXy: [0, 0],
                }),
                spcMay: im.deriveCameraControlEnabled({
                    kind: "scene-pointer-candidate", pointerId: 1, input: inp,
                    eligible: new Set(["click"]), startXy: [0, 0], endXy: [0, 0],
                    moved: false, cameraMayAlsoHandle: true,
                }),
                spcNoMay: im.deriveCameraControlEnabled({
                    kind: "scene-pointer-candidate", pointerId: 1, input: inp,
                    eligible: new Set(["click"]), startXy: [0, 0], endXy: [0, 0],
                    moved: false, cameraMayAlsoHandle: false,
                }),
                ncc: im.deriveCameraControlEnabled({
                    kind: "node-click-candidate", pointerId: 1, input: inp,
                    nodeName: "n", instanceIndex: null,
                    startXy: [0, 0], moved: false, cameraMayAlsoHandle: true,
                }),
                rect: im.deriveCameraControlEnabled({
                    kind: "scene-rect-select", pointerId: 1, input: inp,
                    eligible: new Set(["rect-select"]),
                    startXy: [0, 0], endXy: [0, 0],
                }),
                drag: im.deriveCameraControlEnabled({
                    kind: "node-drag", pointerId: 1, input: inp,
                    nodeName: "n", instanceIndex: null,
                    startXy: [0, 0], dragState: null, cameraControlAtStart: null,
                }),
            };
        }
        """,
    )
    assert out == {
        "idle": True,
        "camera": True,
        "spcMay": True,
        "spcNoMay": False,
        "ncc": True,
        "rect": False,
        "drag": False,
    }


def test_derive_cursor_table(viser_server: viser.ViserServer, viser_page: Page) -> None:
    """Cursor reducer cells:

    - empty registrations + no hover + no held modifier  -> auto
    - hover a clickable node                              -> pointer
    - rect-select filter alone                            -> auto
      (rect-select is a drag affordance, not a click affordance --
      it does not change the cursor)
    - unmodified click filter + no modifier held          -> pointer
    - unmodified click filter + shift held                -> auto
      (modifier mismatch: filter expects null, held is shift)
    - shift click filter + shift held                     -> pointer
    - shift click filter + no modifier held               -> auto
    - rect-select gesture, motion crossed                 -> crosshair
    - rect-select gesture, no motion yet                  -> auto
      (no click filter is registered, and rect-select alone does
      not drive cursor)
    """
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            const idle = { kind: "idle" };
            const inp = { button: "left", modifier: null };
            const rectStill = {
                kind: "scene-rect-select", pointerId: 1, input: inp,
                eligible: new Set(["rect-select"]),
                startXy: [10, 10], endXy: [10, 10],
            };
            const rectMoved = { ...rectStill, endXy: [50, 50] };
            const empty = { nodes: new Map(), scenePointerFilters: new Map() };
            const rectFilter = (() => {
                const m = new Map();
                m.set("rect-select", [{ button: "left", modifier: null }]);
                return { nodes: new Map(), scenePointerFilters: m };
            })();
            const unmodClickFilter = (() => {
                const m = new Map();
                m.set("click", [{ button: "left", modifier: null }]);
                return { nodes: new Map(), scenePointerFilters: m };
            })();
            const shiftClickFilter = (() => {
                const m = new Map();
                m.set("click", [{ button: "left", modifier: "shift" }]);
                return { nodes: new Map(), scenePointerFilters: m };
            })();
            const noHover = { clickableNode: null };
            const hovered = { clickableNode: { nodeName: "n", instanceIndex: null } };
            return {
                emptyAuto: im.deriveCursor(idle, noHover, empty, null),
                hoverPointer: im.deriveCursor(idle, hovered, empty, null),
                rectFilterAlone: im.deriveCursor(idle, noHover, rectFilter, null),
                unmodClickNoHeld: im.deriveCursor(idle, noHover, unmodClickFilter, null),
                unmodClickWithShift: im.deriveCursor(idle, noHover, unmodClickFilter, "shift"),
                shiftClickWithShift: im.deriveCursor(idle, noHover, shiftClickFilter, "shift"),
                shiftClickNoHeld: im.deriveCursor(idle, noHover, shiftClickFilter, null),
                rectStill: im.deriveCursor(rectStill, noHover, rectFilter, null),
                rectMovedCrosshair: im.deriveCursor(rectMoved, noHover, rectFilter, null),
            };
        }
        """,
    )
    assert out == {
        "emptyAuto": "auto",
        "hoverPointer": "pointer",
        "rectFilterAlone": "auto",
        "unmodClickNoHeld": "pointer",
        "unmodClickWithShift": "auto",
        "shiftClickWithShift": "pointer",
        "shiftClickNoHeld": "auto",
        "rectStill": "auto",
        "rectMovedCrosshair": "crosshair",
    }


def test_should_suppress_context_menu(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """shouldSuppressContextMenu reads policy.suppress; null -> preserve."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const im = window.__viserInputManager__;
            return {
                none: im.shouldSuppressContextMenu(null),
                yes: im.shouldSuppressContextMenu({
                    pointerId: 1,
                    input: { button: "left", modifier: "cmd/ctrl" },
                    target: null, suppress: true,
                }),
                no: im.shouldSuppressContextMenu({
                    pointerId: 1,
                    input: { button: "right", modifier: null },
                    target: null, suppress: false,
                }),
            };
        }
        """,
    )
    assert out == {"none": False, "yes": True, "no": False}
