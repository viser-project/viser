"""Manual stepped acceptance test for drag/click/scene-pointer behavior.

This is a developer harness, not a pytest file -- it spins up a viser server
with a GUI stepper that walks through every edge case the drag-handler
branch fixes. Each phase sets up a scene, gives you an instruction, and
then shows what fired so you can confirm the observed behavior matches
the expectation.

Run:

    python tests/drag_handler_tests.py

Open the printed URL, follow the instruction at the top of the GUI, then
press "Next phase". The status log at the bottom prints every callback
firing so you can diff observed vs. expected without leaving the page.

Edge cases covered:

  1. Click-only node: small jitter still fires click (motion-threshold
     suppression for stationary-ish gestures).
  2. Drag-only node: drag fires immediately, no click race.
  3. Click+drag node: stationary press fires click, drag fires drag.
     A press+drag must NOT fire the click handler. A press without
     motion must NOT fire drag start/update/end.
  4. Scene on_click: plain left-drag on empty space orbits the camera
     (does NOT disable orbit at pointerdown).
  5. Scene on_click: stationary press in empty space fires the scene
     click handler.
  6. Scene on_rect_select(modifier="shift"): shift-drag fires
     rect-select AND suppresses orbit; plain drag still orbits.
  7. Parallel state slots: shift+drag on a draggable node engages
     BOTH the node candidate AND the rect-select gesture.
  8. Modifier-filtered click does NOT block plain orbit (an
     on_click(modifier="cmd/ctrl") still lets plain drag orbit).
  9. Multiple drag handlers on the same node, different modifiers,
     route to the right one.
 10. Window blur mid-drag fires the "end" phase exactly once so
     per-drag state can be released cleanly.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

import viser
from viser._messages import KeyModifier

# ---------------------------------------------------------------------------
# Stepper state.
# ---------------------------------------------------------------------------


@dataclass
class Phase:
    """One acceptance step."""

    title: str
    instructions: str
    expected: str
    setup: Callable[["Harness"], None]


@dataclass
class Harness:
    server: viser.ViserServer
    log_handle: viser.GuiMarkdownHandle  # status log
    counters: dict[str, int] = field(default_factory=dict)
    log_lines: list[str] = field(default_factory=list)
    log_lock: threading.Lock = field(default_factory=threading.Lock)
    # Scene-level callbacks registered by the current phase. Tracked
    # so teardown can remove only this phase's handlers without
    # touching anything else on the scene.
    scene_click_cbs: list[Callable] = field(default_factory=list)
    scene_rect_select_cbs: list[Callable] = field(default_factory=list)
    # Scene nodes created by the current phase, tracked by name.
    phase_node_names: list[str] = field(default_factory=list)

    def log(self, line: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        with self.log_lock:
            self.log_lines.append(f"`{stamp}` {line}")
            if len(self.log_lines) > 30:
                self.log_lines.pop(0)
            self.log_handle.content = "### Event log\n\n" + "\n\n".join(
                reversed(self.log_lines)
            )

    def bump(self, key: str) -> int:
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    def teardown(self) -> None:
        self.counters.clear()
        # Remove this phase's nodes only -- leaves the orbit marker
        # and world axes alone so they keep providing a parallax cue.
        for name in self.phase_node_names:
            try:
                self.server.scene.remove_by_name(name)
            except Exception:  # noqa: BLE001
                # Node may have been removed already (e.g. by a
                # repeated reset). Quietly ignore.
                pass
        self.phase_node_names.clear()
        # Drop this phase's scene-level callbacks.
        for cb in self.scene_click_cbs:
            try:
                self.server.scene.remove_click_callback(cb)
            except Exception:  # noqa: BLE001
                pass
        self.scene_click_cbs.clear()
        for cb in self.scene_rect_select_cbs:
            try:
                self.server.scene.remove_rect_select_callback(cb)
            except Exception:  # noqa: BLE001
                pass
        self.scene_rect_select_cbs.clear()

    def add_box(
        self,
        name: str,
        dimensions: tuple[float, float, float],
        color: tuple[int, int, int],
        position: tuple[float, float, float] = (0.0, 0.0, 0.0),
    ) -> viser.BoxHandle:
        handle = self.server.scene.add_box(
            name, dimensions=dimensions, color=color, position=position
        )
        self.phase_node_names.append(name)
        return handle

    def on_scene_click(self, modifier: KeyModifier | None = None) -> Callable:
        def decorator(func: Callable) -> Callable:
            registered = self.server.scene.on_click(modifier=modifier)(func)
            self.scene_click_cbs.append(registered)
            return registered

        return decorator

    def on_scene_rect_select(self, modifier: KeyModifier | None = None) -> Callable:
        def decorator(func: Callable) -> Callable:
            registered = self.server.scene.on_rect_select(modifier=modifier)(func)
            self.scene_rect_select_cbs.append(registered)
            return registered

        return decorator


# ---------------------------------------------------------------------------
# Phase definitions.
# ---------------------------------------------------------------------------


def _phase_click_only(h: Harness) -> None:
    """Edge case 1: click-only node, motion threshold."""
    box = h.add_box(
        "/test/click_only",
        dimensions=(0.6, 0.6, 0.6),
        color=(180, 220, 255),
    )

    @box.on_click
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        n = h.bump("click_only/click")
        h.log(f"click-only box: on_click #{n} (modifier={event.modifier})")


def _phase_drag_only(h: Harness) -> None:
    """Edge case 2: drag-only node."""
    box = h.add_box(
        "/test/drag_only",
        dimensions=(0.6, 0.6, 0.6),
        color=(255, 200, 200),
    )

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"drag_only/{event.phase}")
        h.log(f"drag-only box: on_drag phase={event.phase} #{n}")


def _phase_click_and_drag(h: Harness) -> None:
    """Edge case 3: tap-vs-drag gate."""
    box = h.add_box(
        "/test/click_and_drag",
        dimensions=(0.6, 0.6, 0.6),
        color=(220, 255, 200),
    )

    @box.on_click
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        n = h.bump("click_and_drag/click")
        h.log(f"click+drag box: on_click #{n}")

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"click_and_drag/{event.phase}")
        h.log(f"click+drag box: on_drag phase={event.phase} #{n}")


def _phase_scene_click_does_not_disable_orbit(h: Harness) -> None:
    """Edge case 4 + 5: scene.on_click() is passive at pointerdown.

    Plain drag on empty space should orbit; stationary press should
    fire the click handler.
    """

    @h.on_scene_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event
        n = h.bump("scene/click")
        h.log(f"scene.on_click() fired #{n}")


def _phase_rect_select_with_shift(h: Harness) -> None:
    """Edge case 6: rect-select with shift modifier suppresses orbit
    on shift+drag but plain drag still orbits."""

    @h.on_scene_rect_select(modifier="shift")
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event
        n = h.bump("scene/rect_select_shift")
        h.log(f"scene.on_rect_select(modifier='shift') fired #{n}")


def _phase_parallel_node_and_rect_select(h: Harness) -> None:
    """Edge case 7: parallel state slots.

    A clickable+draggable node and a shift rect-select both registered.
    Shift-drag starting ON the box should fire rect-select; plain drag
    starting ON the box should drag the box (not orbit, not rect-select);
    plain click on the box should fire on_click.
    """
    box = h.add_box(
        "/test/parallel",
        dimensions=(0.6, 0.6, 0.6),
        color=(255, 230, 150),
    )

    @box.on_click
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        n = h.bump("parallel/click")
        h.log(f"parallel box: on_click #{n}")

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"parallel/drag_{event.phase}")
        h.log(f"parallel box: on_drag phase={event.phase} #{n}")

    @h.on_scene_rect_select(modifier="shift")
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event
        n = h.bump("scene/rect_select_shift")
        h.log(f"scene.on_rect_select(modifier='shift') fired #{n}")


def _phase_modifier_filtered_click(h: Harness) -> None:
    """Edge case 8: modifier-filtered click does not block plain orbit."""

    @h.on_scene_click(modifier="cmd/ctrl")
    def _(event: viser.SceneClickEvent) -> None:
        del event
        n = h.bump("scene/click_cmdctrl")
        h.log(f"scene.on_click(modifier='cmd/ctrl') fired #{n}")


def _phase_multiple_drag_handlers(h: Harness) -> None:
    """Edge case 9: multiple drag handlers, different modifiers."""
    box = h.add_box(
        "/test/multi_modifier",
        dimensions=(0.6, 0.6, 0.6),
        color=(220, 200, 255),
    )

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"multi/plain_{event.phase}")
        h.log(f"multi box: plain drag phase={event.phase} #{n}")

    @box.on_drag("left", modifier="cmd/ctrl")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"multi/cmdctrl_{event.phase}")
        h.log(f"multi box: cmd/ctrl drag phase={event.phase} #{n}")

    @box.on_drag("left", modifier="shift")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"multi/shift_{event.phase}")
        h.log(f"multi box: shift drag phase={event.phase} #{n}")


def _phase_blur_during_drag(h: Harness) -> None:
    """Edge case 10: window blur mid-drag fires the 'end' phase.

    Press down on the box, then alt-tab (or click into another window)
    while still holding the mouse. The drag should receive an 'end'
    phase exactly once.
    """
    box = h.add_box(
        "/test/blur_test",
        dimensions=(0.6, 0.6, 0.6),
        color=(255, 200, 255),
    )
    state = {"saw_start": False, "saw_end": False}

    @box.on_drag("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        n = h.bump(f"blur/{event.phase}")
        h.log(f"blur box: on_drag phase={event.phase} #{n}")
        if event.phase == "start":
            state["saw_start"] = True
        elif event.phase == "end":
            state["saw_end"] = True
            if state["saw_start"]:
                h.log("blur box: end phase fired after start -- lifecycle complete")


PHASES: list[Phase] = [
    Phase(
        title="1. Click-only node",
        instructions=(
            "A blue box appears at the origin. It has an `on_click` "
            "handler but no `on_drag`.\n\n"
            "**Do this:**\n"
            "- Click the box once (no motion).\n"
            "- Then press and drag the box ~30 px (small motion).\n"
            "- Then press and drag the box across the canvas (>50 px)."
        ),
        expected=(
            "- Stationary click: `click_only/click` increments by 1.\n"
            "- Small drag (~30 px): camera orbits, `click_only/click` "
            "does NOT increment (motion threshold suppresses).\n"
            "- Large drag: camera orbits, no click."
        ),
        setup=_phase_click_only,
    ),
    Phase(
        title="2. Drag-only node (3px motion gate)",
        instructions=(
            "A red box appears. It has an `on_drag` handler but no "
            "`on_click`. Drag-only nodes use the same 3px motion gate "
            "as click+drag nodes -- a stationary press fires nothing.\n\n"
            "**Do this:**\n"
            "- Press and drag the box across the canvas (>3 px).\n"
            "- Press and release the box without moving.\n"
            "- Press the box, jitter ~2 px, release (sub-threshold)."
        ),
        expected=(
            "- Drag (>3 px): `drag_only/start` += 1, "
            "`drag_only/update` += N (>=1), `drag_only/end` += 1.\n"
            "- Stationary press: NO drag callbacks fire.\n"
            "- Sub-threshold jitter (<3 px): NO drag callbacks fire."
        ),
        setup=_phase_drag_only,
    ),
    Phase(
        title="3. Click + drag node (tap-vs-drag gate)",
        instructions=(
            "A green box appears with BOTH `on_click` and `on_drag` "
            "handlers.\n\n"
            "**Do this:**\n"
            "- Click the box without moving.\n"
            "- Press the box and drag across the canvas.\n"
            "- Press the box, jitter ~2 px, release (sub-threshold)."
        ),
        expected=(
            "- Stationary click: `click_and_drag/click` += 1. No drag "
            "callbacks.\n"
            "- Drag (>3 px motion): `click_and_drag/start/update/end` "
            "fire. `click_and_drag/click` does NOT increment.\n"
            "- Sub-threshold jitter (<3 px): treated as click -- "
            "`click_and_drag/click` += 1. No drag callbacks."
        ),
        setup=_phase_click_and_drag,
    ),
    Phase(
        title="4. scene.on_click() is passive at pointerdown",
        instructions=(
            "A `scene.on_click()` handler is registered. No nodes in the "
            "scene.\n\n"
            "**Do this:**\n"
            "- Plain left-drag on empty space.\n"
            "- Stationary click on empty space."
        ),
        expected=(
            "- Drag on empty space: camera orbits. `scene/click` does "
            "NOT increment.\n"
            "- Stationary click: camera does NOT move; `scene/click` "
            "+= 1."
        ),
        setup=_phase_scene_click_does_not_disable_orbit,
    ),
    Phase(
        title="5. Rect-select with shift",
        instructions=(
            "A `scene.on_rect_select(modifier='shift')` handler is "
            "registered.\n\n"
            "**Do this:**\n"
            "- Plain left-drag on empty space (no shift).\n"
            "- Shift + left-drag on empty space."
        ),
        expected=(
            "- Plain drag: camera orbits, no rect-select rectangle, "
            "`scene/rect_select_shift` does NOT increment.\n"
            "- Shift drag: rubber-band rectangle appears, camera does "
            "NOT orbit, `scene/rect_select_shift` += 1 on release."
        ),
        setup=_phase_rect_select_with_shift,
    ),
    Phase(
        title="6. Parallel slots: node drag + shift rect-select",
        instructions=(
            "A yellow draggable+clickable box AND a "
            "`scene.on_rect_select(modifier='shift')` are both "
            "registered.\n\n"
            "**Do this:**\n"
            "- Plain left-drag starting on the box (no shift).\n"
            "- Shift + left-drag starting ON the box.\n"
            "- Plain click on the box."
        ),
        expected=(
            "- Plain drag on box: `parallel/drag_*` fires, box moves. "
            "No rect-select.\n"
            "- Shift drag starting on box: rubber-band rectangle "
            "draws, `scene/rect_select_shift` += 1. The node drag "
            "candidate also engaged but resolved to no-op because the "
            "modifier doesn't match the plain `on_drag('left')` "
            "binding.\n"
            "- Click on box: `parallel/click` += 1."
        ),
        setup=_phase_parallel_node_and_rect_select,
    ),
    Phase(
        title="7. Modifier-filtered click does not block plain orbit",
        instructions=(
            "A `scene.on_click(modifier='cmd/ctrl')` handler is "
            "registered.\n\n"
            "**Do this:**\n"
            "- Plain left-drag on empty space (no modifier).\n"
            "- Cmd/Ctrl + click on empty space."
        ),
        expected=(
            "- Plain drag: camera orbits, `scene/click_cmdctrl` does "
            "NOT increment.\n"
            "- Cmd/Ctrl + click: `scene/click_cmdctrl` += 1, camera "
            "doesn't move."
        ),
        setup=_phase_modifier_filtered_click,
    ),
    Phase(
        title="8. Multiple drag handlers on one node",
        instructions=(
            "A purple box with three drag bindings: plain, cmd/ctrl, "
            "shift.\n\n"
            "**Do this:**\n"
            "- Plain left-drag the box.\n"
            "- Cmd/Ctrl + left-drag the box.\n"
            "- Shift + left-drag the box."
        ),
        expected=(
            "- Plain drag: only `multi/plain_*` fires.\n"
            "- Cmd/Ctrl drag: only `multi/cmdctrl_*` fires.\n"
            "- Shift drag: only `multi/shift_*` fires.\n"
            "- Each gesture produces exactly one `start` and one `end`."
        ),
        setup=_phase_multiple_drag_handlers,
    ),
    Phase(
        title="9. Window blur during drag fires 'end'",
        instructions=(
            "A pink box with a plain `on_drag`.\n\n"
            "**Do this:**\n"
            "- Press the box and start dragging.\n"
            "- While still holding the mouse button, Alt+Tab (or "
            "click into another app/window) to blur this window.\n"
            "- Then release the mouse."
        ),
        expected=(
            "- `blur/start` += 1 at press.\n"
            "- `blur/update` += N during motion.\n"
            "- `blur/end` += 1 *immediately* when the window loses "
            "focus -- not later when the mouse is released.\n"
            "- The log line `lifecycle complete` confirms start+end "
            "paired."
        ),
        setup=_phase_blur_during_drag,
    ),
]


# ---------------------------------------------------------------------------
# Main: build the GUI stepper.
# ---------------------------------------------------------------------------


def main() -> None:
    server = viser.ViserServer()
    server.scene.world_axes.visible = True
    server.initial_camera.position = (3.0, 3.0, 3.0)
    server.initial_camera.look_at = (0.0, 0.0, 0.0)

    # Spinning sphere so the camera-orbit checks have an obvious
    # parallax cue.
    marker = server.scene.add_icosphere(
        "/orbit_marker",
        radius=0.08,
        color=(255, 255, 255),
        position=(1.5, 0.0, 0.0),
    )

    def spin_marker() -> None:
        t0 = time.time()
        while True:
            t = time.time() - t0
            marker.position = (1.5 * np.cos(t), 1.5 * np.sin(t), 0.0)
            time.sleep(0.05)

    threading.Thread(target=spin_marker, daemon=True).start()

    # Top header.
    server.gui.add_markdown(
        "# Drag handler acceptance tests\n\n"
        "Walk through each phase, perform the gesture, then read the "
        "log at the bottom to confirm the observed counters match the "
        "expectation."
    )

    phase_idx_handle = server.gui.add_number(
        "Phase",
        initial_value=0,
        min=0,
        max=len(PHASES) - 1,
        step=1,
        disabled=True,
    )
    phase_title = server.gui.add_markdown("")
    phase_instructions = server.gui.add_markdown("")
    phase_expected = server.gui.add_markdown("")

    counter_handle = server.gui.add_markdown("")
    log_handle = server.gui.add_markdown("### Event log\n\n_(empty)_")

    harness = Harness(server=server, log_handle=log_handle)

    def render_phase(idx: int) -> None:
        harness.teardown()
        phase = PHASES[idx]
        phase_title.content = f"## {phase.title}"
        phase_instructions.content = "**Instructions**\n\n" + phase.instructions
        phase_expected.content = "**Expected**\n\n" + phase.expected
        phase_idx_handle.value = idx
        counter_handle.content = "### Counters\n\n_(none yet)_"
        log_handle.content = "### Event log\n\n_(empty)_"
        harness.log_lines.clear()
        harness.log(f"--- entered phase {idx + 1}: {phase.title} ---")
        phase.setup(harness)

    def refresh_counters() -> None:
        with harness.log_lock:
            if not harness.counters:
                counter_handle.content = "### Counters\n\n_(none yet)_"
                return
            lines = [
                f"- `{key}`: **{val}**" for key, val in sorted(harness.counters.items())
            ]
        counter_handle.content = "### Counters\n\n" + "\n".join(lines)

    # Background loop to keep the counter panel in sync with the log
    # without forcing every callback to repaint it.
    def counter_repaint() -> None:
        while True:
            refresh_counters()
            time.sleep(0.2)

    threading.Thread(target=counter_repaint, daemon=True).start()

    next_button = server.gui.add_button("Next phase ▶")
    prev_button = server.gui.add_button("◀ Previous phase")
    reset_button = server.gui.add_button("Reset current phase")

    @next_button.on_click
    def _(event: viser.GuiEvent) -> None:
        del event
        cur = int(phase_idx_handle.value)
        nxt = (cur + 1) % len(PHASES)
        render_phase(nxt)

    @prev_button.on_click
    def _(event: viser.GuiEvent) -> None:
        del event
        cur = int(phase_idx_handle.value)
        prv = (cur - 1) % len(PHASES)
        render_phase(prv)

    @reset_button.on_click
    def _(event: viser.GuiEvent) -> None:
        del event
        render_phase(int(phase_idx_handle.value))

    # Boot into the first phase.
    render_phase(0)

    print(
        "\nDrag handler acceptance tests running. Open the URL above, "
        "follow the GUI stepper, and Ctrl-C here to stop.\n"
    )
    while True:
        time.sleep(1.0)


if __name__ == "__main__":
    main()
