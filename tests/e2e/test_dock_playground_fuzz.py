"""Exploratory (thin) E2E fuzz for the docking playground.

Drives randomized pointer-drag sequences against the dev playground and asserts
robustness properties rather than exact outcomes:

* no uncaught JS console errors / page errors during the whole run;
* no floating window ends up stuck fully off-screen (always at least partially
  reachable so the user can grab it back).

* no panel is ever lost or duplicated (the set of ``data-dock-tab`` PANEL ids is
  conserved across the whole sequence -- groups may merge/split, but panels must
  not vanish). This was a real bug -- random drags could lose a panel via a
  docked self-drop (BUG #2) or a floating self-snap (BUG #1); both are now FIXED,
  and these tests are the live regression guard (their unit-level counterparts
  are in ``src/viser/client/src/dock/layoutOps.bugs.test.ts``).

Skips cleanly if the client toolchain (``npx`` + ``node_modules``) is missing.
"""

from __future__ import annotations

import random

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import PLAYGROUND_PATH, collect_errors, drag, real_errors
from .dock_helpers import open_playground as _open


def _all_panel_ids(page: Page) -> list[str]:
    """Every panel id in the committed layout MODEL (the playground's
    ``window.__dockLayout`` test probe). We conserve PANELS, not groups: merging
    two groups into one tab strip legitimately reduces the group count while
    keeping all panels. The DOM is NOT a reliable conservation unit: tabs inside
    a nested area drop out of the DOM whenever the area's host panel body is
    hidden (host tab inactive, host minimized) even though no panel was lost."""
    return sorted(
        page.evaluate(
            "() => Object.values(window.__dockLayout.groups).flatMap(g => g.paneIds)"
        )
    )


def _grip_centers(page: Page) -> list[tuple[float, float]]:
    """Center of every grip handle currently on the page."""
    boxes = page.eval_on_selector_all(
        "[data-dock-griphandle]",
        """els => els.map(e => {
            const r = e.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2,
                     ok: r.width > 0 && r.height > 0 };
        })""",
    )
    return [(b["x"], b["y"]) for b in boxes if b["ok"]]


def _floating_offscreen(page: Page, vw: int, vh: int) -> list[str]:
    """Floating windows whose rect is entirely outside the viewport."""
    return page.evaluate(
        """([vw, vh]) => {
            const out = [];
            document.querySelectorAll('[data-floating-window]').forEach(w => {
                const r = w.getBoundingClientRect();
                const off = r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh;
                if (off) out.push(w.getAttribute('data-floating-window'));
            });
            return out;
        }""",
        [vw, vh],
    )


def _drag(page: Page, start: tuple[float, float], end: tuple[float, float]) -> None:
    drag(page, start, end, steps=5, settle_ms=40)


def _random_end(rng: random.Random, grips, start, vw: int, vh: int):
    choice = rng.random()
    if choice < 0.3:
        return (rng.uniform(vw - 30, vw - 5), rng.uniform(40, vh - 40))  # right edge
    if choice < 0.5:
        return (rng.uniform(5, 30), rng.uniform(40, vh - 40))  # left edge
    if choice < 0.8 and len(grips) > 1:
        return rng.choice([g for g in grips if g != start])  # onto another panel
    return (rng.uniform(100, vw - 100), rng.uniform(100, vh - 100))  # canvas


# The op-sequence space is fuzzed densely by the vitest fuzz suite; these few
# seeds only cover the real pointer-gesture wiring.
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_random_drags_never_throw_or_strand_windows(
    dock_context, vite_server: int, seed: int
) -> None:
    """Robustness: random drag storms must not raise JS errors or leave a
    floating window fully off-screen. (Panel conservation is asserted in the
    companion test below.)"""
    vw, vh = 1280, 800
    # Open by hand (not open_playground): the error collector must be attached
    # BEFORE navigation so load-time errors are also caught.
    page = dock_context.new_page()
    page.set_viewport_size({"width": vw, "height": vh})
    errors = collect_errors(page)
    try:
        page.goto(f"http://localhost:{vite_server}{PLAYGROUND_PATH}")
        page.wait_for_function(
            "() => document.querySelector('[data-dock-group]') !== null",
            polling=50,
        )
        rng = random.Random(seed)

        for _ in range(18):
            grips = _grip_centers(page)
            if not grips:
                break
            start = rng.choice(grips)
            _drag(page, start, _random_end(rng, grips, start, vw, vh))

            off = _floating_offscreen(page, vw, vh)
            assert off == [], f"floating window(s) off-screen at seed={seed}: {off}"

        assert real_errors(errors) == [], (
            f"JS errors during seed={seed}: {real_errors(errors)}"
        )
    finally:
        page.close()


# The op-sequence space is fuzzed densely by the vitest fuzz suite; these two
# seeds (3 = the historical step-1 panel loss, plus one other) cover the
# gesture wiring only.
@pytest.mark.parametrize("seed", [1, 3])
def test_random_drags_conserve_panels(
    dock_context, vite_server: int, seed: int
) -> None:
    """Regression guard for the live panel-loss bugs (now FIXED): a fixed-seed
    drag storm must never create or destroy a PANEL. Seed 3 used to lose a panel
    by step 1 (a docked self-drop, BUG #2); other seeds hit the floating
    self-snap path (BUG #1). We conserve panel ids from the layout MODEL (via
    the ``window.__dockLayout`` probe), NOT group ids -- merging two groups into
    one tab strip legitimately removes a group while keeping every panel."""
    vw, vh = 1280, 800
    page = _open(dock_context, vite_server, vw, vh)
    try:
        expected = _all_panel_ids(page)
        rng = random.Random(seed)

        for step in range(18):
            grips = _grip_centers(page)
            if not grips:
                break
            start = rng.choice(grips)
            _drag(page, start, _random_end(rng, grips, start, vw, vh))
            assert _all_panel_ids(page) == expected, (
                f"panel set changed at seed={seed} step={step}: "
                f"{_all_panel_ids(page)} != {expected}"
            )
    finally:
        page.close()


# Multi-column seed: start from a region with sibling columns (one RAILED,
# one a 2-leaf stack) so the random storm exercises the D46 column paths --
# column inserts at side bands, in-column seam inserts, rail cells, and
# dropping onto/around rails -- which the playground default (no docked
# columns) never reaches.
@pytest.mark.parametrize("seed", [1, 2, 5])
def test_random_drags_multicolumn_seed_conserve_and_no_errors(
    dock_context, vite_server: int, seed: int
) -> None:
    from .dock_helpers import columns, dock_layout, set_layout, stack, window

    vw, vh = 1280, 900
    page = dock_context.new_page()
    page.set_viewport_size({"width": vw, "height": vh})
    errors = collect_errors(page)
    try:
        page.goto(f"http://localhost:{vite_server}{PLAYGROUND_PATH}")
        page.wait_for_function(
            "() => document.querySelector('[data-dock-group]') !== null",
            polling=50,
        )
        # Right edge: [controls(railed) | inspector+console stack]; a
        # floating `scene` to drag around. (scene is a non-area, mergeable
        # pane -- the area panes layers/props/history can't be reused here
        # without putting a pane in two groups.) The railed column keeps a
        # rail surface in the storm (D28/D38).
        set_layout(
            page,
            dock_layout(
                docked_right=columns(
                    stack("controls", railed=True),
                    stack("inspector", "console"),
                ),
                floating=[window("scene", x=200, y=200)],
            ),
        )
        expected = _all_panel_ids(page)
        rng = random.Random(seed)
        for step in range(18):
            grips = _grip_centers(page)
            if not grips:
                break
            start = rng.choice(grips)
            _drag(page, start, _random_end(rng, grips, start, vw, vh))
            off = _floating_offscreen(page, vw, vh)
            assert off == [], f"off-screen window at seed={seed} step={step}: {off}"
            assert _all_panel_ids(page) == expected, (
                f"panel set changed at seed={seed} step={step}: "
                f"{_all_panel_ids(page)} != {expected}"
            )
        assert real_errors(errors) == [], (
            f"JS errors during multiband seed={seed}: {real_errors(errors)}"
        )
    finally:
        page.close()
