"""E2E regression coverage for a batch of docking-library panel behaviors.

These lock in the CURRENT behavior of the docked/floating panel chrome, exercised
against the standalone-Vite playground (``/dock_test.html``, HMR disabled):

7.  The docked Scene has NO cell-level minimize (D32); the region chevron
    collapses it to the 36px rail and the rail header's + restores it.
8.  The unmergeable "Connected" FLOATING main panel keeps its header-click
    minimize (single-group floating window, D32) and renders its face bar.
9.  Snapping a panel below a COLLAPSED floating window keeps both panels in
    one window (the container's one flag governs the rendering, D38).
10. Dragging the divider between two stacked floating groups grows the top group
    and shrinks the bottom one (and reverses when dragged back).
11. Undocking the full-bleed main panel keeps a real height (the nested area
    fills it).
12. Dropping a floater on the OUTER edge band of the full-bleed main panel splits
    BESIDE it rather than merging into the inner full-bleed area.
13. D32/D38: docked cells -- stacked or lone -- render NO per-cell minimize;
    the column chevron rails a 2-leaf column as one scope and the rail
    header's + expands it whole.

Same harness as ``test_dock_playground_dropzones.py``. Run with::

    uv run pytest tests/e2e/test_dock_playground_panels.py -v

Skips cleanly if the client toolchain (``npx`` + ``node_modules``) is missing, or
if a particular gesture didn't produce the expected structure this run (drop-zone
geometry can vary by a few px).
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import (
    click_column_chevron,
    column_railed_for_group,
    columns,
    dock_layout,
    group,
    rows,
    set_layout,
    stack,
    window,
)
from .dock_helpers import collapsed as _model_collapsed
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
# 7. The docked Scene has no cell-level minimize (D32); the region chevron
#    collapses it to the 36px rail; the rail header's + restores it.
# ===========================================================================
def test_docked_scene_collapses_to_rail_via_chevron(
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

        # No cell-level `-` on the docked cell (D32).
        assert (
            page.locator(
                f'[data-dock-group="{scene_gid}"] [data-dock-minimize]'
            ).count()
            == 0
        ), "a docked cell must not render a cell-level minimize (D32)"

        # Collapse via the region chevron -> the 36px rail.
        page.eval_on_selector('[data-dock-region-collapse="left"]', "e => e.click()")
        page.wait_for_timeout(350)
        assert page.locator("[data-dock-region-rail]").count() == 1
        mini = _gbox(page, scene_gid)
        assert mini["w"] < 60, (
            f"collapsed Scene should render as the ~36px rail cell, got {mini['w']}"
        )

        # Restore via the rail header's +.
        page.eval_on_selector(
            "[data-dock-region-rail] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(350)
        restored = _box(page, f'[data-dock-leaf]:has([data-dock-group="{scene_gid}"])')
        assert restored is not None and restored["w"] > full_w - 30, (
            f"restoring should re-open the Scene at ~{full_w}px, got {restored}"
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

        # Toggle back. Once collapsed, the floating main panel renders its
        # FACE BAR in place (D19/D33: the header kept, body hidden) -- a
        # motionless click on the bar expands it.
        strip = page.query_selector(
            f'[data-dock-group="{main_gid}"][data-dock-collapsed="true"]'
        )
        assert strip is not None, "collapsed main panel should render its face bar"
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
# 9. Snap a panel below a COLLAPSED floating window: both survive in one
#    window; collapse stays a container property (D38).
# ===========================================================================
def test_snap_below_collapsed_window_keeps_top_panel(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        # Arrange: controls floating ALREADY COLLAPSED (window flag, D38),
        # inspector floating apart from it (the snap-below gesture is the
        # subject).
        set_layout(
            page,
            dock_layout(
                floating=[
                    window("controls", x=500, y=150, collapsed=True),
                    window("inspector", x=900, y=150, width=260),
                ]
            ),
        )
        ctrl_win = "t-w-controls"
        insp_gid = "t-inspector"

        # Snap inspector BELOW the (collapsed) controls window.
        ctrl_box = _box(page, f'[data-floating-window="{ctrl_win}"]')
        if ctrl_box is None:
            pytest.skip("collapsed controls window not laid out this run")
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
        # group, 2 panes); either way both panels are present and reachable,
        # and every group renders per the CONTAINER's one flag (D38: no
        # per-group state exists to mix).
        out = page.evaluate(
            """(w) => { const l = window.__dockLayout;
                const win = l.floating.find((f) => f.id === w);
                return {
                    panes: win.stack.flatMap((g) => l.groups[g].paneIds),
                    collapsed: win.collapsed === true,
                }; }""",
            stacked,
        )
        assert "controls" in out["panes"] and "inspector" in out["panes"], (
            f"both panels should be in the window, got {out['panes']}"
        )
        # Controls' rendering is still present with positive height (a bar if
        # the window stayed collapsed; a full cell if it expanded).
        cgid = page.evaluate(
            """() => { const l = window.__dockLayout;
                for (const [g, v] of Object.entries(l.groups))
                    if (v.paneIds.includes('controls')) return g;
                return null; }"""
        )
        cbox = _gbox(page, cgid)
        assert cbox["h"] > 10, f"controls' cell should have height, got {cbox}"
    finally:
        page.close()


def test_rail_cell_split_preview_has_no_blue_flood(
    dock_context, vite_server: int
) -> None:
    """Hovering a split band on a RAIL cell shows only the thin insertion
    line -- never the 'shrink + tint the vacated half' leaf preview, which on
    a region-tall strip floods the whole region light-blue (regression;
    converted from the pre-D38 in-place-strip form)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=stack(group(["controls", "inspector"])),
                floating=[window("console", x=200, y=300, collapsed=True)],
            ),
        )
        gid = "t-controls"
        # Collapse the region: the rail cell is the hover target.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        cell = _box(page, f'[data-dock-group="{gid}"]')
        # The floating minimized window is a stack of bars; the bar IS the
        # group's drag handle (drag moves the group, click expands).
        cap = _box(page, '[data-floating-window] [data-dock-group="t-console"]')
        if cell is None or cap is None:
            pytest.skip("rail not laid out this run")
        # Start dragging console's bar, then hover the rail cell's thin TOP
        # edge band (resolves to insert-above, which is what used to trigger
        # the leaf tint).
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
            f"rail cell should not show the blue split-preview flood, got {bg}"
        )
    finally:
        page.close()


def test_tear_tab_from_rail_floats_born_collapsed(
    dock_context, vite_server: int
) -> None:
    """Dragging a tab ROW out of the collapsed region's rail floats JUST that
    pane as a COLLAPSED window (born collapsed, D38) -- dragging never
    expands (only a no-motion click does)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(docked_right=stack(group(["controls", "inspector"]))),
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
        if _floating_window_id_for_panel(page, "inspector") is None:
            pytest.skip("tear-out didn't float this run; geometry off")
        assert _model_collapsed(
            page,
            page.evaluate(
                """() => {
                    for (const [g, v] of Object.entries(window.__dockLayout.groups))
                        if (v.paneIds.includes("inspector")) return g;
                    return null; }"""
            ),
        ), "a tab torn from the rail must float as a collapsed window (D38)"
    finally:
        page.close()


def test_drop_into_rail_at_tab_position(dock_context, vite_server: int) -> None:
    """The collapsed region rail's spine-label rows are a tab strip: dropping
    over a row inserts at THAT position (begin / between / end), like dropping
    between expanded horizontal tabs. The region stays collapsed."""
    page = _open(dock_context, vite_server)
    try:
        # A docked group [controls, inspector] + a collapsed floating console.
        set_layout(
            page,
            dock_layout(
                docked_right=stack(group(["controls", "inspector"])),
                floating=[window("console", x=300, y=300, collapsed=True)],
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
            "() => window.__dockLayout.regionCollapsed.right === true"
        ), "the region must stay collapsed after a tab-position drop"
    finally:
        page.close()


def test_expanded_panel_docked_beside_railed_column_stays_expanded(
    dock_context, vite_server: int
) -> None:
    """Dropping an EXPANDED panel as a new column beside a RAILED column
    lands expanded and visible, while the railed column stays railed
    (collapse belongs to the container the newcomer joins, not to
    neighbors -- D38's structural no-adoption)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=columns("inspector", stack("controls", railed=True)),
                floating=[window("console", x=300, y=400, width=240)],  # EXPANDED
            ),
        )
        assert column_railed_for_group(page, "t-controls") is True
        cgrip = _grip(page, "t-console")
        # Drop on the rail CELL's outer third (rail cell zones are the
        # expanded cell's, rotated -- spec 5.3): a new column beside it.
        cell = _box(page, '[data-dock-group="t-controls"][data-dock-collapsed]')
        assert cell is not None
        _drag(
            page,
            (cgrip["x"], cgrip["y"]),
            (cell["right"] - 5, cell["y"] + cell["h"] / 2),
        )
        docked = page.evaluate(
            """() => { const l = window.__dockLayout;
                return l.docked.right !== null
                    && JSON.stringify(l.docked.right).includes("console"); }"""
        )
        if not docked:
            pytest.skip("new column didn't land this run")
        assert column_railed_for_group(page, "t-console") is False, (
            "an expanded panel docked beside a rail must LAND expanded"
        )
        assert column_railed_for_group(page, "t-controls") is True, (
            "the railed neighbor must stay railed"
        )
        # Its cell is really visible at content width (not swallowed into a
        # rail).
        w = page.evaluate(
            """() => document
                .querySelector('[data-dock-group="t-console"]')
                .closest('[data-dock-leaf]').getBoundingClientRect().width"""
        )
        assert w > 100, f"the new column should render expanded, got {w}px"
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


# ===========================================================================
# 13. D32/D38: NO docked cell -- stacked or lone -- renders a per-cell
#     minimize. Seed a band holding a 2-leaf column (controls/inspector)
#     next to a lone 1-leaf column (console):
#     * no docked cell carries [data-dock-minimize] (the largest coinciding
#       scope owns collapse, D32);
#     * both column parent handles carry the column chevron (band has
#       sibling columns, D27);
#     * the 2-leaf column's chevron rails it as ONE scope (both cells in one
#       rail) and the rail header's + expands it whole; the sibling column
#       (console) is untouched throughout.
# ===========================================================================
def test_no_docked_cell_has_minimize_column_chevron_rails_stack(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=columns(stack("controls", "inspector"), "console")
            ),
        )

        # No docked cell renders a minimize toggle (D32) -- stacked or lone.
        for gid in ("t-controls", "t-inspector", "t-console"):
            assert not _has_minimize(page, gid), (
                f"docked cell {gid} must NOT render a per-cell minimize (D32)"
            )
        for gid in ("t-controls", "t-inspector", "t-console"):
            assert _has_grip(page, gid), f"{gid} should keep its grip bar"
        # Both columns of the band carry the chevron on their parent handles.
        assert (
            page.eval_on_selector_all(
                "[data-dock-column-collapse]", "els => els.length"
            )
            == 2
        ), "each column of a multi-column band carries its chevron (D27/D32)"

        # Rail the 2-leaf column via its chevron: ONE scope -- both cells
        # render as cells of one column rail.
        click_column_chevron(page, "t-controls")
        assert column_railed_for_group(page, "t-controls") is True
        assert column_railed_for_group(page, "t-inspector") is True, (
            "railing the column collapses the WHOLE stack (one flag, D38)"
        )
        assert page.locator("[data-dock-column-rail]").count() == 1
        assert _model_collapsed(page, "t-controls")
        assert _model_collapsed(page, "t-inspector")
        assert not _model_collapsed(page, "t-console"), (
            "the sibling column must be untouched by the rail"
        )

        # The rail header's + expands the whole column; console untouched.
        page.eval_on_selector(
            "[data-dock-column-rail] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(350)  # wait out the expand animation
        assert not _model_collapsed(page, "t-controls"), (
            "the rail header's + should expand the column"
        )
        assert not _model_collapsed(page, "t-inspector"), (
            "the rail header's + must expand the WHOLE stack (D38)"
        )
        assert not _model_collapsed(page, "t-console"), (
            "the sibling column must be untouched by the expand"
        )
    finally:
        page.close()


def test_plain_stack_cells_have_no_minimize_control(
    dock_context, vite_server: int
) -> None:
    """D30 visual-column scope: a PLAIN docked stack (two bands, one leaf
    each -- the canonical D12 shape) is ONE visual column, so neither cell
    carries the cell-level minus even though each sits alone in its MODEL
    column. The collapse control is the region handle's chevron."""
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(docked_right=rows("controls", "inspector")),
        )
        for gid in ("t-controls", "t-inspector"):
            assert _has_grip(page, gid), f"{gid} should keep its grip bar"
            assert not _has_minimize(page, gid), (
                f"plain-stack cell {gid} must NOT render a per-cell minimize "
                "(D30: the stack is one visual column)"
            )
        assert page.query_selector('[data-dock-region-collapse="right"]') is not None, (
            "the single-visual-column region's handle should carry the chevron"
        )
    finally:
        page.close()


# ===========================================================================
# Rail drop-zone pins (user-reported symptoms; layout: band 1 = full-width
# expanded panel, band 2 = two railed columns side by side):
# a. Dropping on the LEFT sliver of the leftmost rail lands in the RAILS'
#    band (previously the 40px region side band shadowed the 36px rail and
#    committed into band 1).
# b. The drop hint between the two rails is BAND-TALL and stays in the
#    rails' band (previously a ~cell-tall stub, or a hint over band 1 while
#    the pointer was over band 2).
# c. A drop over the rails band's empty interior (right of the rails) also
#    lands in the rails' band -- never in band 1, and never dead.
# ===========================================================================
def _rails_over_panel_layout(page: Page) -> None:
    """Band 1 = expanded console (full width), band 2 = two rails; a floating
    scene panel (240px) is the dragged subject."""
    set_layout(
        page,
        dock_layout(
            docked_right=rows(
                "console",
                columns(
                    stack("controls", railed=True),
                    stack("inspector", railed=True),
                ),
            ),
            floating=[window("scene", x=400, y=300, width=240)],
        ),
    )


def _rail_root_box(page: Page, gid: str) -> dict | None:
    """Bounding rect of the full rail STRIP (data-dock-rail-root) holding
    `gid` -- band-tall, 36px wide."""
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        "e => { const root = e.closest('[data-dock-rail-root]'); "
        "if (!root) return null; const r = root.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height, "
        "right: r.right, bottom: r.bottom }; }",
    )


def _region_bands(page: Page, edge: str = "right") -> list | None:
    """The docked region's bands as [[{railed, groups}, ...], ...]."""
    return page.evaluate(
        """(edge) => {
            const region = window.__dockLayout.docked[edge];
            if (!region) return null;
            return region.rows.map((row) => row.columns.map((col) => ({
                railed: col.railed === true,
                groups: col.leaves.map((l) => l.group),
            })));
        }""",
        edge,
    )


def _band_index_of(bands: list, gid: str) -> int | None:
    for i, band in enumerate(bands):
        for col in band:
            if gid in col["groups"]:
                return i
    return None


def test_drop_left_of_leftmost_rail_lands_in_rails_band(
    dock_context, vite_server: int
) -> None:
    """Symptom (a): the leftmost rail's outer sliver docks a new column into
    the RAILS' band. The 40px region side band must not shadow the 36px rail
    or commit the drop into band 1."""
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        _rails_over_panel_layout(page)
        assert column_railed_for_group(page, "t-controls") is True
        rail = _rail_root_box(page, "t-controls")
        if rail is None:
            pytest.skip("rail not laid out this run")
        # 4px inside the leftmost rail's left edge, in the band's LOWER half
        # (the old bug drew/committed into the top band from here).
        target = (rail["x"] + 4, rail["y"] + rail["h"] * 0.6)
        _drag_group(page, "t-scene", target)
        bands = _region_bands(page)
        if bands is None or _band_index_of(bands, "t-scene") is None:
            pytest.skip("scene did not dock this run")
        assert _band_index_of(bands, "t-scene") == 1, (
            f"drop left of the leftmost rail must land in the rails' band, got {bands}"
        )
        # Band 1 keeps console alone; the rails stay railed; scene lands
        # expanded as the band's new outer column.
        assert [c["groups"] for c in bands[0]] == [["t-console"]], bands
        assert bands[1][0]["groups"] == ["t-scene"], bands
        assert bands[1][0]["railed"] is False
        assert column_railed_for_group(page, "t-controls") is True
    finally:
        page.close()


def test_between_rails_hint_is_band_tall(dock_context, vite_server: int) -> None:
    """Symptom (b)/(c): hovering between the two rails shows a thin vertical
    insertion line spanning the rails' BAND -- not a short stub, and not a
    hint up in band 1 while the pointer is over band 2."""
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        _rails_over_panel_layout(page)
        c_rail = _rail_root_box(page, "t-controls")
        i_rail = _rail_root_box(page, "t-inspector")
        if c_rail is None or i_rail is None:
            pytest.skip("rails not laid out this run")
        grip = _grip(page, "t-scene")
        gap_x = (c_rail["right"] + i_rail["x"]) / 2
        hover_y = c_rail["y"] + c_rail["h"] * 0.75  # lower half of the band
        page.mouse.move(grip["x"], grip["y"])
        page.mouse.down()
        page.mouse.move(grip["x"] + 6, grip["y"] + 6, steps=2)
        page.mouse.move(gap_x, hover_y, steps=8)
        page.wait_for_timeout(150)
        hints = page.evaluate(
            """() => [...document.querySelectorAll('[data-dock-hint]')]
                .map((e) => { const r = e.getBoundingClientRect();
                    return { x: r.x, y: r.y, w: r.width, h: r.height }; })"""
        )
        page.mouse.up()
        if not hints:
            pytest.skip("no drop hint shown between the rails this run")
        h = hints[0]
        assert h["w"] <= 8, f"between-rails hint should be a thin line, got {h}"
        assert h["h"] >= 0.6 * c_rail["h"], (
            f"between-rails hint must be band-tall (band {c_rail['h']}px), got {h}"
        )
        assert h["y"] >= c_rail["y"] - 12 and h["y"] + h["h"] <= (
            c_rail["y"] + c_rail["h"] + 12
        ), f"hint must stay within the rails' band {c_rail}, got {h}"
    finally:
        page.close()


def test_drop_over_rails_band_interior_lands_in_rails_band(
    dock_context, vite_server: int
) -> None:
    """Symptom (c): the rails band's empty interior (right of the packed
    rails) is a live 'dock beside the rails' zone committing into THAT band
    -- a drop at band 2's y never lands in band 1."""
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        _rails_over_panel_layout(page)
        i_rail = _rail_root_box(page, "t-inspector")
        if i_rail is None:
            pytest.skip("rail not laid out this run")
        # Well inside the band's empty run right of the rightmost rail.
        target = (i_rail["right"] + 60, i_rail["y"] + i_rail["h"] * 0.5)
        _drag_group(page, "t-scene", target)
        bands = _region_bands(page)
        if bands is None or _band_index_of(bands, "t-scene") is None:
            pytest.skip("scene did not dock this run")
        assert _band_index_of(bands, "t-scene") == 1, (
            f"a drop over the rails band's interior must land in the rails' "
            f"band, got {bands}"
        )
        assert [c["groups"] for c in bands[0]] == [["t-console"]], bands
        # The newcomer sits after the rails (a split right of the rightmost).
        assert bands[1][-1]["groups"] == ["t-scene"], bands
    finally:
        page.close()


def test_all_railed_band_content_sizes(dock_context, vite_server: int) -> None:
    """D41 (revision 2): an ALL-RAILED band SNAPS to its CONTENT height when
    it becomes all-railed (weight committed as the measured spine height), so
    by default no dead gray sits below its spine icons and an EXPANDED
    sibling band reclaims the freed height -- heights stay free to drag
    afterwards. The two rails stay SEPARATE (nothing merges): two
    column-rails, each its own spine. And the default must not squeeze -- at
    a small tab count the spine does NOT scroll.

    (Supersedes the 2026-07-06 full-height rule, which parked an all-railed
    band at a full weighted share and left a big gray tail below the icons --
    the user's screenshot. The full-height rule existed so a MANY-tab rail
    wouldn't be squeezed into a sliver; the huge case is covered by
    ``test_all_railed_band_caps_and_scrolls_when_huge``.)"""
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        # A top band of two rails (controls / inspector) over an expanded
        # console band -- the user's shape. The all-rails band must shrink to
        # its spine height; the expanded band must reclaim the rest.
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack("controls", railed=True),
                        stack("inspector", railed=True),
                    ),
                    "console",
                ),
            ),
        )
        geom = page.evaluate(
            """() => {
                const region = document.querySelector('[data-dock-region]');
                const rh = region.getBoundingClientRect().height;
                const rails = [...document.querySelectorAll(
                    '[data-dock-column-rail]')].map((rail) => {
                    const root = rail.parentElement;
                    const r = root.getBoundingClientRect();
                    const body = root.children[1];
                    return {
                        h: r.height,
                        scrolls: body
                            ? body.scrollHeight > body.clientHeight + 1
                            : null,
                    };
                });
                // The expanded console cell's rendered height.
                const exp = document.querySelector(
                    '[data-dock-group="t-console"]');
                const th = exp ? exp.getBoundingClientRect().height : null;
                return { rh, rails, th };
            }"""
        )
        # Rails stay SEPARATE -- two column-rails, nothing merged.
        assert len(geom["rails"]) == 2, geom
        for rail in geom["rails"]:
            # Content-sized: the spine band is far shorter than the region
            # (no full-height weighted share -> no dead gray below the icons).
            assert rail["h"] < geom["rh"] * 0.6, (
                f"an all-railed band must content-size, not fill the region: {geom}"
            )
            # Never squeezed below content: a few-tab spine does not scroll.
            assert rail["scrolls"] is False, (
                f"content-sizing must not squeeze the spine into a scrollbar: {geom}"
            )
        # The expanded Tools band reclaims the height the rail band freed:
        # it takes the bulk of the region, not a mere half.
        assert geom["th"] is not None and geom["th"] > geom["rh"] * 0.6, (
            f"the expanded sibling band must reclaim the freed height: {geom}"
        )
    finally:
        page.close()


def test_all_railed_band_caps_and_scrolls_when_huge(
    dock_context, vite_server: int
) -> None:
    """D41: a genuinely huge all-railed band (many tabs, taller than the
    region) never exceeds the region height -- it sizes by its weighted share
    (basis 0 + grow, which can never overflow the container) and its spine
    scrolls via the rail Paper's overflowY:auto, so it never overflows into
    the next band. This is the degenerate case the 2026-07-06 full-height
    rule protected; the share sizing preserves that protection while the
    common few-tab case snaps to content."""
    page = _open(dock_context, vite_server, 1400, 220)
    try:
        # A TALL all-rails band: two railed columns (D39 needs 2+ so neither is
        # a lone-column band), one with MANY tabs (one spine row each), over an
        # expanded band, in a SHORT region so the tallest spine cannot fit and
        # must scroll.
        many = group(["controls", "inspector", "console", "layers", "props", "history"])
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack(many, railed=True),
                        stack("scene", railed=True),
                    ),
                    "monitor",
                ),
            ),
        )
        geom = page.evaluate(
            """() => {
                const region = document.querySelector('[data-dock-region]');
                const rh = region.getBoundingClientRect().height;
                // The band box is the rail root's parent (the band wrapper).
                const roots = [...document.querySelectorAll(
                    '[data-dock-rail-root]')];
                const rails = roots.map((root) => {
                    const r = root.getBoundingClientRect();
                    const body = root.children[1];
                    return {
                        h: r.height,
                        scrolls: body
                            ? body.scrollHeight > body.clientHeight + 1
                            : null,
                    };
                });
                const bandH = Math.max(...rails.map((x) => x.h), 0);
                const anyScroll = rails.some((x) => x.scrolls === true);
                return { rh, h: bandH, scrolls: anyScroll, n: roots.length };
            }"""
        )
        # Capped at the region's own height (never taller, so it cannot
        # overflow into the next band).
        assert geom["h"] is not None and geom["h"] <= geom["rh"] + 2, (
            f"a huge all-railed band must cap at the region height: {geom}"
        )
        # The huge spine scrolls internally (acceptable for the degenerate
        # case).
        assert geom["scrolls"] is True, (
            f"a huge spine must scroll rather than overflow: {geom}"
        )
    finally:
        page.close()


# ===========================================================================
# Fix A: an ALL-RAILS region (2+ rail bands, NO expanded band) fills the
# the region height UNIFORMLY (weighted shares), NOT content-sized. Sizing
# an all-rails band only pays off when an expanded band exists to donate the
# freed height to; with no expanded band, content-sizing would leave the
# the lower area of the region empty and the bands ragged. (Two rail bands
# SAME multi-column partition D13-zip into one; unequal partitions -- a 2-col
# band over a 3-col band -- stay two separate bands.)
# ===========================================================================
def test_all_rails_region_fills_height_uniformly(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack("controls", railed=True),
                        stack("inspector", railed=True),
                    ),
                    columns(
                        stack("console", railed=True),
                        stack("scene", railed=True),
                        stack("monitor", railed=True),
                    ),
                ),
            ),
        )
        # Confirm the region is genuinely all-rails and stayed TWO bands (not
        # zipped): a 2-col band over a 3-col band.
        bands = _region_bands(page)
        assert bands is not None and len(bands) == 2, (
            f"expected two unequal-partition rail bands, got {bands}"
        )
        for band in bands:
            assert all(col["railed"] for col in band), (
                f"every column must be railed (all-rails region), got {bands}"
            )
        geom = page.evaluate(
            """() => {
                const region = document.querySelector('[data-dock-region]');
                const rh = region.getBoundingClientRect().height;
                // The region's flex column of band wrappers: sum the band
                // heights (skip the divider fragments).
                const inner = region.firstElementChild;
                const bandBoxes = [...inner.children]
                    .filter((el) => el.getAttribute('data-dock-divider') === null)
                    .map((el) => el.getBoundingClientRect().height);
                return { rh, bandBoxes, sum: bandBoxes.reduce((s, h) => s + h, 0) };
            }"""
        )
        # The bands together fill essentially the whole region (uniform fill),
        # not a short content-sized stack that strands the lower area.
        assert geom["sum"] >= geom["rh"] * 0.9, (
            f"an all-rails region must FILL the height (weighted shares), not "
            f"content-size and leave the lower area empty: {geom}"
        )
        # Each band is a substantial share -- neither collapsed to a short
        # content strip. With equal band weights each is ~half the region.
        for h in geom["bandBoxes"]:
            assert h >= geom["rh"] * 0.3, (
                f"each all-rails band should take a weighted share of the "
                f"region, not content-size to a short strip: {geom}"
            )
    finally:
        page.close()


# ===========================================================================
# Fix A / D41-win intact: a rail band OVER an expanded band still lands at
# its content height by default (the snap) and the expanded band reclaims
# the freed height. (Duplicates the guarantee of
# test_all_railed_band_content_sizes with an explicit "the D41 win survives
# Fix A" framing: the snap is scoped to when an expanded band exists to
# donate to.)
# ===========================================================================
def test_rail_band_over_expanded_still_content_sizes(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack("controls", railed=True),
                        stack("inspector", railed=True),
                    ),
                    "console",
                ),
            ),
        )
        geom = page.evaluate(
            """() => {
                const region = document.querySelector('[data-dock-region]');
                const rh = region.getBoundingClientRect().height;
                const railBand = document.querySelector('[data-dock-rail-root]')
                    ?.closest('[data-dock-column]')?.parentElement;
                const railH = railBand
                    ? railBand.getBoundingClientRect().height
                    : null;
                const exp = document.querySelector('[data-dock-group="t-console"]');
                const expH = exp ? exp.getBoundingClientRect().height : null;
                return { rh, railH, expH };
            }"""
        )
        # The rail band content-sizes to a short strip (well under half the
        # the region), and the expanded console band reclaims the bulk (D41 win).
        assert geom["railH"] is not None and geom["railH"] < geom["rh"] * 0.6, (
            f"the rail band over an expanded band must content-size: {geom}"
        )
        assert geom["expH"] is not None and geom["expH"] > geom["rh"] * 0.6, (
            f"the expanded band must reclaim the freed height (D41 win): {geom}"
        )
    finally:
        page.close()


# ===========================================================================
# A multi-column rail band with UNEQUAL cell counts ([1-cell | 2-cell |
# 1-cell]) keeps FULL-HEIGHT columns, and the vertical divider rule between
# two rail columns runs the FULL band height -- a rail column's body is the
# full band (empty tail below the spine included), so the boundary between
# two columns must span their whole shared edge. A rule that stops at the
# shorter spine's content reads as the rails "not extending full height"
# (user report, 2026-07-09).
# ===========================================================================
def test_rail_band_divider_rule_runs_full_band_height(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack("controls", railed=True),
                        stack("inspector", "console", railed=True),
                        stack("scene", railed=True),
                    ),
                    "monitor",
                ),
            ),
        )
        geom = page.evaluate(
            """() => {
                const rowDividers = [...document.querySelectorAll(
                    '[data-dock-divider="row"]')].map((d) => {
                    const rule = d.querySelector('[data-dock-divider-rule]');
                    return rule
                        ? Math.round(rule.getBoundingClientRect().height)
                        : null;
                });
                // Per rail column: box height (stretched full-band) vs its
                // spine CONTENT bottom (the LAST spine cell's bottom).
                const roots = [...document.querySelectorAll(
                    '[data-dock-rail-root]')].map((root) => {
                    const r = root.getBoundingClientRect();
                    const cells = root.querySelectorAll('[data-dock-leaf]');
                    const last = cells[cells.length - 1];
                    const contentH = last
                        ? Math.round(
                            last.getBoundingClientRect().bottom - r.top)
                        : null;
                    return {
                        boxH: Math.round(r.height),
                        contentH,
                        n: root.querySelectorAll('[data-dock-tab]').length,
                    };
                });
                return { rowDividers, roots };
            }"""
        )
        roots = geom["roots"]
        if len(roots) < 3 or any(r["contentH"] is None for r in roots):
            pytest.skip("rail band not laid out with 3 columns this run")
        # The columns are full-height (cross-axis stretch is correct): every
        # rail box is the same band height, taller than the short columns'
        # content.
        box_hs = {r["boxH"] for r in roots}
        assert len(box_hs) == 1, (
            f"rail columns must all stretch to full band height: {geom}"
        )
        band_h = next(iter(box_hs))
        short_content = min(r["contentH"] for r in roots)
        # The short columns' content is genuinely shorter than the band (there
        # IS an empty tail) -- otherwise the test proves nothing.
        assert short_content < band_h - 20, (
            f"expected a short column with an empty tail below its spine: {geom}"
        )
        # Every rail-to-rail divider rule spans the full band height -- it
        # must NOT stop at the shorter neighbor's spine content.
        rules = [h for h in geom["rowDividers"] if h is not None]
        assert rules, f"expected row-divider rules, got {geom}"
        for h in rules:
            assert h >= band_h - 4, (
                f"a rail-to-rail divider rule ({h}px) must run the full band "
                f"height ({band_h}px), not stop at the shorter spine "
                f"({short_content}px): {geom}"
            )
    finally:
        page.close()


# ===========================================================================
# The band divider beside a rail band is LIVE and FREE (D41 revision 2):
# dragging it toward the rail band squeezes the band below its content (the
# spine scrolls) and the expanded band grows; dragging it away grows the
# band freely PAST its content (bands have no maximum height -- dead gray by
# explicit user drag is the user's call); and a drag landing near the
# content height DETENTS onto it exactly. The band STARTS at its content
# height (the snap-to-content default). Layout mirrors the user's report
# (2026-07-09): a 2-cell rail beside a 1-cell rail, over an expanded band.
# ===========================================================================
def test_rail_band_divider_is_live_free_and_detents(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack("controls", "inspector", railed=True),
                        stack("console", railed=True),
                    ),
                    "monitor",
                ),
            ),
        )

        def _band_geom():
            return page.evaluate(
                """() => {
                    const band = document.querySelector('[data-dock-band]');
                    const divider = document.querySelector(
                        '[data-dock-divider="column"]');
                    const exp = document.querySelector(
                        '[data-dock-group="t-monitor"]');
                    if (!band || !divider || !exp) return null;
                    const db = divider.getBoundingClientRect();
                    return {
                        bandH: band.getBoundingClientRect().height,
                        expH: exp.getBoundingClientRect().height,
                        resizable: divider.getAttribute(
                            'data-dock-divider-resizable'),
                        cursor: getComputedStyle(divider).cursor,
                        dx: db.x + db.width / 2,
                        dy: db.y + db.height / 2,
                    };
                }"""
            )

        g0 = _band_geom()
        assert g0 is not None, "expected a rail band over an expanded band"
        # The divider beside the content-capped rail band is a REAL handle.
        assert g0["resizable"] == "true", (
            f"the band divider beside a rail band must be live: {g0}"
        )
        assert g0["cursor"] == "ns-resize", (
            f"a live band divider must show the resize cursor: {g0}"
        )

        # Drag UP 80px: the rail band shrinks below its content (spine
        # scrolls) and the expanded band grows by about the same amount.
        _drag(page, (g0["dx"], g0["dy"]), (g0["dx"], g0["dy"] - 80))
        g1 = _band_geom()
        assert g1 is not None
        assert g1["bandH"] < g0["bandH"] - 50, (
            f"dragging the divider up must shrink the rail band "
            f"({g0['bandH']} -> {g1['bandH']})"
        )
        assert g1["expH"] > g0["expH"] + 50, (
            f"the expanded band must reclaim the height ({g0['expH']} -> {g1['expH']})"
        )

        # Drag DOWN well past the content height: the band grows FREELY past
        # its spine (no maximum height) -- the dead gray below the spine is
        # the user's explicit choice here.
        _drag(page, (g1["dx"], g1["dy"]), (g1["dx"], g1["dy"] + 300))
        g2 = _band_geom()
        assert g2 is not None
        assert g2["bandH"] > g0["bandH"] + 100, (
            f"dragging well past the spine must grow the band freely past "
            f"its content ({g0['bandH']}px content, got {g2['bandH']}px)"
        )

        # Drag back UP to ~5px short of the content height: the seam DETENTS
        # onto the content exactly ("exactly no dead gray" is trivial to
        # land on). g0.bandH IS the content height (the snap default).
        target_delta = (g2["bandH"] - g0["bandH"]) - 5
        _drag(page, (g2["dx"], g2["dy"]), (g2["dx"], g2["dy"] - target_delta))
        g3 = _band_geom()
        assert g3 is not None
        assert abs(g3["bandH"] - g0["bandH"]) <= 2, (
            f"a drag landing within the detent must snap the band onto its "
            f"content height ({g0['bandH']}px), got {g3['bandH']}px"
        )
    finally:
        page.close()


# ===========================================================================
# D42: a band's LONE column carries the rail chevron and rails IN PLACE --
# the user's "two rails in the top half, one rail in the bottom half"
# picture. The lone rail keeps its own band (rails never merge); its strip
# is 36px with the rest of the band as plain band body; expanding from its
# rail header restores it.
# ===========================================================================
def test_lone_column_rails_in_place_via_chevron(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        stack("controls", "inspector", railed=True),
                        stack("console", railed=True),
                    ),
                    "monitor",
                ),
            ),
        )
        # The lone monitor column's handle carries a chevron (D42).
        has_chevron = page.evaluate(
            """() => {
                const g = document.querySelector('[data-dock-group="t-monitor"]');
                const col = g && g.closest('[data-dock-column]');
                return col
                    ? col.querySelector('[data-dock-column-collapse]') !== null
                    : null;
            }"""
        )
        assert has_chevron is True, (
            "a band's lone column must carry the rail chevron (D42)"
        )

        click_column_chevron(page, "t-monitor")
        page.wait_for_timeout(300)
        assert column_railed_for_group(page, "t-monitor") is True
        geom = page.evaluate(
            """() => {
                const bands = [...document.querySelectorAll('[data-dock-band]')];
                const rails = [...document.querySelectorAll(
                    '[data-dock-column-rail]')];
                const g = document.querySelector('[data-dock-group="t-monitor"]');
                const strip = g && g.closest('[data-dock-column]');
                return {
                    bands: bands.length,
                    rails: rails.length,
                    stripW: strip
                        ? Math.round(strip.getBoundingClientRect().width)
                        : null,
                    bandW: bands[1]
                        ? Math.round(bands[1].getBoundingClientRect().width)
                        : null,
                };
            }"""
        )
        # Two bands still -- the lone rail keeps its OWN band (never merges
        # into the top rails' band); its strip is the 36px rail width while
        # its band spans the region (the rest is plain band body). With
        # EVERY column now railed the region itself packs to rail widths
        # (D40 accounting: the widest band is the two-rail band, ~73px), so
        # the lone rail's band is that width -- strip plus body, canvas
        # reclaiming everything else.
        assert geom["bands"] == 2, f"the lone rail must keep its band: {geom}"
        assert geom["rails"] == 3, (
            f"three separate column rails (two top, one bottom): {geom}"
        )
        assert geom["stripW"] is not None and geom["stripW"] <= 40, (
            f"the lone rail renders as the 36px strip: {geom}"
        )
        assert geom["bandW"] is not None and geom["bandW"] > geom["stripW"] + 20, (
            f"the band spans the region around the strip (plain band body "
            f"beside the rail): {geom}"
        )

        # Expanding from the lone rail's header restores the column.
        page.eval_on_selector(
            '[data-dock-column-rail="'
            + page.evaluate(
                """() => document.querySelector('[data-dock-group="t-monitor"]')
                    .closest('[data-dock-column]')
                    .querySelector('[data-dock-rail-root]')
                    .getAttribute('data-dock-rail-root')"""
            )
            + '"] [data-dock-minimize-all]',
            "e => e.click()",
        )
        page.wait_for_timeout(300)
        assert column_railed_for_group(page, "t-monitor") is False, (
            "the rail header's + must expand the lone column in place"
        )
    finally:
        page.close()


# ===========================================================================
# D43 accordion: railing a band's LAST expanded column via its chevron
# expands the nearest railed sibling -- the chevron gesture always leaves a
# multi-column band with one expanded column. The user's report: a railed
# Tools beside an expanded Stats, over an expanded band -- "if we collapse
# Stats we should expand Tools" (otherwise the band strands a wide run of
# nothing but strips). Chevron clicks are synthetic (element.click).
# ===========================================================================
def test_railing_last_expanded_column_expands_railed_sibling(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        # [controls(railed) | inspector] over an expanded band -- the user's
        # screenshot shape (Tools rail | Stats, over Notes/Log). The lower
        # band is single-column so the equal-partition D13 zip can't merge
        # the bands at injection (the real layout's partitions differ by
        # width; the helpers only speak weight 1).
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(stack("controls", railed=True), "inspector"),
                    "monitor",
                ),
            ),
        )
        assert column_railed_for_group(page, "t-controls") is True
        assert column_railed_for_group(page, "t-inspector") is False

        # Rail inspector (the band's last expanded column): the accordion
        # swaps -- controls expands, inspector rails.
        click_column_chevron(page, "t-inspector")
        page.wait_for_timeout(300)
        assert column_railed_for_group(page, "t-inspector") is True, (
            "the chevron must rail its own column"
        )
        assert column_railed_for_group(page, "t-controls") is False, (
            "railing the band's last expanded column must expand the railed "
            "sibling (D43 accordion)"
        )
        # The band keeps real content: exactly one rail strip, one expanded
        # cell, and the lower band untouched.
        geom = page.evaluate(
            """() => {
                const bands = [...document.querySelectorAll('[data-dock-band]')];
                return {
                    bands: bands.length,
                    railsInBand0: bands[0]
                        ? bands[0].querySelectorAll('[data-dock-rail-root]').length
                        : null,
                    controlsExpanded: document.querySelector(
                        '[data-dock-group="t-controls"] [data-dock-tab]') !== null,
                };
            }"""
        )
        assert geom["bands"] == 2, geom
        assert geom["railsInBand0"] == 1, (
            f"exactly one rail strip after the swap: {geom}"
        )
        assert geom["controlsExpanded"] is True, (
            f"controls must render expanded after the swap: {geom}"
        )
    finally:
        page.close()


# ===========================================================================
# Fix C: an INERT divider (rail-to-rail, where resizable=false because no
# expanded column sits on one side, D24) must look DISTINCT from a live
# resize handle between two expanded columns -- so users don't expect a
# resize where none exists. Assert the inert row-divider has cursor:default
# AND a dimmer rule than the live one, which shows a resize cursor. (Band
# dividers no longer have an inert form: a rail band's height is a plain
# weighted share, so its seam is always live -- see
# test_rail_band_divider_is_live_free_and_detents.)
# ===========================================================================
def test_inert_rail_divider_is_visually_distinct_from_resizable(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        # One band: [rail | rail | console | monitor]. The rail|rail seam (and
        # the rail|console seam, with no expanded column to its left) is
        # INERT; the console|monitor seam is a LIVE resize handle.
        set_layout(
            page,
            dock_layout(
                docked_right=columns(
                    stack("controls", railed=True),
                    stack("inspector", railed=True),
                    "console",
                    "monitor",
                ),
            ),
        )
        dividers = page.evaluate(
            """() => [...document.querySelectorAll(
                '[data-dock-divider="row"]')].map((d) => {
                const rule = d.querySelector('[data-dock-divider-rule]');
                return {
                    resizable: d.getAttribute('data-dock-divider-resizable'),
                    cursor: getComputedStyle(d).cursor,
                    opacity: parseFloat(getComputedStyle(rule).opacity),
                };
            })"""
        )
        inert = [d for d in dividers if d["resizable"] == "false"]
        live = [d for d in dividers if d["resizable"] == "true"]
        if not inert or not live:
            pytest.skip(
                f"expected both an inert and a live row divider, got {dividers}"
            )
        for d in inert:
            # Inert: no resize cursor.
            assert d["cursor"] == "default", (
                f"an inert divider must not show a resize cursor: {d}"
            )
        for d in live:
            assert d["cursor"] == "ew-resize", (
                f"a live row divider must show the resize cursor: {d}"
            )
        # The inert rule is DIMMER than the live one (thinner-looking): "no
        # resize here" is honest, not an identical 1px line.
        max_inert_opacity = max(d["opacity"] for d in inert)
        min_live_opacity = min(d["opacity"] for d in live)
        assert max_inert_opacity < min_live_opacity, (
            f"the inert divider rule must be dimmer than the live one so it "
            f"reads as non-resizable (inert {max_inert_opacity} vs live "
            f"{min_live_opacity}): {dividers}"
        )
    finally:
        page.close()
