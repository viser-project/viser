from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import threading
from asyncio.events import AbstractEventLoop
from typing import (
    AsyncGenerator,
    Callable,
    Dict,
    Generator,
    List,
    Optional,
    Sequence,
    Set,
    Tuple,
)

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
    ids_from_entity_state_key: Dict[Tuple[str, str], Set[int]] = dataclasses.field(
        default_factory=dict
    )
    """Buffered per-entity state messages, indexed by
    ``Message.entity_state_key()``. Keeps same-name replacement, remove-time
    update purges, and the GC sweep O(per-entity messages) instead of
    O(buffer). Maintained under ``buffer_lock`` by every path that inserts
    into or deletes from ``message_from_id``."""

    buffer_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    """Lock to prevent race conditions when pushing messages from different threads."""

    max_window_size: int = 128
    window_duration_sec: float = 1.0 / 60.0
    done: bool = False
    atomic_counter: int = 0
    _warned_push_after_done: bool = False
    """One-shot latch for the dead-connection write warning in push()."""

    _sanctioned_dead_writes: int = 0
    """Nesting depth of ``sanctioned_dead_writes()`` scopes; nonzero
    suppresses the dead-connection write warning."""

    generator_cursors: Dict[int, int] = dataclasses.field(default_factory=dict)
    """Per-active-connection consumption cursors (client id -> last message id
    that connection's window generator has drained). Written by each generator
    as it advances (int dict writes are atomic under the GIL); read under
    ``buffer_lock`` by the garbage collector, which may only delete messages
    that EVERY active generator has consumed -- a shared "any messages
    pending?" event is not a consumption watermark, since a backpressured
    client's cursor can sit arbitrarily far behind it."""

    @contextlib.contextmanager
    def sanctioned_dead_writes(self) -> Generator[None, None, None]:
        """Suppress the dead-connection write warning for pushes inside this
        scope. For cleanup emits that removal paths perform on behalf of the
        user (e.g. the empty interaction-bindings broadcasts in a scene
        node's ``remove()``): on a dead buffer they are benign no-ops, same
        as the removal messages themselves. The depth is adjusted under
        ``buffer_lock`` so concurrent scopes can't lose an update and wedge
        the counter; a concurrent unsanctioned push slipping through
        unwarned is still acceptable for a best-effort diagnostic."""
        with self.buffer_lock:
            self._sanctioned_dead_writes += 1
        try:
            yield
        finally:
            with self.buffer_lock:
                self._sanctioned_dead_writes -= 1

    def pop_message_locked(self, message_id: int) -> Optional[Message]:
        """Delete one message from the buffer and every index that refers to
        it, returning the message (or None if the id is absent). The caller
        must hold ``buffer_lock``: this is THE single deletion primitive, so
        the redundancy and entity-state indices cannot drift from
        ``message_from_id``."""
        message = self.message_from_id.pop(message_id, None)
        if message is None:
            return None
        # Unmap the redundancy slot only if it still points at THIS message:
        # slots for colliding keys point at the newest holder, and a blind
        # pop here would orphan that newer message's mapping.
        redundancy_key = message.redundancy_key()
        if self.id_from_redundancy_key.get(redundancy_key) == message_id:
            del self.id_from_redundancy_key[redundancy_key]
        entity_key = message.entity_state_key()
        if entity_key is not None:
            ids = self.ids_from_entity_state_key.get(entity_key)
            if ids is not None:
                ids.discard(message_id)
                if not ids:
                    del self.ids_from_entity_state_key[entity_key]
        return message

    def remove_from_buffer(self, match_fn: Callable[[Message], bool]) -> None:
        """Remove messages that match some condition."""

        with self.buffer_lock:
            # Remove messages that match the condition.
            for id in [
                id for id, message in self.message_from_id.items() if match_fn(message)
            ]:
                self.pop_message_locked(id)

    def remove_entity_state_from_buffer(self, entity_type: str, entity_id: str) -> None:
        """Purge every buffered message carrying per-entity state for one
        entity -- exactly the messages ``targets_entity_state`` matches, via
        the entity-state index rather than a full-buffer scan. Used by
        same-name scene node replacement, where a per-add O(buffer) scan
        made re-add loops quadratic in scene size."""
        with self.buffer_lock:
            ids = self.ids_from_entity_state_key.get((entity_type, entity_id))
            if not ids:
                return
            for message_id in tuple(ids):
                self.pop_message_locked(message_id)

    def push(self, message: Message) -> None:
        """Push a new message to our buffer, and remove old redundant ones."""

        assert isinstance(message, Message)

        # A done buffer has no producer left to drain it: for a per-client
        # buffer this means the client disconnected, and anything pushed via
        # a stale handle silently accumulates forever. Warn ONCE per buffer
        # so the dead-handle write is diagnosable without spamming loops
        # that keep animating a departed client's elements. Removal messages
        # are exempt: releasing elements of a departed client (e.g. inside
        # on_client_disconnect, which runs after the buffer is closed) is
        # ordinary cleanup, and a remove on a dead connection is a benign
        # no-op rather than a leak in the making.
        if (
            self.done
            and not self._warned_push_after_done
            and message.lifecycle_phase != "remove"
            and self._sanctioned_dead_writes == 0
        ):
            self._warned_push_after_done = True
            import warnings

            warnings.warn(
                f"Queued a {type(message).__name__} on a closed connection "
                "(e.g. via a handle owned by a disconnected client, or after "
                "the server stopped); it will never be delivered.",
                stacklevel=4,
            )

        # Pre-compute per-message keys outside the lock.
        redundancy_key = message.redundancy_key()
        entity_key = message.entity_state_key()
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
            # namespace, so they need explicit purging.) Resolved through the
            # entity-state index; the phase-less name-keyed messages that
            # share the bucket are left for remove()'s own explicit
            # empty-binding broadcasts.
            if purge_entity_type is not None:
                assert purge_entity_id is not None
                indexed_ids = self.ids_from_entity_state_key.get(
                    (purge_entity_type, purge_entity_id)
                )
                if indexed_ids:
                    for mid in tuple(indexed_ids):
                        if self.message_from_id[mid].lifecycle_phase is not None:
                            self.pop_message_locked(mid)

            new_message_id = self.message_counter
            self.message_from_id[new_message_id] = message
            self.message_counter += 1
            if entity_key is not None:
                ids = self.ids_from_entity_state_key.get(entity_key)
                if ids is None:
                    ids = self.ids_from_entity_state_key[entity_key] = set()
                ids.add(new_message_id)

            # If an existing message with the same key already exists in our buffer, we
            # don't need the old one anymore. :-)
            if (
                redundancy_key is not None
                and redundancy_key in self.id_from_redundancy_key
            ):
                old_message_id = self.id_from_redundancy_key[redundancy_key]
                self.pop_message_locked(old_message_id)
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
                try:
                    self.event_loop.call_soon_threadsafe(self.message_event.set)
                except RuntimeError:
                    # Event loop already closed (write after stop()); the
                    # message is buffered above, and a closed loop has no
                    # consumer to wake -- same tolerance as set_done().
                    pass

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
            try:
                self.event_loop.call_soon_threadsafe(self.message_event.set)
            except RuntimeError:
                # Event loop already closed (teardown); nothing to wake.
                pass

    def flush(self) -> None:
        """Flush the message buffer; signals to yield a message window immediately."""
        try:
            self.event_loop.call_soon_threadsafe(self.flush_event.set)
        except RuntimeError:
            # Event loop already closed (teardown); nothing to wake.
            pass

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
        # (Captured HERE eagerly; the cursor registration is inside the
        # generator body instead -- a generator that is never iterated, e.g.
        # a producer that observes buffer.done before its first __anext__,
        # never runs its body OR its finally, so an eager registration here
        # would leak. An unstarted generator has consumed nothing and needs
        # no cursor: purging under a not-yet-registered new client is this
        # GC's intended behavior.)
        backlog_last_id = self.message_counter - 1
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
        # Register this connection's consumption cursor (see
        # generator_cursors) for the garbage collector's deletion floor;
        # inside the try so the finally that drops it is guaranteed to pair.
        self.generator_cursors[client_id] = last_sent_id
        try:
            while not self.done:
                window: List[Message] = []
                most_recent_message_id = self.message_counter - 1
                # D51: the end-of-replay marker goes IMMEDIATELY after the
                # connection's captured backlog. Cap the pre-marker windows at
                # the boundary so a live message pushed since connect cannot
                # slip in front of the marker; the live tail drains in the
                # next window.
                if backlog_done_pending:
                    most_recent_message_id = min(
                        most_recent_message_id, backlog_last_id
                    )
                while (
                    last_sent_id < most_recent_message_id
                    and len(window) < self.max_window_size
                    # We should only be polling for new messages if we aren't
                    # in an atomic block.
                    and self.atomic_counter == 0
                ):
                    last_sent_id += 1
                    if self.persistent_messages:
                        message = self.message_from_id.get(last_sent_id, None)
                    else:
                        # If we're not persisting messages, remove them from
                        # the buffer.
                        with self.buffer_lock:
                            message = self.pop_message_locked(last_sent_id)

                    if (
                        message is not None
                        and message.excluded_self_client != client_id
                    ):
                        window.append(message)

                # Advance this connection's consumption cursor: everything at
                # or below last_sent_id is either in `window` (about to be
                # sent) or skipped, so the GC may delete it without this
                # client losing it.
                self.generator_cursors[client_id] = last_sent_id

                if (
                    backlog_done_pending
                    and last_sent_id >= backlog_last_id
                    and self.atomic_counter == 0
                ):
                    # Backlog fully drained (or empty at connect): mark the
                    # end of the replay in-stream, ordered before any live
                    # message that lands after this window.
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

                # Add a delay if either (a) we failed to yield or (b) there's
                # currently no messages to send.
                most_recent_message_id = self.message_counter - 1
                if len(window) == 0 or most_recent_message_id == last_sent_id:
                    done, pending = await asyncio.wait(
                        [flush_wait], timeout=self.window_duration_sec
                    )
                    del pending
                    if flush_wait in done and not self.done:
                        self.flush_event.clear()
                        flush_wait = self.event_loop.create_task(
                            self.flush_event.wait()
                        )
        finally:
            # Drop this connection's GC cursor: a departed client must not
            # hold the deletion floor down forever.
            self.generator_cursors.pop(client_id, None)
            # And reap the CURRENT flush waiter (a plain local, so the latest
            # re-armed task is the one cancelled): an un-awaited Event.wait()
            # task otherwise lingers until a future flush, accumulating one
            # per quiet disconnect.
            flush_wait.cancel()
            try:
                await flush_wait
            except asyncio.CancelledError:
                pass
