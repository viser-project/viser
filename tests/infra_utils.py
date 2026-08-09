"""Shared helpers for headless server-side tests (no browser).

The synthetic-client construction here is the third home this pattern
needed (after inline copies in ``test_panel.py`` and
``test_get_render_latency.py``); new tests should import it from here.
"""

from __future__ import annotations

import asyncio

import viser
from viser._viser import ClientHandle
from viser.infra._async_message_buffer import AsyncMessageBuffer
from viser.infra._infra import WebsockClientConnection, _ClientHandleState


def make_synthetic_client(server: viser.ViserServer, client_id: int) -> ClientHandle:
    """In-process ClientHandle with a real per-client message buffer but no
    websocket (mirrors how WebsockServer builds per-client state). Buffer
    construction hops to the server's loop thread because
    AsyncMessageBuffer's asyncio primitives bind to the running loop."""

    async def _make_buffer() -> AsyncMessageBuffer:
        return AsyncMessageBuffer(server._event_loop, persistent_messages=False)

    buffer = asyncio.run_coroutine_threadsafe(
        _make_buffer(), server._event_loop
    ).result(timeout=5.0)
    conn = WebsockClientConnection(
        client_id, _ClientHandleState(buffer, server._event_loop)
    )
    return ClientHandle(conn, server)
