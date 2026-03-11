"""E2E tests for GUI interactions and callbacks."""

from __future__ import annotations

import threading

from playwright.sync_api import Page, expect

import viser

from .utils import find_gui_input, wait_for_scene_node


def test_button_click_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Clicking a button in the browser should trigger the on_click callback."""
    click_event = threading.Event()
    button = viser_server.gui.add_button("Clickable")

    @button.on_click
    def _(event: viser.GuiEvent) -> None:
        click_event.set()

    browser_button = viser_page.get_by_role("button", name="Clickable")
    expect(browser_button).to_be_visible(timeout=5_000)
    browser_button.click()

    assert click_event.wait(timeout=5.0), "Button on_click callback was not triggered"


def test_checkbox_toggle_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Toggling a checkbox should trigger the on_update callback and update value."""
    update_event = threading.Event()
    received_value: list[bool] = []

    checkbox = viser_server.gui.add_checkbox("Toggleable", initial_value=False)

    @checkbox.on_update
    def _(event: viser.GuiEvent) -> None:
        received_value.append(checkbox.value)
        update_event.set()

    checkbox_input = find_gui_input(viser_page, "Toggleable")
    expect(checkbox_input).to_be_visible(timeout=5_000)
    checkbox_input.click()

    assert update_event.wait(timeout=5.0), "Checkbox on_update was not triggered"
    assert received_value[-1] is True


def test_text_input_change_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Changing a text input value should trigger on_update and update the server value."""
    update_event = threading.Event()
    received_values: list[str] = []

    text_handle = viser_server.gui.add_text("Editable", initial_value="start")

    @text_handle.on_update
    def _(event: viser.GuiEvent) -> None:
        received_values.append(text_handle.value)
        update_event.set()

    text_input = find_gui_input(viser_page, "Editable")
    expect(text_input).to_be_visible(timeout=5_000)

    text_input.fill("new value")
    text_input.blur()

    assert update_event.wait(timeout=5.0), "Text on_update was not triggered"
    assert "new value" in received_values


def test_dropdown_selection_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Selecting a dropdown option should trigger on_update with the new value."""
    update_event = threading.Event()
    received_values: list[str] = []

    dropdown = viser_server.gui.add_dropdown(
        "Color", options=["red", "green", "blue"], initial_value="red"
    )

    @dropdown.on_update
    def _(event: viser.GuiEvent) -> None:
        received_values.append(dropdown.value)
        update_event.set()

    select_input = find_gui_input(viser_page, "Color")
    expect(select_input).to_be_visible(timeout=5_000)
    select_input.click()

    option = viser_page.locator("div[role='option']", has_text="blue")
    expect(option).to_be_visible(timeout=5_000)
    option.click()

    assert update_event.wait(timeout=5.0), "Dropdown on_update was not triggered"
    assert "blue" in received_values


def test_button_click_multiple_times(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Multiple button clicks should each trigger the callback."""
    click_count: list[int] = [0]
    lock = threading.Lock()
    all_clicks_received = threading.Event()

    button = viser_server.gui.add_button("Multi Click")

    @button.on_click
    def _(event: viser.GuiEvent) -> None:
        with lock:
            click_count[0] += 1
            if click_count[0] >= 3:
                all_clicks_received.set()

    browser_button = viser_page.get_by_role("button", name="Multi Click")
    expect(browser_button).to_be_visible(timeout=5_000)

    for _ in range(3):
        browser_button.click()

    assert all_clicks_received.wait(timeout=5.0), (
        f"Expected >= 3 clicks, got {click_count[0]}"
    )


def test_server_value_update_round_trip(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Server-side value update should reflect in the client, and vice versa."""
    handle = viser_server.gui.add_number(
        "Round Trip", initial_value=10, min=0, max=100, step=1
    )

    number_input = find_gui_input(viser_page, "Round Trip")
    expect(number_input).to_be_visible(timeout=5_000)
    expect(number_input).to_have_value("10")

    # Server -> Client.
    handle.value = 42
    expect(number_input).to_have_value("42", timeout=5_000)

    # Client -> Server.
    update_event = threading.Event()

    @handle.on_update
    def _(event: viser.GuiEvent) -> None:
        update_event.set()

    number_input.fill("77")
    number_input.blur()

    assert update_event.wait(timeout=5.0), "Number on_update was not triggered"
    assert handle.value == 77, f"Expected server value 77, got {handle.value}"


def test_gui_and_scene_interaction(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A button click should be able to modify scene objects."""
    sphere = viser_server.scene.add_icosphere(
        "/interactive_sphere",
        radius=0.3,
        color=(255, 0, 0),
        position=(0, 0, 0),
    )

    visibility_toggled = threading.Event()
    button = viser_server.gui.add_button("Toggle Sphere")

    @button.on_click
    def _(event: viser.GuiEvent) -> None:
        sphere.visible = not sphere.visible
        visibility_toggled.set()

    wait_for_scene_node(viser_page, "/interactive_sphere")

    browser_button = viser_page.get_by_role("button", name="Toggle Sphere")
    expect(browser_button).to_be_visible(timeout=5_000)
    browser_button.click()

    assert visibility_toggled.wait(timeout=5.0), "Button callback was not triggered"


def test_disabled_button_not_clickable(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A disabled button should not trigger the callback when clicked."""
    click_event = threading.Event()
    button = viser_server.gui.add_button("No Click", disabled=True)

    @button.on_click
    def _(event: viser.GuiEvent) -> None:
        click_event.set()

    browser_button = viser_page.get_by_role("button", name="No Click")
    expect(browser_button).to_be_visible(timeout=5_000)
    expect(browser_button).to_be_disabled()

    browser_button.click(force=True)
    viser_page.wait_for_timeout(500)

    assert not click_event.is_set(), (
        "Disabled button callback should not have been triggered"
    )


def test_disabled_toggle_from_server(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Toggling disabled from the server should update the client state."""
    button = viser_server.gui.add_button("Toggle Disable")

    browser_button = viser_page.get_by_role("button", name="Toggle Disable")
    expect(browser_button).to_be_visible(timeout=5_000)
    expect(browser_button).to_be_enabled()

    button.disabled = True
    expect(browser_button).to_be_disabled(timeout=5_000)

    button.disabled = False
    expect(browser_button).to_be_enabled(timeout=5_000)
