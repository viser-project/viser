"""Date and Time Pickers

Examples of date-only, time-only, and datetime pickers.
"""

import datetime
import time

import viser


def main():
    server = viser.ViserServer()

    # Add date picker.
    gui_date = server.gui.add_date(
        "Date",
        initial_value=datetime.date.today(),
        hint="Select a date",
    )

    # Add time picker.
    gui_time = server.gui.add_time(
        "Time",
        initial_value=datetime.time(14, 30, 0),
        hint="Select a time",
    )

    # Add datetime picker.
    gui_datetime = server.gui.add_datetime(
        "DateTime",
        initial_value=datetime.datetime.now(),
        hint="Select a date and time",
    )

    # Add a button to set to current values.
    button = server.gui.add_button("Set to Now")

    @button.on_click
    def _(_) -> None:
        now = datetime.datetime.now()
        gui_date.value = now.date()
        gui_time.value = now.time()
        gui_datetime.value = now

    # Display selected values.
    with server.gui.add_folder("Selected Values"):
        date_display = server.gui.add_text("Date", initial_value="", disabled=True)
        time_display = server.gui.add_text("Time", initial_value="", disabled=True)
        datetime_display = server.gui.add_text(
            "DateTime", initial_value="", disabled=True
        )

    # Update display continuously.
    while True:
        # Format the values for display.
        date_display.value = gui_date.value.isoformat()
        time_display.value = gui_time.value.isoformat()
        datetime_display.value = gui_datetime.value.strftime("%Y-%m-%d %H:%M:%S")

        time.sleep(0.1)


if __name__ == "__main__":
    main()
