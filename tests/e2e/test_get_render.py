"""get_render() must not hang forever when the client goes away.

render_ready_event.wait() had no timeout and nothing set it on disconnect,
so a closed tab / dropped network left the calling thread (and, from a sync
callback, its pool worker) blocked forever. get_render now polls and raises
promptly once the client is no longer connected.
"""

from __future__ import annotations

import threading
import time
from typing import Generator

import pytest
from playwright.sync_api import Browser

import viser
import viser._client_autobuild

from .utils import find_free_port, wait_for_connection, wait_for_server_ready


@pytest.fixture()
def own_server() -> Generator[viser.ViserServer, None, None]:
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server: viser.ViserServer | None = None
    for attempt in range(3):
        try:
            server = viser.ViserServer(port=find_free_port(), verbose=False)
            break
        except OSError:
            if attempt == 2:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())
    yield server
    server.stop()


def test_get_render_raises_promptly_on_disconnect(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    captured: list[viser.ClientHandle] = []
    own_server.on_client_connect(lambda client: captured.append(client))

    context = browser.new_context()
    page = context.new_page()
    wait_for_connection(page, own_server.get_port())

    deadline = time.monotonic() + 10
    while not captured and time.monotonic() < deadline:
        time.sleep(0.05)
    assert captured, "client never connected"
    client = captured[0]

    # Drop the client, wait for the server to notice.
    page.close()
    context.close()
    deadline = time.monotonic() + 10
    while (
        client.client_id in own_server._connected_clients
        and time.monotonic() < deadline
    ):
        time.sleep(0.05)
    assert client.client_id not in own_server._connected_clients

    # get_render must now raise quickly instead of hanging forever.
    result: list[object] = []

    def call() -> None:
        try:
            client.get_render(height=64, width=64)
            result.append("returned")
        except RuntimeError as e:
            result.append(e)

    t = threading.Thread(target=call)
    start = time.monotonic()
    t.start()
    t.join(timeout=8.0)
    assert not t.is_alive(), "get_render hung after the client disconnected"
    assert time.monotonic() - start < 6.0
    assert result and isinstance(result[0], RuntimeError)
    assert "disconnect" in str(result[0]).lower()
