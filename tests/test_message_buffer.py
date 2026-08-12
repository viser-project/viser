"""Tests for the broadcast message buffer's replay/windowing contracts."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Dict, Generator, Set, Tuple

from viser import _messages as vm
from viser.infra._async_message_buffer import AsyncMessageBuffer, _entity_state_key

from .thread_isolation import run_isolated


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

    seen = run_isolated(lambda: asyncio.run(scenario()))
    assert seen.index("MARKER") < seen.index("live-1"), (
        f"live message drained ahead of the replay marker: {seen}"
    )
    assert seen.index("backlog-2") < seen.index("MARKER")


# test_disconnect_releases_gc_cursor_promptly moved to
# tests/e2e/test_broadcast_gc_disconnect.py: it drives a real browser, which
# the browserless `build` CI job (pytest --ignore=tests/e2e) can't run.


@contextlib.contextmanager
def _sync_buffer() -> Generator[AsyncMessageBuffer, None, None]:
    """A buffer usable from synchronous test code: push() only schedules
    wakeups on the (never-run) loop, so a fresh non-running loop suffices."""
    loop = asyncio.new_event_loop()
    try:
        yield AsyncMessageBuffer(loop, persistent_messages=True)
    finally:
        loop.close()


def _assert_entity_index_consistent(buffer: AsyncMessageBuffer) -> None:
    """The entity-state index must be exactly the index recomputed from the
    buffer's contents -- no stale ids, no missing ids, no empty buckets --
    and bucket membership must agree with ``Message.targets_entity_state``,
    the taxonomy the index materializes."""
    expected: Dict[Tuple[str, str], Set[int]] = {}
    for mid, message in buffer.message_from_id.items():
        key = _entity_state_key(message)
        if key is not None:
            expected.setdefault(key, set()).add(mid)
    assert buffer.ids_from_entity_state_key == expected

    probes = set(buffer.ids_from_entity_state_key) | {("scene", "/never-added")}
    for probe in probes:
        for mid, message in buffer.message_from_id.items():
            in_bucket = mid in buffer.ids_from_entity_state_key.get(probe, set())
            assert in_bucket == message.targets_entity_state(*probe)


def _frame_message(name: str) -> vm.FrameMessage:
    return vm.FrameMessage(
        name=name,
        props=vm.FrameProps(
            show_axes=True,
            axes_length=0.5,
            axes_radius=0.025,
            origin_radius=0.05,
            origin_color=(230, 180, 30),
            scale=1.0,
        ),
    )


def test_entity_state_index_tracks_buffer_mutations() -> None:
    """The index stays consistent through pushes, redundancy replacement,
    remove-phase update purges, and predicate removal."""
    with _sync_buffer() as buffer:
        buffer.push(_frame_message("/a"))
        buffer.push(vm.SetPositionMessage("/a", (1.0, 0.0, 0.0)))
        buffer.push(vm.SetOrientationMessage("/a", (1.0, 0.0, 0.0, 0.0)))
        buffer.push(vm.SetSceneNodeClickBindingsMessage("/a", bindings=()))
        buffer.push(_frame_message("/b"))
        buffer.push(vm.SetPositionMessage("/b", (0.0, 1.0, 0.0)))
        _assert_entity_index_consistent(buffer)

        # Redundancy replacement: a second position update for /a supersedes
        # the first in-place; the index must drop the replaced id.
        buffer.push(vm.SetPositionMessage("/a", (2.0, 0.0, 0.0)))
        _assert_entity_index_consistent(buffer)
        assert len(buffer.ids_from_entity_state_key[("scene", "/a")]) == 3

        # Remove-phase push purges /a's pending updates (but not bindings).
        buffer.push(vm.RemoveSceneNodeMessage("/a"))
        _assert_entity_index_consistent(buffer)

        # Predicate-based removal keeps the index consistent too.
        buffer.remove_from_buffer(
            lambda m: (
                getattr(m, "name", None) == "/b"
                and m.lifecycle_phase == "update_simple"
            )
        )
        _assert_entity_index_consistent(buffer)


def test_remove_entity_state_matches_predicate_purge() -> None:
    """remove_entity_state_from_buffer removes exactly the messages
    ``targets_entity_state`` matches for that entity (the same-name
    replacement purge's contract, previously an O(buffer) predicate scan),
    leaving creates and other entities untouched."""
    with _sync_buffer() as buffer:
        buffer.push(_frame_message("/a"))
        buffer.push(vm.SetPositionMessage("/a", (1.0, 0.0, 0.0)))
        buffer.push(vm.SetOrientationMessage("/a", (1.0, 0.0, 0.0, 0.0)))
        buffer.push(vm.SetSceneNodeVisibilityMessage("/a", visible=False))
        buffer.push(vm.SetSceneNodeClickBindingsMessage("/a", bindings=()))
        buffer.push(_frame_message("/b"))
        buffer.push(vm.SetPositionMessage("/b", (0.0, 1.0, 0.0)))

        expected_removed = {
            mid
            for mid, m in buffer.message_from_id.items()
            if m.targets_entity_state("scene", "/a")
        }
        assert len(expected_removed) == 4
        before = set(buffer.message_from_id)

        buffer.remove_entity_state_from_buffer("scene", "/a")

        assert before - set(buffer.message_from_id) == expected_removed
        _assert_entity_index_consistent(buffer)
        # /a's create and /b's messages survive.
        survivors = {type(m).__name__ for m in buffer.message_from_id.values()}
        assert "FrameMessage" in survivors
        assert any(
            getattr(m, "name", None) == "/b" and isinstance(m, vm.SetPositionMessage)
            for m in buffer.message_from_id.values()
        )

        # Purging an entity with no state is a no-op.
        buffer.remove_entity_state_from_buffer("scene", "/never-added")
        _assert_entity_index_consistent(buffer)


def test_remove_phase_push_purges_updates_but_not_bindings() -> None:
    """push()ing a remove purges the entity's pending update messages while
    leaving phase-less binding messages for remove()'s own explicit
    empty-binding broadcasts -- the pre-index behavior, preserved."""
    with _sync_buffer() as buffer:
        buffer.push(_frame_message("/a"))
        buffer.push(vm.SetPositionMessage("/a", (1.0, 0.0, 0.0)))
        buffer.push(vm.SetSceneNodeClickBindingsMessage("/a", bindings=()))

        buffer.push(vm.RemoveSceneNodeMessage("/a"))

        kinds = {type(m).__name__ for m in buffer.message_from_id.values()}
        assert "SetPositionMessage" not in kinds
        assert "SetSceneNodeClickBindingsMessage" in kinds
        assert "RemoveSceneNodeMessage" in kinds
        _assert_entity_index_consistent(buffer)
