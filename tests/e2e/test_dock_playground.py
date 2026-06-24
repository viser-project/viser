"""Thin E2E smoke tests for the docking library, driven against the dev
playground (``src/viser/client/dock_test.html``) -- a standalone Vite entry
point with no WebSocket/3D scene (see ``conftest.py``'s ``vite_server``).

Coverage (smoke level -- assert the gesture produces the expected structural
change, not pixel-perfect geometry):

* dock-to-screen-edge: drag a floating panel into the empty right screen edge.
* tab tear-out: drag a docked panel's grip out to a free area -> it floats.
* tab reorder: drag one tab past another within a group.
* snap two floating panels: drag one floating panel onto another -> one window.
* minimize-via-button: clicking the dedicated minimize button collapses/restores
  (and a no-motion tap on the drag handle does NOT collapse, by design).
"""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import center as _center
from .dock_helpers import drag, open_playground
from .dock_helpers import floating_group_ids as _floating_group_ids


@pytest.fixture()
def page(dock_context, vite_server: int) -> Generator[Page, None, None]:
    pg = open_playground(dock_context, vite_server)
    yield pg
    pg.close()


def _drag(
    page: Page,
    start: tuple[float, float],
    end: tuple[float, float],
    steps: int = 20,
) -> None:
    drag(page, start, end, steps=steps)


def _group_count(page: Page) -> int:
    return page.locator("[data-dock-group]").count()


def _docked_leaf_count(page: Page, edge: str | None = None) -> int:
    sel = (
        "[data-dock-leaf]"
        if edge is None
        else f'[data-dock-leaf][data-dock-edge="{edge}"]'
    )
    return page.locator(sel).count()


# ---------------------------------------------------------------------------
# Smoke tests.
# ---------------------------------------------------------------------------
def test_dock_to_screen_edge(page: Page) -> None:
    """Drag a floating panel's grip into the empty right screen edge; it should
    become a docked leaf on the right."""
    assert _docked_leaf_count(page, "right") == 0
    floating_before = len(_floating_group_ids(page))

    # Grab the grip of the first floating group (controls) and drag to the far
    # right edge band.
    floating_ids = _floating_group_ids(page)
    assert floating_ids, "expected floating groups in the playground"
    grip = page.locator(
        f'[data-dock-group="{floating_ids[0]}"] [data-dock-griphandle]'
    ).first
    start = _center(grip.bounding_box())  # type: ignore[arg-type]
    vw = page.viewport_size["width"]  # type: ignore[index]
    _drag(page, start, (vw - 10, 400))

    assert _docked_leaf_count(page, "right") >= 1
    assert len(_floating_group_ids(page)) == floating_before - 1


def test_tab_tear_out(page: Page) -> None:
    """Drag the docked Scene panel's grip out into open canvas; it should detach
    into a floating window (the left edge becomes empty). Counted in WINDOWS,
    not groups: the Scene panel hosts a nested dockable area, so floating it
    moves two groups (host + area) out from under the leaf at once."""
    assert _docked_leaf_count(page, "left") == 1
    floating_before = page.locator("[data-floating-window]").count()

    grip = page.locator("[data-dock-leaf] [data-dock-griphandle]").first
    start = _center(grip.bounding_box())  # type: ignore[arg-type]
    # Drop into the lower-right corner: clear of the left dock region AND of
    # every floating window in the playground (which cluster upper-center), so
    # the panel floats free rather than snapping/merging into another window.
    _drag(page, start, (950, 720))

    assert _docked_leaf_count(page, "left") == 0
    assert page.locator("[data-floating-window]").count() == floating_before + 1


def _strip_order(page: Page, group_id: str) -> list[str | None]:
    tabs = page.locator(
        f'[data-dock-group="{group_id}"] [data-dock-strip] [data-dock-tab]'
    )
    return [tabs.nth(i).get_attribute("data-dock-tab") for i in range(tabs.count())]


def test_tab_reorder(page: Page) -> None:
    """Merge two floating panels into a tab group, then drag the second tab
    before the first; the tab order should swap."""
    # First, merge two floating groups so we have a 2-tab strip to reorder. We
    # aim at ~45% of the target's height -- the center "merge" band, clear of the
    # lower "snap-below" band.
    ids = _floating_group_ids(page)
    assert len(ids) >= 2
    src_id, tgt_id = ids[0], ids[1]
    src_grip = page.locator(
        f'[data-dock-group="{src_id}"] [data-dock-griphandle]'
    ).first
    tb = page.locator(f'[data-dock-group="{tgt_id}"]').first.bounding_box()
    assert tb is not None
    _drag(
        page,
        _center(src_grip.bounding_box()),  # type: ignore[arg-type]
        (tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] * 0.45),
    )

    order_before = _strip_order(page, tgt_id)
    assert len(order_before) == 2, (
        f"merge should yield a 2-tab strip, got {order_before}"
    )

    # Drag the last tab to the front of the strip.
    tabs = page.locator(
        f'[data-dock-group="{tgt_id}"] [data-dock-strip] [data-dock-tab]'
    )
    last_box = tabs.nth(1).bounding_box()
    first_box = tabs.nth(0).bounding_box()
    assert last_box is not None and first_box is not None
    _drag(
        page,
        _center(last_box),
        (first_box["x"] + 4, first_box["y"] + first_box["height"] / 2),
    )

    order_after = _strip_order(page, tgt_id)
    assert order_after == list(reversed(order_before)), (
        f"expected order to swap: {order_before} -> {order_after}"
    )


def test_snap_two_floating_panels(page: Page) -> None:
    """Drag one floating panel onto the bottom of another; they should snap into
    one window (one fewer floating window, both groups still present)."""
    ids = _floating_group_ids(page)
    assert len(ids) >= 2
    groups_before = _group_count(page)
    src_id, tgt_id = ids[0], ids[1]

    src_grip = page.locator(
        f'[data-dock-group="{src_id}"] [data-dock-griphandle]'
    ).first
    target = page.locator(f'[data-dock-group="{tgt_id}"]').first
    tb = target.bounding_box()
    assert tb is not None
    # Aim at the lower portion of the target -> snap-below band.
    drop = (tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] - 8)
    _drag(page, _center(src_grip.bounding_box()), drop)  # type: ignore[arg-type]

    # Both groups still exist (snap doesn't merge tabs into one strip), and they
    # now live in the SAME floating window -- detected structurally via their
    # nearest common ancestor (the window Paper holding exactly these groups).
    assert _group_count(page) == groups_before
    co_located = page.evaluate(
        """([a, b]) => {
            const ea = document.querySelector(`[data-dock-group="${a}"]`);
            const eb = document.querySelector(`[data-dock-group="${b}"]`);
            if (!ea || !eb) return false;
            // Walk up from a to the nearest ancestor that also contains b: their
            // common container. When snapped into one window, that container is
            // the window Paper holding exactly these two groups (not the page
            // body, which would mean they're still in separate windows).
            let node = ea.parentElement;
            while (node) {
                if (node.contains(eb)) break;
                node = node.parentElement;
            }
            if (!node) return false;
            const groupsInside = node.querySelectorAll('[data-dock-group]').length;
            return groupsInside === 2 && node !== document.body;
        }""",
        [src_id, tgt_id],
    )
    assert co_located, "expected the two panels to share one floating window"


def _docked_collapsed(page: Page) -> bool:
    """Whether the docked group is minimized (via its data-dock-collapsed flag).
    The handle bar is now DRAG-ONLY; a dedicated minimize button toggles state,
    so a no-motion press on the handle intentionally does nothing."""
    return (
        page.locator(
            '[data-dock-leaf] [data-dock-group][data-dock-collapsed="true"]'
        ).count()
        > 0
    )


def _wait_collapsed(page: Page, want: bool) -> None:
    """Poll until the docked group's collapsed state matches `want` (avoids
    fixed-sleep flakiness when the machine is busy)."""
    page.wait_for_function(
        """(want) => {
            const el = document.querySelector('[data-dock-leaf] [data-dock-group]');
            return !!el && (el.getAttribute('data-dock-collapsed') === 'true') === want;
        }""",
        arg=want,
        timeout=3000,
    )


def test_minimize_via_button(page: Page) -> None:
    """Clicking the dedicated minimize button (data-dock-minimize) toggles the
    group's collapsed state; a second click restores it. (The grip handle is
    drag-only -- a no-motion press there does nothing by design.)"""
    btn = page.locator("[data-dock-leaf] [data-dock-minimize]").first
    assert btn.count() > 0, "expected a minimize button on the docked group"
    assert not _docked_collapsed(page), "should start expanded"

    btn.click()
    _wait_collapsed(page, True)

    btn.click()
    _wait_collapsed(page, False)


def test_handle_tap_toggles_minimize(page: Page) -> None:
    """A motionless tap anywhere on the grip HANDLE toggles minimize/expand --
    consistent with the main panel's header. (A real drag still moves the panel;
    the click-vs-drag threshold keeps a tap from being read as a drag.)"""
    leaf_grip = page.locator("[data-dock-leaf] [data-dock-griphandle]").first
    box = leaf_grip.bounding_box()
    assert box is not None
    cx, cy = _center(box)

    assert not _docked_collapsed(page)
    # Tap (no motion) -> collapses.
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.up()
    page.wait_for_timeout(120)
    assert _docked_collapsed(page), "a no-motion handle tap should collapse"

    # Tap again -> expands. (The collapsed strip's cell is the handle now.)
    strip = page.locator("[data-dock-group][data-dock-collapsed]").first
    sbox = strip.bounding_box()
    assert sbox is not None
    sx, sy = _center(sbox)
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.up()
    page.wait_for_timeout(120)
    assert not _docked_collapsed(page), "a tap on the collapsed handle should expand"
