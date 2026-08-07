"""E2E regression tests for the mobile (<=576px-wide) breakpoint.

Two bugs fixed in the v1.0.30 regression audit are pinned here:

1. Mobile canvas remount (App.tsx): ``useMediaQuery`` used to read the mobile
   media query in an effect, so a mobile-width load rendered desktop-first,
   mounted the canvas inside the dock surface, then flipped on the next render
   -- remounting the entire canvas subtree and creating (then throwing away) a
   WebGL context. The fix reads matchMedia synchronously on first render, so a
   mobile load creates exactly as many WebGL contexts as a desktop load and
   never tears a canvas element down. An init script installed before any page
   JS counts WebGL context acquisitions AND canvas-element removals; both are
   compared against a desktop-load self-baseline instead of hardcoded values.
   (The removal probe is what catches the remount deterministically: in fast
   headless runs the desktop-first canvas is destroyed before R3F's async GL
   init, so the throwaway context -- the extra count -- may never material-
   ize, while the create-then-destroy of the canvas element always does.)

2. Mobile bottom-sheet panel updates (ControlPanel.tsx / PanelsFallback): the
   panel-list subscription used key-set equality, but ``updatePanel`` replaces
   the panel object for the updated uuid (same key set), so server-side
   visible/order updates never re-rendered the sheet. The fix subscribes with
   value-level equality; we assert a server-side ``visible`` toggle actually
   hides (and re-shows) a panel's section in the sheet.

Both tests drive real mobile-sized browser contexts (the conftest ``page``
fixture is desktop-sized, so contexts are created per test here).
"""

from __future__ import annotations

from playwright.sync_api import Browser, BrowserContext, Page, expect

import viser

from .utils import wait_for_connection

# The suite's standard desktop viewport (conftest._E2E_VIEWPORT), used for the
# self-baseline load; comfortably above the 576px (36em) mobile breakpoint.
_DESKTOP_VIEWPORT = {"width": 960, "height": 600}
# iPhone-ish portrait viewport; what matters is width <= 576px so the client's
# `(max-width: ${theme.breakpoints.xs})` query matches.
_MOBILE_VIEWPORT = {"width": 390, "height": 844}

# Installed via context.add_init_script, so it runs before any page JS.
#
# Two probes, both read against a desktop-load self-baseline:
#
# * __webglContextCount: patches getContext to count each canvas that
#   successfully acquires a webgl/webgl2 context AT MOST ONCE (repeat
#   getContext calls on the same canvas return the same context and must not
#   inflate the count); 2D contexts are ignored. When the throwaway canvas
#   lives long enough to initialize GL (real GPUs, slow runners), the pre-fix
#   remount shows up as one extra count.
# * __canvasRemovals: a MutationObserver counting <canvas> elements removed
#   from the document. The pre-fix desktop-first render mounted the canvas
#   subtree and REMOVED it when the media-query effect flipped to mobile --
#   observable even when the flip wins the race against R3F's async GL init
#   (fast headless runs), where the context count alone would miss it. The
#   observer targets `document` (documentElement does not exist yet at
#   init-script time).
_WEBGL_COUNT_INIT = """
(() => {
  window.__webglContextCount = 0;
  window.__canvasRemovals = 0;
  const counted = new WeakSet();
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = orig.call(this, type, ...args);
    if (
      ctx !== null &&
      (type === "webgl" || type === "webgl2" || type === "experimental-webgl") &&
      !counted.has(this)
    ) {
      counted.add(this);
      window.__webglContextCount += 1;
    }
    return ctx;
  };
  const countCanvases = (node) => {
    if (!(node instanceof Element)) return 0;
    return (
      (node instanceof HTMLCanvasElement ? 1 : 0) +
      node.querySelectorAll("canvas").length
    );
  };
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const removed of m.removedNodes) {
        window.__canvasRemovals += countCanvases(removed);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
})();
"""


def _load_and_measure_canvas_churn(
    browser: Browser, port: int, viewport: dict
) -> tuple[int, int]:
    """Load the client at `viewport` in a fresh context (with the probing
    init script installed) and return ``(webgl_context_count,
    canvas_removals)`` observed during startup."""
    context = browser.new_context(
        viewport=viewport, device_scale_factor=1, reduced_motion="reduce"
    )
    try:
        context.add_init_script(_WEBGL_COUNT_INIT)
        page = context.new_page()
        wait_for_connection(page, port)
        # At least the live scene canvas must have acquired a context.
        page.wait_for_function("() => window.__webglContextCount >= 1", timeout=15_000)
        # The pre-fix remount happened on the render right after the
        # media-query effect (a frame or two after first mount), so give the
        # probes a generous settle window before reading them -- a remount
        # inside this window lands as an extra count / removal.
        page.wait_for_timeout(800)
        return (
            page.evaluate("() => window.__webglContextCount"),
            page.evaluate("() => window.__canvasRemovals"),
        )
    finally:
        context.close()


def test_mobile_load_does_not_remount_canvas(
    browser: Browser, viser_server: viser.ViserServer
) -> None:
    """A mobile-width load must not create-then-destroy the canvas subtree:
    no extra WebGL context and no canvas removals beyond what a desktop load
    shows (pre-fix: the desktop-first render mounted the canvases inside the
    dock surface and remounted them when the media-query effect flipped)."""
    port = viser_server.get_port()

    # Self-baseline: what a desktop load does (measured, not hardcoded --
    # capability probes may legitimately touch extra canvases).
    desktop_count, desktop_removals = _load_and_measure_canvas_churn(
        browser, port, _DESKTOP_VIEWPORT
    )
    assert desktop_count >= 1

    mobile_count, mobile_removals = _load_and_measure_canvas_churn(
        browser, port, _MOBILE_VIEWPORT
    )

    # No canvas element may be torn down during a mobile load (the remount is
    # observable as removals even when it wins the race against R3F's async
    # GL init, in which case the thrown-away canvas never acquired a context).
    assert mobile_removals == desktop_removals, (
        f"mobile-width load removed {mobile_removals} canvas element(s) vs "
        f"{desktop_removals} on desktop -- the canvas subtree was mounted "
        "desktop-first and remounted for mobile"
    )
    # And when the throwaway canvas DID live long enough to initialize GL,
    # it shows up as an extra context creation.
    assert mobile_count == desktop_count, (
        f"mobile-width load created {mobile_count} WebGL context(s) vs "
        f"{desktop_count} on desktop -- an extra context means a "
        "created-then-destroyed canvas"
    )


def _mobile_context(browser: Browser) -> BrowserContext:
    return browser.new_context(
        viewport=_MOBILE_VIEWPORT, device_scale_factor=1, reduced_motion="reduce"
    )


def _section(page: Page, label: str):
    """A collapsed panel section row in the mobile bottom sheet
    (MobilePanelSection renders the collapsed header as a role=button with an
    'Expand panel <label>' aria-label)."""
    return page.get_by_role("button", name=f"Expand panel {label}")


def test_mobile_bottom_sheet_reflects_panel_updates(
    browser: Browser, viser_server: viser.ViserServer
) -> None:
    """Server-side panel prop updates must propagate to the mobile bottom
    sheet: visible=False removes the section, visible=True restores it
    (pre-fix: the sheet's key-set-equality subscription swallowed the update
    and kept rendering the stale panel list)."""
    context = _mobile_context(browser)
    try:
        page = context.new_page()
        wait_for_connection(page, viser_server.get_port())

        panel_a = viser_server.gui.add_panel(order=1)
        with panel_a.add_tab("Alpha"):
            viser_server.gui.add_markdown("alpha content")
        panel_b = viser_server.gui.add_panel(order=2)
        with panel_b.add_tab("Beta"):
            viser_server.gui.add_markdown("beta content")

        # Both panels appear as sections of the mobile bottom sheet.
        expect(_section(page, "Alpha")).to_be_visible(timeout=10_000)
        expect(_section(page, "Beta")).to_be_visible(timeout=10_000)

        # A server-side visibility update must actually render: Beta's section
        # disappears while Alpha's stays.
        panel_b.visible = False
        expect(_section(page, "Beta")).to_have_count(0, timeout=10_000)
        expect(_section(page, "Alpha")).to_be_visible()

        # And the reverse update re-renders too.
        panel_b.visible = True
        expect(_section(page, "Beta")).to_be_visible(timeout=10_000)
    finally:
        context.close()
