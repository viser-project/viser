from __future__ import annotations

import dataclasses
import warnings
from typing import Any

from typing_extensions import override

from viser._assignable_props_api import AssignablePropsBase

from ._messages import (
    NotificationProps,
    NotificationShowMessage,
    NotificationUpdateMessage,
    RemoveNotificationMessage,
)
from .infra._infra import WebsockClientConnection


@dataclasses.dataclass
class _NotificationHandleState:
    websock_interface: WebsockClientConnection
    uuid: str
    props: NotificationProps
    removed: bool = False


class NotificationHandle(
    NotificationProps, AssignablePropsBase[_NotificationHandleState]
):
    """Handle for a notification in our visualizer."""

    def __init__(self, impl: _NotificationHandleState) -> None:
        self._impl = impl

    @override
    def _queue_update(self, name: str, value: Any) -> None:
        """Queue an update message with the property change. Notifications
        send the full props object (not a delta) so the client uses the same
        construction path as the show case; successive updates collapse to
        "latest wins" via the redundancy key."""
        del name, value
        self._impl.websock_interface.queue_message(
            NotificationUpdateMessage(self._impl.uuid, self._impl.props)
        )

    def _show(self) -> None:
        """Emit the initial NotificationShowMessage."""
        self._impl.websock_interface.queue_message(
            NotificationShowMessage(self._impl.uuid, self._impl.props)
        )

    def remove(self) -> None:
        if self._impl.removed:
            warnings.warn(
                "Attempted to remove an already removed NotificationHandle.",
                stacklevel=2,
            )
            return
        self._impl.removed = True
        self._impl.websock_interface.queue_message(
            RemoveNotificationMessage(self._impl.uuid)
        )
