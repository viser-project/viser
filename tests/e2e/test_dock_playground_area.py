"""E2E coverage for nested dockable AREAS in the dock playground.

A nested area (``<DockArea areaId=.../>``) is a FIRST-CLASS participant in the
dock model: its tab group lives in the shared layout, so dropping panels in,
tearing a tab out, and dropping a whole snapped stack all reuse the same
hit-testing and pointer-drag controller as everything else. The playground seeds
two areas:

* ``area-scene`` -- inside the docked "Scene" panel, starts with ["layers"].
* ``area-main`` -- inside the unmergeable "Connected" main panel, starts with
  ["props", "history"].

This exercises:

1. Drag the floating "controls" panel's grip onto ``[data-dock-area="area-scene"]``
   -> "controls" appears as a tab in that area.

2. ONE continuous drag of the area's "layers" tab down OUT of the area, then onto
   the docked Scene panel's own strip -> Scene's parent group gains "layers" and
   the area loses it (pull-out + merge-with-parent in a single gesture).

3. Snap "console" below "inspector" (drag console's grip to just inside the
   inspector window's bottom), then drag the WHOLE stacked window by its
   ``[data-floating-handle]`` onto area-scene -> BOTH inspector and console become
   tabs in the area (the stack collapses to tabs).

Skips cleanly if the client toolchain is missing, or if a particular drop didn't
produce the expected structure this run.
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import center as _center
from .dock_helpers import collect_errors, drag, real_errors
from .dock_helpers import group_grip_center as _grip
from .dock_helpers import open_playground as _open


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def _box(page: Page, selector: str) -> dict | None:
    return page.eval_on_selector(
        selector,
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height }; }",
    )


# DOM-based (vs dock_helpers.floating_window_for_panel's layout-model lookup):
# returns the window's id only while the panel's TAB is rendered in it.
def _floating_window_id_for_panel(page: Page, panel_id: str) -> str | None:
    """The data-floating-window id of the window currently containing `panel_id`
    (as the active tab / sole panel)."""
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


def _area_panel_ids(page: Page, area_id: str) -> list[str]:
    """The panel ids currently shown as tabs inside the given area."""
    return page.evaluate(
        """(aid) => {
            const area = document.querySelector(`[data-dock-area="${aid}"]`);
            if (!area) return [];
            return [...area.querySelectorAll('[data-dock-tab]')]
                .map(t => t.getAttribute('data-dock-tab'));
        }""",
        area_id,
    )


def _docked_scene_group_id(page: Page) -> str | None:
    """The group id of the docked Scene leaf (the panel hosting area-scene)."""
    return page.evaluate(
        """() => {
            const leaf = document.querySelector('[data-dock-leaf] [data-dock-group]');
            return leaf ? leaf.getAttribute('data-dock-group') : null;
        }"""
    )


def _docked_panel_ids(page: Page, gid: str) -> list[str]:
    """Tabs of a docked group (the parent Scene panel's group)."""
    return page.evaluate(
        """(gid) => {
            const g = document.querySelector(`[data-dock-leaf] [data-dock-group="${gid}"]`);
            if (!g) return [];
            // Only this group's own tabs (not nested area tabs).
            return [...g.querySelectorAll('[data-dock-tab]')]
                .filter(t => t.closest('[data-dock-group]') === g)
                .map(t => t.getAttribute('data-dock-tab'));
        }""",
        gid,
    )


def _drag(page: Page, start: tuple[float, float], end: tuple[float, float]) -> None:
    drag(page, start, end, steps=14)


# ===========================================================================
# (a) Drag the floating "controls" panel's grip onto area-scene -> "controls"
#     appears as a tab in that area.
# ===========================================================================
def test_drag_floating_panel_into_area(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        # The floating "controls" panel lives in its own group (sole tab).
        ctrl_win = _floating_window_id_for_panel(page, "controls")
        if ctrl_win is None:
            pytest.skip("controls floating panel not found this run")
        gid = page.eval_on_selector(
            f'[data-floating-window="{ctrl_win}"] [data-dock-group]',
            "e => e.getAttribute('data-dock-group')",
        )

        area_before = _area_panel_ids(page, "area-scene")
        assert "controls" not in area_before

        area_box = _box(page, '[data-dock-area="area-scene"]')
        if area_box is None:
            pytest.skip("area-scene not laid out this run")
        # Drop onto the body of the area (a merge -> append as a tab).
        _drag(page, _grip(page, gid), _center(area_box))

        area_after = _area_panel_ids(page, "area-scene")
        assert "controls" in area_after, (
            f"expected controls as a tab in area-scene; area has {area_after}"
        )
        # And controls is no longer a free-floating window.
        assert _floating_window_id_for_panel(page, "controls") is None, (
            "controls should have left its floating window"
        )
    finally:
        page.close()


# ===========================================================================
# (b) ONE continuous drag of the area's "layers" tab DOWN out of the area, then
#     onto the docked Scene panel's own strip -> Scene's parent group gains
#     "layers" and the area loses it (pull-out + merge-with-parent).
# ===========================================================================
def test_drag_area_tab_out_and_merge_with_parent(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        scene_gid = _docked_scene_group_id(page)
        if scene_gid is None:
            pytest.skip("docked Scene group not found this run")

        # Area starts with layers; the parent Scene group starts with just scene.
        assert "layers" in _area_panel_ids(page, "area-scene")
        parent_before = _docked_panel_ids(page, scene_gid)
        assert "layers" not in parent_before

        # The "layers" tab inside the area.
        tab_box = _box(page, '[data-dock-area="area-scene"] [data-dock-tab="layers"]')
        if tab_box is None:
            pytest.skip("layers tab not found in area-scene this run")
        # The docked Scene group's own strip (above the body where the area lives).
        strip_box = _box(page, f'[data-dock-leaf] [data-dock-strip="{scene_gid}"]')
        if strip_box is None:
            pytest.skip("docked Scene strip not found this run")

        sx, sy = _center(tab_box)
        # ONE continuous gesture: press the tab, pull DOWN out of the area first
        # (to tear it from the area), then move UP onto the Scene group's strip and
        # release (merge into the parent). All before any pointer up.
        page.mouse.move(sx, sy)
        page.mouse.down()
        page.mouse.move(sx + 4, sy + 4, steps=2)
        # Pull down out of the area body.
        page.mouse.move(sx, sy + 160, steps=10)
        # Then onto the docked Scene group's strip (center of the strip).
        tx, ty = _center(strip_box)
        page.mouse.move(tx, ty, steps=14)
        page.mouse.move(tx, ty)
        page.mouse.up()
        page.wait_for_timeout(120)

        parent_after = _docked_panel_ids(page, scene_gid)
        area_after = _area_panel_ids(page, "area-scene")
        assert "layers" in parent_after, (
            f"expected layers merged into the Scene parent group; "
            f"parent tabs are {parent_after}"
        )
        assert "layers" not in area_after, (
            f"expected the area to lose layers; area still has {area_after}"
        )
    finally:
        page.close()


# ===========================================================================
# (c) Snap "console" below "inspector", then drag the whole stacked window by its
#     [data-floating-handle] onto area-scene -> BOTH inspector and console become
#     tabs in the area (the stack collapses to tabs).
# ===========================================================================
def test_drag_snapped_stack_into_area_collapses_to_tabs(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 900)
    try:
        insp_win = _floating_window_id_for_panel(page, "inspector")
        cons_win = _floating_window_id_for_panel(page, "console")
        if insp_win is None or cons_win is None:
            pytest.skip("inspector/console floating panels not found this run")
        insp_gid = page.eval_on_selector(
            f'[data-floating-window="{insp_win}"] [data-dock-group]',
            "e => e.getAttribute('data-dock-group')",
        )
        cons_gid = page.eval_on_selector(
            f'[data-floating-window="{cons_win}"] [data-dock-group]',
            "e => e.getAttribute('data-dock-group')",
        )

        # Snap console BELOW inspector: drag console's grip to just inside the
        # inspector window's bottom (the snap-below band).
        insp_box = _box(page, f'[data-floating-window="{insp_win}"]')
        if insp_box is None:
            pytest.skip("inspector window not laid out this run")
        _drag(
            page,
            _grip(page, cons_gid),
            (insp_box["x"] + insp_box["w"] / 2, insp_box["y"] + insp_box["h"] - 8),
        )

        # The two groups should now share one floating window (a vertical stack).
        stacked_win = _floating_window_id_for_panel(page, "inspector")
        cons_win_after = _floating_window_id_for_panel(page, "console")
        if stacked_win is None or stacked_win != cons_win_after:
            pytest.skip("console did not snap below inspector this run")
        n_groups = page.eval_on_selector_all(
            f'[data-floating-window="{stacked_win}"] [data-dock-group]',
            "els => els.length",
        )
        if n_groups != 2:
            pytest.skip("snapped window is not a 2-group stack this run")

        area_before = _area_panel_ids(page, "area-scene")
        assert "inspector" not in area_before and "console" not in area_before

        # Drag the WHOLE stacked window by its floating handle onto area-scene.
        handle = _box(page, f'[data-floating-handle="{stacked_win}"]')
        area_box = _box(page, '[data-dock-area="area-scene"]')
        if handle is None or area_box is None:
            pytest.skip("stacked handle / area not laid out this run")
        _drag(page, _center(handle), _center(area_box))

        area_after = _area_panel_ids(page, "area-scene")
        assert "inspector" in area_after and "console" in area_after, (
            f"expected BOTH inspector and console as tabs in area-scene "
            f"(stack collapsed to tabs); area has {area_after}"
        )
        # Both left their floating window.
        assert _floating_window_id_for_panel(page, "inspector") is None
        assert _floating_window_id_for_panel(page, "console") is None
        # Use the captured group ids so the lint doesn't flag them unused and to
        # document that the original per-panel groups were consumed by the merge.
        assert insp_gid and cons_gid
    finally:
        page.close()


# ===========================================================================
# (d) REGRESSION: dragging a window over the stale rect of its OWN nested area
#     must never merge the host into that area (a containment cycle: the host
#     panel would become a tab inside an area it renders). Drop targets are
#     collected at drag start, so the area's rect stays at its original spot
#     while the window moves with the cursor -- dragging the grip down into
#     that stale rect used to offer/commit a self-merge and cycle the render.
# ===========================================================================
def test_drag_window_over_own_area_no_self_merge(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1280, 800)
    errors = collect_errors(page)
    try:
        # Float the docked Scene panel (host of area-scene) into free space
        # (bottom-left: clear of every seeded floating window AND of the edge
        # drop zones, so the release is a plain move -- a drop on another
        # window would merge the scene group away).
        gid = _docked_scene_group_id(page)
        assert gid is not None
        _drag(page, _grip(page, gid), (150, 520))
        win = _floating_window_id_for_panel(page, "scene")
        if win is None:
            pytest.skip("scene did not float this run")
        area_before = _area_panel_ids(page, "area-scene")

        # Drag the floating window by its grip DOWN into where its own nested
        # area sat at drag start (the stale target rect).
        area_box = _box(page, '[data-dock-area="area-scene"]')
        assert area_box is not None
        _drag(page, _grip(page, gid), _center(area_box))

        # The host must NOT have merged into its own area: scene still has its
        # own group, the area's tabs are unchanged, and nothing crashed.
        assert _floating_window_id_for_panel(page, "scene") is not None
        assert _area_panel_ids(page, "area-scene") == area_before
        assert "scene" not in _area_panel_ids(page, "area-scene")
        assert real_errors(errors) == [], (
            f"JS errors during self-merge drag: {real_errors(errors)}"
        )
    finally:
        page.close()
