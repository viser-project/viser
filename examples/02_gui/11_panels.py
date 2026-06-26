"""Standalone panels

Create dockable / floating GUI panels that live outside the main control panel,
and place them programmatically.

A panel is a dockable container; tabs are its content. Placement is imperative:

* :meth:`viser.GuiApi.add_panel` creates a standalone panel.
* :meth:`viser.PanelHandle.add_tab` adds a tab to fill with GUI elements.
* :meth:`viser.PanelHandle.dock_left` / :meth:`viser.PanelHandle.dock_right` dock
  to a viewport edge.
* :meth:`viser.PanelHandle.dock_above` / :meth:`viser.PanelHandle.dock_below`
  stack a panel relative to another panel.
* :meth:`viser.PanelHandle.float` floats a panel at an explicit position. The
  coordinates are relative to the viewport (the canvas inside any docked panels),
  so a float lands clear of docked panels and shifts to stay within the canvas if
  the docked regions change.
* :meth:`viser.PanelHandle.set_width` / :meth:`viser.PanelHandle.set_height`
  size a panel (``set_height`` applies to floating panels only).
* ``add_panel(expand_by_default=False)`` starts a panel minimized (a one-shot
  initial hint, like a folder's; the user controls collapse/expand thereafter).

Placement is replayed to clients that connect later, but is not continuously
synchronized: once a panel is placed, users can freely drag, dock, and minimize
it in the browser. The server owns a panel's existence -- there is no close
button; a panel disappears only when :meth:`viser.PanelHandle.remove` is called.

:attr:`viser.GuiApi.main_panel` exposes the same placement commands for the main
control panel, and is a legal dock anchor for other panels.
"""

import time

import numpy as np

import viser


def main() -> None:
    server = viser.ViserServer()

    server.scene.add_frame("/axes", axes_length=1.0, axes_radius=0.02)

    # A panel docked to the right edge, with two tabs. All panels here start
    # minimized via the one-shot `expand_by_default=False` hint -- they render as
    # handles/strips the user can click to expand; the user controls collapse and
    # expand thereafter.
    stats_panel = server.gui.add_panel(expand_by_default=False)
    with stats_panel.add_tab("Stats", viser.Icon.CHART_BAR):
        counter = server.gui.add_number("Counter", initial_value=0, disabled=True)
        server.gui.add_markdown("Live values update in this docked panel.")
    with stats_panel.add_tab("Notes", viser.Icon.NOTES):
        server.gui.add_markdown("A second tab in the same panel.")
    stats_panel.dock_right()
    stats_panel.set_width(320)

    # A floating panel at an explicit position. x/y are viewport-relative (the
    # canvas inside docked panels), so this stays clear of the left-docked main
    # panel below and shifts if the docked regions change.
    tools_panel = server.gui.add_panel(expand_by_default=False)
    with tools_panel.add_tab("Tools", viser.Icon.TOOL):
        randomize = server.gui.add_button("Randomize point cloud")
    tools_panel.float(x=30, y=30, width=260)

    # A panel stacked below the docked stats panel (a column split).
    log_panel = server.gui.add_panel(expand_by_default=False)
    with log_panel.add_tab("Log", viser.Icon.TERMINAL):
        log = server.gui.add_markdown("Waiting for events...")
    log_panel.dock_below(stats_panel)

    # The main control panel can be placed too -- here, docked to the left.
    server.gui.main_panel.dock_left()

    rng = np.random.default_rng(0)
    points = rng.normal(size=(2000, 3)) * 0.5
    log_lines: list[str] = []

    def append_log(message: str) -> None:
        # Keep a short rolling history so the log reads like a real log, not a
        # single replaced line.
        log_lines.append(message)
        del log_lines[:-8]  # keep the last 8 lines
        log.content = "\n\n".join(log_lines)

    @randomize.on_click
    def _(_) -> None:
        nonlocal points
        points = rng.normal(size=(2000, 3)) * 0.5
        append_log(f"Randomized at t={counter.value}.")

    while True:
        counter.value += 1
        server.scene.add_point_cloud(
            "/points", points=points, colors=(120, 180, 255), point_size=0.02
        )
        time.sleep(0.5)


if __name__ == "__main__":
    main()
