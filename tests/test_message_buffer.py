"""Tests for the broadcast message buffer's replay/windowing contracts."""

from __future__ import annotations

import asyncio

from viser import _messages as vm
from viser.infra._async_message_buffer import AsyncMessageBuffer


def test_replay_marker_precedes_live_messages() -> None:
    """The end-of-replay marker (D51) goes IMMEDIATELY after the connection's
    captured backlog: a live message pushed after the generator was created
    but before its first window must drain AFTER the marker, never in front
    of it. Regression: the pre-marker window drained through the CURRENT
    message counter, so such a live message slipped in ahead."""

    async def scenario() -> list[str]:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        marker = vm.ReplayDoneMessage()
        buffer.push(vm.GuiCloseModalMessage(uuid="backlog-1"))
        buffer.push(vm.GuiCloseModalMessage(uuid="backlog-2"))
        gen = buffer.window_generator(1, backlog_done_message=marker)
        # A live message lands after connect, before the first window drains.
        buffer.push(vm.GuiCloseModalMessage(uuid="live-1"))
        seen: list[str] = []
        while True:
            window = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
            for msg in window:
                seen.append(
                    "MARKER"
                    if isinstance(msg, vm.ReplayDoneMessage)
                    else getattr(msg, "uuid", "?")
                )
            if "live-1" in seen:
                return seen

    seen = asyncio.run(scenario())
    assert seen.index("MARKER") < seen.index("live-1"), (
        f"live message drained ahead of the replay marker: {seen}"
    )
    assert seen.index("backlog-2") < seen.index("MARKER")
