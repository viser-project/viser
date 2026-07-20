from __future__ import annotations

import asyncio
import dataclasses
import threading
from asyncio.events import AbstractEventLoop
from typing import AsyncGenerator, Callable, Dict, List, Sequence

from ._messages import Message


@dataclasses.dataclass
class AsyncMessageBuffer:
    """Async iterable for keeping a persistent buffer of messages.

    Uses heuristics on message names to automatically cull out redundant messages."""

    event_loop: AbstractEventLoop
    persistent_messages: bool
    message_event: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)
    flush_event: asyncio.Event = dataclasses.field(default_factory=asyncio.Event)

    message_counter: int = 0
    message_from_id: Dict[int, Message] = dataclasses.field(default_factory=dict)
    id_from_redundancy_key: Dict[str, int] = dataclasses.field(default_factory=dict)

    buffer_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    """Lock to prevent race conditions when pushing messages from different threads."""

    max_window_size: int = 128
    window_duration_sec: float = 1.0 / 60.0
    done: bool = False
    atomic_counter: int = 0

    generator_cursors: Dict[int, int] = dataclasses.field(default_factory=dict)
    """Per-active-connection consumption cursors (client id -> last message id
    that connection's window generator has drained). Written by each generator
    as it advances (int dict writes are atomic under the GIL); read under
    ``buffer_lock`` by the garbage collector, which may only delete messages
    that EVERY active generator has consumed -- a shared "any messages
    pending?" event is not a consumption watermark, since a backpressured
    client's cursor can sit arbitrarily far behind it."""

    def remove_from_buffer(self, match_fn: Callable[[Message], bool]) -> None:
        """Remove messages that match some condition."""

        with self.buffer_lock:
            # Remove messages that match the condition.
            for id, message in filter(
                lambda kv_pair: match_fn(self.message_from_id[kv_pair[0]]),
                tuple(self.message_from_id.items()),
            ):
                self.message_from_id.pop(id)
                self.id_from_redundancy_key.pop(message.redundancy_key())

    def push(self, message: Message) -> None:
        """Push a new message to our buffer, and remove old redundant ones."""

        assert isinstance(message, Message)

        # Add message to buffer.
        redundancy_key = message.redundancy_key()

        # Pre-compute entity coordinates outside the lock.
        purge_entity_type: str | None = None
        purge_entity_id: str | None = None
        if (
            message.lifecycle_phase == "remove"
            and message.entity_type is not None
            and message.entity_id_field is not None
        ):
            purge_entity_type = message.entity_type
            purge_entity_id = getattr(message, message.entity_id_field)

        with self.buffer_lock:
            # On Remove, drop pending Updates for the same entity so a
            # removed entity leaves no residue in the buffer. (Create+Remove
            # coalesce via the redundancy key below; Updates use a separate
            # namespace, so they need explicit purging.)
            if purge_entity_type is not None:
                stale_ids = [
                    mid
                    for mid, m in self.message_from_id.items()
                    if m.lifecycle_phase in ("update_dict", "update_simple")
                    and m.entity_type == purge_entity_type
                    and m.entity_id_field is not None
                    and getattr(m, m.entity_id_field, None) == purge_entity_id
                ]
                for mid in stale_ids:
                    stale = self.message_from_id.pop(mid)
                    stale_key = stale.redundancy_key()
                    if stale_key is not None:
                        self.id_from_redundancy_key.pop(stale_key, None)

            new_message_id = self.message_counter
            self.message_from_id[new_message_id] = message
            self.message_counter += 1

            # If an existing message with the same key already exists in our buffer, we
            # don't need the old one anymore. :-)
            if (
                redundancy_key is not None
                and redundancy_key in self.id_from_redundancy_key
            ):
                old_message_id = self.id_from_redundancy_key.pop(redundancy_key)
                self.message_from_id.pop(old_message_id)
            self.id_from_redundancy_key[redundancy_key] = new_message_id

            # Pulse message event to notify consumers that a new message is
            # available.
            #
            # We set this both inside and outside of the event loop.
            #
            # This call is necessary so we can read the value immedaitely
            # in synchronous logic.
            self.message_event.set()
            if self.atomic_counter == 0:
                # This call is necessary to make sure that awaiting tasks are
                # triggered correctly.
                #
                # If we're in an atomic block, this will happen when
                # atomic_end() is called.
                self.event_loop.call_soon_threadsafe(self.message_event.set)

    def atomic_start(self) -> None:
        """Start an atomic block. No new messages/windows should be sent."""
        # Locked: `atomic()` is public and may be entered from multiple threads,
        # and `+=`/`-=` are non-atomic read-modify-writes. A lost update would
        # leave the counter stuck != 0 and stall message delivery permanently.
        with self.buffer_lock:
            self.atomic_counter += 1

    def atomic_end(self) -> None:
        """End an atomic block."""
        with self.buffer_lock:
            self.atomic_counter -= 1
            should_flush = self.atomic_counter == 0
        if should_flush:
            self.event_loop.call_soon_threadsafe(self.message_event.set)

    def flush(self) -> None:
        """Flush the message buffer; signals to yield a message window immediately."""
        self.event_loop.call_soon_threadsafe(self.flush_event.set)

    def set_done(self) -> None:
        """Set the done flag. Kills the generator."""
        self.done = True

        try:
            # Pulse message event to make sure we aren't waiting for a new message.
            self.event_loop.call_soon_threadsafe(self.message_event.set)

            # Pulse flush event to skip any windowing delay.
            self.event_loop.call_soon_threadsafe(self.flush_event.set)
        except RuntimeError:
            # Event loop may already be closed during teardown.
            pass

    def window_generator(
        self, client_id: int, backlog_done_message: Message | None = None
    ) -> AsyncGenerator[Sequence[Message], None]:
        """Async iterator over messages. Loops infinitely, and waits when no messages
        are available.

        When `backlog_done_message` is given, it is injected into the stream
        exactly once, immediately after the last message that was already
        buffered when this generator was CREATED -- an explicit end-of-replay
        marker for a (re)connecting client. The boundary is captured eagerly
        here (an async generator's body does not run until first iteration,
        which would fold live messages pushed in between into the backlog and
        let them precede the marker). The marker is never stored in the
        buffer (each connection gets its own), so it has no redundancy/
        coalescing semantics."""
        # The replay boundary: everything at or below this id is backlog the
        # client must consume before the marker; everything above is live.
        backlog_last_id = self.message_counter - 1
        # Register this connection's consumption cursor (see generator_cursors)
        # for the garbage collector's deletion floor; dropped when the
        # generator exits.
        self.generator_cursors[client_id] = -1
        return self._window_loop(client_id, backlog_last_id, backlog_done_message)

    async def _window_loop(
        self,
        client_id: int,
        backlog_last_id: int,
        backlog_done_message: Message | None,
    ) -> AsyncGenerator[Sequence[Message], None]:
        last_sent_id = -1
        backlog_done_pending = backlog_done_message is not None
        flush_wait = self.event_loop.create_task(self.flush_event.wait())
        try:
            async for window in self._windows(
                client_id, last_sent_id, backlog_last_id, backlog_done_pending,
                backlog_done_message, flush_wait,
            ):
                yield window
        finally:
            # Drop this connection's GC cursor: a departed client must not
            # hold the deletion floor down forever.
            self.generator_cursors.pop(client_id, None)

    async def _windows(
        self,
        client_id: int,
        last_sent_id: int,
        backlog_last_id: int,
        backlog_done_pending: bool,
        backlog_done_message: Message | None,
        flush_wait: asyncio.Task,
    ) -> AsyncGenerator[Sequence[Message], None]:
        while not self.done:
            window: List[Message] = []
            most_recent_message_id = self.message_counter - 1
            # D51: the end-of-replay marker goes IMMEDIATELY after the
            # connection's captured backlog. Cap the pre-marker windows at the
            # boundary so a live message pushed since connect cannot slip in
            # front of the marker; the live tail drains in the next window.
            if backlog_done_pending:
                most_recent_message_id = min(
                    most_recent_message_id, backlog_last_id
                )
            while (
                last_sent_id < most_recent_message_id
                and len(window) < self.max_window_size
                # We should only be polling for new messages if we aren't in an atomic block.
                and self.atomic_counter == 0
            ):
                last_sent_id += 1
                if self.persistent_messages:
                    message = self.message_from_id.get(last_sent_id, None)
                else:
                    # If we're not persisting messages, remove them from the buffer.
                    with self.buffer_lock:
                        message = self.message_from_id.pop(last_sent_id, None)
                        if message is not None:
                            redundancy_key = message.redundancy_key()
                            self.id_from_redundancy_key.pop(redundancy_key, None)

                if message is not None and message.excluded_self_client != client_id:
                    window.append(message)

            # Advance this connection's consumption cursor: everything at or
            # below last_sent_id is either in `window` (about to be sent) or
            # skipped, so the GC may delete it without this client losing it.
            self.generator_cursors[client_id] = last_sent_id

            if (
                backlog_done_pending
                and last_sent_id >= backlog_last_id
                and self.atomic_counter == 0
            ):
                # Backlog fully drained (or empty at connect): mark the end of
                # the replay in-stream, ordered before any live message that
                # lands after this window.
                backlog_done_pending = False
                assert backlog_done_message is not None
                window.append(backlog_done_message)

            if len(window) > 0:
                # Yield a window!
                yield window
            else:
                # Wait for a new message to come in.
                await self.message_event.wait()
                self.message_event.clear()

            # Add a delay if either (a) we failed to yield or (b) there's currently no messages to send.
            most_recent_message_id = self.message_counter - 1
            if len(window) == 0 or most_recent_message_id == last_sent_id:
                done, pending = await asyncio.wait(
                    [flush_wait], timeout=self.window_duration_sec
                )
                del pending
                if flush_wait in done and not self.done:
                    self.flush_event.clear()
                    flush_wait = self.event_loop.create_task(self.flush_event.wait())
