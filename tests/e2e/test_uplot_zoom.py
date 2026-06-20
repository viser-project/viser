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

import os
from typing import Any, Generator

import numpy as np
import pytest
from playwright.sync_api import Page

import viser
import viser.uplot


@pytest.fixture()
def uplot_render_sync(viser_page: Page) -> Generator[Page, None, None]:
    """Force synchronous per-mutation rendering for zoom-preservation tests.

    ``test_x_zoom_survives_data_update_with_tuple_range`` exercises a render-
    timing-sensitive path: rapid ``setData`` updates trigger uplot-react
    re-renders, and the tuple-range zoom must survive them. In a real browser
    this works -- verified directly in a HEADED, real-GPU Chromium: zoom to
    [-50,-10], then a no-spacing burst of 5 ``handle.data=`` updates (all
    applied, confirmed via ``chart.data``) leaves the zoom at [-50,-10]. But the
    headless pytest-playwright context coalesces those re-renders such that the
    static range wrapper is re-applied and the zoom reverts -- a harness
    artifact, not a client bug.

    Playwright's DOM snapshotter (enabled by trace capture) incidentally forces
    each re-render to flush, which is the only reason these assertions passed
    before capture was disabled by default for speed (see ``conftest.py``). We
    re-create just that effect here with snapshots-only tracing -- cheap for a
    single lightweight plot -- so the test reflects real-browser behavior
    without paying tracing's cost across the whole suite."""
    # When VISER_E2E_CAPTURE is set, pytest-playwright already started tracing on
    # this context (so the snapshotter -- the effect we need -- is live, and a
    # second start() would raise "Tracing has been already started"). No-op then.
    if os.environ.get("VISER_E2E_CAPTURE"):
        yield viser_page
        return
    viser_page.context.tracing.start(snapshots=True, screenshots=False)
    try:
        yield viser_page
    finally:
        viser_page.context.tracing.stop()


def _wait_for_chart(page: Page, uuid: str) -> None:
    page.wait_for_function(
        """(uuid) => {
            const tp = window.__viserTestpoints;
            return tp && tp.uplots && tp.uplots[uuid] && tp.uplots[uuid].chart;
        }""",
        arg=uuid,
        timeout=10_000,
    )


# uPlot commits a setScale() (and any dblclick/redraw-driven rescale) on its
# *next* animation frame, not synchronously. Reading scales.x.min/max right
# after therefore races the frame, and whether the read wins depends on
# incidental paint cadence -- which is why these assertions only passed with
# Playwright tracing enabled (it drove enough frames to mask the race). Awaiting
# two rAFs inside the evaluate forces a deterministic commit in any context.
_AWAIT_TWO_FRAMES = (
    "await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));"
)


def _set_x_scale(page: Page, uuid: str, xmin: float, xmax: float) -> Any:
    """Set uPlot's x-scale and return the committed ``[min, max]`` after a frame."""
    return page.evaluate(
        f"""async ([uuid, xmin, xmax]) => {{
            const ch = window.__viserTestpoints.uplots[uuid].chart;
            ch.setScale('x', {{min: xmin, max: xmax}});
            {_AWAIT_TWO_FRAMES}
            return [ch.scales.x.min, ch.scales.x.max];
        }}""",
        [uuid, xmin, xmax],
    )


def _read_x_scale(page: Page, uuid: str) -> Any:
    """Read uPlot's committed x-scale ``[min, max]`` after flushing a frame."""
    return page.evaluate(
        f"""async (uuid) => {{
            const ch = window.__viserTestpoints.uplots[uuid].chart;
            {_AWAIT_TWO_FRAMES}
            return [ch.scales.x.min, ch.scales.x.max];
        }}""",
        uuid,
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
    uplot_render_sync: Page,
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
    assert _set_x_scale(viser_page, uuid, -50.0, -10.0) == [-50.0, -10.0]

    # Pre-fix: each data update fires redraw() → _setScale(x, scaleX.min,
    # scaleX.max) → the static-range fnOrSelf would override scaleX.min/max
    # with (-100, 0).
    for _ in range(3):
        x2 = x + 1.0  # shift so something actually changes wire-side
        y2 = np.cos(x2 * 0.1).astype(np.float64)
        handle.data = (x2, y2)

    after = _read_x_scale(viser_page, uuid)
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

    assert _set_x_scale(viser_page, uuid, -75.0, -25.0) == [-75.0, -25.0]

    viser_page.set_viewport_size({"width": 1024, "height": 768})
    viser_page.wait_for_timeout(150)
    viser_page.set_viewport_size({"width": 1400, "height": 900})
    viser_page.wait_for_timeout(150)

    after = _read_x_scale(viser_page, uuid)
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


def test_partial_null_x_range_resolves_to_data_extrema(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """``Scale(range=(None, b))`` and ``Scale(range=(a, None))`` mean
    "auto on the null side, locked on the other." uPlot's own array-range
    path skips this conversion for x in mode 1 (uPlot.cjs.js:3041 is
    gated to non-x), so we resolve the null side ourselves from the data
    extrema."""
    x = np.linspace(-50.0, 50.0, 64, dtype=np.float64)
    y = np.sin(x * 0.1).astype(np.float64)

    none_max = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={"x": viser.uplot.Scale(time=False, range=(None, 0.0))},
        aspect=2.0,
        title="partial-null-min",
    )
    _wait_for_chart(viser_page, none_max._impl.uuid)
    bounds = _eval_uplot(
        viser_page, none_max._impl.uuid, "[ch.scales.x.min, ch.scales.x.max]"
    )
    assert bounds == [-50.0, 0.0], (
        f"(None, 0) should resolve null-min to data min (-50); got {bounds}"
    )

    none_min = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={"x": viser.uplot.Scale(time=False, range=(0.0, None))},
        aspect=2.0,
        title="partial-null-max",
    )
    _wait_for_chart(viser_page, none_min._impl.uuid)
    bounds = _eval_uplot(
        viser_page, none_min._impl.uuid, "[ch.scales.x.min, ch.scales.x.max]"
    )
    assert bounds == [0.0, 50.0], (
        f"(0, None) should resolve null-max to data max (50); got {bounds}"
    )


def test_dblclick_resets_x_tuple_range_to_user_bounds(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Double-clicking the plot must reset the x-axis to the caller's
    tuple, not fit-to-data. uPlot's default dblclick handler runs
    autoScaleX → snaps to data extrema; we override it via
    ``cursor.bind.dblclick`` so a tuple-range plot still feels "locked"
    on reset."""
    x = np.linspace(-50.0, 50.0, 64, dtype=np.float64)
    y = np.sin(x * 0.1).astype(np.float64)

    handle = viser_server.gui.add_uplot(
        data=(x, y),
        series=(viser.uplot.Series(label="t"), viser.uplot.Series(label="v")),
        scales={
            "x": viser.uplot.Scale(time=False, auto=False, range=(-100.0, 0.0)),
            "y": viser.uplot.Scale(auto=True),
        },
        aspect=2.0,
        title="dblclick-resets-to-tuple",
    )
    uuid = handle._impl.uuid

    _wait_for_chart(viser_page, uuid)
    assert _set_x_scale(viser_page, uuid, -25.0, -5.0) == [-25.0, -5.0]

    # Dispatch dblclick on the chart's `over` element (where uPlot binds).
    _eval_uplot(
        viser_page,
        uuid,
        """(() => {
            const evt = new MouseEvent('dblclick', {
                bubbles: true, cancelable: true, button: 0,
            });
            ch.over.dispatchEvent(evt);
            return null;
        })()""",
    )

    after = _read_x_scale(viser_page, uuid)
    assert after == [-100.0, 0.0], (
        f"Dblclick should reset x to (-100, 0); got {after}. The "
        "cursor.bind.dblclick override likely isn't installed."
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
