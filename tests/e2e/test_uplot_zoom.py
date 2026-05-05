"""E2E tests for uPlot zoom preservation in viser.

Exercises the ``transformScales`` rewrite and its memoization in
``src/viser/client/src/components/UplotComponent.tsx`` against a real
Chromium-hosted uPlot instance.

The bug: a tuple ``range`` on the x-scale becomes a hard ``fnOrSelf``
wrapper inside uPlot, and every commit (including the redraw uplot-react
issues on data updates) re-applies that wrapper — silently reverting any
user drag-to-zoom.

Tests reach into the chart through ``window.__viserTestpoints.uplots[uuid]``
exposed by ``UplotComponent.tsx``: ``{chart, createCount}``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from playwright.sync_api import Page

import viser
import viser.uplot

def _wait_for_chart(page: Page, uuid: str) -> None:
    page.wait_for_function(
        """(uuid) => {
            const tp = window.__viserTestpoints;
            return tp && tp.uplots && tp.uplots[uuid] && tp.uplots[uuid].chart;
        }""",
        arg=uuid,
        timeout=10_000,
    )


def _eval_uplot(page: Page, uuid: str, expr: str) -> Any:
    """Evaluate ``expr`` in the page with ``entry`` (the testpoint
    ``{chart, createCount}``) and ``ch`` (alias of ``entry.chart``) bound."""
    return page.evaluate(
        f"""(uuid) => {{
            const entry = window.__viserTestpoints.uplots[uuid];
            const ch = entry.chart;
            return {expr};
        }}""",
        uuid,
    )


def _make_data(n: int = 100) -> tuple[np.ndarray, np.ndarray]:
    x = np.linspace(-100.0, 0.0, n, dtype=np.float64)
    y = np.sin(x * 0.1).astype(np.float64)
    return x, y


def test_x_zoom_survives_data_update_with_tuple_range(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """The original bug: tuple x-range + setData must not revert user zoom."""
    x, y = _make_data()
    handle = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={
            "x": viser.uplot.Scale(time=False, auto=False, range=(-100.0, 0.0)),
            "y": viser.uplot.Scale(auto=True),
        },
        aspect=2.0,
        title="zoom-survives-data",
    )
    uuid = handle._impl.uuid

    _wait_for_chart(viser_page, uuid)
    _eval_uplot(viser_page, uuid, "ch.setScale('x', {min: -50, max: -10})")
    assert _eval_uplot(viser_page, uuid, "[ch.scales.x.min, ch.scales.x.max]") == [
        -50.0,
        -10.0,
    ]

    # Pre-fix: each data update fires redraw() → _setScale(x, scaleX.min,
    # scaleX.max) → the static-range fnOrSelf would override scaleX.min/max
    # with (-100, 0).
    for _ in range(3):
        x2 = x + 1.0  # shift so something actually changes wire-side
        y2 = np.cos(x2 * 0.1).astype(np.float64)
        handle.data = (x2, y2)

    viser_page.wait_for_timeout(300)
    after = _eval_uplot(viser_page, uuid, "[ch.scales.x.min, ch.scales.x.max]")
    assert after == [-50.0, -10.0], f"Zoom reverted after data update: got {after}"


def test_x_zoom_survives_viewport_resize(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Resize regression: rebuilding ``processedScales`` on every render
    caused uplot-react to recreate the chart on container-width changes,
    which silently lost the user's zoom. Chart instance must persist."""
    x, y = _make_data()
    handle = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={
            "x": viser.uplot.Scale(time=False, auto=False, range=(-100.0, 0.0)),
            "y": viser.uplot.Scale(auto=True),
        },
        aspect=2.0,
        title="zoom-survives-resize",
    )
    uuid = handle._impl.uuid

    _wait_for_chart(viser_page, uuid)
    initial_count = _eval_uplot(viser_page, uuid, "entry.createCount")

    _eval_uplot(viser_page, uuid, "ch.setScale('x', {min: -75, max: -25})")

    viser_page.set_viewport_size({"width": 1024, "height": 768})
    viser_page.wait_for_timeout(150)
    viser_page.set_viewport_size({"width": 1400, "height": 900})
    viser_page.wait_for_timeout(150)

    after = _eval_uplot(viser_page, uuid, "[ch.scales.x.min, ch.scales.x.max]")
    after_count = _eval_uplot(viser_page, uuid, "entry.createCount")

    assert after == [-75.0, -25.0], f"Zoom reverted on resize: got {after}"
    assert after_count == initial_count, (
        f"Chart was recreated {after_count - initial_count} time(s) on resize. "
        "uplot-react detected a fresh `scales` reference — processedScales "
        "memoization regression."
    )


def test_y_tuple_range_remains_locked(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Non-x tuple ranges must stay hard-locked. An earlier iteration
    rewrote every tuple range, which made the y-axis fit to data instead
    of honoring the static bounds — broke ``examples/02_gui/08_uplot.py``."""
    x = np.linspace(0.0, 1.0, 64, dtype=np.float64)
    y = np.sin(x * 6.28).astype(np.float64)  # values in roughly [-1, 1]

    handle = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={
            "x": viser.uplot.Scale(time=False, auto=True),
            "y": viser.uplot.Scale(range=(-1.5, 2.5)),
        },
        aspect=2.0,
        title="y-stays-locked",
    )
    uuid = handle._impl.uuid

    _wait_for_chart(viser_page, uuid)
    yrange = _eval_uplot(viser_page, uuid, "[ch.scales.y.min, ch.scales.y.max]")
    assert yrange == [-1.5, 2.5], (
        f"Y-axis fit to data instead of staying locked at (-1.5, 2.5): "
        f"got {yrange}. Smart-range transform leaked into y-scale."
    )


def test_x_tuple_range_without_explicit_auto_locks_initial_bounds(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """``Scale(range=(a, b))`` without an explicit ``auto=False`` must still
    show ``[a, b]`` initially. uPlot normally forces ``auto=false`` when the
    range field is an array (uPlot.cjs.js:3070); the smart-range transform
    replaces the array with a function before uPlot sees it, defeating that
    forcing — so the rewritten scale must pin ``auto=false`` itself.

    Data is intentionally outside the configured range so a regression
    (auto-fitting to data) is observable."""
    x = np.linspace(-50.0, 50.0, 64, dtype=np.float64)
    y = np.sin(x * 0.1).astype(np.float64)

    handle = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={
            # Note: no `auto=False` — relying on uPlot's tuple-range semantic.
            "x": viser.uplot.Scale(time=False, range=(-100.0, 0.0)),
            "y": viser.uplot.Scale(auto=True),
        },
        aspect=2.0,
        title="x-locked-without-explicit-auto",
    )
    uuid = handle._impl.uuid

    _wait_for_chart(viser_page, uuid)
    xrange = _eval_uplot(viser_page, uuid, "[ch.scales.x.min, ch.scales.x.max]")
    assert xrange == [-100.0, 0.0], (
        f"X-scale fit to data ({xrange}) instead of honoring tuple "
        "range (-100, 0). transformScales must preserve uPlot's "
        "implicit `auto=false` for array ranges."
    )
