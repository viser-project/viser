"""Unit tests for modifier-filter validation and dispatch on
``on_click`` / ``on_rect_select`` / ``on_drag_*`` / ``add_command``."""

from __future__ import annotations

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
    import asyncio

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
    asyncio.run(server.scene._handle_node_click_updates(ClientId(0), msg))

    # Snapshot semantics: cb1 + cb2 fire (registered before dispatch),
    # the newly-added callback does NOT fire on this dispatch. Without
    # snapshot, Python's list iterator picks up appends -- `added` would
    # also be in `fired`.
    assert fired == ["cb1", "cb2"]
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
    # rect-select still registered → cleanup must not fire yet.
    assert fired == []

    server.scene.remove_rect_select_callback()
    # Now the list is empty → cleanup fires.
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
    clickable_msgs = [
        m for m in sent if isinstance(m, _messages.SetSceneNodeClickableMessage)
    ]
    # No SetSceneNodeClickableMessage should have been queued.
    assert clickable_msgs == []
    assert len(box._impl.click_cb) == 0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_click_rejects_extra_kwargs() -> None:
    """Unknown kwargs to ``on_click`` should fail loudly."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))
    with pytest.raises(TypeError, match="unexpected keyword"):
        box.on_click(foo=1)  # type: ignore[call-overload]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_on_drag_start_rejects_extra_positional_args() -> None:
    """``on_drag_start("left", "right")`` is a typo; should raise.

    The explicit signature ``button: ..., *, modifier=...`` makes
    Python's call-site machinery do this for free."""
    server = viser.ViserServer()
    box = server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))
    with pytest.raises(TypeError, match="positional argument"):
        box.on_drag_start("left", "right")  # type: ignore[call-overload]


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
    import asyncio

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
    asyncio.run(server.scene._handle_scene_pointer_updates(ClientId(0), msg))

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
    import asyncio

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
    asyncio.run(server.scene._handle_scene_pointer_updates(ClientId(0), make_msg(None)))
    assert fired == ["plain"]

    # Cmd-click: only "cmd" fires.
    fired.clear()
    asyncio.run(
        server.scene._handle_scene_pointer_updates(ClientId(0), make_msg("cmd/ctrl"))
    )
    assert fired == ["cmd"]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_click_dispatch_filters_by_modifier() -> None:
    """Two click callbacks with different modifiers should each fire
    only when their modifier matches."""
    import asyncio

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
    asyncio.run(server.scene._handle_node_click_updates(ClientId(0), make_msg(None)))
    assert fired == ["plain"]

    fired.clear()
    asyncio.run(server.scene._handle_node_click_updates(ClientId(0), make_msg("shift")))
    assert fired == ["shift"]
