"""stop() must not drop disconnect callbacks queued during teardown.

ViserServer.stop() shuts the callback thread pool so its worker threads don't
linger after the server is gone. But the background event loop's connection
teardown fires on_client_disconnect and submits the (sync) user callbacks to
that same pool -- and the infra server only join()s the loop thread for 0.1s.
Shutting the pool right after that short join races those late submits: a
submit that lands after shutdown() raises "cannot schedule new futures after
shutdown" and the user's disconnect callback is silently dropped. stop() now
joins the loop thread (bounded) before shutting the pool, so the teardown's
submits are all in the queue first.
"""

from __future__ import annotations

import asyncio
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
    # The test calls stop() itself; a second stop() is a no-op guarded by
    # atexit unregister, but wrap defensively in case the test failed early.
    try:
        server.stop()
    except Exception:
        pass


def test_stop_runs_disconnect_callback_queued_during_teardown(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    disconnect_ran = threading.Event()

    # A slow ASYNC disconnect callback runs first, inline on the event loop. It
    # holds the loop thread's teardown past websock_server.stop()'s short 0.1s
    # join, so the SYNC callback's pool submit below lands only after stop()
    # has moved on -- the exact window where a premature pool shutdown drops
    # it. Without this delay the submit finishes inside the 0.1s join and the
    # race never surfaces locally.
    @own_server.on_client_disconnect
    async def _(client: viser.ClientHandle) -> None:
        await asyncio.sleep(0.5)

    @own_server.on_client_disconnect
    def _(client: viser.ClientHandle) -> None:
        # Sync callback -> dispatched to the thread pool, the path that
        # stop()'s pool shutdown can race.
        disconnect_ran.set()

    context = browser.new_context()
    page = context.new_page()
    wait_for_connection(page, own_server.get_port())

    deadline = time.monotonic() + 10
    while not own_server._connected_clients and time.monotonic() < deadline:
        time.sleep(0.05)
    assert own_server._connected_clients, "client never connected"

    # Stop the server while the client is still connected: teardown fires the
    # disconnect callbacks and submits the sync one to the pool. The pool must
    # not be shut before that submit lands, or the callback is dropped.
    own_server.stop()

    assert disconnect_ran.wait(timeout=5.0), (
        "disconnect callback was dropped during stop(): the pool was shut "
        "before the teardown's submit landed."
    )

    page.close()
    context.close()
