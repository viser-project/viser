"""Contract tests for the entity lifecycle protocol.

Invariants exercised:
- Post-remove writes raise RuntimeError (AssignablePropsBase guard).
- RemoveCommandMessage tombstones are GC'd (declarative GC).
- CommandUpdateMessage has its own redundancy namespace (Update separated from
  Create/Remove).
- Register/Remove coalesce correctly across entity types.
- The `entity_type` / `lifecycle_phase` markers are declared on all relevant
  message classes, enforced by __init_subclass__ validation.
"""

from unittest.mock import patch

import pytest

import viser
import viser._client_autobuild
from viser._messages import (
    CommandUpdateMessage,
    EntityIdField,
    EntityType,
    GuiRemoveMessage,
    GuiUpdateMessage,
    LifecyclePhase,
    Message,
    NotificationShowMessage,
    NotificationUpdateMessage,
    RegisterCommandMessage,
    RemoveCommandMessage,
    RemoveNotificationMessage,
    RemoveSceneNodeMessage,
    SceneNodeUpdateMessage,
    SetPositionMessage,
    _CreateGuiComponentMessage,
    _CreateSceneNodeMessage,
)


# ---------------------------------------------------------------------------
# Entity marker declarations
# ---------------------------------------------------------------------------


def test_entity_markers_on_expected_classes() -> None:
    """Every message that logically represents a lifecycle phase has the
    markers wired correctly."""
    cases: list[tuple[type[Message], EntityType, LifecyclePhase, EntityIdField]] = [
        (_CreateSceneNodeMessage, "scene", "create", "name"),
        (RemoveSceneNodeMessage, "scene", "remove", "name"),
        (SceneNodeUpdateMessage, "scene", "update", "name"),
        (_CreateGuiComponentMessage, "gui", "create", "uuid"),
        (GuiRemoveMessage, "gui", "remove", "uuid"),
        (GuiUpdateMessage, "gui", "update", "uuid"),
        (RegisterCommandMessage, "command", "create", "uuid"),
        (CommandUpdateMessage, "command", "update", "uuid"),
        (RemoveCommandMessage, "command", "remove", "uuid"),
        (NotificationShowMessage, "notification", "create", "uuid"),
        (NotificationUpdateMessage, "notification", "update", "uuid"),
        (RemoveNotificationMessage, "notification", "remove", "uuid"),
    ]
    for cls, expected_type, expected_phase, expected_id in cases:
        assert cls.entity_type == expected_type, cls
        assert cls.lifecycle_phase == expected_phase, cls
        assert cls.entity_id_field == expected_id, cls


def test_include_in_scene_serialization_required() -> None:
    """Every Message subclass must explicitly resolve
    include_in_scene_serialization (directly via kwarg, or inherited from an
    intermediate base)."""
    with pytest.raises(TypeError, match="include_in_scene_serialization"):

        class _Missing(Message):  # no kwarg and no intermediate base provides it
            pass


def test_scene_serialization_flag_categorizes_correctly() -> None:
    """Spot-check that the include_in_scene_serialization flag is set to the
    expected value on representative messages from each category."""
    from viser._messages import (
        FrameMessage,
        GuiFolderMessage,
        NotificationShowMessage,
        RegisterCommandMessage,
        RemoveSceneNodeMessage,
        RunJavascriptMessage,
        SetPositionMessage,
        ThemeConfigurationMessage,
    )

    # Scene state -> recorded.
    assert FrameMessage.include_in_scene_serialization is True
    assert RemoveSceneNodeMessage.include_in_scene_serialization is True
    assert SetPositionMessage.include_in_scene_serialization is True
    assert ThemeConfigurationMessage.include_in_scene_serialization is True
    assert RunJavascriptMessage.include_in_scene_serialization is True
    # GUI / command / notification -> not recorded.
    assert GuiFolderMessage.include_in_scene_serialization is False
    assert RegisterCommandMessage.include_in_scene_serialization is False
    assert NotificationShowMessage.include_in_scene_serialization is False


# ---------------------------------------------------------------------------
# Redundancy key namespaces
# ---------------------------------------------------------------------------


def test_command_update_has_own_redundancy_namespace() -> None:
    """CommandUpdateMessage must not share a redundancy key with Register /
    Remove for the same command -- the key collision was the source of ghost
    commands."""
    create_msg = RegisterCommandMessage(
        uuid="abc",
        props=viser._messages.CommandProps(
            label="x", description=None, hotkey=None, _icon_html=None, disabled=False
        ),
    )
    update_msg = CommandUpdateMessage(uuid="abc", updates={"label": "y"})
    remove_msg = RemoveCommandMessage(uuid="abc")

    assert create_msg.redundancy_key() != update_msg.redundancy_key()
    assert remove_msg.redundancy_key() != update_msg.redundancy_key()
    # Register and Remove DO share a key (intentional: Remove supersedes Create).
    assert create_msg.redundancy_key() == remove_msg.redundancy_key()


def test_update_keys_separate_per_prop_set() -> None:
    """Update messages for different prop sets on the same entity should
    coalesce within their prop set, not with each other."""
    m1 = GuiUpdateMessage(uuid="abc", updates={"value": 1})
    m2 = GuiUpdateMessage(uuid="abc", updates={"disabled": True})
    m3 = GuiUpdateMessage(uuid="abc", updates={"value": 2})
    # Same prop set -> same key (m3 supersedes m1).
    assert m1.redundancy_key() == m3.redundancy_key()
    # Different prop set -> different key.
    assert m1.redundancy_key() != m2.redundancy_key()


# ---------------------------------------------------------------------------
# Declarative GC
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_tombstone_is_gcd() -> None:
    """RemoveCommandMessage tombstones must be purged by the declarative GC
    so new clients don't replay removes of commands they never saw."""
    server = viser.ViserServer()
    buffer = server._websock_server._broadcast_buffer.message_from_id
    baseline = len(buffer)

    for i in range(10):
        handle = server.gui.add_command(f"command_{i}")
        handle.remove()

    # Before GC, the remove tombstones are in the buffer.
    assert len(buffer) > baseline

    server._run_garbage_collector(force=True)
    assert len(buffer) == baseline, "RemoveCommandMessage tombstones not GC'd"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_scene_node_update_is_purged_after_remove() -> None:
    """SceneNodeUpdateMessage for a removed scene node should be purged by
    GC so a late-joining client doesn't see updates for a node that no longer
    exists."""
    server = viser.ViserServer()
    buffer = server._websock_server._broadcast_buffer.message_from_id
    baseline = len(buffer)

    frame = server.scene.add_frame("/gc_update_test")
    # Queue an update via declarative path.
    server._websock_server.queue_message(
        SceneNodeUpdateMessage(
            name="/gc_update_test", updates={"visible": False}
        )
    )
    frame.remove()
    server._run_garbage_collector(force=True)
    assert len(buffer) == baseline, (
        "Stale SceneNodeUpdateMessage survived Remove"
    )


# ---------------------------------------------------------------------------
# AssignablePropsBase removed-guard
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_post_remove_gui_write_raises() -> None:
    server = viser.ViserServer()
    handle = server.gui.add_number("x", 0.0)
    handle.remove()
    with pytest.raises(RuntimeError, match="removed"):
        handle.value = 1.0


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_post_remove_scene_write_raises() -> None:
    server = viser.ViserServer()
    handle = server.scene.add_frame("/test")
    handle.remove()
    with pytest.raises(RuntimeError, match="removed"):
        handle.position = (1.0, 2.0, 3.0)


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_post_remove_command_write_raises() -> None:
    server = viser.ViserServer()
    handle = server.gui.add_command("test")
    handle.remove()
    with pytest.raises(RuntimeError, match="removed"):
        handle.label = "new"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_post_remove_command_icon_setter_raises() -> None:
    """The explicit icon setter path also enforces the removed guard."""
    server = viser.ViserServer()
    handle = server.gui.add_command("test")
    handle.remove()
    with pytest.raises(RuntimeError, match="removed"):
        handle.icon = viser.Icon.CHECK


# ---------------------------------------------------------------------------
# Modal double-close
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_modal_double_close_warns() -> None:
    import warnings

    server = viser.ViserServer()
    with server.gui.add_modal("m") as modal:
        pass
    modal.close()

    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        modal.close()
        assert any(
            "already closed" in str(rec.message) for rec in w
        ), "double-close should warn"


# ---------------------------------------------------------------------------
# Post-remove writes must not leave ghost commands in the buffer.
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_command_update_after_remove_is_suppressed() -> None:
    """add_command -> remove -> property write must raise; no residual
    messages for the command should remain in the broadcast buffer."""
    server = viser.ViserServer()
    buffer = server._websock_server._broadcast_buffer.message_from_id

    handle = server.gui.add_command("test")
    handle.remove()
    with pytest.raises(RuntimeError):
        handle.label = "should not apply"

    server._run_garbage_collector(force=True)
    # After GC: no ghost-command messages left in the buffer.
    command_messages = [
        m for m in buffer.values() if m.entity_type == "command"
    ]
    assert command_messages == []


# ---------------------------------------------------------------------------
# Two-pass GC ordering invariant
# ---------------------------------------------------------------------------


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_gc_two_pass_purges_update_buffered_after_tombstone() -> None:
    """Adversarial ordering: a scene Update lands at a HIGHER message id than
    the Remove tombstone (possible via race / direct _queue_update). A
    single-pass reverse walk would cull the tombstone first and then fail to
    purge the later update. The two-pass walk must catch both."""
    server = viser.ViserServer()
    buf = server._websock_server._broadcast_buffer
    # Wipe any startup traffic so we control the ordering exactly.
    buf.message_from_id.clear()
    buf.id_from_redundancy_key.clear()

    remove = RemoveSceneNodeMessage(name="/ghost")
    update = SceneNodeUpdateMessage(name="/ghost", updates={"visible": False})
    # Remove at low id, Update at high id -- the reorder scenario.
    buf.message_from_id[10] = remove
    buf.id_from_redundancy_key[remove.redundancy_key()] = 10
    buf.message_from_id[20] = update
    buf.id_from_redundancy_key[update.redundancy_key()] = 20

    server._run_garbage_collector(force=True)
    assert 10 not in buf.message_from_id, "tombstone not purged"
    assert 20 not in buf.message_from_id, "late update survived tombstone"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_gc_purges_set_position_after_scene_remove() -> None:
    """Scene-adjacent Set*Messages (no entity markers, just a `name` field)
    must be purged when their target scene node has a tombstone."""
    server = viser.ViserServer()
    buf = server._websock_server._broadcast_buffer

    frame = server.scene.add_frame("/setpos_target")
    server._websock_server.queue_message(
        SetPositionMessage(name="/setpos_target", position=(1.0, 2.0, 3.0))
    )
    frame.remove()
    server._run_garbage_collector(force=True)

    leftover = [
        m
        for m in buf.message_from_id.values()
        if getattr(m, "name", None) == "/setpos_target"
    ]
    assert leftover == [], f"scene-adjacent messages survived GC: {leftover}"
