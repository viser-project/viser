"""E2E tests for the command palette (add_command) feature."""

from __future__ import annotations

import threading

from playwright.sync_api import Page, expect

import viser

# Mantine Spotlight selectors (v8).
_SPOTLIGHT_SEARCH = "input.mantine-Spotlight-search"
_SPOTLIGHT_ACTION = "button.mantine-Spotlight-action"


def _open_spotlight(page: Page) -> None:
    """Open the Mantine Spotlight command palette via keyboard shortcut."""
    page.keyboard.press("Control+K")
    page.locator(_SPOTLIGHT_SEARCH).wait_for(state="visible", timeout=5_000)


def test_command_palette_opens(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Pressing Ctrl+K should open the command palette."""
    viser_server.gui.add_command("Dummy Command")
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)
    expect(viser_page.locator(_SPOTLIGHT_SEARCH)).to_be_visible()


def test_registered_command_appears(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A registered command should appear in the command palette."""
    viser_server.gui.add_command(
        "My Test Command", description="A test command description"
    )
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="My Test Command")
    expect(action).to_be_visible(timeout=5_000)

    # Description should be visible too.
    desc = action.locator(".mantine-Spotlight-actionDescription")
    expect(desc).to_have_text("A test command description")


def test_multiple_commands_appear(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Multiple registered commands should all appear in the palette."""
    viser_server.gui.add_command("Command Alpha")
    viser_server.gui.add_command("Command Beta")
    viser_server.gui.add_command("Command Gamma")
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    for name in ["Command Alpha", "Command Beta", "Command Gamma"]:
        action = viser_page.locator(_SPOTLIGHT_ACTION, has_text=name)
        expect(action).to_be_visible(timeout=5_000)


def test_command_triggers_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Clicking a command in the palette should trigger the on_trigger callback."""
    triggered = threading.Event()

    handle = viser_server.gui.add_command("Trigger Me")

    @handle.on_trigger
    def _(event: viser.CommandEvent) -> None:
        triggered.set()

    viser_page.wait_for_timeout(500)
    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Trigger Me")
    expect(action).to_be_visible(timeout=5_000)
    action.click()

    assert triggered.wait(timeout=5.0), "on_trigger callback was not invoked"


def test_command_trigger_receives_client(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """The CommandEvent should contain a valid client reference."""
    event_holder: list[viser.CommandEvent] = []
    triggered = threading.Event()

    handle = viser_server.gui.add_command("Client Check")

    @handle.on_trigger
    def _(event: viser.CommandEvent) -> None:
        event_holder.append(event)
        triggered.set()

    viser_page.wait_for_timeout(500)
    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Client Check")
    action.click()

    assert triggered.wait(timeout=5.0)
    assert len(event_holder) == 1
    assert event_holder[0].client is not None
    assert event_holder[0].client_id is not None


def test_fuzzy_search_filters_commands(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Typing in the search box should filter actions using fuzzy matching."""
    viser_server.gui.add_command("Export Data")
    viser_server.gui.add_command("Import Data")
    viser_server.gui.add_command("Delete All")
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    search_input = viser_page.locator(_SPOTLIGHT_SEARCH)
    search_input.fill("export")
    viser_page.wait_for_timeout(300)

    export_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Export Data")
    expect(export_action).to_be_visible(timeout=3_000)

    delete_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Delete All")
    expect(delete_action).to_be_hidden(timeout=3_000)


def test_command_remove_disappears_from_palette(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a command should remove it from the command palette."""
    handle = viser_server.gui.add_command("Removable Command")
    viser_page.wait_for_timeout(500)

    # Verify it appears.
    _open_spotlight(viser_page)
    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Removable Command")
    expect(action).to_be_visible(timeout=5_000)

    # Close spotlight, remove action.
    viser_page.keyboard.press("Escape")
    viser_page.wait_for_timeout(300)

    handle.remove()
    viser_page.wait_for_timeout(500)

    # With zero actions the Spotlight component is unmounted, so the
    # shortcut should no longer open anything.
    viser_page.keyboard.press("Control+Shift+P")
    viser_page.wait_for_timeout(500)
    expect(viser_page.locator(_SPOTLIGHT_SEARCH)).to_be_hidden()


def test_command_label_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Updating the label from the server should update it in the palette."""
    handle = viser_server.gui.add_command("Old Name")
    viser_page.wait_for_timeout(500)

    handle.label = "New Name"
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    new_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="New Name")
    expect(new_action).to_be_visible(timeout=5_000)

    old_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Old Name")
    expect(old_action).to_be_hidden(timeout=3_000)


def test_command_with_icon(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """An action registered with an icon should display the icon SVG."""
    viser_server.gui.add_command(
        "Save File",
        description="Save the current file",
        icon=viser.Icon.DEVICE_FLOPPY,
    )
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Save File")
    expect(action).to_be_visible(timeout=5_000)

    # The icon is rendered as an inline SVG.
    svg = action.locator("svg")
    expect(svg).to_be_visible()


def test_disabled_command_visible_but_not_triggerable(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A disabled action should appear in the palette but not trigger callbacks."""
    triggered = threading.Event()

    handle = viser_server.gui.add_command("Disabled Command", disabled=True)

    @handle.on_trigger
    def _(event: viser.CommandEvent) -> None:
        triggered.set()

    viser_page.wait_for_timeout(500)
    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Disabled Command")
    expect(action).to_be_visible(timeout=5_000)

    # The button should be disabled.
    expect(action).to_be_disabled()

    # Click it anyway — callback should not fire.
    action.click(force=True)
    assert not triggered.wait(timeout=1.0), (
        "Callback should not fire for disabled action"
    )


def test_disabled_command_re_enabled(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Re-enabling a disabled action should make it triggerable again."""
    triggered = threading.Event()

    handle = viser_server.gui.add_command("Toggle Action", disabled=True)

    @handle.on_trigger
    def _(event: viser.CommandEvent) -> None:
        triggered.set()

    viser_page.wait_for_timeout(500)

    # Re-enable the command.
    handle.disabled = False
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Toggle Action")
    expect(action).to_be_visible(timeout=5_000)
    expect(action).to_be_enabled()

    action.click()
    assert triggered.wait(timeout=5.0), "Callback should fire after re-enabling"
