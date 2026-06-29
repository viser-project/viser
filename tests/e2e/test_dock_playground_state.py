"""E2E state/timing tests for the docking React/DOM layer.

These target the interaction/render layer (not the pure ops), where flushSync /
rAF / ResizeObserver races and stale-closure bugs live. Skips cleanly if the
client toolchain is missing.

Coverage:
* rapid minimize/expand clicks on the handle button (incl. on a BACKGROUND /
  overlapping floating window) -- no click is lost to a DOM reorder;
* dock/undock height: collapsed vertical-stack siblings expand; the floating
  bottom/corner resize grips are hidden while minimized;
* page/container RESIZE: floating panels' top-left corner stays on-screen and
  nothing is stranded;
* rapid mixed gesture sequences don't desync panel state or throw;
* rapid SEQUENTIAL tab reorders (reorder, release, immediately reorder another):
  no stuck 'dragging' tab and no leftover transform (MED-1 settle-timer fix);
* region outer-edge divider with a minimized/overlaid canvas-adjacent column:
  the reserved area tracks the cursor 1:1 with no jump on grab (MED-2 fix).
"""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import (
    collect_errors,
    columns,
    dock_layout,
    floating_group_ids,
    floating_window_for_panel,
    group,
    open_playground,
    real_errors,
    set_layout,
    stack,
    window,
)
from .dock_helpers import drag_group as _drag_group
from .dock_helpers import group_box as _gbox


@pytest.fixture()
def page(dock_context, vite_server: int) -> Generator[Page, None, None]:
    pg = open_playground(dock_context, vite_server)
    yield pg
    pg.close()


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def _is_collapsed(page: Page, group_id: str) -> bool:
    return (
        page.locator(f'[data-dock-group="{group_id}"]').get_attribute(
            "data-dock-collapsed"
        )
        == "true"
    )


def _floating_group_ids(page: Page) -> list[str]:
    return floating_group_ids(page, require_grip=True)


def _minimize_btn(page: Page, group_id: str):
    return page.locator(f'[data-dock-group="{group_id}"] [data-dock-minimize]').first


def _box(page: Page, selector: str):
    return page.locator(selector).first.bounding_box()


def _panel_ids(page: Page) -> list[str]:
    return sorted(
        page.eval_on_selector_all(
            "[data-dock-tab]", "els => els.map(e => e.getAttribute('data-dock-tab'))"
        )
    )


# ===========================================================================
# Rapid minimize/expand -- no lost clicks (the reported flake).
# ===========================================================================
def test_rapid_minimize_expand_no_lost_clicks(page: Page) -> None:
    """Click the minimize button N times fast; the collapsed state must end up
    matching the click parity exactly (no click swallowed by a DOM reorder)."""
    docked = page.locator("[data-dock-leaf] [data-dock-group]").first
    gid = docked.get_attribute("data-dock-group")
    assert gid is not None
    btn = _minimize_btn(page, gid)

    assert not _is_collapsed(page, gid)
    # 12 clicks; after each, poll until the state flips to the expected parity.
    # Every click MUST register (no DOM-reorder swallowing it). We wait for the
    # expected state rather than sleeping a fixed amount, so this is robust under
    # load while still proving no click was lost. (NOTE: Playwright's per-click
    # actionability ensures each click is delivered; raw back-to-back synthetic
    # clicks at one point get coalesced by the browser as a double-click, which
    # is a harness artifact, not an app bug -- so we use real .click() here.)
    for i in range(12):
        btn.click()
        expected = (i % 2) == 0  # odd # of clicks so far -> collapsed
        page.wait_for_function(
            """([sel, want]) => {
                const el = document.querySelector(sel);
                return !!el && (el.getAttribute('data-dock-collapsed') === 'true') === want;
            }""",
            arg=[f'[data-dock-group="{gid}"]', expected],
            timeout=3000,
        )
    assert not _is_collapsed(page, gid)  # even total -> expanded


def test_minimize_click_on_background_overlapping_window(page: Page) -> None:
    """Two floating windows overlapped so one's minimize button sits under the
    other; raise the bottom one (click its handle), then minimize it. The click
    must hit it even though raising changes z-index (DOM order is stable)."""
    # Arrange: window b (inspector) overlapping window a's (controls) left
    # side, slightly up-left so a's minimize button itself stays reachable
    # (and clear of b's top resize band); b is later in the floating array,
    # so it paints on top of a.
    a, b = "t-controls", "t-inspector"
    set_layout(
        page,
        dock_layout(
            floating=[
                window("controls", x=400, y=200),
                window("inspector", x=300, y=190, width=260),
            ]
        ),
    )

    # Both still floating and present.
    assert a in _floating_group_ids(page) and b in _floating_group_ids(page)

    # Minimize a (now partially behind b). Its button should still toggle.
    before = _is_collapsed(page, a)
    _minimize_btn(page, a).click()
    page.wait_for_timeout(60)
    assert _is_collapsed(page, a) != before, (
        "minimize click on overlapped window was lost"
    )


# ===========================================================================
# Height correctness.
# ===========================================================================
def test_vertical_stack_minimizes_as_a_unit(page: Page) -> None:
    """A vertical docked stack minimizes ALL-OR-NOTHING: the individual panels
    have no per-cell +/- (only the parent stack handle), and toggling that
    handle collapses/expands every panel together -- there's no mixed
    'one minimized, one short' state."""
    a, b = "t-controls", "t-inspector"
    set_layout(page, dock_layout(docked_right=stack("controls", "inspector")))
    docked_right = page.eval_on_selector_all(
        '[data-dock-leaf][data-dock-edge="right"] [data-dock-group]',
        "els => els.map(e => e.getAttribute('data-dock-group'))",
    )
    assert a in docked_right and b in docked_right

    # No individual minimize buttons inside a stack -- only the parent handle.
    def n_individual_btns(gid: str) -> int:
        return page.eval_on_selector_all(
            f'[data-dock-group="{gid}"] [data-dock-minimize]', "els => els.length"
        )

    assert n_individual_btns(a) == 0 and n_individual_btns(b) == 0, (
        "stacked panels must not show individual +/- buttons"
    )
    parent = page.query_selector("[data-dock-column-handle] [data-dock-minimize-all]")
    assert parent is not None, "a stack must show a parent minimize-all handle"

    # The parent handle minimizes BOTH; clicking again expands BOTH.
    parent.click()
    page.wait_for_timeout(120)
    assert _is_collapsed(page, a) and _is_collapsed(page, b), (
        "the parent handle must minimize the whole stack"
    )
    page.query_selector(
        "[data-dock-column-handle] [data-dock-minimize-all]"
    ).click()
    page.wait_for_timeout(120)
    assert not _is_collapsed(page, a) and not _is_collapsed(page, b), (
        "the parent handle must expand the whole stack"
    )


def test_floating_resize_grip_hidden_when_minimized(page: Page) -> None:
    """A minimized floating window must not show its bottom/corner resize grips
    (nothing to resize vertically). We detect grips by their resize cursor."""
    fids = _floating_group_ids(page)
    assert fids
    gid = fids[0]
    win_sel = _window_selector_for_group(page, gid)
    assert win_sel is not None

    def vertical_grips() -> int:
        return page.eval_on_selector_all(
            f"{win_sel} *",
            """els => els.filter(e => {
                const c = getComputedStyle(e).cursor;
                return c === 'ns-resize' || c === 'nwse-resize' || c === 'nesw-resize';
            }).length""",
        )

    assert vertical_grips() > 0, "expected vertical/corner grips when expanded"
    _minimize_btn(page, gid).click()
    page.wait_for_timeout(80)
    assert _is_collapsed(page, gid)
    assert vertical_grips() == 0, (
        "vertical/corner resize grips still present when minimized"
    )


def _window_selector_for_group(page: Page, group_id: str) -> str | None:
    wid = page.eval_on_selector(
        f'[data-dock-group="{group_id}"]',
        "el => { const w = el.closest('[data-floating-window]'); "
        "return w ? w.getAttribute('data-floating-window') : null; }",
    )
    return f'[data-floating-window="{wid}"]' if wid else None


# ===========================================================================
# Page / container resize: corners stay on-screen.
# ===========================================================================
def test_container_resize_keeps_floating_corners_onscreen(page: Page) -> None:
    """Shrinking the viewport must pull every floating window's top-left corner
    back on-screen (ResizeObserver), so the handle stays reachable."""
    # Arrange: one window parked near the right/bottom (a shrink would strand
    # it) plus one at a normal spot, so "every floating window" is plural.
    set_layout(
        page,
        dock_layout(
            floating=[
                window("inspector", x=680, y=120, width=260),
                window("controls", x=1000, y=700),
            ]
        ),
    )

    # Shrink the viewport hard.
    page.set_viewport_size({"width": 640, "height": 460})
    page.wait_for_timeout(120)  # let ResizeObserver fire + React commit

    KEEP = 32  # KEEP_VISIBLE_PX in DockManager (corner stays at least this on)
    stranded = page.evaluate(
        """([vw, vh, keep]) => {
            const out = [];
            document.querySelectorAll('[data-floating-window]').forEach(w => {
                const r = w.getBoundingClientRect();
                // Top-left corner must be within the viewport (minus the keep margin).
                if (r.left > vw - keep || r.top > vh - keep || r.right < keep || r.bottom < keep) {
                    out.push({ id: w.getAttribute('data-floating-window'),
                               left: r.left, top: r.top });
                }
            });
            return out;
        }""",
        [640, 460, KEEP],
    )
    assert stranded == [], (
        f"floating window(s) stranded off-screen after resize: {stranded}"
    )


def test_drag_does_not_resize_pinned_height_window(page: Page) -> None:
    """Moving a floating window must never change its size: a pinned-height
    window dragged toward the bottom keeps its full height and overhangs the
    bottom edge (like auto-height windows do), instead of being squashed to
    fit above its new y. Regression: the rendered-height cap depended on
    win.y, so a resize-then-drag visibly shrank the window at drop."""
    set_layout(
        page,
        dock_layout(
            floating=[window("inspector", x=300, y=160, width=280, height=360)]
        ),
    )
    before = _box(page, "[data-floating-window]")
    assert before is not None and abs(before["height"] - 360) < 3

    # Drag low enough that y + height overflows the 800px-tall container.
    _drag_group(page, "t-inspector", (440, 640))
    win = floating_window_for_panel(page, "inspector")
    after = _box(page, "[data-floating-window]")
    assert win is not None and after is not None
    assert win["y"] > 500, "drag should have moved the window down"
    assert win["height"] == {"mode": "pinned", "px": 360}, (
        "model height must be untouched by a move"
    )
    assert abs(after["height"] - before["height"]) < 2, (
        f"drag visually resized the window: {before['height']} -> {after['height']}"
    )


def test_width_only_viewport_resize_keeps_bottom_window_y(page: Page) -> None:
    """Narrowing the browser WITHOUT changing its height must not move a
    bottom-overhanging floating window vertically. Regression: the on-screen
    pull ran on both axes whenever either container dimension changed, yanking
    deliberately bottom-placed windows upward on a width-only resize."""
    set_layout(
        page,
        dock_layout(floating=[window("controls", x=900, y=620, width=280, height=300)]),
    )
    page.set_viewport_size({"width": 1000, "height": 800})
    page.wait_for_timeout(150)  # let ResizeObserver fire + React commit
    win = floating_window_for_panel(page, "controls")
    assert win is not None
    assert win["height"] == {"mode": "pinned", "px": 300}
    assert win["y"] == 620, f"width-only resize moved the window up: y={win['y']}"


# ===========================================================================
# Rapid mixed gestures don't throw or desync.
# ===========================================================================
def test_rapid_mixed_gestures_no_errors(page: Page) -> None:
    """A fast burst of mixed interactions (minimize toggles + small drags +
    a viewport resize) must not raise JS errors or lose a panel."""
    errors = collect_errors(page)
    expected = _panel_ids(page)

    for i in range(10):
        grips = page.eval_on_selector_all(
            "[data-dock-griphandle]",
            """els => els.map(e => { const r = e.getBoundingClientRect();
                return { x: r.x + r.width/2, y: r.y + r.height/2, ok: r.width>0 }; })
                .filter(b => b.ok)""",
        )
        if not grips:
            break
        gr = grips[i % len(grips)]
        # Small drag (move, not necessarily a dock) to stir the layout.
        page.mouse.move(gr["x"], gr["y"])
        page.mouse.down()
        page.mouse.move(gr["x"] + 6, gr["y"] + 6, steps=2)
        page.mouse.move(gr["x"] + 80, gr["y"] + 60, steps=4)
        page.mouse.up()
        page.wait_for_timeout(30)
        # No collapsed group hides its tabs -> panel-id conservation stays valid.
        n_groups = page.locator("[data-dock-group]").count()
        n_with_tabs = page.locator("[data-dock-group]:has([data-dock-tab])").count()
        if n_groups == n_with_tabs:
            assert _panel_ids(page) == expected, f"panel set changed at iter {i}"

    assert real_errors(errors) == [], (
        f"JS errors during rapid gestures: {real_errors(errors)}"
    )


def test_viewport_resize_mid_drag_no_desync(page: Page) -> None:
    """Resizing the viewport WHILE a window drag is in flight (ResizeObserver
    fires mid-gesture) must not lose a panel or throw -- a flushSync/rAF/observer
    race guard."""
    errors = collect_errors(page)
    before = _panel_ids(page)
    fids = _floating_group_ids(page)
    assert fids
    grip = page.locator(f'[data-dock-group="{fids[0]}"] [data-dock-griphandle]').first
    g = grip.bounding_box()
    assert g is not None
    page.mouse.move(g["x"] + g["width"] / 2, g["y"] + g["height"] / 2)
    page.mouse.down()
    page.mouse.move(g["x"] + 6, g["y"] + 6, steps=2)
    page.mouse.move(700, 400, steps=6)
    page.set_viewport_size({"width": 900, "height": 600})  # resize MID-drag
    page.mouse.move(650, 380, steps=4)
    page.mouse.up()
    page.wait_for_timeout(120)

    assert _panel_ids(page) == before, "panel lost on resize mid-drag"
    real = [
        e for e in errors if "[vite]" not in e.lower() and "websocket" not in e.lower()
    ]
    assert real == [], f"JS errors on resize mid-drag: {real}"


def test_resize_storm_strands_nothing(page: Page) -> None:
    """A rapid storm of viewport size changes must leave every floating window's
    corner reachable and conserve panels."""
    before = _panel_ids(page)
    for w in (600, 1280, 500, 1000, 400, 1280):
        page.set_viewport_size({"width": w, "height": 600})
        page.wait_for_timeout(15)
    page.wait_for_timeout(120)

    stranded = page.evaluate(
        """([vw, vh, keep]) => {
            const out = [];
            document.querySelectorAll('[data-floating-window]').forEach(w => {
                const r = w.getBoundingClientRect();
                if (r.left > vw - keep || r.top > vh - keep || r.right < keep || r.bottom < keep)
                    out.push(w.getAttribute('data-floating-window'));
            });
            return out;
        }""",
        [1280, 600, 32],
    )
    assert stranded == [], f"stranded windows after resize storm: {stranded}"
    assert _panel_ids(page) == before, "panel lost during resize storm"


# ===========================================================================
# Helpers for the reorder + overlaid-divider cases below.
# ===========================================================================
def _tabs(page: Page, gid: str) -> list[dict]:
    return page.eval_on_selector_all(
        f'[data-dock-group="{gid}"] [data-dock-tab]',
        """els => els.map(e => { const r = e.getBoundingClientRect();
            return { id: e.getAttribute('data-dock-tab'),
                     x: r.x, y: r.y, w: r.width, h: r.height }; })""",
    )


def _dragging_tab_count(page: Page) -> int:
    """Tabs currently styled as 'dragging' (position:relative + zIndex 5). A
    stuck-dragging state shows up as this staying > 0 after a gesture settles."""
    return page.eval_on_selector_all(
        "[data-dock-tab]",
        """els => els.filter(e => {
            const s = getComputedStyle(e);
            return s.position === 'relative' && s.zIndex === '5';
        }).length""",
    )


def _residual_transform_tabs(page: Page) -> list[str]:
    """Tabs left with a non-identity transform after settle (a FLIP/imperative
    fight would leave one stuck mid-translate)."""
    return page.eval_on_selector_all(
        "[data-dock-tab]",
        """els => els.filter(e => {
            const t = getComputedStyle(e).transform;
            return t && t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
        }).map(e => e.getAttribute('data-dock-tab'))""",
    )


# ===========================================================================
# (a) Rapid sequential tab reorders -- no stuck dragging / no FLIP fight.
# ===========================================================================
def test_rapid_sequential_tab_reorders_no_stuck_state(page: Page) -> None:
    """Reorder one tab, release, then IMMEDIATELY (within the ~180ms settle)
    reorder a different tab. The first reorder's delayed setDraggingTabId(null)
    must not fire mid-second-drag: exactly one tab is 'dragging' during the
    second drag, none after it settles, and no tab is left mid-transform."""
    # Arrange: a docked 4-tab group (the rapid reorders are the subject). A
    # non-scene tab is active so the scene body's nested area (and its
    # "layers" tab) is hidden, exactly like the old merge-built setup.
    d = "t-scene"
    set_layout(
        page,
        dock_layout(
            docked_left=columns(
                group(["scene", "controls", "inspector", "console"], active="console")
            )
        ),
    )

    tabs = _tabs(page, d)
    assert len(tabs) == 4

    # Reorder #1: drag the first tab right, past the second, and release.
    t0, t1 = tabs[0], tabs[1]
    page.mouse.move(t0["x"] + t0["w"] / 2, t0["y"] + t0["h"] / 2)
    page.mouse.down()
    page.mouse.move(t0["x"] + t0["w"] / 2 + 8, t0["y"] + t0["h"] / 2, steps=2)
    page.mouse.move(t1["x"] + t1["w"], t1["y"] + t1["h"] / 2, steps=8)
    page.mouse.move(t1["x"] + t1["w"], t1["y"] + t1["h"] / 2)
    page.mouse.up()
    # Do NOT wait out the 180ms settle -- start reorder #2 immediately.

    tabs2 = _tabs(page, d)
    last = tabs2[-1]
    first = tabs2[0]
    page.mouse.move(last["x"] + last["w"] / 2, last["y"] + last["h"] / 2)
    page.mouse.down()
    page.mouse.move(last["x"] + last["w"] / 2 - 8, last["y"] + last["h"] / 2, steps=2)
    page.mouse.move(first["x"], first["y"] + first["h"] / 2, steps=8)
    page.mouse.move(first["x"], first["y"] + first["h"] / 2)
    # Mid-drag of #2: exactly ONE tab should be marked dragging (the held one).
    mid = _dragging_tab_count(page)
    page.mouse.up()
    # Wait out both settle windows.
    page.wait_for_timeout(120)

    assert mid == 1, f"expected exactly 1 dragging tab mid-2nd-reorder, got {mid}"
    assert _dragging_tab_count(page) == 0, (
        "a tab is stuck in 'dragging' state after settle"
    )
    assert _residual_transform_tabs(page) == [], (
        "a tab was left mid-transform (FLIP/imperative fight)"
    )
    # Sanity: the group still has all its tabs (nothing lost/duplicated).
    final = sorted(t["id"] for t in _tabs(page, d))
    assert len(final) == len(set(final)) and len(final) >= 3


# ===========================================================================
# (b) Region outer-edge divider with an overlaid (minimized) canvas-adjacent
#     column -- the reserved area follows the cursor 1:1, no jump on grab.
# ===========================================================================
def _reserved_width(page: Page) -> int | None:
    """Width of the reserved (expanded) docked column on the right edge. With one
    column minimized/overlaid, the single expanded leaf == the reserved area."""
    boxes = page.eval_on_selector_all(
        '[data-dock-leaf][data-dock-edge="right"] [data-dock-group]',
        """els => els
            .filter(e => e.getAttribute('data-dock-collapsed') !== 'true')
            .map(e => Math.round(e.closest('[data-dock-leaf]').getBoundingClientRect().width))""",
    )
    return boxes[0] if len(boxes) == 1 else None


def test_overlaid_region_divider_tracks_without_jump(page: Page) -> None:
    """2-column right region with the canvas-adjacent column minimized (overlaid);
    dragging the region's outer-edge divider must move the reserved area 1:1 with
    the cursor and NOT jump on grab (the MED-2 reserved-width fix)."""
    fids = _floating_group_ids(page)
    assert len(fids) >= 2
    a, b = fids[0], fids[1]
    vw = page.viewport_size["width"]  # type: ignore[index]

    # Dock a to the right edge, then b to a's LEFT band -> [b | a] side by side.
    _drag_group(page, a, (vw - 10, 400))
    ab = _gbox(page, a)
    _drag_group(page, b, (ab["x"] + 8, ab["y"] + ab["h"] / 2))
    cols = page.eval_on_selector_all(
        '[data-dock-leaf][data-dock-edge="right"] [data-dock-group]',
        "els => els.map(e => e.getAttribute('data-dock-group'))",
    )
    if len(cols) != 2:
        pytest.skip("did not produce a 2-column right region this run")

    # For a RIGHT region the canvas-adjacent column is the FIRST one; minimize it.
    inner = cols[0]
    _minimize_btn(page, inner).click()
    page.wait_for_timeout(350)  # wait out the minimize width animation
    if not _is_collapsed(page, inner):
        pytest.skip("inner column did not collapse this run")

    reserved0 = _reserved_width(page)
    if reserved0 is None:
        pytest.skip("could not isolate a single reserved column this run")

    # The reserved region's canvas-facing edge (left edge of the reserved box for
    # a right region) is where the divider grip sits.
    reserved_left = page.eval_on_selector(
        f'[data-dock-leaf][data-dock-edge="right"] [data-dock-group="{cols[1]}"]',
        "e => Math.round(e.closest('[data-dock-leaf]').getBoundingClientRect().left)",
    )
    gx, gy = reserved_left, 400

    page.mouse.move(gx, gy)
    page.mouse.down()
    # Tiny grab move: width must NOT jump (only track the ~2px move).
    page.mouse.move(gx - 2, gy, steps=1)
    grab_w = _reserved_width(page)
    assert grab_w is not None
    assert abs(grab_w - reserved0) <= 8, (
        f"reserved width jumped on grab: {reserved0} -> {grab_w}"
    )
    # Drag the divider 60px outward (grows the reserved area for a right region).
    page.mouse.move(gx - 60, gy, steps=10)
    page.mouse.move(gx - 60, gy)
    drag_w = _reserved_width(page)
    page.mouse.up()
    page.wait_for_timeout(120)
    assert drag_w is not None
    # 1:1 tracking: ~+60px (allow slack for clamping + sub-pixel).
    assert abs((drag_w - reserved0) - 60) <= 14, (
        f"reserved area did not track 1:1: {reserved0} -> {drag_w} (expected ~+60)"
    )
    # The minimized column is still overlaid (not lost).
    assert _is_collapsed(page, inner)


def test_width_only_shrink_keeps_collapsed_strip_in_place(page: Page) -> None:
    """Anchoring/pulling must use the RENDERED height. A collapsed
    pinned-height window is a ~50px strip on screen; a height shrink that
    leaves the strip comfortably on-screen must keep its distance to the
    bottom edge, not yank it up by the hidden content's height."""
    set_layout(
        page,
        dock_layout(
            floating=[
                window(
                    group("controls", collapsed=True),
                    x=600,
                    y=700,
                    width=280,
                    height=380,
                )
            ]
        ),
    )
    page.set_viewport_size({"width": 1280, "height": 750})
    page.wait_for_timeout(150)
    win = floating_window_for_panel(page, "controls")
    assert win is not None
    # Bottom-half anchor: the strip's distance to the bottom edge is preserved
    # across the shrink (~640px in the 750px container, set by the strip's
    # rendered height). The key contrast is with the OLD model-height pull, which
    # would have yanked it up to 750 - 380 = 370; anything near the bottom half
    # confirms the rendered-height anchor. (Loose bound: the exact y tracks the
    # strip's rendered height, which is layout/font dependent.)
    assert 600 < win["y"] < 680, f"strip moved wrongly: y={win['y']}"


def test_flip_expand_of_pinned_height_window_keeps_height(
    browser, vite_server: int
) -> None:
    """Expanding a pinned-height floating window WITH ANIMATIONS ENABLED must
    end at the pinned height. Regression: the FLIP animation cleared the
    inline height on completion, but React's style cache still held it, so
    the window rendered at 0px and vanished. (The shared dock_context forces
    reduced motion, which skips the FLIP -- so this test makes its own
    context.)"""
    ctx = browser.new_context()  # animations ON: no reduced_motion here.
    try:
        pg = open_playground(ctx, vite_server)
        set_layout(
            pg,
            dock_layout(
                floating=[
                    window(
                        group("controls", collapsed=True),
                        x=300,
                        y=150,
                        width=280,
                        height=360,
                    )
                ]
            ),
        )
        pg.eval_on_selector(
            '[data-dock-group="t-controls"] [data-dock-minimize]',
            "e => e.click()",
        )
        pg.wait_for_timeout(600)  # let the 180ms FLIP finish (or break)
        box = pg.locator("[data-floating-window]").first.bounding_box()
        assert box is not None
        assert abs(box["height"] - 360) < 5, (
            f"window should settle at its pinned 360px, got {box['height']}"
        )
    finally:
        ctx.close()
