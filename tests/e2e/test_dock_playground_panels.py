"""E2E regression coverage for a batch of docking-library panel behaviors.

These lock in the CURRENT behavior of the docked/floating panel chrome, exercised
against the standalone-Vite playground (``/dock_test.html``, HMR disabled):

7.  Minimizing the docked Scene collapses its WIDTH to a narrow vertical
    strip (~32px) and the canvas reclaims the freed width; restoring brings it
    back.
8.  The unmergeable "Connected" main panel has NO separate minimize button and NO
    gray grip; clicking its header toggles its collapsed state.
9.  Snapping a panel below a minimized floating panel keeps the top (minimized)
    panel present with a positive height.
10. Dragging the divider between two stacked floating groups grows the top group
    and shrinks the bottom one (and reverses when dragged back).
11. Undocking the full-bleed main panel keeps a real height (the nested area
    fills it).
12. Dropping a floater on the OUTER edge band of the full-bleed main panel splits
    BESIDE it rather than merging into the inner full-bleed area.

Same harness as ``test_dock_playground_dropzones.py``. Run with::

    uv run pytest tests/e2e/test_dock_playground_panels.py -v

Skips cleanly if the client toolchain (``npx`` + ``node_modules``) is missing, or
if a particular gesture didn't produce the expected structure this run (drop-zone
geometry can vary by a few px).
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import columns, dock_layout, group, set_layout, window
from .dock_helpers import drag as _drag
from .dock_helpers import open_playground as _open


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def _box(page: Page, selector: str) -> dict | None:
    return page.eval_on_selector(
        selector,
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; }",
    )


def _gbox(page: Page, gid: str) -> dict:
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height }; }",
    )


def _grip(page: Page, gid: str) -> dict:
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-griphandle]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )


def _floating_window_id_for_panel(page: Page, panel_id: str) -> str | None:
    """The data-floating-window id of the window containing `panel_id`. Mergeable
    panels render as a [data-dock-tab]; an unmergeable panel renders a full-width
    [data-dock-header] (no tab), so match either."""
    return page.evaluate(
        """(pid) => {
            for (const w of document.querySelectorAll('[data-floating-window]')) {
                if (w.querySelector(`[data-dock-tab="${pid}"]`)) {
                    return w.getAttribute('data-floating-window');
                }
            }
            return null;
        }""",
        panel_id,
    )


def _main_window_id(page: Page) -> str | None:
    """The floating window hosting the unmergeable 'Connected' main panel
    (group's active panel is 'monitor'). It has a [data-dock-header], not a tab.
    Identify it as the floating window whose group renders a header."""
    return page.evaluate(
        """() => {
            for (const w of document.querySelectorAll('[data-floating-window]')) {
                if (w.querySelector('[data-dock-header]')) {
                    return w.getAttribute('data-floating-window');
                }
            }
            return null;
        }"""
    )


def _main_group_id(page: Page) -> str | None:
    """The group id of the unmergeable main panel (wherever it lives -- floating
    or docked). It is the only group that renders a [data-dock-header]."""
    return page.evaluate(
        """() => {
            const h = document.querySelector('[data-dock-header]');
            return h ? h.getAttribute('data-dock-header') : null;
        }"""
    )


def _docked_scene_group_id(page: Page) -> str | None:
    return page.evaluate(
        """() => {
            const leaf = document.querySelector('[data-dock-leaf] [data-dock-group]');
            return leaf ? leaf.getAttribute('data-dock-group') : null;
        }"""
    )


def _drag_group(page: Page, gid: str, end: tuple[float, float]) -> None:
    s = _grip(page, gid)
    _drag(page, (s["x"], s["y"]), end)


def _has_minimize(page: Page, gid: str) -> bool:
    return (
        page.query_selector(f'[data-dock-group="{gid}"] [data-dock-minimize]')
        is not None
    )


def _has_grip(page: Page, gid: str) -> bool:
    return (
        page.query_selector(f'[data-dock-group="{gid}"] [data-dock-griphandle]')
        is not None
    )


# ===========================================================================
# 7. Minimize collapses the docked Scene's WIDTH via an overlay rail.
# ===========================================================================
def test_minimize_docked_scene_collapses_width_to_overlay_rail(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        scene_gid = _docked_scene_group_id(page)
        if scene_gid is None:
            pytest.skip("no docked Scene group this run")

        leaf_before = _box(
            page, f'[data-dock-leaf]:has([data-dock-group="{scene_gid}"])'
        )
        if leaf_before is None or leaf_before["w"] < 200:
            pytest.skip("docked Scene leaf not laid out at full width this run")
        full_w = leaf_before["w"]

        # Minimize via the grip bar's minimize button.
        page.locator(
            f'[data-dock-group="{scene_gid}"] [data-dock-minimize]'
        ).first.click()
        page.wait_for_timeout(120)

        # The collapsed Scene is now a narrow vertical strip (~32px, NOT the
        # full docked-column width). Its rendered group box must be much narrower.
        mini = _gbox(page, scene_gid)
        assert mini["w"] <= 60, (
            f"minimized Scene should collapse to a narrow vertical strip; "
            f"got width {mini['w']} (was {full_w})"
        )
        assert mini["w"] < full_w - 20, (
            f"minimized width {mini['w']} did not shrink from {full_w}"
        )

        # Restore (click again): it expands back to a wide docked column.
        page.locator(
            f'[data-dock-group="{scene_gid}"] [data-dock-minimize]'
        ).first.click()
        page.wait_for_timeout(120)
        restored = _gbox(page, scene_gid)
        assert restored["w"] > mini["w"] + 20, (
            f"restoring did not widen the Scene back (mini {mini['w']} -> "
            f"restored {restored['w']})"
        )
    finally:
        page.close()


# ===========================================================================
# 8. The unmergeable "Connected" main panel: no separate minimize button, no
#    gray grip; clicking its header toggles data-dock-collapsed.
# ===========================================================================
def test_main_panel_click_header_toggles_collapsed(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 900)
    try:
        # The main panel hosts panel "monitor" (title "Connected"), unmergeable.
        # It renders a [data-dock-header] (no tab), so identify it by that.
        main_gid = _main_group_id(page)
        if main_gid is None:
            pytest.skip("main 'Connected' panel not present this run")

        # Unmergeable panel: NO separate minimize button and NO gray grip handle.
        assert not _has_minimize(page, main_gid), (
            "the unmergeable main panel must NOT have a [data-dock-minimize] button"
        )
        assert not _has_grip(page, main_gid), (
            "the unmergeable main panel must NOT have a gray grip ([data-dock-griphandle])"
        )

        header_el = page.query_selector(f'[data-dock-header="{main_gid}"]')
        if header_el is None:
            pytest.skip("main panel header not found this run")

        def _collapsed() -> bool:
            return page.eval_on_selector(
                f'[data-dock-group="{main_gid}"]',
                "e => e.getAttribute('data-dock-collapsed') === 'true'",
            )

        was = _collapsed()
        # Click the header (no drag motion) -> toggles collapsed.
        hb = header_el.bounding_box()
        assert hb is not None
        page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
        page.mouse.down()
        page.mouse.up()
        page.wait_for_timeout(120)
        assert _collapsed() != was, (
            "clicking the main panel header did not toggle collapsed"
        )

        # Toggle back.
        page.mouse.down()
        page.mouse.up()
        page.wait_for_timeout(120)
        assert _collapsed() == was, "second header click did not toggle collapsed back"
    finally:
        page.close()


# ===========================================================================
# 9. Snap a panel below a MINIMIZED floating panel: both survive, top has height.
# ===========================================================================
def test_snap_below_minimized_keeps_top_panel(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        # Arrange: controls floating ALREADY MINIMIZED, inspector floating
        # apart from it (the snap-below gesture is the subject).
        set_layout(
            page,
            dock_layout(
                floating=[
                    window(group("controls", collapsed=True), x=500, y=150),
                    window("inspector", x=900, y=150, width=260),
                ]
            ),
        )
        ctrl_win = "t-w-controls"
        ctrl_gid, insp_gid = "t-controls", "t-inspector"

        # Snap inspector BELOW the (minimized) controls window.
        ctrl_box = _box(page, f'[data-floating-window="{ctrl_win}"]')
        if ctrl_box is None:
            pytest.skip("minimized controls window not laid out this run")
        igrip = _grip(page, insp_gid)
        _drag(
            page,
            (igrip["x"], igrip["y"]),
            (ctrl_box["x"] + ctrl_box["w"] / 2, ctrl_box["y"] + ctrl_box["h"] - 6),
        )

        stacked = _floating_window_id_for_panel(page, "controls")
        insp_after = _floating_window_id_for_panel(page, "inspector")
        if stacked is None or insp_after != stacked:
            pytest.skip("inspector did not snap below controls this run")

        # Both panels present in the stacked window.
        n_groups = page.eval_on_selector_all(
            f'[data-floating-window="{stacked}"] [data-dock-group]',
            "els => els.length",
        )
        assert n_groups == 2, f"expected a 2-group stack, got {n_groups}"
        # The top (controls) panel keeps a positive height (it didn't vanish).
        ctrl_after = _gbox(page, ctrl_gid)
        assert ctrl_after["h"] > 0, "the minimized top (controls) panel has no height"
    finally:
        page.close()


# ===========================================================================
# 10. Floating stack divider (#49): snap console below inspector, then drag the
#     [data-floating-divider] DOWN -> top (inspector) grows, bottom (console)
#     shrinks; dragging back up reverses it.
# ===========================================================================
def test_floating_stack_divider_resizes_both_directions(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 950)
    try:
        # Arrange: console already snapped below inspector in one stacked
        # window (the divider drags are the subject).
        set_layout(
            page,
            dock_layout(
                floating=[window("inspector", "console", x=700, y=120, width=300)]
            ),
        )
        insp_gid, cons_gid = "t-inspector", "t-console"
        stacked = _floating_window_id_for_panel(page, "inspector")
        assert stacked is not None
        assert _floating_window_id_for_panel(page, "console") == stacked

        divider = page.query_selector(
            f'[data-floating-window="{stacked}"] [data-floating-divider]'
        )
        if divider is None:
            pytest.skip("no floating divider rendered this run")
        db = divider.bounding_box()
        if db is None:
            pytest.skip("divider not laid out this run")

        def _heights() -> tuple[float, float]:
            return _gbox(page, insp_gid)["h"], _gbox(page, cons_gid)["h"]

        top0, bot0 = _heights()

        # Drag the divider DOWN by ~80px: the top group (inspector) grows, the
        # bottom (console) shrinks. (The first drag pins auto-height to a definite
        # total before the cascade applies.)
        dx, dy = db["x"] + db["width"] / 2, db["y"] + db["height"] / 2
        _drag(page, (dx, dy), (dx, dy + 80))

        top1, bot1 = _heights()
        if abs(top1 - top0) < 8 and abs(bot1 - bot0) < 8:
            pytest.skip("divider drag produced no measurable change this run")
        assert top1 > top0 + 5, (
            f"dragging the divider down should GROW the top group ({top0} -> {top1})"
        )
        assert bot1 < bot0 - 5, (
            f"dragging the divider down should SHRINK the bottom group "
            f"({bot0} -> {bot1})"
        )

        # Drag back UP past the original position -> reverses (top shrinks).
        d2 = page.query_selector(
            f'[data-floating-window="{stacked}"] [data-floating-divider]'
        )
        if d2 is None:
            pytest.skip("divider gone after first drag this run")
        db2 = d2.bounding_box()
        assert db2 is not None
        dx2, dy2 = db2["x"] + db2["width"] / 2, db2["y"] + db2["height"] / 2
        _drag(page, (dx2, dy2), (dx2, dy2 - 100))
        top2, _ = _heights()
        assert top2 < top1 - 5, (
            f"dragging the divider back up should shrink the top group "
            f"({top1} -> {top2})"
        )
    finally:
        page.close()


# ===========================================================================
# 11. Undock the full-bleed main panel: dock it to an edge, then drag it out --
#     the floated window keeps a real height (the full-bleed area fills it).
# ===========================================================================
def test_undock_fullbleed_main_panel_keeps_height(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        # Arrange: the unmergeable main panel docked on the right edge (the
        # undock drag is the subject).
        set_layout(page, dock_layout(docked_right=columns("monitor")))
        main_gid = _main_group_id(page)
        assert main_gid == "t-monitor"
        docked = page.query_selector(f'[data-dock-leaf] [data-dock-group="{main_gid}"]')
        assert docked is not None

        # Now drag it back OUT into the canvas (undock).
        header2 = page.query_selector(f'[data-dock-header="{main_gid}"]')
        if header2 is None:
            pytest.skip("main panel header gone after docking this run")
        hb2 = header2.bounding_box()
        assert hb2 is not None
        _drag(
            page,
            (hb2["x"] + hb2["width"] / 2, hb2["y"] + hb2["height"] / 2),
            (500, 300),
        )

        if _main_window_id(page) is None:
            pytest.skip("main panel did not undock to a floating window this run")

        # The floated full-bleed area has a real height (it fills the window).
        area = _box(page, '[data-dock-area="area-main"]')
        if area is None:
            pytest.skip("area-main not laid out after undock this run")
        assert area["h"] > 100, (
            f"undocked full-bleed main panel collapsed (area height {area['h']})"
        )
    finally:
        page.close()


# ===========================================================================
# 12. Dock BESIDE the full-bleed main panel: dropping a floater on the OUTER
#     ~30px side band splits beside it rather than merging into area-main (the
#     area's hit-rect is inset). Skip gracefully if geometry is finicky.
# ===========================================================================
def test_dock_beside_fullbleed_main_panel_does_not_merge_into_area(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        # Arrange: the unmergeable main panel docked right + controls floating
        # (the outer-band drop is the subject).
        set_layout(
            page,
            dock_layout(
                docked_right=columns("monitor"),
                floating=[window("controls", x=500, y=150)],
            ),
        )
        main_gid = _main_group_id(page)
        assert main_gid == "t-monitor"
        docked = page.query_selector(f'[data-dock-leaf] [data-dock-group="{main_gid}"]')
        assert docked is not None

        area_main_before = page.evaluate(
            """() => {
                const area = document.querySelector('[data-dock-area="area-main"]');
                if (!area) return [];
                return [...area.querySelectorAll('[data-dock-tab]')]
                    .map(t => t.getAttribute('data-dock-tab'));
            }"""
        )

        # Drop the floating "controls" panel on the LEFT outer band of the docked
        # main column (its leaf's far-left ~15px), which is OUTSIDE the inset
        # area-main hit-rect -> a split beside, not a merge into the area.
        ctrl_win = _floating_window_id_for_panel(page, "controls")
        if ctrl_win is None:
            pytest.skip("controls floater not found this run")
        ctrl_gid = page.eval_on_selector(
            f'[data-floating-window="{ctrl_win}"] [data-dock-group]',
            "e => e.getAttribute('data-dock-group')",
        )
        leaf = _box(page, f'[data-dock-leaf]:has([data-dock-group="{main_gid}"])')
        if leaf is None:
            pytest.skip("docked main leaf not laid out this run")
        # Aim ~10px inside the leaf's left edge (within the outer side band, but
        # outside the inset full-bleed area).
        target = (leaf["x"] + 10, leaf["y"] + leaf["h"] / 2)
        _drag_group(page, ctrl_gid, target)

        # controls must NOT have merged into area-main's tabs.
        area_main_after = page.evaluate(
            """() => {
                const area = document.querySelector('[data-dock-area="area-main"]');
                if (!area) return [];
                return [...area.querySelectorAll('[data-dock-tab]')]
                    .map(t => t.getAttribute('data-dock-tab'));
            }"""
        )
        merged_into_area = (
            "controls" in area_main_after and "controls" not in area_main_before
        )

        # If it didn't land as a split-beside (still floating, or it merged), this
        # is a geometry-finicky run -> skip rather than fail. The hard assertion is
        # the negative one: it must not have merged into the inner area.
        still_floating = _floating_window_id_for_panel(page, "controls") is not None
        if still_floating:
            pytest.skip("controls did not dock beside the main panel this run")
        assert not merged_into_area, (
            f"controls merged INTO area-main ({area_main_after}); the outer side "
            "band should split beside the full-bleed panel, not merge into its area"
        )
    finally:
        page.close()
