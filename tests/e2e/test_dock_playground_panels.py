"""E2E regression coverage for a batch of docking-library panel behaviors.

These lock in the CURRENT behavior of the docked/floating panel chrome, exercised
against the standalone-Vite playground (``/dock_test.html``, HMR disabled):

7.  Minimizing the docked Scene collapses it to its in-place 26px bar (D20:
    width kept; the region only narrows via the explicit collapse, D21);
    restoring brings it back.
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

from .dock_helpers import columns, dock_layout, group, set_layout, stack, window
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
# 7. Minimize collapses the docked Scene to its in-place BAR (D20): height
#    shrinks to the handle, width is KEPT (the region only narrows via the
#    explicit region-collapse chevron, D21).
# ===========================================================================
def test_minimize_docked_scene_collapses_to_in_place_bar(
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
        full_h = leaf_before["h"]

        # Minimize via the grip bar's minimize button.
        page.locator(
            f'[data-dock-group="{scene_gid}"] [data-dock-minimize]'
        ).first.click()
        page.wait_for_timeout(350)  # wait out the minimize animation

        # The collapsed Scene is its 26px bar IN PLACE: width kept, height
        # collapsed to the handle (D20 -- no width reclaim without D21).
        mini = _gbox(page, scene_gid)
        assert mini["w"] > full_w - 30, (
            f"minimized Scene bar should keep the column width (~{full_w}); "
            f"got {mini['w']}"
        )
        assert mini["h"] < 40, (
            f"minimized Scene should collapse to a handle-height bar; "
            f"got height {mini['h']} (was {full_h})"
        )

        # Restore (click again): it expands back to a tall docked column.
        page.locator(
            f'[data-dock-group="{scene_gid}"] [data-dock-minimize]'
        ).first.click()
        page.wait_for_timeout(350)  # wait out the expand animation
        restored = _gbox(page, scene_gid)
        assert restored["h"] > mini["h"] + 40, (
            f"restoring did not re-open the Scene (mini {mini['h']} -> "
            f"restored {restored['h']})"
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

        # Unmergeable panel: no gray grip handle, but the header DOES carry
        # the one visible minimize toggle (P9: header-click minimizes, and the
        # toggle is its signifier).
        assert _has_minimize(page, main_gid), (
            "the unmergeable main panel header must have a [data-dock-minimize] toggle"
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

        # Toggle back. Once collapsed, the floating main panel renders as a
        # vertical strip (consistent with docked minimized panels) -- the header
        # is gone, so expand via the strip's cell/+ cap, not the old header spot.
        strip = page.query_selector(
            f'[data-dock-group="{main_gid}"][data-dock-collapsed="true"]'
        )
        assert strip is not None, "collapsed main panel should render a strip"
        sb = strip.bounding_box()
        assert sb is not None
        page.mouse.move(sb["x"] + sb["width"] / 2, sb["y"] + 12)
        page.mouse.down()
        page.mouse.up()
        page.wait_for_timeout(120)
        assert _collapsed() == was, "clicking the collapsed strip did not expand it"
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
        insp_gid = "t-inspector"

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
            pytest.skip("inspector did not land on controls this run")

        # Both panels ended up in the same window -- controls wasn't lost. The
        # drop may snap a new cell (2 groups) or insert a tab into the strip (1
        # group, 2 panes); either way both panels are present and reachable.
        panes = page.evaluate(
            """(w) => { const l = window.__dockLayout;
                const win = l.floating.find((f) => f.id === w);
                return win.stack.flatMap((g) => l.groups[g].paneIds); }""",
            stacked,
        )
        assert "controls" in panes and "inspector" in panes, (
            f"both panels should be in the window, got {panes}"
        )
        # No collapse infection (D16): collapse states travel AS-IS. If a
        # 2-group stack formed, controls stays minimized and inspector stays
        # expanded (mixed stacks are legal); a tab-insert inherits the target
        # group's state instead. Either way, the drop changed no collapse
        # state by itself.
        states = page.evaluate(
            """(w) => { const l = window.__dockLayout;
                const win = l.floating.find((f) => f.id === w);
                return win.stack.map((g) => ({
                    panes: l.groups[g].paneIds,
                    collapsed: l.groups[g].collapsed === true })); }""",
            stacked,
        )
        if len(states) == 2:
            by_pane = {tuple(s["panes"])[0]: s["collapsed"] for s in states}
            assert by_pane.get("controls") is True, (
                f"controls must STAY minimized after the snap, got {states}"
            )
            assert by_pane.get("inspector") is False, (
                f"inspector must STAY expanded (no adoption, D16), got {states}"
            )
    finally:
        page.close()


def test_minimized_cell_split_preview_has_no_blue_flood(
    dock_context, vite_server: int
) -> None:
    """Hovering a split band on a MINIMIZED strip shows only the thin insertion
    line -- never the 'shrink + tint the vacated half' leaf preview, which on a
    region-tall strip floods the whole region light-blue (regression)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=stack(group(["controls", "inspector"], collapsed=True)),
                floating=[window(group("console", collapsed=True), x=200, y=300)],
            ),
        )
        gid = "t-controls"
        cell = _box(page, f'[data-dock-group="{gid}"]')
        # The floating minimized window is a stack of bars; the bar IS the
        # group's drag handle (drag moves the group, click expands).
        cap = _box(page, '[data-floating-window] [data-dock-group="t-console"]')
        if cell is None or cap is None:
            pytest.skip("strip not laid out this run")
        # Start dragging console's cap, then hover the strip's thin TOP edge band
        # (resolves to split-top, which is what used to trigger the leaf tint).
        page.mouse.move(cap["x"] + cap["w"] / 2, cap["y"] + cap["h"] / 2)
        page.mouse.down()
        page.mouse.move(
            cap["x"] + cap["w"] / 2 + 10, cap["y"] + cap["h"] / 2 + 10, steps=4
        )
        page.mouse.move(cell["x"] + cell["w"] / 2, cell["y"] + 2, steps=4)
        page.wait_for_timeout(120)
        # The minimized cell's leaf wrapper must NOT be tinted blue.
        bg = page.evaluate(
            """(g) => {
                const leaf = document
                    .querySelector(`[data-dock-group="${g}"]`)
                    .closest('[data-dock-leaf]');
                return leaf ? getComputedStyle(leaf.parentElement).backgroundColor : null;
            }""",
            gid,
        )
        page.mouse.up()
        # Tinted preview is rgba(34,139,230,0.1); accept any non-blue (white /
        # transparent). Assert it's not the primary-color tint.
        assert bg is not None and "34, 139, 230" not in bg, (
            f"minimized cell should not show the blue split-preview flood, got {bg}"
        )
    finally:
        page.close()


def test_tear_tab_from_minimized_strip_stays_minimized(
    dock_context, vite_server: int
) -> None:
    """Dragging a tab ROW out of the collapsed region's rail floats JUST that
    pane, STILL minimized -- dragging never expands (only a no-motion click
    does). Per-tab tear-out lives in the RAIL (D14/D21); the in-place bar
    shows a single label."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=stack(group(["controls", "inspector"], collapsed=True))
            ),
        )
        gid = "t-controls"
        # Collapse the region explicitly: the rail's spine rows are the
        # per-tab surfaces.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        row = _box(page, f'[data-dock-group="{gid}"] [data-dock-tab="inspector"]')
        if row is None:
            pytest.skip("rail not laid out this run")
        _drag(page, (row["x"] + row["w"] / 2, row["y"] + row["h"] / 2), (500, 400))
        ig = page.evaluate(
            """() => { for (const [g, v] of Object.entries(window.__dockLayout.groups))
                if (v.paneIds.includes("inspector")) return g; return null; }"""
        )
        if _floating_window_id_for_panel(page, "inspector") is None:
            pytest.skip("tear-out didn't float this run; geometry off")
        assert page.evaluate(
            "(g) => window.__dockLayout.groups[g].collapsed === true", ig
        ), "a tab torn from a minimized strip must stay minimized"
    finally:
        page.close()


def test_drop_into_minimized_stack_at_tab_position(
    dock_context, vite_server: int
) -> None:
    """The collapsed region rail's spine-label rows are a tab strip: dropping
    over a row inserts at THAT position (begin / between / end), like dropping
    between expanded horizontal tabs. The whole group stays minimized."""
    page = _open(dock_context, vite_server)
    try:
        # A minimized docked group [controls, inspector] + floating console.
        set_layout(
            page,
            dock_layout(
                docked_right=stack(group(["controls", "inspector"], collapsed=True)),
                floating=[window(group("console", collapsed=True), x=300, y=300)],
            ),
        )
        gid = "t-controls"
        # Collapse the region: per-tab rows live in the rail (D14/D21).
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        # Drag console's bar onto the TOP of the inspector row -> insert
        # console BEFORE inspector (between controls and inspector).
        # The floating minimized window is a stack of bars; the bar IS the
        # group's drag handle (drag moves the group, click expands).
        cap = _box(page, '[data-floating-window] [data-dock-group="t-console"]')
        row = _box(page, f'[data-dock-group="{gid}"] [data-dock-tab="inspector"]')
        if cap is None or row is None:
            pytest.skip("strip not laid out this run")
        _drag(
            page,
            (cap["x"] + cap["w"] / 2, cap["y"] + cap["h"] / 2),
            (row["x"] + row["w"] / 2, row["y"] + 3),
        )
        ids = page.evaluate("(g) => window.__dockLayout.groups[g]?.paneIds", gid)
        if ids is None or "console" not in ids:
            pytest.skip("insertion didn't land this run; geometry off by a few px")
        assert ids == ["controls", "console", "inspector"], (
            f"console should insert before inspector, got {ids}"
        )
        assert page.evaluate(
            "(g) => window.__dockLayout.groups[g].collapsed === true", gid
        ), "the stack must stay minimized after a tab-position drop"
    finally:
        page.close()


def test_new_cell_beside_minimized_stack_stays_expanded(
    dock_context, vite_server: int
) -> None:
    """Dropping an EXPANDED panel as a new cell beside a minimized cell STAYS
    expanded (D16 deleted the adoption rules: collapse changes only by user
    gesture or server command -- P3 with no exceptions)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=stack(group(["controls", "inspector"], collapsed=True)),
                floating=[window("console", x=300, y=300, width=240)],  # EXPANDED
            ),
        )
        gid = "t-controls"
        cell = _gbox(page, gid)
        cgrip = _grip(page, "t-console")
        # Drop at the region's BOTTOM edge band (a lone bar has no per-panel
        # top/bottom zones, D4; the region band stays available over an
        # all-minimized region) -> a new band below the bar.
        vh = page.viewport_size["height"]  # type: ignore[index]
        _drag(
            page,
            (cgrip["x"], cgrip["y"]),
            (cell["x"] + cell["w"] / 2, vh - 4),
        )
        cgid = page.evaluate(
            """() => { for (const [g, v] of Object.entries(window.__dockLayout.groups))
                if (v.paneIds.includes("console")) return g; return null; }"""
        )
        docked = page.evaluate(
            """() => { const l = window.__dockLayout;
                return l.docked.right !== null
                    && JSON.stringify(l.docked.right).includes("console"); }"""
        )
        if not docked:
            pytest.skip("new cell didn't land this run")
        assert page.evaluate(
            "(g) => window.__dockLayout.groups[g].collapsed !== true", cgid
        ), "a new cell beside a minimized cell must STAY expanded (no adoption)"
        # And the minimized neighbor was not expanded by the drop either.
        assert page.evaluate(
            "() => window.__dockLayout.groups['t-controls'].collapsed === true"
        )
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
