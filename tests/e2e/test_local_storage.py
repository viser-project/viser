"""E2E tests for per-client browser localStorage access."""

import time

from playwright.sync_api import Page

import viser


def test_local_storage_round_trip(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Read, write, remove, and clear values through a real browser client."""
    deadline = time.monotonic() + 5.0
    while not (clients := viser_server.get_clients()):
        assert time.monotonic() < deadline, "client never connected"
        time.sleep(0.05)
    client = next(iter(clients.values()))
    key_a = "viser-e2e-local-storage-a"
    key_b = "viser-e2e-local-storage-b"

    assert client.local_storage.get_item(key_a) is None

    client.local_storage.set_item(key_a, "value-a")
    assert client.local_storage.get_item(key_a) == "value-a"

    client.local_storage.remove_item(key_a)
    assert client.local_storage.get_item(key_a) is None

    client.local_storage.set_item(key_a, "value-a")
    client.local_storage.set_item(key_b, "value-b")
    client.local_storage.clear()
    assert client.local_storage.get_item(key_a) is None
    assert client.local_storage.get_item(key_b) is None
