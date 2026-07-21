"""Async connect/disconnect callbacks must be able to call server APIs.

``_client_lock`` used to be held across the ``await`` of user-supplied async
callbacks, so an ``async def`` connect/disconnect callback that called
``server.get_clients()`` (or anything acquiring the lock, e.g. registering an
``on_scene_pointer`` handler) re-acquired a non-reentrant lock on the event
loop thread -- freezing the whole server, every client, forever. Sync (def)
callbacks were immune (they run on the threadpool), which made the docs'
recommendation to prefer async callbacks a trap.

The callbacks here are registered BEFORE the client connects: the
registration path replays callbacks for already-connected clients outside
the lock, so only a fresh connection exercises the locked path under test.
"""

from __future__ import annotations

import threading
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


def test_async_connect_callback_can_call_get_clients(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    done = threading.Event()
    seen: list[int] = []

    @own_server.on_client_connect
    async def _(client: viser.ClientHandle) -> None:
        seen.append(len(own_server.get_clients()))
        done.set()

    context = browser.new_context()
    try:
        page = context.new_page()
        wait_for_connection(page, own_server.get_port())
        assert done.wait(timeout=10.0), (
            "async on_client_connect calling get_clients() never completed -- "
            "event-loop deadlock on _client_lock"
        )
        assert seen[0] >= 1
    finally:
        context.close()


def test_async_disconnect_callback_can_call_get_clients(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    done = threading.Event()

    @own_server.on_client_disconnect
    async def _(client: viser.ClientHandle) -> None:
        own_server.get_clients()
        done.set()

    context = browser.new_context()
    try:
        page = context.new_page()
        wait_for_connection(page, own_server.get_port())
        page.close()
        assert done.wait(timeout=10.0), (
            "async on_client_disconnect calling get_clients() never completed "
            "-- event-loop deadlock on _client_lock"
        )
    finally:
        context.close()
