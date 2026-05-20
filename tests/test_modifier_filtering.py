"""Unit tests for modifier-filter validation and dispatch on
``on_click`` / ``on_rect_select`` / ``on_drag_*`` / ``add_command``."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Coroutine
from unittest.mock import MagicMock, patch

import pytest

import viser
import viser._client_autobuild
from viser import _messages
from viser.infra import ClientId


def _inject_fake_client(server: viser.ViserServer, client_id: int = 0) -> None:
    """Inject a stub client handle so ``_get_client_handle`` resolves
    when we hand-feed dispatch messages in unit tests."""
    server._connected_clients[ClientId(client_id)] = MagicMock(name="fake-client")


def _run_coro(coro: Coroutine[Any, Any, Any]) -> Any:
    """Run a coroutine on a fresh event loop without ``asyncio.run``'s
    'no running loop' precondition.

    Some test fixtures (e.g. pytest-playwright's sync API) leave a running
    event loop attached to the main thread, which breaks ``asyncio.run``
    -- and even ``loop.run_until_complete`` -- when these unit tests run in
    the same process. ``run_until_complete`` checks ``_get_running_loop()``
    on the calling thread, so we run the loop on a worker thread to bypass
    that check.
    """
    import threading

    result: list[Any] = []
    error: list[BaseException] = []

    def _target() -> None:
        loop = asyncio.new_event_loop()
        try:
            result.append(loop.run_until_complete(coro))
        except BaseException as e:
            error.append(e)
        finally:
            loop.close()

    t = threading.Thread(target=_target)
    t.start()
    t.join()
    if error:
        raise error[0]
    return result[0]


def _wait_until(
    predicate: Callable[[], bool], timeout: float = 2.0, interval: float = 0.005
) -> None:
    """Poll ``predicate`` until it returns True or the timeout expires.

    Click / pointer / drag dispatchers submit sync callbacks to a 32-worker
    threadpool and return without waiting (see ``_dispatch_callback`` in
    ``_scene_api.py``). Tests that immediately inspect callback side effects
    can race the threadpool unless we wait for the work to drain.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError(
        f"Predicate did not become true within {timeout}s -- callbacks "
        f"likely did not all fire."
    )


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_click_rejects_invalid_modifier_string() -> None:
    """``on_click(modifier="ctrl")`` is a common typo but the canonical
    string is ``"cmd/ctrl"``. Without validation it silently no-ops
    because the substring matcher uses ``"cmd/ctrl"``. Should raise."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))
    with pytest.raises(ValueError, match="Unknown modifier"):
        box.on_click(modifier="ctrl")  # type: ignore[arg-type]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_scene_on_click_rejects_invalid_modifier_string() -> None:
    """Same as above for the scene-level ``on_click``."""
    server = viser.ViserServer()
    with pytest.raises(ValueError, match="Unknown modifier"):
        server.scene.on_click(modifier="control")  # type: ignore[arg-type]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_click_accepts_canonical_modifier_strings() -> None:
    """Known-good modifier strings should not raise."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    @box.on_click(modifier="cmd/ctrl+shift")
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event

    @box.on_click(modifier=None)
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event

    assert len(box._impl.click_cb) == 2


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_command_rejects_invalid_modifier_string() -> None:
    """``add_command(hotkey="K", modifier="ctrl")`` is the same kind of
    typo as ``on_click(modifier="ctrl")``. Should raise just like the
    other registration paths -- silently no-op'ing on the client (the
    substring matcher uses ``"cmd/ctrl"``) is the worst outcome."""
    server = viser.ViserServer()
    with pytest.raises(ValueError, match="Unknown modifier"):
        server.gui.add_command("X", hotkey="K", modifier="ctrl")  # type: ignore[arg-type]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_add_command_rejects_modifier_without_hotkey() -> None:
    """Passing ``modifier=`` without ``hotkey=`` silently produces an
    unbound command -- the modifier has no key to attach to. This is
    almost always a user mistake; should raise."""
    server = viser.ViserServer()
    with pytest.raises(ValueError, match="modifier"):
        server.gui.add_command("X", modifier="cmd/ctrl")


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_click_dispatch_iterates_over_snapshot() -> None:
    """A click callback that mutates click_cb during dispatch must not
    affect the in-progress dispatch -- snapshot semantics."""

    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    fired: list[str] = []

    @box.on_click
    def cb1(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        fired.append("cb1")

        @box.on_click
        def _added_during_dispatch(
            event: viser.SceneNodePointerEvent[viser.BoxHandle],
        ) -> None:
            del event
            fired.append("added")

    @box.on_click
    def cb2(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        fired.append("cb2")

    _inject_fake_client(server)
    msg = _messages.SceneNodeClickMessage(
        name="/box",
        instance_index=None,
        ray_origin=(0.0, 0.0, 0.0),
        ray_direction=(0.0, 0.0, 1.0),
        screen_pos=(0.5, 0.5),
        modifier=None,
    )
    _run_coro(server.scene._handle_node_click_updates(ClientId(0), msg))

    # Snapshot semantics: cb1 + cb2 fire (registered before dispatch),
    # the newly-added callback does NOT fire on this dispatch. Without
    # snapshot, Python's list iterator picks up appends -- `added` would
    # also be in `fired`.
    #
    # Sync callbacks run on a 32-worker threadpool, so cb1/cb2 may finish in
    # either order; the test only cares that *both* (and only those two) ran.
    _wait_until(lambda: len(fired) >= 2)
    assert sorted(fired) == ["cb1", "cb2"]
    assert len(box._impl.click_cb) == 3


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_pointer_callback_removed_fires_all_registered() -> None:
    """``on_pointer_callback_removed`` must support multiple
    registrations and fire each one on remove."""
    server = viser.ViserServer()

    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    fired: list[str] = []

    @server.scene.on_pointer_callback_removed
    def _() -> None:
        fired.append("done1")

    @server.scene.on_pointer_callback_removed
    def _() -> None:
        fired.append("done2")

    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        server.scene.remove_pointer_callback()
    assert sorted(fired) == ["done1", "done2"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_pointer_event_replaces_existing_and_fires_cleanup() -> None:
    """The deprecated ``on_pointer_event`` is single-slot: registering a
    new callback replaces any prior pointer registrations (legacy or
    typed) and fires existing ``on_pointer_callback_removed`` cleanups.
    Without this, mixing legacy and typed callbacks would let both fire
    for the same gesture, which the legacy API never did."""
    import warnings

    server = viser.ViserServer()

    fired: list[str] = []

    # Pre-register a typed click callback + cleanup. Both should be
    # cleared when on_pointer_event registers next.
    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)

        @server.scene.on_pointer_callback_removed
        def _() -> None:
            fired.append("pre-cleanup")

        @server.scene.on_pointer_event(event_type="click")
        def _(event: viser.ScenePointerEvent) -> None:
            del event

    # Pre-existing typed callback was cleared, on_pointer_event left
    # exactly one registration, and the pre-cleanup fired.
    assert len(server.scene._scene_pointer_cb) == 1
    assert fired == ["pre-cleanup"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_click_callback_fires_cleanup_when_list_empties() -> None:
    """The per-event removal APIs (``remove_click_callback`` /
    ``remove_rect_select_callback``) must fire ``on_pointer_callback_removed``
    cleanup callbacks when the user's last registration goes away.
    Without this, the canonical example pattern of "disable a button on
    click registration, re-enable it via on_pointer_callback_removed
    when the click handler tears itself down" silently leaks a
    permanently-disabled button."""
    server = viser.ViserServer()

    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    fired: list[str] = []

    @server.scene.on_pointer_callback_removed
    def _() -> None:
        fired.append("done")

    # Per-event removal should empty the list and fire cleanup.
    server.scene.remove_click_callback()
    assert fired == ["done"]
    assert len(server.scene._scene_pointer_cb) == 0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_click_callback_does_not_fire_cleanup_with_remaining_rect_select() -> (
    None
):
    """Cleanup only fires when the user's *last* registration is
    removed. If a rect-select callback remains, cleanup must not fire
    yet -- the user still has live event handlers."""
    server = viser.ViserServer()

    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    @server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event

    fired: list[str] = []

    @server.scene.on_pointer_callback_removed
    def _() -> None:
        fired.append("done")

    server.scene.remove_click_callback()
    # rect-select still registered -> cleanup must not fire yet.
    assert fired == []

    server.scene.remove_rect_select_callback()
    # Now the list is empty -> cleanup fires.
    assert fired == ["done"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_pointer_event_server_scope_clears_client_scope_and_vice_versa() -> None:
    """Server-scope and per-client-scope ``on_pointer_event`` share the
    same wire (the ``ScenePointerEnableMessage`` toggle on the client
    side). Allowing both to register simultaneously would let one
    scope's ``enable=False`` deactivate the other's callbacks. The API
    enforces exclusivity: registering on one scope clears the other.

    This is asserted indirectly -- we don't fully spin up a client
    handle here; we only verify the cross-scope cleanup hook is wired
    by checking that the server-scope list is cleared via a fake
    client whose ``scene._scene_pointer_cb`` we observe."""
    server = viser.ViserServer()

    # Stand up a minimal stub client that satisfies the cross-scope
    # cleanup branch -- it just needs ``.scene._scene_pointer_cb`` and
    # ``.scene._remove_all_pointer_callbacks`` to be present.
    fake_client = MagicMock(name="fake-client")
    fake_client.client_id = ClientId(0)
    fake_client._viser_server = server
    fake_client.scene._scene_pointer_cb = []

    def _stub_remove_all(**_kwargs: object) -> None:
        fake_client.scene._scene_pointer_cb.clear()

    fake_client.scene._remove_all_pointer_callbacks = MagicMock(
        side_effect=_stub_remove_all
    )
    server._connected_clients[ClientId(0)] = fake_client

    # Fake client populates its own list as if a client-scope
    # registration had happened.
    fake_client.scene._scene_pointer_cb.append(object())
    assert len(fake_client.scene._scene_pointer_cb) == 1

    @server.scene.on_click()
    def _server_cb(event: viser.SceneClickEvent) -> None:
        del event

    # Server-scope registration should have cleared the client-scope list.
    assert len(server.scene._scene_pointer_cb) == 1
    fake_client.scene._remove_all_pointer_callbacks.assert_called_once()
    assert len(fake_client.scene._scene_pointer_cb) == 0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_click_unapplied_decorator_does_not_mark_clickable() -> None:
    """``box.on_click(modifier="shift")`` returns a decorator factory.
    If the user never applies it, the client must not be told the
    node is clickable -- otherwise we'd have a clickable-but-unbound
    node from the user's perspective."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    sent: list[_messages.Message] = []
    original_queue = server._websock_server.queue_message

    def capture_queue(message: _messages.Message) -> None:
        sent.append(message)
        original_queue(message)

    server._websock_server.queue_message = capture_queue  # type: ignore[method-assign]

    # Decorator factory; never applied.
    _unused = box.on_click(modifier="shift")
    bindings_msgs = [
        m for m in sent if isinstance(m, _messages.SetSceneNodeClickBindingsMessage)
    ]
    # No SetSceneNodeClickBindingsMessage should have been queued for
    # an un-applied decorator factory.
    assert bindings_msgs == []
    assert len(box._impl.click_cb) == 0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_click_rejects_extra_kwargs() -> None:
    """Unknown kwargs to ``on_click`` should fail loudly."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))
    with pytest.raises(TypeError, match="unexpected keyword"):
        box.on_click(foo=1)  # type: ignore[call-overload]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_drag_rejects_extra_positional_args() -> None:
    """``on_drag("left", "right")`` is a typo; should raise.

    The explicit signature ``button: ..., *, modifier=...`` makes
    Python's call-site machinery do this for free."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))
    with pytest.raises(TypeError, match="positional argument"):
        box.on_drag("left", "right")  # type: ignore[call-overload]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_click_callback_targets_only_click_callbacks() -> None:
    """``remove_click_callback`` clears scene click registrations and
    leaves rect-select registrations intact."""
    server = viser.ViserServer()

    @server.scene.on_click()
    def _click(event: viser.SceneClickEvent) -> None:
        del event

    @server.scene.on_rect_select()
    def _rect(event: viser.SceneRectSelectEvent) -> None:
        del event

    assert len(server.scene._scene_pointer_cb) == 2

    server.scene.remove_click_callback()
    remaining = [e.event_type for e in server.scene._scene_pointer_cb]
    assert remaining == ["rect-select"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_rect_select_callback_targets_only_rect_callbacks() -> None:
    server = viser.ViserServer()

    @server.scene.on_click()
    def _click(event: viser.SceneClickEvent) -> None:
        del event

    @server.scene.on_rect_select()
    def _rect(event: viser.SceneRectSelectEvent) -> None:
        del event

    server.scene.remove_rect_select_callback()
    remaining = [e.event_type for e in server.scene._scene_pointer_cb]
    assert remaining == ["click"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_click_callback_with_specific_function() -> None:
    server = viser.ViserServer()

    @server.scene.on_click()
    def cb_a(event: viser.SceneClickEvent) -> None:
        del event

    @server.scene.on_click()
    def cb_b(event: viser.SceneClickEvent) -> None:
        del event

    server.scene.remove_click_callback(cb_a)
    callbacks = [e.callback for e in server.scene._scene_pointer_cb]
    assert callbacks == [cb_b]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_pointer_event_unapplied_decorator_does_not_destroy_callbacks() -> None:
    """Calling ``on_pointer_event(...)`` returns a decorator factory.
    If the user never applies it (typo, exception, etc.), no
    cross-scope cleanup should fire -- otherwise existing callbacks
    would silently disappear."""
    server = viser.ViserServer()

    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    assert len(server.scene._scene_pointer_cb) == 1

    # Build a decorator factory but don't apply it -- should not
    # mutate any state.
    _unused = server.scene.on_click(modifier="cmd/ctrl")
    assert len(server.scene._scene_pointer_cb) == 1


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_pointer_dispatch_iterates_over_snapshot() -> None:
    """Same as click -- pointer dispatch must use snapshot semantics."""

    server = viser.ViserServer()
    fired: list[str] = []

    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event
        fired.append("cb1")

        @server.scene.on_click()
        def _added(event: viser.SceneClickEvent) -> None:
            del event
            fired.append("added")

    _inject_fake_client(server)
    msg = _messages.ScenePointerMessage(
        event_type="click",
        ray_origin=(0.0, 0.0, 0.0),
        ray_direction=(0.0, 0.0, 1.0),
        screen_pos=((0.5, 0.5),),
        modifier=None,
    )
    _run_coro(server.scene._handle_scene_pointer_updates(ClientId(0), msg))

    _wait_until(lambda: "cb1" in fired)
    assert fired == ["cb1"]
    assert len(server.scene._scene_pointer_cb) == 2


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_pointer_event_supports_multiple_callbacks_simultaneously() -> None:
    """Registering two callbacks on different event_types should keep
    both alive (no overwrite)."""
    server = viser.ViserServer()

    @server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    @server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event

    assert len(server.scene._scene_pointer_cb) == 2
    event_types = {entry.event_type for entry in server.scene._scene_pointer_cb}
    assert event_types == {"click", "rect-select"}


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_pointer_event_modifier_dispatch_filters_correctly() -> None:
    """Two callbacks on the same event_type with different modifiers
    should each fire only when their modifier matches."""

    server = viser.ViserServer()

    fired: list[str] = []

    @server.scene.on_click()  # modifier=None: no modifiers held
    def _(event: viser.SceneClickEvent) -> None:
        del event
        fired.append("plain")

    @server.scene.on_click(modifier="cmd/ctrl")
    def _(event: viser.SceneClickEvent) -> None:
        del event
        fired.append("cmd")

    _inject_fake_client(server)

    def make_msg(modifier: _messages.KeyModifier | None):
        return _messages.ScenePointerMessage(
            event_type="click",
            ray_origin=(0.0, 0.0, 0.0),
            ray_direction=(0.0, 0.0, 1.0),
            screen_pos=((0.5, 0.5),),
            modifier=modifier,
        )

    # Plain click: only "plain" fires.
    fired.clear()
    _run_coro(server.scene._handle_scene_pointer_updates(ClientId(0), make_msg(None)))
    _wait_until(lambda: "plain" in fired)
    assert fired == ["plain"]

    # Cmd-click: only "cmd" fires.
    fired.clear()
    _run_coro(
        server.scene._handle_scene_pointer_updates(ClientId(0), make_msg("cmd/ctrl"))
    )
    _wait_until(lambda: "cmd" in fired)
    assert fired == ["cmd"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_click_dispatch_filters_by_modifier() -> None:
    """Two click callbacks with different modifiers should each fire
    only when their modifier matches."""

    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    fired: list[str] = []

    @box.on_click  # modifier=None: no modifiers held
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        fired.append("plain")

    @box.on_click(modifier="shift")
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        fired.append("shift")

    _inject_fake_client(server)

    def make_msg(modifier: _messages.KeyModifier | None):
        return _messages.SceneNodeClickMessage(
            name="/box",
            instance_index=None,
            ray_origin=(0.0, 0.0, 0.0),
            ray_direction=(0.0, 0.0, 1.0),
            screen_pos=(0.5, 0.5),
            modifier=modifier,
        )

    fired.clear()
    _run_coro(server.scene._handle_node_click_updates(ClientId(0), make_msg(None)))
    _wait_until(lambda: "plain" in fired)
    assert fired == ["plain"]

    fired.clear()
    _run_coro(server.scene._handle_node_click_updates(ClientId(0), make_msg("shift")))
    _wait_until(lambda: "shift" in fired)
    assert fired == ["shift"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_click_dedups_redundant_wire_emits() -> None:
    """Each ``box.on_click(...)`` call emits exactly one
    ``SetSceneNodeClickBindingsMessage`` with the growing bindings
    tuple. A no-op ``remove_click_callback("nonexistent")`` queues
    NOTHING (the bindings tuple is unchanged).
    """
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    sent: list[_messages.Message] = []
    original_queue = server._websock_server.queue_message

    def capture_queue(message: _messages.Message) -> None:
        sent.append(message)
        original_queue(message)

    server._websock_server.queue_message = capture_queue  # type: ignore[method-assign]

    # Register 5 click callbacks. Expect exactly FIVE
    # SetSceneNodeClickBindingsMessage with growing bindings tuples.
    for _ in range(5):

        @box.on_click()
        def _cb(event: viser.SceneNodePointerEvent) -> None:
            del event

    bindings_msgs = [
        m for m in sent if isinstance(m, _messages.SetSceneNodeClickBindingsMessage)
    ]
    assert len(bindings_msgs) == 5
    assert [len(m.bindings) for m in bindings_msgs] == [1, 2, 3, 4, 5]

    # Remove a callback that isn't registered. Should queue nothing
    # (the bindings tuple is unchanged).
    pre = len(sent)

    def not_registered(event: viser.SceneNodePointerEvent) -> None:
        del event

    box.remove_click_callback(not_registered)
    assert len(sent) == pre, (
        "no-op remove of unregistered callback should not queue messages"
    )

    # Remove all. Expect ONE empty bindings emit.
    pre = len(sent)
    box.remove_click_callback("all")
    new = sent[pre:]
    new_bindings = [
        m for m in new if isinstance(m, _messages.SetSceneNodeClickBindingsMessage)
    ]
    assert len(new_bindings) == 1 and new_bindings[0].bindings == ()


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_publish_click_state_cache_rolls_back_on_queue_failure() -> None:
    """If ``queue_message`` raises mid-publish (e.g. websocket dropped),
    the dedup cache must NOT have been updated -- otherwise the next
    legitimate state change against the same handle would
    short-circuit against a state the client never received,
    permanently desyncing the registration."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    # Seed the cache with a no-modifier click. Cache is now
    # ``(True, [(left, None)])``.
    @box.on_click()
    def cb_a(event: viser.SceneNodePointerEvent) -> None:
        del event

    cache_before_failure = box._impl._last_published_click_bindings
    assert cache_before_failure == (
        _messages.DragBinding(button="left", modifier=None),
    )

    # Force the next ``queue_message`` to raise. ``_publish_click_state``
    # emits one ``ClickBindings`` message per state change -- raise on
    # the first queue_message call after this point.
    original_queue = server._websock_server.queue_message
    raise_armed = {"value": True}

    def raising_queue(message: _messages.Message) -> None:
        if raise_armed["value"]:
            raise_armed["value"] = False
            raise RuntimeError("simulated websocket failure")
        original_queue(message)

    server._websock_server.queue_message = raising_queue  # type: ignore[method-assign]

    # Register a second click *with a different modifier* so the
    # post-recovery bindings genuinely differ from the pre-failure
    # cache. Without this, a no-op cache rollback would still happen
    # to look correct.
    try:

        @box.on_click(modifier="cmd/ctrl")
        def cb_b(event: viser.SceneNodePointerEvent) -> None:
            del event
    except RuntimeError:
        pass

    cache_after_failure = box._impl._last_published_click_bindings
    assert cache_after_failure == cache_before_failure, (
        "cache committed despite queue_message raising -- next legit "
        "state change will short-circuit against unsent state"
    )

    # Restore the queue. The next publish must NOT short-circuit -- the
    # current bindings (cb_a no-mod + cb_b cmd/ctrl) differ from the
    # pre-failure cache, so the catch-up emit is required.
    server._websock_server.queue_message = original_queue  # type: ignore[method-assign]
    sent_after_recovery: list[_messages.Message] = []
    original_queue2 = server._websock_server.queue_message

    def capture_queue(message: _messages.Message) -> None:
        sent_after_recovery.append(message)
        original_queue2(message)

    server._websock_server.queue_message = capture_queue  # type: ignore[method-assign]

    # Force another publish via a no-op-style call -- registering a
    # third callback genuinely changes the bindings list and triggers
    # ``_publish_click_state``.
    @box.on_click(modifier="shift")
    def _cb_c(event: viser.SceneNodePointerEvent) -> None:
        del event

    bindings_msgs = [
        m
        for m in sent_after_recovery
        if isinstance(m, _messages.SetSceneNodeClickBindingsMessage)
    ]
    # The catch-up emit must include cb_b's cmd/ctrl binding -- the
    # exact entry whose initial publish was lost to the simulated
    # failure. Pre-fix, the cache would have committed before the
    # failed queue_message call and the catch-up would carry only
    # the cb_a + cb_c bindings, missing cb_b.
    assert len(bindings_msgs) >= 1
    last_bindings = bindings_msgs[-1].bindings
    assert _messages.DragBinding(button="left", modifier="cmd/ctrl") in last_bindings, (
        f"catch-up emit missing the cmd/ctrl binding that was lost to "
        f"the simulated failure; got {last_bindings}"
    )


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_node_purges_click_bindings_in_persistent_buffer() -> None:
    """When a node is removed, both the legacy ``Clickable`` flag and
    the new ``ClickBindings`` set must be cleared in the persistent
    message buffer. Without the bindings purge, a future node created
    with the same name would inherit the prior node's modifier
    filters on late-joining clients (the persistent buffer is keyed
    by node name, not by handle identity)."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))

    @box.on_click(modifier="cmd/ctrl")
    def _(event: viser.SceneNodePointerEvent) -> None:
        del event

    sent: list[_messages.Message] = []
    original_queue = server._websock_server.queue_message

    def capture_queue(message: _messages.Message) -> None:
        sent.append(message)
        original_queue(message)

    server._websock_server.queue_message = capture_queue  # type: ignore[method-assign]

    box.remove()

    bindings_purge = [
        m
        for m in sent
        if isinstance(m, _messages.SetSceneNodeClickBindingsMessage)
        and m.bindings == ()
        and m.name == "/box"
    ]
    assert len(bindings_purge) == 1, (
        f"expected exactly 1 SetSceneNodeClickBindingsMessage(()) for "
        f"/box on remove() to purge the persistent buffer; got "
        f"{bindings_purge}"
    )
