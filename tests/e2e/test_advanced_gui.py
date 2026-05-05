"""E2E tests for advanced GUI controls: tabs, modals, color pickers, vectors, etc."""

from __future__ import annotations

import threading

from playwright.sync_api import Page, expect

import viser

# --- Tab groups ---


def test_tab_group_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A tab group with multiple tabs should render all tab labels."""
    tab_group = viser_server.gui.add_tab_group()
    with tab_group.add_tab("Alpha"):
        viser_server.gui.add_button("Alpha Btn")
    with tab_group.add_tab("Beta"):
        viser_server.gui.add_button("Beta Btn")

    expect(viser_page.get_by_role("tab", name="Alpha")).to_be_visible(timeout=5_000)
    expect(viser_page.get_by_role("tab", name="Beta")).to_be_visible(timeout=5_000)


def test_tab_group_switching(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Clicking a tab should show its contents and hide the other tab's contents."""
    tab_group = viser_server.gui.add_tab_group()
    with tab_group.add_tab("First"):
        viser_server.gui.add_button("First Btn")
    with tab_group.add_tab("Second"):
        viser_server.gui.add_button("Second Btn")

    first_btn = viser_page.get_by_role("button", name="First Btn")
    second_btn = viser_page.get_by_role("button", name="Second Btn")
    expect(first_btn).to_be_visible(timeout=5_000)

    viser_page.get_by_role("tab", name="Second").click()
    expect(second_btn).to_be_visible(timeout=5_000)
    expect(first_btn).to_be_hidden(timeout=5_000)

    viser_page.get_by_role("tab", name="First").click()
    expect(first_btn).to_be_visible(timeout=5_000)
    expect(second_btn).to_be_hidden(timeout=5_000)


# --- Modal dialogs ---


def test_modal_renders_with_content(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A modal should appear in the DOM with its title and contained elements."""
    with viser_server.gui.add_modal("Test Modal"):
        viser_server.gui.add_markdown("Modal body text here")
        viser_server.gui.add_button("Modal Action")

    title = viser_page.locator("text=Test Modal").first
    expect(title).to_be_visible(timeout=5_000)

    modal_btn = viser_page.get_by_role("button", name="Modal Action")
    expect(modal_btn).to_be_visible(timeout=5_000)


def test_modal_close(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Closing a modal from the server should remove it from the DOM."""
    modal = viser_server.gui.add_modal("Closable Modal")
    with modal:
        viser_server.gui.add_button("Inside Modal")

    inside_btn = viser_page.get_by_role("button", name="Inside Modal")
    expect(inside_btn).to_be_visible(timeout=5_000)

    modal.close()
    expect(inside_btn).to_be_hidden(timeout=5_000)


# --- Color pickers ---


def test_rgb_color_picker_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """An RGB color picker should render with the correct label."""
    viser_server.gui.add_rgb("Color", initial_value=(255, 0, 0))

    label = viser_page.locator("label", has_text="Color")
    expect(label).to_be_visible(timeout=5_000)


def test_rgb_server_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Updating an RGB value from the server should propagate to the client."""
    handle = viser_server.gui.add_rgb("Dynamic Color", initial_value=(255, 0, 0))

    label = viser_page.locator("label", has_text="Dynamic Color")
    expect(label).to_be_visible(timeout=5_000)

    handle.value = (0, 255, 0)

    # Verify the color change reached the browser by checking the color
    # swatch's background style. Mantine renders a color preview element
    # whose background-color reflects the current value.
    gui_row = label.locator("xpath=ancestor::div[contains(@class, 'Flex-root')][1]")
    swatch = gui_row.locator("[style*='background']").first
    expect(swatch).to_have_css("background-color", "rgb(0, 255, 0)", timeout=5_000)


def test_rgba_color_picker_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """An RGBA color picker should render with the correct label."""
    viser_server.gui.add_rgba("Overlay Color", initial_value=(128, 128, 128, 200))

    label = viser_page.locator("label", has_text="Overlay Color")
    expect(label).to_be_visible(timeout=5_000)


# --- Vector inputs ---


def test_vector2_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A vector2 input should render with two number inputs."""
    viser_server.gui.add_vector2("Position 2D", initial_value=(1.0, 2.0))

    label = viser_page.locator("label", has_text="Position 2D")
    expect(label).to_be_visible(timeout=5_000)

    gui_row = label.locator("xpath=ancestor::div[contains(@class, 'Flex-root')][1]")
    inputs = gui_row.locator("input")
    expect(inputs.first).to_be_visible(timeout=5_000)
    assert inputs.count() == 2


def test_vector2_initial_values(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Vector2 inputs should display the correct initial values."""
    viser_server.gui.add_vector2("Vec2 Init", initial_value=(3.5, -1.0))

    label = viser_page.locator("label", has_text="Vec2 Init")
    expect(label).to_be_visible(timeout=5_000)

    gui_row = label.locator("xpath=ancestor::div[contains(@class, 'Flex-root')][1]")
    inputs = gui_row.locator("input")
    expect(inputs.nth(0)).to_have_value("3.5", timeout=5_000)
    expect(inputs.nth(1)).to_have_value("-1", timeout=5_000)


def test_vector3_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A vector3 input should render with three number inputs."""
    viser_server.gui.add_vector3("Position 3D", initial_value=(1.0, 2.0, 3.0))

    label = viser_page.locator("label", has_text="Position 3D")
    expect(label).to_be_visible(timeout=5_000)

    gui_row = label.locator("xpath=ancestor::div[contains(@class, 'Flex-root')][1]")
    inputs = gui_row.locator("input")
    expect(inputs.first).to_be_visible(timeout=5_000)
    assert inputs.count() == 3


def test_vector3_server_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Updating a vector3 value from the server should update the client."""
    handle = viser_server.gui.add_vector3("Dynamic Vec", initial_value=(0.0, 0.0, 0.0))

    label = viser_page.locator("label", has_text="Dynamic Vec")
    expect(label).to_be_visible(timeout=5_000)

    gui_row = label.locator("xpath=ancestor::div[contains(@class, 'Flex-root')][1]")
    inputs = gui_row.locator("input")
    expect(inputs.first).to_be_visible(timeout=5_000)

    handle.value = (10.0, 20.0, 30.0)

    expect(inputs.nth(0)).to_have_value("10", timeout=5_000)
    expect(inputs.nth(1)).to_have_value("20", timeout=5_000)
    expect(inputs.nth(2)).to_have_value("30", timeout=5_000)


# --- Button groups ---


def test_button_group_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A button group should render all option buttons."""
    viser_server.gui.add_button_group("Mode", options=["Edit", "View", "Delete"])

    for option in ["Edit", "View", "Delete"]:
        expect(viser_page.get_by_role("button", name=option)).to_be_visible(
            timeout=5_000
        )


def test_button_group_click_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Clicking a button group option should trigger the on_click callback."""
    click_event = threading.Event()
    received_value: list[str] = []

    bg = viser_server.gui.add_button_group("Action", options=["Save", "Load", "Reset"])

    @bg.on_click
    def _(event: viser.GuiEvent) -> None:
        received_value.append(bg.value)
        click_event.set()

    load_btn = viser_page.get_by_role("button", name="Load")
    expect(load_btn).to_be_visible(timeout=5_000)
    load_btn.click()

    assert click_event.wait(timeout=5.0), "Button group on_click was not triggered"
    assert "Load" in received_value


# --- Progress bar ---


def test_progress_bar_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A progress bar should render in the DOM."""
    viser_server.gui.add_progress_bar(50)

    progressbar = viser_page.locator("[role='progressbar']")
    expect(progressbar.first).to_be_visible(timeout=5_000)


def test_progress_bar_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Updating the progress bar value from the server should not crash."""
    handle = viser_server.gui.add_progress_bar(25)

    progressbar = viser_page.locator("[role='progressbar']")
    expect(progressbar.first).to_be_visible(timeout=5_000)

    handle.value = 75
    viser_page.wait_for_timeout(500)
    expect(progressbar.first).to_be_visible()


def test_progress_bar_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a progress bar from the server should remove it from the DOM."""
    handle = viser_server.gui.add_progress_bar(50)

    progressbar = viser_page.locator("[role='progressbar']")
    expect(progressbar.first).to_be_visible(timeout=5_000)

    handle.remove()
    expect(progressbar.first).to_be_hidden(timeout=5_000)
