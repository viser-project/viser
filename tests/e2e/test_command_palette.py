"""E2E tests for the command palette (add_action) feature."""

from __future__ import annotations

import threading

from playwright.sync_api import Page, expect

import viser

# Mantine Spotlight selectors (v8).
_SPOTLIGHT_SEARCH = "input.mantine-Spotlight-search"
_SPOTLIGHT_ACTION = "button.mantine-Spotlight-action"


def _open_spotlight(page: Page) -> None:
    """Open the Mantine Spotlight command palette via keyboard shortcut."""
    page.keyboard.press("Control+Shift+P")
    page.locator(_SPOTLIGHT_SEARCH).wait_for(state="visible", timeout=5_000)


def test_command_palette_opens(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Pressing Ctrl+Shift+P should open the command palette."""
    viser_server.gui.add_action("Dummy Action")
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)
    expect(viser_page.locator(_SPOTLIGHT_SEARCH)).to_be_visible()


def test_registered_action_appears(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A registered action should appear in the command palette."""
    viser_server.gui.add_action(
        "My Test Action", description="A test action description"
    )
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="My Test Action")
    expect(action).to_be_visible(timeout=5_000)

    # Description should be visible too.
    desc = action.locator(".mantine-Spotlight-actionDescription")
    expect(desc).to_have_text("A test action description")


def test_multiple_actions_appear(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Multiple registered actions should all appear in the palette."""
    viser_server.gui.add_action("Action Alpha")
    viser_server.gui.add_action("Action Beta")
    viser_server.gui.add_action("Action Gamma")
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    for name in ["Action Alpha", "Action Beta", "Action Gamma"]:
        action = viser_page.locator(_SPOTLIGHT_ACTION, has_text=name)
        expect(action).to_be_visible(timeout=5_000)


def test_action_triggers_callback(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Clicking an action in the palette should trigger the on_trigger callback."""
    triggered = threading.Event()

    handle = viser_server.gui.add_action("Trigger Me")

    @handle.on_trigger
    def _(event: viser.ActionEvent) -> None:
        triggered.set()

    viser_page.wait_for_timeout(500)
    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Trigger Me")
    expect(action).to_be_visible(timeout=5_000)
    action.click()

    assert triggered.wait(timeout=5.0), "on_trigger callback was not invoked"


def test_action_trigger_receives_client(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """The ActionEvent should contain a valid client reference."""
    event_holder: list[viser.ActionEvent] = []
    triggered = threading.Event()

    handle = viser_server.gui.add_action("Client Check")

    @handle.on_trigger
    def _(event: viser.ActionEvent) -> None:
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


def test_fuzzy_search_filters_actions(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Typing in the search box should filter actions using fuzzy matching."""
    viser_server.gui.add_action("Export Data")
    viser_server.gui.add_action("Import Data")
    viser_server.gui.add_action("Delete All")
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    search_input = viser_page.locator(_SPOTLIGHT_SEARCH)
    search_input.fill("export")
    viser_page.wait_for_timeout(300)

    export_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Export Data")
    expect(export_action).to_be_visible(timeout=3_000)

    delete_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Delete All")
    expect(delete_action).to_be_hidden(timeout=3_000)


def test_action_remove_disappears_from_palette(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing an action should remove it from the command palette."""
    handle = viser_server.gui.add_action("Removable Action")
    viser_page.wait_for_timeout(500)

    # Verify it appears.
    _open_spotlight(viser_page)
    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Removable Action")
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


def test_action_label_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Updating the label from the server should update it in the palette."""
    handle = viser_server.gui.add_action("Old Name")
    viser_page.wait_for_timeout(500)

    handle.label = "New Name"
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    new_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="New Name")
    expect(new_action).to_be_visible(timeout=5_000)

    old_action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Old Name")
    expect(old_action).to_be_hidden(timeout=3_000)


def test_action_with_icon(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """An action registered with an icon should display the icon SVG."""
    viser_server.gui.add_action(
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


def test_disabled_action_visible_but_not_triggerable(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A disabled action should appear in the palette but not trigger callbacks."""
    triggered = threading.Event()

    handle = viser_server.gui.add_action("Disabled Action", disabled=True)

    @handle.on_trigger
    def _(event: viser.ActionEvent) -> None:
        triggered.set()

    viser_page.wait_for_timeout(500)
    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Disabled Action")
    expect(action).to_be_visible(timeout=5_000)

    # The button should be disabled.
    expect(action).to_be_disabled()

    # Click it anyway — callback should not fire.
    action.click(force=True)
    assert not triggered.wait(timeout=1.0), (
        "Callback should not fire for disabled action"
    )


def test_disabled_action_re_enabled(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Re-enabling a disabled action should make it triggerable again."""
    triggered = threading.Event()

    handle = viser_server.gui.add_action("Toggle Action", disabled=True)

    @handle.on_trigger
    def _(event: viser.ActionEvent) -> None:
        triggered.set()

    viser_page.wait_for_timeout(500)

    # Re-enable the action.
    handle.disabled = False
    viser_page.wait_for_timeout(500)

    _open_spotlight(viser_page)

    action = viser_page.locator(_SPOTLIGHT_ACTION, has_text="Toggle Action")
    expect(action).to_be_visible(timeout=5_000)
    expect(action).to_be_enabled()

    action.click()
    assert triggered.wait(timeout=5.0), "Callback should fire after re-enabling"
