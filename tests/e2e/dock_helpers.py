"""Shared helpers for the dock playground e2e modules.

These are the canonical versions of the page/drag/layout helpers that grew up
copy-pasted across the ``test_dock_*`` files. Import the ones whose semantics
match (most modules alias them to their old local names); modules with
genuinely different needs (label-based grip lookup, custom drag step counts)
keep local variants.
"""

from __future__ import annotations

from typing import Any, Mapping

from playwright.sync_api import Page

PLAYGROUND_PATH = "/dock_test.html"

# Python mirrors of the dock's TS layout constants (src/viser/client/src/dock/):
MIN_PANEL_WIDTH_PX = 220  # types.ts
MAX_PANEL_WIDTH_PX = 600  # types.ts
MIN_CELL_HEIGHT_PX = 80  # SplitView.tsx


def open_playground(dock_context, port: int, w: int = 1280, h: int = 800) -> Page:
    """New page on the shared context, sized and navigated to the playground."""
    pg = dock_context.new_page()
    pg.set_viewport_size({"width": w, "height": h})
    pg.goto(f"http://localhost:{port}{PLAYGROUND_PATH}")
    pg.wait_for_selector("[data-dock-group]")
    pg.wait_for_selector('[data-dock-area="area-scene"]')
    return pg


def drag(
    page: Page,
    start: tuple[float, float],
    end: tuple[float, float],
    steps: int = 12,
    settle_ms: int = 120,
) -> None:
    """Pointer drag with a small initial nudge (crosses the drag threshold)."""
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0] + 6, start[1] + 6, steps=2)
    page.mouse.move(*end, steps=steps)
    page.mouse.move(*end)
    page.mouse.up()
    page.wait_for_timeout(settle_ms)


def center(box: Mapping[str, Any]) -> tuple[float, float]:
    """Center of a rect keyed either {x, y, w, h} or {x, y, width, height}
    (accepts Playwright's FloatRect)."""
    w = box["w"] if "w" in box else box["width"]
    h = box["h"] if "h" in box else box["height"]
    return box["x"] + w / 2, box["y"] + h / 2


def layout(page: Page) -> dict:
    return page.evaluate("() => window.__dockLayout")


def floating_group_ids(page: Page, require_grip: bool = False) -> list[str]:
    """Group ids not docked under a leaf, in DOM order. With ``require_grip``,
    only groups that can be DRAGGED (have a grip handle) -- this excludes the
    unmergeable monitor panel (click-to-minimize header, no grip) and
    area-backing groups (their strip never drags the group)."""
    grip_filter = (
        " && e.querySelector('[data-dock-griphandle]') !== null" if require_grip else ""
    )
    return page.eval_on_selector_all(
        "[data-dock-group]",
        f"""els => els.filter(e => !e.closest('[data-dock-leaf]'){grip_filter})
            .map(e => e.getAttribute('data-dock-group'))""",
    )


def group_box(page: Page, gid: str) -> dict:
    """Bounding rect of a group element: {x, y, w, h, right, bottom}."""
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height, "
        "right: r.right, bottom: r.bottom }; }",
    )


def leaf_box(page: Page, gid: str) -> dict:
    """Bounding rect of the docked LEAF containing the group `gid`."""
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        "e => { const l = e.closest('[data-dock-leaf]'); "
        "const r = l.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height, "
        "right: r.right, bottom: r.bottom }; }",
    )


def group_grip_center(page: Page, gid: str) -> tuple[float, float]:
    """Center of the grip bar of the group with DOM id `gid`. (Dropping another
    panel here is the per-panel 'above THIS one' zone: clientY < strip.top.)"""
    box = page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-griphandle]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    return box["x"], box["y"]


def drag_group(page: Page, gid: str, end: tuple[float, float], steps: int = 12) -> None:
    """Drag the group `gid` by its grip handle to `end`."""
    drag(page, group_grip_center(page, gid), end, steps=steps)


def right_cols(page: Page) -> list[dict]:
    """Right-edge docked LEAVES with rendered geometry, in DOM order (one entry
    per leaf: {g: group id, x, y, w, h})."""
    return page.eval_on_selector_all(
        '[data-dock-leaf][data-dock-edge="right"]',
        """els => els.map(l => {
            const r = l.getBoundingClientRect();
            const g = l.querySelector('[data-dock-group]');
            return { g: g ? g.getAttribute('data-dock-group') : null,
                     x: Math.round(r.x), y: Math.round(r.y),
                     w: Math.round(r.width), h: Math.round(r.height) }; })""",
    )


def park_monitor(page: Page) -> None:
    """Park the unmergeable monitor window (seeded at x 900-1200, y 60-440; its
    full-bleed area merges away anything dropped on it) at the lower left, clear
    of the right side and the drop areas the dock tests use. Dragged by its
    'Connected' header text -- it has no grip handle."""
    hdr = page.get_by_text("Connected").bounding_box()
    assert hdr is not None
    drag(
        page,
        (hdr["x"] + hdr["width"] / 2, hdr["y"] + hdr["height"] / 2),
        (300, 640),
    )


def setup_side_by_side(page: Page, a: str, b: str) -> bool:
    """Dock `a` to the right screen edge, then drop `b` on a's LEFT split band
    -> side-by-side [b | a]. True if a 2-column right region resulted."""
    vw = page.viewport_size["width"]  # type: ignore[index]
    drag_group(page, a, (vw - 10, 400))
    ab = group_box(page, a)
    drag_group(page, b, (ab["x"] + ab["w"] * 0.10, ab["y"] + ab["h"] / 2))
    cols = right_cols(page)
    gids = [c["g"] for c in cols]
    return len(cols) == 2 and a in gids and b in gids


def collect_errors(page: Page) -> list[str]:
    """Start collecting console/page errors into the returned (live) list."""
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    return errors


def real_errors(errors: list[str]) -> list[str]:
    """Drop dev-server noise (HMR/websocket chatter) from console errors."""
    return [
        e
        for e in errors
        if "websocket" not in e.lower()
        and "[vite]" not in e.lower()
        and "failed to load resource" not in e.lower()
    ]


def group_id_for_panel(page: Page, panel_id: str) -> str:
    return page.evaluate(
        """(pid) => {
            const l = window.__dockLayout;
            for (const [gid, g] of Object.entries(l.groups)) {
                if (g.panelIds.includes(pid)) return gid;
            }
            return null;
        }""",
        panel_id,
    )


def floating_window_for_panel(page: Page, panel_id: str) -> dict | None:
    return page.evaluate(
        """(pid) => {
            const l = window.__dockLayout;
            for (const win of l.floating) {
                for (const gid of win.stack) {
                    if (l.groups[gid]?.panelIds.includes(pid))
                        return { id: win.id, x: win.x, y: win.y };
                }
            }
            return null;
        }""",
        panel_id,
    )


def grip_center(page: Page, panel_id: str) -> tuple[float, float]:
    """Center of the grip bar of the group containing `panel_id`."""
    return group_grip_center(page, group_id_for_panel(page, panel_id))


def collapsed(page: Page, gid: str) -> bool:
    return page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    )


def hint_visible(page: Page) -> bool:
    return page.evaluate(
        """() => {
            const h = document.querySelector('[data-dock-hint]');
            return h !== null && h.style.display !== 'none';
        }"""
    )
