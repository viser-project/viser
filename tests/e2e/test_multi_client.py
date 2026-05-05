"""E2E tests for multi-client scenarios: two browsers connected simultaneously."""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Browser, Page, expect

import viser
import viser._client_autobuild

from .utils import (
    find_free_port,
    find_gui_input,
    wait_for_connection,
    wait_for_scene_node,
    wait_for_scene_node_removed,
    wait_for_server_ready,
)


@pytest.fixture()
def multi_client_setup(browser: Browser) -> Generator[dict, None, None]:
    """Set up a viser server with two browser pages connected to it.

    Returns a dict with 'server', 'page1', 'page2' keys.
    """
    viser._client_autobuild.ensure_client_is_built = lambda: None

    port = find_free_port()
    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(port)

    context1 = browser.new_context()
    context2 = browser.new_context()
    page1 = context1.new_page()
    page2 = context2.new_page()

    wait_for_connection(page1, port)
    wait_for_connection(page2, port)

    yield {"server": server, "page1": page1, "page2": page2}

    context1.close()
    context2.close()
    server.stop()


def test_two_clients_see_gui(multi_client_setup: dict) -> None:
    """Both clients should see GUI elements added by the server."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    server.gui.add_button("Shared Button")

    for page in [page1, page2]:
        expect(page.get_by_role("button", name="Shared Button")).to_be_visible(
            timeout=5_000
        )


def test_two_clients_see_scene(multi_client_setup: dict) -> None:
    """Both clients should see scene objects added by the server."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    server.scene.add_icosphere(
        "/shared_sphere",
        radius=0.5,
        color=(255, 0, 0),
        position=(0.0, 0.0, 0.0),
    )

    for page in [page1, page2]:
        wait_for_scene_node(page, "/shared_sphere")


def test_gui_state_sync_text(multi_client_setup: dict) -> None:
    """Server-side text update should propagate to both clients."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    handle = server.gui.add_text("Sync Text", initial_value="initial")

    input1 = find_gui_input(page1, "Sync Text")
    input2 = find_gui_input(page2, "Sync Text")
    expect(input1).to_have_value("initial", timeout=5_000)
    expect(input2).to_have_value("initial", timeout=5_000)

    handle.value = "server_update"
    expect(input1).to_have_value("server_update", timeout=5_000)
    expect(input2).to_have_value("server_update", timeout=5_000)


def test_gui_state_sync_checkbox(multi_client_setup: dict) -> None:
    """Server-side checkbox toggle should propagate to both clients."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    handle = server.gui.add_checkbox("Sync Check", initial_value=False)

    checkbox1 = find_gui_input(page1, "Sync Check")
    checkbox2 = find_gui_input(page2, "Sync Check")
    expect(checkbox1).to_be_visible(timeout=5_000)
    expect(checkbox2).to_be_visible(timeout=5_000)
    expect(checkbox1).not_to_be_checked()
    expect(checkbox2).not_to_be_checked()

    handle.value = True
    expect(checkbox1).to_be_checked(timeout=5_000)
    expect(checkbox2).to_be_checked(timeout=5_000)


def test_scene_update_visible_to_both(multi_client_setup: dict) -> None:
    """Scene changes should be visible to both clients."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    handle = server.scene.add_box(
        "/multi_box",
        dimensions=(1.0, 1.0, 1.0),
        color=(0, 200, 100),
        position=(0.0, 0.0, 0.0),
    )

    for page in [page1, page2]:
        wait_for_scene_node(page, "/multi_box")

    handle.remove()

    for page in [page1, page2]:
        wait_for_scene_node_removed(page, "/multi_box")


def test_form_dirty_shows_on_sender(multi_client_setup: dict) -> None:
    """The client that types should see the dirty indicator itself."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]

    with server.gui.add_form("Profile") as form:
        server.gui.add_text("Name", initial_value="")

    dirty_indicator = page1.locator("span[style*='opacity']", has_text="*")
    expect(dirty_indicator).to_be_hidden(timeout=5_000)

    input1 = find_gui_input(page1, "Name")
    expect(input1).to_be_visible(timeout=5_000)
    input1.fill("alice")
    expect(dirty_indicator).to_be_visible(timeout=5_000)

    form.submit()
    expect(dirty_indicator).to_be_hidden(timeout=5_000)

    # Must reappear after a second round of edits.
    input1.fill("bob")
    expect(dirty_indicator).to_be_visible(timeout=5_000)


def test_form_dirty_syncs_to_peer(multi_client_setup: dict) -> None:
    """Typing in a form on page1 should show the dirty indicator on page2."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    with server.gui.add_form("Profile"):
        server.gui.add_text("Name", initial_value="")

    dirty_indicator = page2.locator("span[style*='opacity']", has_text="*")
    expect(dirty_indicator).to_be_hidden(timeout=5_000)

    input1 = find_gui_input(page1, "Name")
    expect(input1).to_be_visible(timeout=5_000)
    input1.fill("alice")

    expect(dirty_indicator).to_be_visible(timeout=5_000)


def test_form_dirty_clears_on_submit_to_peer(multi_client_setup: dict) -> None:
    """Submitting a form on page1 should clear the dirty indicator on page2."""
    server: viser.ViserServer = multi_client_setup["server"]
    page1: Page = multi_client_setup["page1"]
    page2: Page = multi_client_setup["page2"]

    with server.gui.add_form("Profile") as form:
        server.gui.add_text("Name", initial_value="")

    input1 = find_gui_input(page1, "Name")
    expect(input1).to_be_visible(timeout=5_000)
    input1.fill("alice")

    dirty_indicator = page2.locator("span[style*='opacity']", has_text="*")
    expect(dirty_indicator).to_be_visible(timeout=5_000)

    form.submit()

    expect(dirty_indicator).to_be_hidden(timeout=5_000)


def test_late_joining_client_sees_dirty_form(browser: Browser) -> None:
    """A client joining after a form is made dirty should see the dirty indicator."""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    port = find_free_port()
    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(port)

    with server.gui.add_form("Settings"):
        server.gui.add_text("Username", initial_value="")

    context1 = browser.new_context()
    page1 = context1.new_page()
    wait_for_connection(page1, port)

    input1 = find_gui_input(page1, "Username")
    expect(input1).to_be_visible(timeout=5_000)
    input1.fill("bob")

    # Late-joining client connects after the form is already dirty.
    context2 = browser.new_context()
    page2 = context2.new_page()
    wait_for_connection(page2, port)

    dirty_indicator = page2.locator("span[style*='opacity']", has_text="*")
    expect(dirty_indicator).to_be_visible(timeout=5_000)

    context1.close()
    context2.close()
    server.stop()


def test_per_client_form_dirty_is_isolated(browser: Browser) -> None:
    """Dirty state on a per-client form should not bleed to other clients."""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    port = find_free_port()
    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None

    @server.on_client_connect
    def _(client: viser.ClientHandle) -> None:
        with client.gui.add_form("Per-client Form"):
            client.gui.add_text("Note", initial_value="")

    wait_for_server_ready(port)

    context1 = browser.new_context()
    context2 = browser.new_context()
    page1 = context1.new_page()
    page2 = context2.new_page()
    wait_for_connection(page1, port)
    wait_for_connection(page2, port)

    # Both clients have their own independent form.
    input1 = find_gui_input(page1, "Note")
    input2 = find_gui_input(page2, "Note")
    expect(input1).to_be_visible(timeout=5_000)
    expect(input2).to_be_visible(timeout=5_000)

    # Client 1 edits -- only its own dirty indicator should appear.
    input1.fill("hello")
    dirty1 = page1.locator("span[style*='opacity']", has_text="*")
    dirty2 = page2.locator("span[style*='opacity']", has_text="*")
    expect(dirty1).to_be_visible(timeout=5_000)
    expect(dirty2).to_be_hidden(timeout=2_000)

    context1.close()
    context2.close()
    server.stop()


def test_late_joining_client_sees_state(browser: Browser) -> None:
    """A client joining after GUI/scene elements are added should see them."""
    viser._client_autobuild.ensure_client_is_built = lambda: None

    port = find_free_port()
    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(port)

    server.gui.add_button("Pre-existing Button")
    server.scene.add_icosphere(
        "/pre_existing_sphere",
        radius=0.3,
        color=(0, 0, 255),
    )

    context = browser.new_context()
    page = context.new_page()
    wait_for_connection(page, port)

    expect(page.get_by_role("button", name="Pre-existing Button")).to_be_visible(
        timeout=5_000
    )
    wait_for_scene_node(page, "/pre_existing_sphere")

    context.close()
    server.stop()
