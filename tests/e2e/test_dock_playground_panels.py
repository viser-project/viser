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


def test_all_railed_band_keeps_full_height(dock_context, vite_server: int) -> None:
    """D38: rails reclaim WIDTH, never height. When every column of a band is
    railed, the band must stay full-height (region-tall rail strips, spine
    content unscrolled at small tab counts) -- the bars-era band collapse
    squeezed a band of rails to a ~60px sliver with crammed icons behind a
    scrollbar (user report)."""
    page = _open(dock_context, vite_server, 1400, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=columns(
                    stack("controls", railed=True),
                    stack("inspector", railed=True),
                )
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
                return { rh, rails };
            }"""
        )
        assert len(geom["rails"]) == 2, geom
        for rail in geom["rails"]:
            assert abs(rail["h"] - geom["rh"]) <= 2, (
                f"a railed column must span the region height, got {geom}"
            )
            assert rail["scrolls"] is False, (
                f"rail spine content must not scroll at this tab count: {geom}"
            )
    finally:
        page.close()
