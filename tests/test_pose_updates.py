from unittest.mock import patch

import numpy as np

import viser
import viser._client_autobuild
from viser import _messages


def _pose_messages(server: viser.ViserServer, fn) -> list:
    """Pose messages queued while running ``fn``."""
    queued: list = []
    original = server.scene._queue_scene_message

    def record(message: _messages.Message) -> None:
        queued.append(message)
        original(message)

    with patch.object(server.scene, "_queue_scene_message", record):
        fn()
    return [
        m
        for m in queued
        if isinstance(
            m, (_messages.SetPositionMessage, _messages.SetOrientationMessage)
        )
    ]


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_small_pose_changes_are_sent() -> None:
    """A pose change below np.allclose's default tolerance is still sent."""
    server = viser.ViserServer()
    frame = server.scene.add_frame("/frame", position=(1.0, 2.0, 3.0))
    tiny = 1e-7  # relative change well below rtol=1e-5

    def nudge() -> None:
        frame.position = (1.0 + tiny, 2.0, 3.0)
        frame.wxyz = (np.cos(tiny), np.sin(tiny), 0.0, 0.0)

    sent = _pose_messages(server, nudge)
    assert [type(m) for m in sent] == [
        _messages.SetPositionMessage,
        _messages.SetOrientationMessage,
    ]
    np.testing.assert_array_equal(frame.position, (1.0 + tiny, 2.0, 3.0))
    server.stop()


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_identical_pose_is_not_resent() -> None:
    """Assigning the current pose again sends nothing."""
    server = viser.ViserServer()
    frame = server.scene.add_frame("/frame", position=(1.0, 2.0, 3.0))

    def same() -> None:
        frame.position = (1.0, 2.0, 3.0)
        frame.wxyz = (1.0, 0.0, 0.0, 0.0)

    assert _pose_messages(server, same) == []
    server.stop()
