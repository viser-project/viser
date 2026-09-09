"""Table Data Example

Example demonstrating the table data GUI element with editable cells,
row selection, and dynamic data manipulation.
"""

import time

import viser

server = viser.ViserServer()
server.gui.configure_theme(dark_mode=False, control_width="large")


# Create a table with typed columns
table = server.gui.add_table_data(
    "Measurements",
    columns=[
        ("ID", "number", False),  # Read-only numeric ID
        ("Name", "string", True),  # Editable name
        ("Value", "number", True),  # Editable numeric value
        ("Status", "string", True),  # Editable status
    ],
    initial_rows=[
        (1, "Sample A", 42.5, "Active"),
        (2, "Sample B", 38.2, "Pending"),
        (3, "Sample C", 45.1, "Active"),
    ],
    selection_mode="single",
    hint="Click a row to select it, click cells to edit them",
)


# Add buttons to manipulate the table
with server.gui.add_folder("Table Controls"):
    add_button = server.gui.add_button("Add Row")
    clear_button = server.gui.add_button("Clear All Rows")
    delete_last_button = server.gui.add_button("Delete Last Row")
    update_cell_button = server.gui.add_button("Update Cell (0,2)")

# Display current selection
selection_text = server.gui.add_text(
    "Selected Row",
    initial_value="No row selected",
    disabled=True,
)


# Track row counter for IDs
row_counter = [4]  # Using list to allow modification in nested function


@add_button.on_click
def _(_):
    """Add a new row to the table."""
    new_id = row_counter[0]
    table.append_row((new_id, f"Sample {chr(64 + new_id)}", 50.0, "New"))
    row_counter[0] += 1
    print(f"Added row with ID {new_id}")


@clear_button.on_click
def _(_):
    """Clear all rows from the table."""
    table.clear_rows()
    row_counter[0] = 1
    print("Cleared all rows")


@delete_last_button.on_click
def _(_):
    """Delete the last row from the table."""
    if len(table.value) > 0:
        last_idx = len(table.value) - 1
        table.delete_row(last_idx)
        print(f"Deleted row at index {last_idx}")
    else:
        print("Table is empty, nothing to delete")


@update_cell_button.on_click
def _(_):
    """Update a specific cell value."""
    if len(table.value) > 0:
        import random

        new_value = round(random.uniform(30, 60), 2)
        table.set_cell(row=0, col=2, value=new_value)
        print(f"Updated cell (0,2) to {new_value}")
    else:
        print("Table is empty, nothing to update")


@table.on_select_row
def _(event):
    """Handle row selection."""
    row_idx = event.target.selected_row
    if row_idx >= 0:
        row_data = event.target.value[row_idx]
        selection_text.value = f"Selected row {row_idx}: {row_data}"
        print(f"Selected row {row_idx}: {row_data}")
    else:
        selection_text.value = "No row selected"
        print("Row deselected")


# Example: Simple string table
simple_table = server.gui.add_table_data(
    "Simple String Table",
    columns=["Column A", "Column B", "Column C"],
    initial_rows=[
        ("Data 1", "Data 2", "Data 3"),
        ("Data 4", "Data 5", "Data 6"),
    ],
    hint="All cells are editable strings",
)


# Example: Table without selection
readonly_table = server.gui.add_table_data(
    "Read-Only Table",
    columns=[
        ("Timestamp", "string", False),
        ("Event", "string", False),
        ("Count", "number", False),
    ],
    initial_rows=[
        ("2024-01-01 10:00:00", "System Start", 1),
        ("2024-01-01 10:05:23", "User Login", 5),
        ("2024-01-01 10:12:45", "Data Update", 142),
    ],
    selection_mode="none",
    hint="This table is completely read-only",
)


print("Table data example server running!")
print("- Click on cells to edit them")
print("- Click on rows in the first table to select them")
print("- Use the buttons to manipulate the table data")

while True:
    time.sleep(1.0)
