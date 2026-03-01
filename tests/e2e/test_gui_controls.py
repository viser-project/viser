"""E2E tests for GUI controls rendering and interaction."""

from __future__ import annotations

from playwright.sync_api import Page, expect

import viser

from .utils import find_gui_input


def test_button_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A button added via the server should appear in the DOM."""
    viser_server.gui.add_button("Click Me", color="blue")

    button = viser_page.get_by_role("button", name="Click Me")
    expect(button).to_be_visible(timeout=5_000)
    expect(button).to_be_enabled()


def test_button_disabled(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A disabled button should render as disabled in the DOM."""
    viser_server.gui.add_button("Disabled Btn", disabled=True)

    button = viser_page.get_by_role("button", name="Disabled Btn")
    expect(button).to_be_visible(timeout=5_000)
    expect(button).to_be_disabled()


def test_checkbox_renders_with_initial_value(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A checkbox should render and reflect its initial checked state."""
    viser_server.gui.add_checkbox("Enable Feature", initial_value=True)

    checkbox = find_gui_input(viser_page, "Enable Feature")
    expect(checkbox).to_be_visible(timeout=5_000)
    expect(checkbox).to_be_checked()


def test_checkbox_unchecked(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A checkbox with initial_value=False should be unchecked."""
    viser_server.gui.add_checkbox("Toggle", initial_value=False)

    checkbox = find_gui_input(viser_page, "Toggle")
    expect(checkbox).to_be_visible(timeout=5_000)
    expect(checkbox).not_to_be_checked()


def test_slider_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A slider should render with its label."""
    viser_server.gui.add_slider(
        "Opacity", min=0.0, max=1.0, step=0.01, initial_value=0.75
    )

    label = viser_page.locator("label", has_text="Opacity")
    expect(label).to_be_visible(timeout=5_000)

    label_for = label.get_attribute("for")
    slider = viser_page.locator(f'[id="{label_for}"]')
    expect(slider).to_be_visible()


def test_text_input_renders_with_value(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A text input should render and display its initial value."""
    viser_server.gui.add_text("Name", initial_value="Hello Viser")

    text_input = find_gui_input(viser_page, "Name")
    expect(text_input).to_be_visible(timeout=5_000)
    expect(text_input).to_have_value("Hello Viser")


def test_number_input_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A number input should render and display its initial value."""
    viser_server.gui.add_number("Count", initial_value=42, min=0, max=100, step=1)

    number_input = find_gui_input(viser_page, "Count")
    expect(number_input).to_be_visible(timeout=5_000)
    expect(number_input).to_have_value("42")


def test_dropdown_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A dropdown should render and show the initial (first) option."""
    viser_server.gui.add_dropdown("Material", options=["standard", "toon3", "toon5"])

    select_input = find_gui_input(viser_page, "Material")
    expect(select_input).to_be_visible(timeout=5_000)
    expect(select_input).to_have_value("standard")


def test_dropdown_with_initial_value(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A dropdown with an explicit initial_value should show that value."""
    viser_server.gui.add_dropdown(
        "Shape",
        options=["circle", "square", "triangle"],
        initial_value="triangle",
    )

    select_input = find_gui_input(viser_page, "Shape")
    expect(select_input).to_be_visible(timeout=5_000)
    expect(select_input).to_have_value("triangle")


def test_markdown_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Markdown content should be rendered as HTML in the GUI panel."""
    viser_server.gui.add_markdown("## Hello World\n\nThis is **bold** text.")

    heading = viser_page.locator("h2", has_text="Hello World")
    expect(heading).to_be_visible(timeout=5_000)

    bold = viser_page.locator("strong", has_text="bold")
    expect(bold).to_be_visible()


def test_folder_renders_and_contains_children(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A folder should render with its label and contain child elements."""
    with viser_server.gui.add_folder("Settings"):
        viser_server.gui.add_checkbox("Dark Mode Custom", initial_value=False)
        viser_server.gui.add_slider("Volume", min=0, max=100, step=1, initial_value=50)

    folder_label = viser_page.locator("text=Settings").first
    expect(folder_label).to_be_visible(timeout=5_000)

    child_label = viser_page.locator("label", has_text="Dark Mode Custom")
    expect(child_label).to_be_visible(timeout=5_000)


def test_folder_collapse_toggle(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Clicking a folder label should toggle its collapsed state."""
    with viser_server.gui.add_folder("Toggleable"):
        viser_server.gui.add_checkbox("Inner Check", initial_value=True)

    inner_label = viser_page.locator("label", has_text="Inner Check")
    expect(inner_label).to_be_visible(timeout=5_000)

    folder_label = viser_page.locator("text=Toggleable").first
    folder_label.click()
    expect(inner_label).to_be_hidden(timeout=3_000)

    folder_label.click()
    expect(inner_label).to_be_visible(timeout=3_000)


def test_multiple_gui_elements_order(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """GUI elements should appear in the order they are added."""
    names = ["First Button", "Second Button", "Third Button"]
    for name in names:
        viser_server.gui.add_button(name)

    for name in names:
        expect(viser_page.get_by_role("button", name=name)).to_be_visible(timeout=5_000)

    # Brief reflow buffer before reading bounding boxes.
    viser_page.wait_for_timeout(300)

    boxes = []
    for name in names:
        box = viser_page.get_by_role("button", name=name).bounding_box()
        assert box is not None
        boxes.append(box)

    assert boxes[0]["y"] < boxes[1]["y"] < boxes[2]["y"]


def test_gui_element_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a GUI element on the server should remove it from the DOM."""
    handle = viser_server.gui.add_button("Temporary")

    button = viser_page.get_by_role("button", name="Temporary")
    expect(button).to_be_visible(timeout=5_000)

    handle.remove()
    expect(button).to_be_hidden(timeout=5_000)


def test_gui_visibility_toggle(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Setting visible=False on a GUI handle should hide the element."""
    handle = viser_server.gui.add_button("Hideable")

    button = viser_page.get_by_role("button", name="Hideable")
    expect(button).to_be_visible(timeout=5_000)

    handle.visible = False
    expect(button).to_be_hidden(timeout=5_000)

    handle.visible = True
    expect(button).to_be_visible(timeout=5_000)


def test_server_updates_text_value(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Updating a GUI value from the server should be reflected in the client."""
    handle = viser_server.gui.add_text("Dynamic", initial_value="initial")

    text_input = find_gui_input(viser_page, "Dynamic")
    expect(text_input).to_be_visible(timeout=5_000)
    expect(text_input).to_have_value("initial")

    handle.value = "updated"
    expect(text_input).to_have_value("updated", timeout=5_000)
