"""E2E tests for standalone panels (``server.gui.add_panel()``).

Panels are server-authored dock groups placed via the imperative ``dock_*`` /
``float`` commands. These tests create panels on the server (the page is already
connected, so create + placement broadcast live) and assert the resulting dock
DOM: floating windows carry ``data-floating-window``; docked panels render a
``data-dock-leaf`` tagged with ``data-dock-edge``.

Placement is replayed to late-joining clients, so a panel created before connect
appears for everyone; here we exercise the live path for simplicity.
"""

from __future__ import annotations

from playwright.sync_api import Browser, Page, expect

import viser
import viser._client_autobuild

from .utils import find_free_port, wait_for_connection, wait_for_server_ready

_VIEWPORT = {"width": 1280, "height": 720}


def _tab(page: Page, label: str):
    """The dock tab whose visible label is `label`."""
    return page.locator("[data-dock-tab]", has_text=label)


def _leaf_box(page: Page, tab_label: str):
    """Bounding box of the docked leaf cell containing the tab labeled
    `tab_label`. Used to distinguish a real column split (panels stacked
    vertically) from independent side-by-side columns (the fallback)."""
    leaf = page.locator("[data-dock-leaf]").filter(has=_tab(page, tab_label))
    box = leaf.first.bounding_box()
    assert box is not None, f"no leaf box for tab {tab_label!r}"
    return box


def _make_server() -> viser.ViserServer:
    """A server on a free port (mirrors the conftest retry pattern)."""
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server: viser.ViserServer | None = None
    for attempt in range(3):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == 2:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())
    return server


def test_add_panel_floats_with_tab(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A floated panel appears as a floating window with its tab label."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Stats"):
        viser_server.gui.add_markdown("hello from a panel")
    panel.float(x=80, y=80, width=280)

    expect(_tab(viser_page, "Stats")).to_be_visible(timeout=5_000)
    # It lives in a floating window (not docked, not in the control panel).
    expect(viser_page.locator("[data-floating-window]")).to_have_count(
        2  # the control panel + our new panel
    )


def test_panel_visible_toggle_hides_and_shows(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """panel.visible = False removes the panel from the dock (without destroying
    it); = True restores it, re-placed."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Toggle"):
        viser_server.gui.add_markdown("toggle me")
    panel.dock_right()
    expect(_tab(viser_page, "Toggle")).to_be_visible(timeout=5_000)

    panel.visible = False
    expect(_tab(viser_page, "Toggle")).to_have_count(0, timeout=5_000)
    # No empty docked leaf left behind on the right edge.
    expect(
        viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    ).to_have_count(0)

    panel.visible = True
    expect(_tab(viser_page, "Toggle")).to_be_visible(timeout=5_000)
    # Re-placed on the right edge.
    expect(
        viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    ).to_have_count(1)


def test_add_panel_without_placement_is_visible(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A bare add_panel() with no placement verb must still be visible (it floats
    at a default), not an invisible orphaned group."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Bare"):
        viser_server.gui.add_markdown("no placement verb was called")

    expect(_tab(viser_page, "Bare")).to_be_visible(timeout=5_000)


def test_dock_below_same_batch_anchor(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Anchor + dependent created back-to-back (no wait between): the dependent's
    split must still resolve the anchor and stack below it on the same edge
    (probes the anchor-resolution race)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    anchor = viser_server.gui.add_panel()
    with anchor.add_tab("A"):
        viser_server.gui.add_markdown("a")
    anchor.dock_right()
    dep = viser_server.gui.add_panel()
    with dep.add_tab("B"):
        viser_server.gui.add_markdown("b")
    dep.dock_below(anchor)

    expect(_tab(viser_page, "A")).to_be_visible(timeout=5_000)
    expect(_tab(viser_page, "B")).to_be_visible(timeout=5_000)
    right_leaves = viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    expect(right_leaves).to_have_count(2)
    # The split actually resolved (vertical stack), proving the anchor race did
    # not silently degrade to the side-by-side right-edge fallback.
    a_box = _leaf_box(viser_page, "A")
    b_box = _leaf_box(viser_page, "B")
    assert b_box["y"] > a_box["y"] + a_box["height"] / 2, (
        "same-batch dock_below should stack vertically (anchor race must not "
        "trigger the right-edge fallback)"
    )


def test_dock_below_reversed_creation_order(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """The DEPENDENT panel is created FIRST, the anchor second, all in one
    batch. The dependent's placement effect runs before the anchor's group
    exists (mount order = creation order); the split must DEFER until the
    anchor materializes instead of silently degrading to the right-edge
    side-by-side fallback."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    dep = viser_server.gui.add_panel()
    with dep.add_tab("B"):
        viser_server.gui.add_markdown("b")
    anchor = viser_server.gui.add_panel()
    with anchor.add_tab("A"):
        viser_server.gui.add_markdown("a")
    anchor.dock_right()
    dep.dock_below(anchor)

    expect(_tab(viser_page, "A")).to_be_visible(timeout=5_000)
    expect(_tab(viser_page, "B")).to_be_visible(timeout=5_000)
    right_leaves = viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    expect(right_leaves).to_have_count(2)
    a_box = _leaf_box(viser_page, "A")
    b_box = _leaf_box(viser_page, "B")
    assert b_box["y"] > a_box["y"] + a_box["height"] / 2, (
        "reversed-creation-order dock_below should stack vertically (the "
        "deferred split must fire once the anchor's group appears)"
    )


def test_dock_below_hidden_anchor_falls_back(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A split against a HIDDEN anchor must not defer forever: the anchor's
    placement step can never run while it's hidden, so the dependent applies
    the right-edge fallback instead of hanging invisible."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    anchor = viser_server.gui.add_panel()
    with anchor.add_tab("A"):
        viser_server.gui.add_markdown("a")
    anchor.dock_left()
    anchor.visible = False
    dep = viser_server.gui.add_panel()
    with dep.add_tab("B"):
        viser_server.gui.add_markdown("b")
    dep.dock_below(anchor)

    # B must appear (fallback), not hang invisible waiting on the hidden A.
    expect(_tab(viser_page, "B")).to_be_visible(timeout=5_000)


def test_dock_anchor_cycle_falls_back(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """An anchor CYCLE (a above b, b above a) can never resolve -- neither dock
    can go first. Both panels must fall back and stay visible rather than
    deadlocking the placement fixpoint."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    a = viser_server.gui.add_panel()
    with a.add_tab("A"):
        viser_server.gui.add_markdown("a")
    b = viser_server.gui.add_panel()
    with b.add_tab("B"):
        viser_server.gui.add_markdown("b")
    a.dock_above(b)
    b.dock_above(a)

    expect(_tab(viser_page, "A")).to_be_visible(timeout=5_000)
    expect(_tab(viser_page, "B")).to_be_visible(timeout=5_000)


def test_dock_right_places_panel_on_right_edge(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Docked"):
        viser_server.gui.add_markdown("content")
    panel.dock_right()

    tab = _tab(viser_page, "Docked")
    expect(tab).to_be_visible(timeout=5_000)
    # The panel's leaf is tagged as docked on the right edge.
    leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    expect(leaf.filter(has=tab)).to_have_count(1)


def test_multi_tab_panel_shows_all_tabs(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("One"):
        viser_server.gui.add_markdown("one")
    with panel.add_tab("Two"):
        viser_server.gui.add_markdown("two")
    panel.float(x=100, y=100, width=300)

    expect(_tab(viser_page, "One")).to_be_visible(timeout=5_000)
    expect(_tab(viser_page, "Two")).to_be_visible()


def test_lone_docked_panel_minimizes_via_toggle(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Minimize is a browser-side gesture only (the server collapse axis is
    gone, D31): a lone docked panel carries the cell-level `-` (D30), and
    clicking it collapses the panel to its in-place bar, label kept."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Mini"):
        viser_server.gui.add_markdown("body text that hides when collapsed")
    panel.dock_right()
    leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']").filter(
        has=_tab(viser_page, "Mini")
    )
    expect(leaf).to_have_count(1, timeout=5_000)
    leaf.locator("[data-dock-minimize]").first.click()
    # Collapsed: exactly one group carries the collapsed marker, and its label
    # shows on the minimized bar (a collapsed group hides its tab strip, so we
    # check the label text, not a [data-dock-tab]).
    expect(viser_page.locator("[data-dock-group][data-dock-collapsed]")).to_have_count(
        1, timeout=5_000
    )
    expect(viser_page.get_by_text("Mini")).to_be_visible()


def test_tab_added_does_not_move_panel(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression (critic Finding 1/2): adding a tab to an already-placed panel
    must NOT re-apply its placement / move it. Membership reconciles in place;
    position is left alone. Here we dock right, then add a 2nd tab, and assert the
    panel stays docked right at the same leaf (doesn't jump or re-float)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("First"):
        viser_server.gui.add_markdown("first")
    panel.dock_right()
    expect(_tab(viser_page, "First")).to_be_visible(timeout=5_000)
    before = _leaf_box(viser_page, "First")

    # Server adds a second tab AFTER placement -- must not reposition the panel.
    with panel.add_tab("Second"):
        viser_server.gui.add_markdown("second")
    expect(_tab(viser_page, "Second")).to_be_visible(timeout=5_000)

    # Still docked on the right edge (not re-floated, not jumped to another edge).
    leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    expect(leaf.filter(has=_tab(viser_page, "First"))).to_have_count(1)
    after = _leaf_box(viser_page, "First")
    # Same horizontal position (didn't move edges / re-float to top-left default).
    assert abs(after["x"] - before["x"]) < 20, (
        f"panel moved after a tab was added: x {before['x']} -> {after['x']}"
    )


def test_clearing_set_width_reverts_to_theme_width(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression (critic Finding 9): after a main_panel.set_width() override is
    cleared (via gui.reset()), the floating control panel must revert toward the
    theme width, not stay stuck at the override width."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_page.get_by_test_id("floating-panel")
    expect(panel).to_be_visible()
    default_w = panel.bounding_box()["width"]  # type: ignore[index]

    # Override much wider, then verify it took effect.
    viser_server.gui.main_panel.set_width(560)
    viser_page.wait_for_timeout(500)
    wide_w = viser_page.get_by_test_id("floating-panel").bounding_box()["width"]  # type: ignore[index]
    assert wide_w > default_w + 100, (
        f"set_width(560) didn't widen the panel ({default_w} -> {wide_w})"
    )

    # Clear the override; width must come back down toward the theme default
    # (the Finding 9 bug left it stuck at 560).
    viser_server.gui.reset()
    viser_page.wait_for_timeout(600)
    reverted_w = viser_page.get_by_test_id("floating-panel").bounding_box()["width"]  # type: ignore[index]
    assert reverted_w < wide_w - 100, (
        f"clearing set_width left the panel stuck wide ({wide_w} -> {reverted_w}); "
        "expected revert toward the theme default"
    )


def test_remove_panel_removes_it(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Temp"):
        viser_server.gui.add_markdown("temporary")
    panel.float(x=120, y=120, width=260)
    expect(_tab(viser_page, "Temp")).to_be_visible(timeout=5_000)

    panel.remove()
    expect(_tab(viser_page, "Temp")).to_have_count(0, timeout=5_000)


def test_dock_below_stacks_under_anchor(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """dock_below(anchor) stacks the new panel below the anchor in a column,
    sharing the same docked edge."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    anchor = viser_server.gui.add_panel()
    with anchor.add_tab("Anchor"):
        viser_server.gui.add_markdown("anchor")
    anchor.dock_right()
    expect(_tab(viser_page, "Anchor")).to_be_visible(timeout=5_000)

    below = viser_server.gui.add_panel()
    with below.add_tab("Below"):
        viser_server.gui.add_markdown("below")
    below.dock_below(anchor)

    expect(_tab(viser_page, "Below")).to_be_visible(timeout=5_000)
    # Both panels are docked on the right edge.
    right_leaves = viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    expect(right_leaves).to_have_count(2)
    # A REAL column split stacks them VERTICALLY: "Below" sits under "Anchor",
    # overlapping horizontally. (The fallback would place an independent column
    # side-by-side instead -- different x, similar y.) This distinguishes a
    # genuine split from the B1 right-edge fallback, which also yields 2 right
    # leaves.
    anchor_box = _leaf_box(viser_page, "Anchor")
    below_box = _leaf_box(viser_page, "Below")
    assert below_box["y"] > anchor_box["y"] + anchor_box["height"] / 2, (
        f"'Below' should stack under 'Anchor' (anchor y={anchor_box['y']}, "
        f"below y={below_box['y']}) -- not the side-by-side fallback"
    )
    # Horizontal overlap confirms same column (not side-by-side).
    assert (
        below_box["x"] < anchor_box["x"] + anchor_box["width"]
        and anchor_box["x"] < below_box["x"] + below_box["width"]
    ), "stacked panels should share the same column (overlapping x-range)"


def test_main_panel_dock_left(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """main_panel.dock_left() docks the control panel to the left edge."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    viser_server.gui.main_panel.dock_left()
    viser_page.wait_for_timeout(500)

    panel = viser_page.get_by_test_id("floating-panel")
    expect(panel).to_be_visible()
    assert panel.get_attribute("data-dock-side") == "left"


def test_main_panel_float_undocks(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """main_panel.float() after a dock_* returns the control panel to floating
    (regression: the 05_theming example's "floating" option appeared to do
    nothing -- here we exercise the underlying command that fixes it)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    viser_server.gui.main_panel.dock_left()
    viser_page.wait_for_timeout(500)
    panel = viser_page.get_by_test_id("floating-panel")
    assert panel.get_attribute("data-dock-side") == "left"

    viser_server.gui.main_panel.float()
    viser_page.wait_for_timeout(500)
    # Back to floating: no dock side, and it lives in a floating window.
    panel = viser_page.get_by_test_id("floating-panel")
    expect(panel).to_be_visible()
    assert panel.get_attribute("data-dock-side") == "none"
    # The left dock region is gone (the panel is no longer docked there).
    expect(viser_page.locator("[data-dock-leaf][data-dock-edge='left']")).to_have_count(
        0
    )


def test_reset_reverts_main_panel_to_float(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """gui.reset() reverts a docked control panel back to a floating default on a
    connected client (regression: placement persisted across reset)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    viser_server.gui.main_panel.dock_left()
    viser_page.wait_for_timeout(500)
    panel = viser_page.get_by_test_id("floating-panel")
    assert panel.get_attribute("data-dock-side") == "left"

    viser_server.gui.reset()
    viser_page.wait_for_timeout(600)
    # Back to floating (no dock side).
    panel = viser_page.get_by_test_id("floating-panel")
    expect(panel).to_be_visible()
    assert panel.get_attribute("data-dock-side") == "none"


def test_dock_below_floating_anchor_falls_back(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """dock_below() against a FLOATING anchor can't split (the dock model only
    splits docked leaves), so it falls back to a right-edge dock -- gracefully,
    with a console warning, no crash."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Capture console warnings to prove the fallback is diagnosable (not silent).
    warnings: list[str] = []
    viser_page.on(
        "console",
        lambda msg: warnings.append(msg.text) if msg.type == "warning" else None,
    )

    anchor = viser_server.gui.add_panel()
    with anchor.add_tab("FloatAnchor"):
        viser_server.gui.add_markdown("floating")
    anchor.float(x=200, y=200, width=260)
    expect(_tab(viser_page, "FloatAnchor")).to_be_visible(timeout=5_000)
    dep = viser_server.gui.add_panel()
    with dep.add_tab("Dep"):
        viser_server.gui.add_markdown("dep")
    dep.dock_below(anchor)  # anchor is floating -> fallback to right edge

    expect(_tab(viser_page, "Dep")).to_be_visible(timeout=5_000)
    # Fell back to a right-edge dock (not stacked under the floating anchor).
    leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']")
    expect(leaf.filter(has=_tab(viser_page, "Dep"))).to_have_count(1)
    # The anchor stayed floating (it was NOT pulled into a docked split).
    expect(
        viser_page.locator("[data-floating-window]").filter(
            has=_tab(viser_page, "FloatAnchor")
        )
    ).to_have_count(1)
    # The fallback warned (the whole point of the B1 mitigation).
    viser_page.wait_for_timeout(300)
    assert any("not" in w and "docked" in w for w in warnings), (
        f"expected a console.warn about the non-docked anchor, got: {warnings}"
    )


def test_late_joining_client_sees_placed_panel(browser: Browser) -> None:
    """A panel created + placed BEFORE a client connects appears placed for the
    late joiner (placement is replayed via the persistent message buffer)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        with panel.add_tab("Replayed"):
            server.gui.add_markdown("placed before connect")
        panel.dock_right()

        context = browser.new_context(viewport=_VIEWPORT)
        page = context.new_page()
        try:
            wait_for_connection(page, server.get_port())
            expect(_tab(page, "Replayed")).to_be_visible(timeout=5_000)
            leaf = page.locator("[data-dock-leaf][data-dock-edge='right']")
            expect(leaf.filter(has=_tab(page, "Replayed"))).to_have_count(1)
        finally:
            context.close()
    finally:
        server.stop()


def test_float_negative_coords_anchor_to_right_edge(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """float(x<0) anchors the panel to the canvas RIGHT edge (a gap of |x|px) and
    tracks it when the viewport resizes."""
    viser_page.set_viewport_size({"width": 1280, "height": 800})
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Anchored"):
        viser_server.gui.add_markdown("top-right")
    panel.float(x=-15, y=15, width=240)
    expect(_tab(viser_page, "Anchored")).to_be_visible(timeout=5_000)

    win = viser_page.locator("[data-floating-window]").filter(
        has=_tab(viser_page, "Anchored")
    )

    def right_gap(width: int) -> float:
        box = win.first.bounding_box()
        assert box is not None
        return width - (box["x"] + box["width"])

    # ~15px gap from the right edge at the initial width...
    assert abs(right_gap(1280) - 15) <= 2, right_gap(1280)
    # ...and still ~15px after the viewport narrows (it tracked the edge).
    viser_page.set_viewport_size({"width": 1000, "height": 800})
    viser_page.wait_for_timeout(500)
    assert abs(right_gap(1000) - 15) <= 2, right_gap(1000)


def test_disconnect_freezes_gui_instead_of_wiping(browser: Browser) -> None:
    """On websocket disconnect, the GUI + panels stay rendered (frozen + dimmed),
    rather than being wiped. Regression: previously a disconnect called resetGui()
    and everything vanished."""
    server = _make_server()
    try:
        server.gui.add_button("StayButton")
        panel = server.gui.add_panel()
        with panel.add_tab("StayTab"):
            server.gui.add_markdown("still here after disconnect")
        panel.dock_right()

        context = browser.new_context(viewport=_VIEWPORT)
        page = context.new_page()
        try:
            wait_for_connection(page, server.get_port())
            expect(page.get_by_role("button", name="StayButton")).to_be_visible(
                timeout=5_000
            )
            expect(_tab(page, "StayTab")).to_be_visible()

            # Drop the connection.
            server.stop()
            # The button + panel must REMAIN in the DOM (frozen), not be removed.
            expect(page.get_by_role("button", name="StayButton")).to_have_count(
                1, timeout=5_000
            )
            expect(_tab(page, "StayTab")).to_have_count(1)

            # And the GUI body is dimmed (the disconnected gate): some ancestor of
            # the button has opacity < 1. Poll -- the client applies the dim only
            # after it detects the dropped socket (and an opacity transition), so a
            # one-shot read can race the disconnect, especially under parallel load.
            def _is_dimmed() -> bool:
                return page.evaluate(
                    """() => {
                      const btn = [...document.querySelectorAll('button')]
                        .find(b => b.textContent.includes('StayButton'));
                      let el = btn;
                      while (el) {
                        const o = parseFloat(getComputedStyle(el).opacity);
                        if (o < 1) return true;
                        el = el.parentElement;
                      }
                      return false;
                    }"""
                )

            dimmed = False
            for _ in range(50):  # up to ~5s for the disconnect dim to apply
                if _is_dimmed():
                    dimmed = True
                    break
                page.wait_for_timeout(100)
            assert dimmed, "GUI should be dimmed while disconnected"
        finally:
            context.close()
    finally:
        server.stop()


def test_per_client_panel_is_isolated(browser: Browser) -> None:
    """A panel created on client.gui (per-client scope) appears only on that
    client, not on other connected clients."""
    server = _make_server()
    seen: list[int] = []

    @server.on_client_connect
    def _(client: viser.ClientHandle) -> None:
        # Only the FIRST client to connect gets a per-client panel.
        first = len(seen) == 0
        seen.append(client.client_id)
        if first:
            p = client.gui.add_panel()
            with p.add_tab("PrivateTab"):
                client.gui.add_markdown("only for the first client")
            p.float(x=120, y=120, width=240)

    try:
        ctx1 = browser.new_context(viewport=_VIEWPORT)
        ctx2 = browser.new_context(viewport=_VIEWPORT)
        page1 = ctx1.new_page()
        page2 = ctx2.new_page()
        try:
            wait_for_connection(page1, server.get_port())
            wait_for_connection(page2, server.get_port())
            # Exactly ONE client (the first to connect) sees the per-client
            # panel; the other must not (per-client scope, no leak). We don't
            # assume which page connected first, so assert the count is 1+0.
            page1.wait_for_timeout(1_500)
            page2.wait_for_timeout(100)
            seen_count = (
                _tab(page1, "PrivateTab").count() + _tab(page2, "PrivateTab").count()
            )
            assert seen_count == 1, (
                f"per-client panel leaked or vanished: visible on {seen_count} "
                "of 2 clients (expected exactly 1)"
            )
        finally:
            ctx1.close()
            ctx2.close()
    finally:
        server.stop()


def test_no_drop_placeholders_in_control_panel(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: a standalone panel must NOT also render inline in the control
    panel as an empty nested dock area ("Drop a panel here")."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Solo"):
        viser_server.gui.add_markdown("content")
    panel.dock_right()
    expect(_tab(viser_page, "Solo")).to_be_visible(timeout=5_000)
    # No drop-zone placeholders anywhere.
    expect(viser_page.get_by_text("Drop a panel here")).to_have_count(0)


def test_float_is_canvas_relative(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: float(x=...) is relative to the CANVAS (past a left-docked
    panel), not the dock root -- so a float lands clear of the control panel."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Dock the control panel left so there's a left inset.
    viser_server.gui.main_panel.dock_left()
    viser_page.wait_for_timeout(400)
    ctrl = viser_page.get_by_test_id("floating-panel").bounding_box()
    assert ctrl is not None and ctrl["x"] < 5  # docked at the left edge

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Floaty"):
        viser_server.gui.add_markdown("x")
    panel.float(x=40, y=40, width=240)
    expect(_tab(viser_page, "Floaty")).to_be_visible(timeout=5_000)

    win = viser_page.locator("[data-floating-window]").filter(
        has=_tab(viser_page, "Floaty")
    )
    box = win.first.bounding_box()
    assert box is not None
    # The float must start PAST the left-docked control panel, not at x=40.
    assert box["x"] >= ctrl["width"] - 5, (
        f"float x={box['x']} should clear the left-docked panel "
        f"(width {ctrl['width']}) -- it is canvas-relative"
    )


def test_standalone_panel_visible_on_mobile(browser: Browser) -> None:
    """Regression: on the mobile bottom-sheet layout there is no dock surface, so
    a standalone panel must fall back to rendering inline (otherwise its content
    is invisible)."""
    server = _make_server()
    try:
        panel = server.gui.add_panel()
        with panel.add_tab("MobileTab"):
            server.gui.add_button("MobileButton")
        panel.dock_right()
        # Below the xs breakpoint -> bottom sheet, no dock surface.
        ctx = browser.new_context(viewport={"width": 420, "height": 740})
        page = ctx.new_page()
        try:
            wait_for_connection(page, server.get_port())
            page.wait_for_timeout(1_000)
            expect(page.get_by_role("button", name="MobileButton")).to_be_visible(
                timeout=5_000
            )
        finally:
            ctx.close()
    finally:
        server.stop()


def test_control_panel_not_blank_with_only_standalone(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: a standalone panel under root must not flip the desktop control
    panel into an empty generated-GUI view -- it should still show server
    controls (e.g. the scene tree)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("OnlyPanel"):
        viser_server.gui.add_markdown("content")
    panel.float(x=60, y=60, width=240)
    expect(_tab(viser_page, "OnlyPanel")).to_be_visible(timeout=5_000)

    # The control panel still shows its server-controls body (Scene tree),
    # not a collapsed/empty generated view.
    expect(viser_page.get_by_text("Scene tree")).to_be_visible(timeout=5_000)


def test_many_docked_panels_do_not_occlude_canvas(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: docking enough panels that the regions' summed default width
    exceeds the viewport must NOT overlap the regions and hide the 3D canvas (the
    controls underneath would be unreachable). The rendered region widths are
    capped so a usable canvas strip always remains in the middle."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # 3 left + 3 right @ 300px default each = 1800px reserved on a 1280px canvas.
    for i in range(3):
        p = viser_server.gui.add_panel()
        with p.add_tab(f"L{i}"):
            viser_server.gui.add_markdown(f"left {i}")
        p.dock_left()
    for i in range(3):
        p = viser_server.gui.add_panel()
        with p.add_tab(f"R{i}"):
            viser_server.gui.add_markdown(f"right {i}")
        p.dock_right()

    expect(_tab(viser_page, "L0")).to_be_visible(timeout=5_000)
    expect(_tab(viser_page, "R0")).to_be_visible(timeout=5_000)

    # The element at the viewport center must be the 3D canvas, not a docked
    # panel painted over it.
    cx = _VIEWPORT["width"] // 2
    cy = _VIEWPORT["height"] // 2
    tag = viser_page.evaluate(
        "([x, y]) => { const el = document.elementFromPoint(x, y);"
        " return el ? el.tagName : null; }",
        [cx, cy],
    )
    assert tag == "CANVAS", f"canvas occluded by a docked region (got <{tag}>)"


def test_minimized_multitab_strip_rows_expand_to_tab(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A minimized docked panel with multiple tabs shows ONE label (the active
    tab, with a +N badge) on its in-place bar (D14); the per-tab rows live in
    the RAIL (explicit region collapse, D21) -- clicking a rail row expands the
    region AND the panel to THAT tab."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Alpha"):
        viser_server.gui.add_markdown("alpha body")
    with panel.add_tab("Beta"):
        viser_server.gui.add_markdown("beta body")
    panel.dock_right()
    # Minimize via the UI: the lone docked panel keeps its cell-level `-`
    # (D30); the server has no collapse command (D31).
    leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']").filter(
        has=_tab(viser_page, "Alpha")
    )
    expect(leaf).to_have_count(1, timeout=5_000)
    leaf.locator("[data-dock-minimize]").first.click()

    bar = viser_page.locator("[data-dock-group][data-dock-collapsed]")
    expect(bar).to_have_count(1, timeout=5_000)
    # The bar shows ONE wayfinding label -- the active tab's -- plus a +1
    # badge for the hidden tab (D14: single-title bars).
    expect(bar.locator("[data-dock-tab]")).to_have_count(1)
    expect(bar.get_by_text("+1")).to_be_visible()

    # Collapse the region: the rail shows one spine row PER tab.
    viser_page.locator("[data-dock-region-collapse='right']").click()
    rail_rows = viser_page.locator(
        "[data-dock-leaf][data-dock-edge='right'] [data-dock-tab]"
    )
    expect(rail_rows).to_have_count(2, timeout=5_000)

    # Click the Beta row -> the region un-collapses, the panel expands, AND
    # Beta's body shows.
    rail_rows.filter(has_text="Beta").first.click()
    expect(viser_page.locator("[data-dock-group][data-dock-collapsed]")).to_have_count(
        0, timeout=5_000
    )
    expect(viser_page.get_by_text("beta body")).to_be_visible(timeout=5_000)


def test_undock_minimized_panel_keeps_width(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: dock a panel (default ~300px), minimize it, drag it out to
    float, then expand. The floated window must keep the panel's width, NOT the
    narrow minimized-strip width (~96px). Before the fix, floatRectFor measured
    the collapsed strip's DOM width and the window stayed ~96px after expand."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    with panel.add_tab("Wide"):
        for i in range(3):
            viser_server.gui.add_slider(f"s{i}", 0, 1, step=0.1, initial_value=0.5)
    panel.dock_right()

    leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']").filter(
        has=_tab(viser_page, "Wide")
    )
    expect(leaf).to_have_count(1, timeout=5_000)
    docked_w = leaf.bounding_box()["width"]
    assert docked_w > 200, f"docked panel should be wide, got {docked_w}"

    # Minimize, then drag the bar out into the canvas to float it. Drop it in
    # the LOWER-LEFT canvas -- clear of the control panel (top-right corner), so
    # the bar tears out to a SOLO floating window instead of snapping into the
    # control panel's stack.
    leaf.locator("[data-dock-minimize]").first.click()
    viser_page.wait_for_timeout(400)
    strip = viser_page.locator("[data-dock-group][data-dock-collapsed]").first
    sb = strip.bounding_box()
    drop_x, drop_y = 320, _VIEWPORT["height"] - 160
    viser_page.mouse.move(sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2)
    viser_page.mouse.down()
    viser_page.mouse.move(drop_x, drop_y, steps=12)
    viser_page.mouse.move(drop_x, drop_y)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(400)

    win = viser_page.locator("[data-floating-window]").filter(
        has=_tab(viser_page, "Wide")
    )
    expect(win).to_have_count(1, timeout=5_000)
    # Expand via the bar's label and assert the width survived (not
    # collapsed to the bar height's worth of chrome).
    win.locator("[data-dock-group] [data-dock-tab]").first.focus()
    viser_page.keyboard.press("Enter")
    viser_page.wait_for_timeout(400)
    expanded_w = win.bounding_box()["width"]
    assert expanded_w > 200, (
        f"undocked+expanded panel collapsed to strip width: {expanded_w}px"
    )


def test_emptied_docked_panel_revives(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Regression: removing all of a DOCKED panel's tabs (down to zero) and then
    adding a new tab must re-show the panel. Before the fix the stale empty group
    lingered, the revive created a new orphaned group, and the panel rendered
    nowhere (with a dev layout-invariant violation)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    panel = viser_server.gui.add_panel()
    tab = panel.add_tab("Only")
    with tab:
        viser_server.gui.add_markdown("only content")
    panel.dock_left()
    expect(_tab(viser_page, "Only")).to_be_visible(timeout=5_000)

    # Empty it: the panel disappears.
    tab.remove()
    expect(
        viser_page.locator("[data-dock-leaf]").filter(has=_tab(viser_page, "Only"))
    ).to_have_count(0, timeout=5_000)

    # Revive: a fresh tab must re-show the panel, docked left again.
    with panel.add_tab("Revived"):
        viser_server.gui.add_markdown("back content")
    revived = _tab(viser_page, "Revived")
    expect(revived).to_be_visible(timeout=5_000)
    expect(
        viser_page.locator("[data-dock-leaf][data-dock-edge='left']").filter(
            has=revived
        )
    ).to_have_count(1)


def test_unminimize_after_sibling_resize_keeps_panel_onscreen(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """D31 pin: in a docked column [Top, Mid, Bottom], resize the Top/Mid
    divider (rewrites the expanded cells' weights to a px scale), then drive
    the whole stack into minimized bars via UI gestures -- the region chevron
    rails the stack, and dragging the rail header out floats it as a window
    of minimized bars (every cell stamped collapsed, spec 7; the server has
    no collapse command). Clicking ONE bar's + then expands the WHOLE stack
    (D31: collapse is stack-scoped in both directions): no collapsed sibling
    may remain, and every panel must come back with real height, on
    screen."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)
    vh = _VIEWPORT["height"]

    top = viser_server.gui.add_panel()
    with top.add_tab("ColTop"):
        viser_server.gui.add_markdown("top")
    top.dock_right()
    mid = viser_server.gui.add_panel()
    with mid.add_tab("ColMid"):
        viser_server.gui.add_markdown("mid")
    mid.dock_below(top)
    bottom = viser_server.gui.add_panel()
    with bottom.add_tab("ColBot"):
        viser_server.gui.add_markdown("bottom")
    bottom.dock_below(mid)
    expect(_tab(viser_page, "ColBot")).to_be_visible(timeout=5_000)

    # Drag the Top/Mid divider down (rewrites the expanded cells' weights to px).
    top_box = (
        viser_page.locator("[data-dock-leaf]")
        .filter(has=_tab(viser_page, "ColTop"))
        .first.bounding_box()
    )
    seam_y = top_box["y"] + top_box["height"]
    cx = top_box["x"] + top_box["width"] / 2
    viser_page.mouse.move(cx, seam_y)
    viser_page.mouse.down()
    viser_page.mouse.move(cx, seam_y + 120, steps=10)
    viser_page.mouse.move(cx, seam_y + 120)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(300)

    # Rail the stack (the docked stack's one collapse control, D30), then drag
    # the rail header out: the region floats as ONE stacked window of
    # minimized bars (every cell stamped collapsed, spec 7).
    viser_page.locator("[data-dock-region-collapse='right']").click()
    rail_header = viser_page.locator("[data-dock-region-rail]")
    expect(rail_header).to_have_count(1, timeout=5_000)
    hb = rail_header.bounding_box()
    assert hb is not None
    drop_x, drop_y = 420, 220
    viser_page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    viser_page.mouse.down()
    viser_page.mouse.move(drop_x, drop_y, steps=12)
    viser_page.mouse.move(drop_x, drop_y)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(400)

    win = viser_page.locator("[data-floating-window]").filter(
        has=_tab(viser_page, "ColTop")
    )
    expect(win).to_have_count(1, timeout=5_000)
    expect(win.locator("[data-dock-group][data-dock-collapsed]")).to_have_count(
        3, timeout=5_000
    )

    # ONE bar's + expands the WHOLE stack (D31) -- no collapsed sibling left.
    win.locator("[data-dock-minimize]").first.click()
    expect(win.locator("[data-dock-group][data-dock-collapsed]")).to_have_count(
        0, timeout=5_000
    )
    viser_page.wait_for_timeout(250)

    for label in ("ColTop", "ColMid", "ColBot"):
        box = (
            win.locator("[data-dock-group]")
            .filter(has=_tab(viser_page, label))
            .first.bounding_box()
        )
        assert box is not None, f"{label} panel not rendered after expand"
        assert box["height"] > 40, (
            f"{label} panel collapsed to {box['height']}px after expand"
        )
        assert box["y"] + box["height"] <= vh + 5, (
            f"{label} panel off-screen: y={box['y']} h={box['height']} (vh {vh})"
        )


def test_docked_resize_pushes_fully_on_canvas_float(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Resizing a docked region pushes a float that is FULLY on the canvas out of
    its way, keeping it flush with the advancing seam (no lag, no jump). A float
    already overlapping the region is left alone -- see the companion test."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    docked = viser_server.gui.add_panel()
    with docked.add_tab("DockEdge"):
        viser_server.gui.add_markdown("docked")
    docked.dock_right()
    floater = viser_server.gui.add_panel()
    with floater.add_tab("Floaty"):
        viser_server.gui.add_markdown("floaty")
    floater.float(x=500, y=300, width=200)  # fully on canvas, right edge 700
    expect(_tab(viser_page, "Floaty")).to_be_visible(timeout=5_000)

    def float_right() -> float:
        box = (
            viser_page.locator("[data-floating-window]")
            .filter(has=_tab(viser_page, "Floaty"))
            .first.bounding_box()
        )
        assert box is not None
        return box["x"] + box["width"]

    before_right = float_right()

    # Drag the region's inner edge left, sweeping past the float's right edge.
    handle = viser_page.locator(
        "[data-dock-region-resize='right']"
    ).first.bounding_box()
    assert handle is not None
    cx = handle["x"] + handle["width"] / 2
    cy = handle["y"] + handle["height"] / 2
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx - 2, cy, steps=2)
    viser_page.mouse.move(cx - 320, cy, steps=14)
    viser_page.mouse.move(cx - 320, cy)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(150)

    after_right = float_right()
    seam = viser_page.eval_on_selector(
        "[data-dock-leaf][data-dock-edge='right']",
        "e => e.getBoundingClientRect().x",
    )
    assert after_right < before_right - 20, (
        f"float should be pushed left as the region sweeps past it: "
        f"{before_right} -> {after_right}"
    )
    # Kept flush with the seam (still fully on the canvas), not shoved past it.
    assert abs(after_right - seam) <= 10, (
        f"pushed float right edge {after_right} should sit flush with the seam {seam}"
    )


def test_example_11_panels_minimized_chrome(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """Real-content pin of the 11_panels example's minimized states:

    1. A panel minimized via the UI (its lone `-`, clicked before a sibling
       stacks above it) renders as an IN-PLACE bar (D20) at full region
       width; docking a sibling above leaves it minimized (no adoption,
       edge case 1); the rail never appears emergently (D21).
    2. The explicit region-collapse chevron gives the 36px rail with exactly
       ONE expand control (the parent handle -- cells show pills, P9).
    3. After expanding stats from the rail (spine row: un-collapses the
       region and expands that panel), the still-minimized log bar must be
       visually BOUNDED against the white panel body above it: its surface
       is the grip-bar gray, not the body color (P13/P10)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Logs docks alone first: a lone docked panel keeps its cell-level `-`
    # (D30), the only UI entry into a minimized docked cell now that the
    # server collapse axis is gone (D31).
    logs = viser_server.gui.add_panel(key="logs")
    with logs.add_tab("Log"):
        viser_server.gui.add_markdown("log content")
    logs.dock_right()
    logs.set_width(320)
    log_leaf = viser_page.locator("[data-dock-leaf][data-dock-edge='right']").filter(
        has=_tab(viser_page, "Log")
    )
    expect(log_leaf).to_have_count(1, timeout=5_000)
    log_leaf.locator("[data-dock-minimize]").first.click()
    expect(viser_page.locator("[data-dock-group][data-dock-collapsed]")).to_have_count(
        1, timeout=5_000
    )

    # Stats stacks above the minimized log bar -- which stays minimized (no
    # adoption, edge case 1) while stats lands expanded.
    stats = viser_server.gui.add_panel(key="stats")
    with stats.add_tab("Stats"):
        viser_server.gui.add_markdown("stats content")
    stats.dock_above(logs)
    expect(_tab(viser_page, "Stats")).to_be_visible(timeout=5_000)

    # One in-place bar beside the expanded panel, NO rail (D21). The stacked
    # expanded cell carries no `-` (D30), so the bar's + is the region's only
    # cell toggle -- and its scope is now the stack (D31).
    bars = viser_page.locator(
        "[data-dock-leaf][data-dock-edge='right'] [data-dock-group][data-dock-collapsed]"
    )
    expect(bars).to_have_count(1, timeout=5_000)
    assert viser_page.locator("[data-dock-region-rail]").count() == 0, (
        "minimizing panels must not flip the region into the rail (D21)"
    )
    n_cell_toggles = viser_page.locator(
        "[data-dock-edge='right'] [data-dock-minimize]"
    ).count()
    assert n_cell_toggles == 1, (
        f"only the bar carries a toggle -- stacked expanded cells have no `-` "
        f"(got {n_cell_toggles})"
    )

    # EXPLICIT collapse via the chevron -> the rail, with exactly ONE expand
    # control: the parent handle (cells show pills, P9).
    viser_page.eval_on_selector("[data-dock-region-collapse='right']", "e => e.click()")
    rail = viser_page.locator("[data-dock-region-rail]")
    expect(rail).to_have_count(1, timeout=5_000)
    n_all = viser_page.locator(
        "[data-dock-edge='right'] [data-dock-minimize], "
        "[data-dock-region-rail] [data-dock-minimize]"
    ).count()
    n_parent = viser_page.locator(
        "[data-dock-region-rail] [data-dock-minimize-all]"
    ).count()
    assert n_all == 0 and n_parent == 1, (
        f"rail must show exactly one expand control (got {n_all} cell +s, "
        f"{n_parent} parent)"
    )

    # Expand stats via its spine row (keyboard; rows are gesture surfaces):
    # un-collapses the region AND expands stats (D21).
    row = viser_page.locator(
        "[data-dock-leaf][data-dock-edge='right'] [data-dock-tab]"
    ).first
    row.focus()
    viser_page.keyboard.press("Enter")
    viser_page.wait_for_timeout(400)
    expect(_tab(viser_page, "Stats")).to_be_visible()
    assert viser_page.locator("[data-dock-region-rail]").count() == 0

    # The log bar renders with the grip-bar surface: its background must
    # DIFFER from the body color of the expanded panel above (P13/P10).
    colors = viser_page.evaluate(
        """() => {
        const bar = document.querySelector(
            '[data-dock-leaf][data-dock-edge="right"] [data-dock-group][data-dock-collapsed]');
        const body = document.querySelector('[data-dock-leaf][data-dock-edge="right"]');
        return {
          bar: bar ? getComputedStyle(bar).backgroundColor : null,
          body: body ? getComputedStyle(body.querySelector('[data-dock-group]')).backgroundColor : null,
        };
    }"""
    )
    assert colors["bar"] is not None
    assert colors["bar"] != colors["body"], (
        f"minimized bar must be bounded by surface contrast, got {colors}"
    )
