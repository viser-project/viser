"""Datetime picker

Example of using the datetime picker GUI control for selecting dates and times.

This example demonstrates :meth:`viser.GuiApi.add_datetime` for datetime input,
which is useful for applications that need to work with temporal data, such as:

* Dynamic scene visualization
* Time-series data exploration
* Animation playback controls
* Event scheduling

The datetime picker provides a user-friendly interface for selecting both date and
time values, with the value automatically synchronized across all connected clients.
"""

import datetime
import time

import viser


def main() -> None:
    server = viser.ViserServer()

    # Add a datetime picker with the current time as the initial value
    gui_datetime = server.gui.add_datetime(
        "Select Time",
        initial_value=datetime.datetime.now(),
    )

    # Add a button to set the datetime to now
    gui_set_now = server.gui.add_button("Set to Now")

    # Add a text display to show the selected datetime
    gui_display = server.gui.add_text(
        "Display",
        initial_value="",
        disabled=True,
    )

    @gui_set_now.on_click
    def _(_) -> None:
        """Callback to set the datetime to the current time."""
        gui_datetime.value = datetime.datetime.now()

    # Update display continuously
    while True:
        # Format the datetime for display
        selected_time = gui_datetime.value
        formatted = selected_time.strftime("%Y-%m-%d %H:%M:%S")

        # Calculate time difference from now
        now = datetime.datetime.now()
        diff = now - selected_time

        if diff.total_seconds() > 0:
            time_desc = f"{int(diff.total_seconds())} seconds ago"
        else:
            time_desc = f"in {int(-diff.total_seconds())} seconds"

        gui_display.value = f"{formatted} ({time_desc})"

        time.sleep(0.1)


if __name__ == "__main__":
    main()
