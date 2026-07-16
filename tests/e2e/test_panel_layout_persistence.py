"""E2E tests for panel-layout persistence across a websocket RECONNECT.

The server's placement commands (``dock_*`` / ``float`` / ``set_width`` /
``minimize``) are write-only and REPLAYED to a (re)connecting client. Without
care, a reconnect re-applies the original placement and clobbers a layout the
user rearranged in the browser. To prevent that, each placement message carries
a counter, and the client tracks (per panel uuid, per axis, per run) the
highest counter it has APPLIED -- there is no separate "user moved" bit (D52):

* a replayed command (counter at or below its own run's applied mark) never
  re-applies, so a user-moved panel keeps the user's arrangement;
* a panel the user never moved converges to the same state either way (the
  replayed command re-describes the layout it already produced);
* the server RE-ASSERTS by calling a placement method again (a new counter
  above the mark), which applies whether or not the user moved anything.

The tracking lives in client memory, so it survives a websocket reconnect (these
tests) but intentionally NOT a full page reload (out of scope by design -- no
persistent storage). A reconnect is a real server-side socket drop
(`disconnect_all_clients`) followed by the client's automatic retry + replay --
see `_reconnect` for why the old `set_offline` approach was vacuous.

Skips cleanly if the client toolchain isn't available (same harness as
test_panels.py).
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

_VIEWPORT = {"width": 1280, "height": 720}


def _panel_box(page: Page) -> dict | None:
    """Whether the (single) standalone panel is docked, and its left x."""
    return page.evaluate(
        """() => {
            const t = document.querySelector('[data-dock-tab]');
            if (!t) return null;
            const leaf = t.closest('[data-dock-leaf]');
            const fw = t.closest('[data-floating-window]');
            const el = leaf || fw;
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { docked: leaf !== null, x: Math.round(r.x) };
        }"""
    )


def _drag_panel_out(page: Page) -> None:
    """Grab the panel's tab and drag it well into the canvas, tearing it out to
    a floating window (a user gesture that marks the panel user-touched)."""
    tabid = page.eval_on_selector(
        "[data-dock-tab]", "e => e.getAttribute('data-dock-tab')"
    )
    grip = page.eval_on_selector(
        f'[data-dock-tab="{tabid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }",
    )
    page.mouse.move(grip["x"], grip["y"])
    page.mouse.down()
    page.mouse.move(grip["x"] - 300, grip["y"] + 200, steps=20)
    page.mouse.move(grip["x"] - 300, grip["y"] + 200)
    page.mouse.up()
    page.wait_for_timeout(400)


def _reconnect(page: Page, server: viser.ViserServer) -> None:
    """Drop + re-establish the websocket without reloading the page.

    SERVER-side drop, deliberately: Playwright's `set_offline` does not close
    an already-established localhost websocket, so the old client-side version
    of this helper never disconnected anything and the whole suite passed
    without exercising resetGui/replay (the reconnect bugs it 'covered'
    shipped anyway). `disconnect_all_clients` closes the socket for real; the
    client's retry loop then reconnects and replays."""
    server._websock_server.disconnect_all_clients()
    # Reconnect + full replay; the retry loop ticks at 1s.
    page.wait_for_timeout(3000)


def _make_docked_panel(server: viser.ViserServer) -> None:
    panel = server.gui.add_panel()
    with panel.add_tab("Persisty"):
        server.gui.add_markdown("hi from a persistent panel")
    panel.dock_right()


def test_user_moved_panel_survives_reconnect(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A panel the user dragged out stays floated across a reconnect (the
    replayed dock_right is ignored)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    _make_docked_panel(viser_server)
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    before = _panel_box(viser_page)
    assert before is not None and before["docked"], f"expected docked: {before}"

    _drag_panel_out(viser_page)
    floated = _panel_box(viser_page)
    assert floated is not None and not floated["docked"], (
        f"drag did not float the panel: {floated}"
    )

    _reconnect(viser_page, viser_server)
    after = _panel_box(viser_page)
    assert after is not None and not after["docked"], (
        f"reconnect clobbered the user's float (re-docked): {after}"
    )


def test_untouched_panel_reapplies_on_reconnect(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A panel the user never moved keeps the server's docked placement across a
    reconnect (the replay re-applies normally)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    _make_docked_panel(viser_server)
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    before = _panel_box(viser_page)
    assert before is not None and before["docked"], f"expected docked: {before}"

    _reconnect(viser_page, viser_server)
    after = _panel_box(viser_page)
    assert after is not None and after["docked"], (
        f"untouched panel lost its docked placement on reconnect: {after}"
    )


def test_server_can_reassert_moved_panel(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """After the user moves a panel, a fresh server placement call (which bumps
    the counter) overrides the user's arrangement."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    panel = viser_server.gui.add_panel()
    with panel.add_tab("Persisty"):
        viser_server.gui.add_markdown("hi")
    panel.dock_right()
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    _drag_panel_out(viser_page)
    floated = _panel_box(viser_page)
    assert floated is not None and not floated["docked"], (
        f"drag did not float the panel: {floated}"
    )

    # Server re-asserts: dock_right() again -> counter increments -> applies even
    # though the panel is user-touched.
    panel.dock_right()
    viser_page.wait_for_timeout(800)
    after = _panel_box(viser_page)
    assert after is not None and after["docked"], (
        f"server re-assert did not re-dock the user-moved panel: {after}"
    )


def test_set_width_after_user_move_does_not_redock(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """THE yank regression: dock_right(), user drags the panel out to a float,
    then set_width() -- the width-only command must apply the width WITHOUT
    re-applying the stale dock position (placement axes are independent, gated
    per axis)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    panel = viser_server.gui.add_panel()
    with panel.add_tab("Persisty"):
        viser_server.gui.add_markdown("hi")
    panel.dock_right()
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    _drag_panel_out(viser_page)
    floated = _panel_box(viser_page)
    assert floated is not None and not floated["docked"], (
        f"drag did not float the panel: {floated}"
    )

    panel.set_width(444)
    viser_page.wait_for_timeout(800)
    after = _panel_box(viser_page)
    assert after is not None and not after["docked"], (
        f"set_width re-docked a user-moved panel (stale position re-applied): {after}"
    )
    # The width itself DID apply (to the floating window) -- the gate lets the
    # fresh axis through while blocking the stale one.
    width = viser_page.eval_on_selector(
        "[data-floating-window]",
        "e => Math.round(e.getBoundingClientRect().width)",
    )
    assert abs(width - 444) <= 2, f"width axis was not applied: {width}"


def test_removed_then_readded_panel_does_not_inherit_touched_state(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Tracking is keyed by a STABLE key (tab labels + order). When a panel is
    removed and a new one with the SAME labels is added, the new panel must NOT
    inherit the removed panel's user-touched/applied state -- otherwise its
    server placement would be wrongly suppressed. Verifies the tracking is
    pruned when a panel goes away."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    panel = viser_server.gui.add_panel()
    with panel.add_tab("Reuse"):
        viser_server.gui.add_markdown("a")
    panel.dock_right()
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    # Touch it (drag out), then remove it.
    _drag_panel_out(viser_page)
    floated = _panel_box(viser_page)
    assert floated is not None and not floated["docked"], (
        f"drag did not float the panel: {floated}"
    )
    panel.remove()
    viser_page.wait_for_timeout(400)

    # A NEW panel with the same labels, docked right, must dock (not inherit the
    # removed panel's floated/touched state).
    panel2 = viser_server.gui.add_panel()
    with panel2.add_tab("Reuse"):
        viser_server.gui.add_markdown("b")
    panel2.dock_right()
    viser_page.wait_for_timeout(800)
    after = _panel_box(viser_page)
    assert after is not None and after["docked"], (
        f"re-added same-label panel inherited stale touched state: {after}"
    )


def _labeled_box(page: Page, label: str) -> dict | None:
    """docked/x for the panel whose tab shows `label` (multi-panel layouts)."""
    return page.evaluate(
        """(label) => {
            const t = [...document.querySelectorAll('[data-dock-tab]')]
                .find((e) => e.textContent.includes(label));
            if (!t) return null;
            const leaf = t.closest('[data-dock-leaf]');
            const fw = t.closest('[data-floating-window]');
            const el = leaf || fw;
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { docked: leaf !== null, x: Math.round(r.x) };
        }""",
        label,
    )


def test_reconnect_with_multiple_panels_preserves_each(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """With several panels, a reconnect must preserve the TOUCHED one's user
    arrangement AND re-apply the untouched one's server placement -- exercising
    the prune path against a real (non-empty) panel set. Guards the fix that
    skips pruning while panels are momentarily empty during resetGui."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    moved = viser_server.gui.add_panel()
    with moved.add_tab("Moved"):
        viser_server.gui.add_markdown("m")
    moved.dock_right()
    kept = viser_server.gui.add_panel()
    with kept.add_tab("Kept"):
        viser_server.gui.add_markdown("k")
    kept.dock_right()
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    # Tear "Moved" out to float; leave "Kept" docked (untouched).
    tabid = viser_page.evaluate(
        """() => [...document.querySelectorAll('[data-dock-tab]')]
            .find((e) => e.textContent.includes('Moved'))
            .getAttribute('data-dock-tab')"""
    )
    grip = viser_page.eval_on_selector(
        f'[data-dock-tab="{tabid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }",
    )
    viser_page.mouse.move(grip["x"], grip["y"])
    viser_page.mouse.down()
    viser_page.mouse.move(300, 560, steps=18)
    viser_page.mouse.move(300, 560)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(400)
    moved_floated = _labeled_box(viser_page, "Moved")
    assert moved_floated is not None and not moved_floated["docked"], (
        f"Moved did not float: {moved_floated}"
    )

    _reconnect(viser_page, viser_server)

    moved_after = _labeled_box(viser_page, "Moved")
    kept_after = _labeled_box(viser_page, "Kept")
    assert moved_after is not None and not moved_after["docked"], (
        f"reconnect clobbered the touched panel's float: {moved_after}"
    )
    assert kept_after is not None and kept_after["docked"], (
        f"untouched panel lost its docked placement on reconnect: {kept_after}"
    )


def _open_dev_settings(page: Page) -> None:
    """Open the control panel's settings view and enable the Dev Settings
    section (where the Reset Panel Layout button lives)."""
    page.evaluate(
        """() => {
            const ai = [...document.querySelectorAll('button')].find(
                (e) => e.querySelector('svg.tabler-icon-adjustments'));
            if (ai) ai.click();
        }"""
    )
    page.wait_for_timeout(300)
    page.evaluate(
        """() => {
            const lab = [...document.querySelectorAll('*')].find(
                (e) => e.children.length === 0 && /^Dev Settings$/.test(e.textContent));
            if (!lab) return;
            const root = lab.closest('label') || lab.parentElement;
            const inp = root.querySelector('input[type=checkbox]')
                || root.parentElement.querySelector('input[type=checkbox]');
            if (inp && !inp.checked) inp.click();
        }"""
    )
    page.wait_for_timeout(400)


def _reset_button_exists(page: Page) -> bool:
    """Whether the Reset Panel Layout button is present. The button is always
    ENABLED (D52): reset is idempotent, and the "has the user rearranged
    anything" dirty bit was the last reader of the deleted user-touched
    tracking -- there is no disabled state to assert anymore."""
    return page.evaluate(
        """() => {
            const b = [...document.querySelectorAll('button')].find(
                (b) => /Reset Panel Layout/.test(b.textContent));
            return b !== undefined;
        }"""
    )


def test_reset_layout_restores_server_placement(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """The Dev Settings "Reset Panel Layout" button re-applies the server's
    placement when clicked (always enabled; reset is idempotent, D52)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(200)
    # A GUI component is needed for the settings (generated) view to be available.
    viser_server.gui.add_number("dummy", 0)
    _make_docked_panel(viser_server)
    viser_page.wait_for_selector("[data-dock-tab]", timeout=8_000)
    viser_page.wait_for_timeout(400)

    _open_dev_settings(viser_page)
    assert _reset_button_exists(viser_page), (
        "Reset Panel Layout button not found in Dev Settings"
    )

    _drag_panel_out(viser_page)
    floated = _panel_box(viser_page)
    assert floated is not None and not floated["docked"], (
        f"drag did not float the panel: {floated}"
    )

    # Click reset: the panel snaps back to the server's docked placement.
    viser_page.evaluate(
        """() => {
            const b = [...document.querySelectorAll('button')].find(
                (b) => /Reset Panel Layout/.test(b.textContent));
            if (b) b.click();
        }"""
    )
    viser_page.wait_for_timeout(700)
    after = _panel_box(viser_page)
    assert after is not None and after["docked"], (
        f"reset did not restore the server's docked placement: {after}"
    )
