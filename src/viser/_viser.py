from __future__ import annotations

import asyncio
import dataclasses
import io
import mimetypes
import os
import threading
import time
import warnings
from collections.abc import Coroutine
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, ContextManager, TypeVar, cast, overload

import numpy as np
import numpy.typing as npt
from typing_extensions import Literal, deprecated

from . import _client_autobuild, _messages, infra
from . import transforms as tf
from ._backwards_compat_shims import DeprecatedAttributeShim
from ._gui_api import GuiApi, LiteralColor
from ._gui_handles import _make_uuid
from ._notification_handle import NotificationHandle, _NotificationHandleState
from ._scene_api import SceneApi, cast_vector
from ._threadpool_exceptions import (
    print_awaited_callback_error,
    print_task_error,
    print_threadpool_errors,
)
from ._tunnel import ViserTunnel
from .infra._infra import StateSerializer


class InitialCameraConfig:
    """Configuration for the initial camera pose.

    Accessed via :attr:`ViserServer.initial_camera`. Values set here determine:

    1. The starting camera pose for new client connections
    2. The pose that "Reset View" returns to in the client

    Default behavior (when properties are not explicitly set):
        The client uses a built-in default camera position that provides a
        reasonable view regardless of the scene's up direction. This default
        is specified in three.js coordinates and does not require world
        coordinate transformation.

    When properties are explicitly set, they are interpreted as viser world
    coordinates and transformed appropriately based on the scene's up direction.

    When properties are changed after clients are connected, only the "Reset
    View" target is updated. Clients' current camera positions are not moved,
    allowing users to continue working undisturbed.

    Note that URL parameters (e.g., ``?initialCameraPosition=1,2,3``) take
    priority over server-set values.

    The API is designed to match :class:`CameraHandle`, which is used for
    per-client camera control.
    """

    def __init__(self, broadcast: Callable[[_messages.Message], None]) -> None:
        self._broadcast = broadcast
        self._position: npt.NDArray[np.float64] = np.array([3.0, 3.0, 3.0])
        self._look_at: npt.NDArray[np.float64] = np.array([0.0, 0.0, 0.0])
        # None means "same as the scene up direction".
        self._up: npt.NDArray[np.float64] | None = None
        # 75 degrees in radians; matches three.js PerspectiveCamera default.
        self._fov: float = 75.0 * np.pi / 180.0
        self._near: float = 0.01
        self._far: float = 1000.0

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Camera position in world coordinates."""
        return self._position

    @position.setter
    def position(
        self, value: tuple[float, float, float] | npt.NDArray[np.floating]
    ) -> None:
        self._position = np.asarray(value, dtype=np.float64)
        self._broadcast(
            _messages.SetCameraPositionMessage(cast_vector(value, 3), initial=True)
        )

    @property
    def look_at(self) -> npt.NDArray[np.float64]:
        """Point the camera looks at in world coordinates."""
        return self._look_at

    @look_at.setter
    def look_at(
        self, value: tuple[float, float, float] | npt.NDArray[np.floating]
    ) -> None:
        self._look_at = np.asarray(value, dtype=np.float64)
        self._broadcast(
            _messages.SetCameraLookAtMessage(cast_vector(value, 3), initial=True)
        )

    @property
    def up(self) -> npt.NDArray[np.float64] | None:
        """Camera up direction, or None for scene up direction."""
        return self._up

    @up.setter
    def up(self, value: tuple[float, float, float] | npt.NDArray[np.floating]) -> None:
        self._up = np.asarray(value, dtype=np.float64)
        self._broadcast(
            _messages.SetCameraUpDirectionMessage(cast_vector(value, 3), initial=True)
        )

    @property
    def fov(self) -> float:
        """Vertical field of view in radians."""
        return self._fov

    @fov.setter
    def fov(self, value: float) -> None:
        self._fov = float(value)
        self._broadcast(_messages.SetCameraFovMessage(self._fov, initial=True))

    @property
    def near(self) -> float:
        """Near clipping plane distance."""
        return self._near

    @near.setter
    def near(self, value: float) -> None:
        self._near = float(value)
        self._broadcast(_messages.SetCameraNearMessage(self._near, initial=True))

    @property
    def far(self) -> float:
        """Far clipping plane distance."""
        return self._far

    @far.setter
    def far(self, value: float) -> None:
        self._far = float(value)
        self._broadcast(_messages.SetCameraFarMessage(self._far, initial=True))


@dataclasses.dataclass
class _CameraHandleState:
    """Information about a client's camera state."""

    client: ClientHandle
    wxyz: npt.NDArray[np.float64]
    position: npt.NDArray[np.float64]
    fov: float
    image_height: int
    image_width: int
    near: float
    far: float
    min_orbit_distance: float
    max_orbit_distance: float
    look_at: npt.NDArray[np.float64]
    up_direction: npt.NDArray[np.float64]
    update_timestamp: float
    camera_cb: list[Callable[[CameraHandle], None | Coroutine]]


class CameraHandle:
    """A handle for reading and writing the camera state of a particular
    client. Typically accessed via :attr:`ClientHandle.camera`."""

    def __init__(self, client: ClientHandle) -> None:
        self._state = _CameraHandleState(
            client,
            wxyz=np.zeros(4),
            position=np.zeros(3),
            fov=0.0,
            image_height=0,
            image_width=0,
            near=0.01,
            far=1000.0,
            # Defaults must match the client's <CameraControls> props exactly:
            # the setters early-return when the new value equals the value here,
            # so a mismatch would make assigning the client-side default a silent
            # no-op. Pinned by tests/test_initial_camera_defaults.py.
            min_orbit_distance=0.01,
            max_orbit_distance=1e4,
            look_at=np.zeros(3),
            up_direction=np.zeros(3),
            update_timestamp=0.0,
            camera_cb=[],
        )

    @property
    def client(self) -> ClientHandle:
        """Client that this camera corresponds to."""
        return self._state.client

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Corresponds to the R in `P_world = [R | t] p_camera`. Synchronized
        automatically when assigned."""
        assert self._state.update_timestamp != 0.0
        return self._state.wxyz

    # Note: asymmetric properties are supported in Pyright, but not yet in mypy.
    # - https://github.com/python/mypy/issues/3004
    # - https://github.com/python/mypy/pull/11643
    @wxyz.setter
    def wxyz(self, wxyz: tuple[float, float, float, float] | np.ndarray) -> None:
        R_world_camera = tf.SO3(np.asarray(wxyz)).as_matrix()
        look_distance = np.linalg.norm(self.look_at - self.position)

        # We're following OpenCV conventions: look_direction is +Z, up_direction is -Y,
        # right_direction is +X.
        look_direction = R_world_camera[:, 2]
        up_direction = -R_world_camera[:, 1]
        right_direction = R_world_camera[:, 0]

        # Minimize our impact on the orbit controls by keeping the new up direction as
        # close to the old one as possible.
        projected_up_direction = (
            self.up_direction
            - float(self.up_direction @ right_direction) * right_direction
        )
        up_cosine = float(up_direction @ projected_up_direction)
        if abs(up_cosine) < 0.05:
            projected_up_direction = up_direction
        elif up_cosine < 0.0:
            projected_up_direction = up_direction

        new_look_at = look_direction * look_distance + self.position

        # Update lookat and up direction.
        self.look_at = new_look_at
        self.up_direction = projected_up_direction

        # The internal camera orientation should be set in the look_at /
        # up_direction setters. We can uncomment this assert to check this.
        # assert np.allclose(self._state.wxyz, wxyz) or np.allclose(
        #     self._state.wxyz, -wxyz
        # )

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Corresponds to the t in `P_world = [R | t] p_camera`. Synchronized
        automatically when assigned.

        To preserve the camera orientation, position updates translate both the camera
        and its `look_at` point together. To change position while looking at a fixed
        point, set `look_at` after updating `position`.
        """
        assert self._state.update_timestamp != 0.0
        return self._state.position

    @position.setter
    def position(self, position: tuple[float, float, float] | np.ndarray) -> None:
        position_array = np.asarray(position).astype(np.float64)
        # Validate BEFORE mutating or queuing: this setter queues its message
        # and then shifts look_at (which validates), so a non-finite position
        # caught late would leave the client sent a bad position and the
        # server state half-updated.
        if not np.all(np.isfinite(position_array)):
            raise ValueError(f"Camera position must be finite, got {position_array}.")
        if np.allclose(position_array, self._state.position):
            return
        offset = position_array - np.array(self.position)  # type: ignore
        self._state.position = position_array

        position_tuple = cast_vector(position, 3)
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraPositionMessage(position_tuple)
        )
        self.look_at = np.array(self.look_at) + offset
        self._state.update_timestamp = time.time()

    def _update_wxyz(self) -> None:
        """Compute and update the camera orientation from the internal look_at, position, and up vectors."""
        # Reject non-finite inputs up front: a NaN/Inf position, look_at, or
        # up_direction would otherwise produce a non-zero (NaN) norm that
        # slips past the degeneracy checks below and stores a NaN quaternion
        # -- the exact silent corruption these guards exist to prevent (every
        # later camera read and on_update callback would then see it).
        for _name, _vec in (
            ("position", self._state.position),
            ("look_at", self._state.look_at),
            ("up_direction", self._state.up_direction),
        ):
            if not np.all(np.isfinite(_vec)):
                raise ValueError(f"Camera {_name} must be finite, got {_vec}.")
        z = self._state.look_at - self._state.position
        z_norm = np.linalg.norm(z)
        if z_norm == 0.0:
            # look_at == position: the view direction is undefined. Reject
            # rather than store a NaN quaternion (which every later camera
            # read and on_update callback would then see, silently).
            raise ValueError(
                "Camera look_at cannot equal position (zero look distance)."
            )
        z /= z_norm
        y = tf.SO3.exp(z * np.pi) @ self._state.up_direction
        y = y - np.dot(z, y) * z
        y_norm = np.linalg.norm(y)
        if y_norm == 0.0:
            # No component of up_direction is perpendicular to the view: it is
            # zero, or parallel to (look_at - position). Reject rather than
            # store/broadcast a NaN basis.
            raise ValueError(
                "Camera up_direction must be nonzero and not parallel to the "
                "view direction (look_at - position)."
            )
        y /= y_norm
        x = np.cross(y, z)
        # Cast to float64 explicitly: newer numpy stubs type np.cross() as
        # possibly complex, which from_matrix() rejects.
        matrix = np.stack([x, y, z], axis=1).astype(np.float64)
        self._state.wxyz = tf.SO3.from_matrix(matrix).wxyz.astype(np.float64)

    @property
    def fov(self) -> float:
        """Vertical field of view of the camera, in radians. Synchronized automatically
        when assigned."""
        assert self._state.update_timestamp != 0.0
        return self._state.fov

    @fov.setter
    def fov(self, fov: float) -> None:
        if np.allclose(self._state.fov, fov):
            return
        self._state.fov = fov
        self._state.update_timestamp = time.time()
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraFovMessage(fov)
        )

    @property
    def near(self) -> float:
        """Near clipping plane distance. Synchronized automatically when
        assigned."""
        assert self._state.update_timestamp != 0.0
        return self._state.near

    @near.setter
    def near(self, near: float) -> None:
        if np.allclose(self._state.near, near):
            return
        self._state.near = near
        self._state.update_timestamp = time.time()
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraNearMessage(near)
        )

    @property
    def far(self) -> float:
        """Far clipping plane distance. Synchronized automatically when
        assigned."""
        assert self._state.update_timestamp != 0.0
        return self._state.far

    @far.setter
    def far(self, far: float) -> None:
        if np.allclose(self._state.far, far):
            return
        self._state.far = far
        self._state.update_timestamp = time.time()
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraFarMessage(far)
        )

    @property
    def min_orbit_distance(self) -> float:
        """How close the camera may be dollied in to its orbit (look-at) point.
        Distinct from :attr:`near`, which clips rendering rather than camera
        travel. Synchronized automatically when assigned."""
        assert self._state.update_timestamp != 0.0
        return self._state.min_orbit_distance

    @min_orbit_distance.setter
    def min_orbit_distance(self, min_orbit_distance: float) -> None:
        if np.allclose(self._state.min_orbit_distance, min_orbit_distance):
            return
        self._state.min_orbit_distance = min_orbit_distance
        self._state.update_timestamp = time.time()
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraMinOrbitDistanceMessage(min_orbit_distance)
        )

    @property
    def max_orbit_distance(self) -> float:
        """How far the camera may be dollied out from its orbit (look-at) point.
        Distinct from :attr:`far`, which clips rendering rather than camera
        travel. Defaults to 1e4. Synchronized automatically when assigned.

        Dolly is multiplicative per wheel event, so a very large maximum means a long
        scroll — a trackpad's inertial tail, for instance — can walk the camera out to
        a distance where the scene is no longer visible. Set this to keep zoom-out
        inside the scene's scale."""
        assert self._state.update_timestamp != 0.0
        return self._state.max_orbit_distance

    @max_orbit_distance.setter
    def max_orbit_distance(self, max_orbit_distance: float) -> None:
        if np.allclose(self._state.max_orbit_distance, max_orbit_distance):
            return
        self._state.max_orbit_distance = max_orbit_distance
        self._state.update_timestamp = time.time()
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraMaxOrbitDistanceMessage(max_orbit_distance)
        )

    @property
    def aspect(self) -> float:
        """Canvas width divided by height. Not assignable."""
        assert self._state.update_timestamp != 0.0
        return float(self._state.image_width) / self._state.image_height

    @property
    def image_height(self) -> int:
        """Image height in pixels. Not assignable."""
        assert self._state.update_timestamp != 0.0
        return self._state.image_height

    @property
    def image_width(self) -> int:
        """Image width in pixels. Not assignable."""
        assert self._state.update_timestamp != 0.0
        return self._state.image_width

    @property
    def update_timestamp(self) -> float:
        assert self._state.update_timestamp != 0.0
        return self._state.update_timestamp

    @property
    def look_at(self) -> npt.NDArray[np.float64]:
        """Look at point for the camera. Synchronized automatically when set."""
        assert self._state.update_timestamp != 0.0
        return self._state.look_at

    @look_at.setter
    def look_at(self, look_at: tuple[float, float, float] | np.ndarray) -> None:
        look_at_array = np.asarray(look_at).astype(np.float64)
        if np.allclose(self._state.look_at, look_at_array):
            return
        old_look_at = self._state.look_at
        old_timestamp = self._state.update_timestamp
        self._state.look_at = look_at_array
        self._state.update_timestamp = time.time()
        try:
            self._update_wxyz()
        except Exception:
            # Roll back so a caught error doesn't leave a desynced half-built
            # camera (state mutated, orientation stale, nothing sent).
            self._state.look_at = old_look_at
            self._state.update_timestamp = old_timestamp
            raise
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraLookAtMessage(cast_vector(look_at, 3))
        )

    @property
    def up_direction(self) -> npt.NDArray[np.float64]:
        """Up direction for the camera. Synchronized automatically when set."""
        assert self._state.update_timestamp != 0.0
        return self._state.up_direction

    @up_direction.setter
    def up_direction(
        self, up_direction: tuple[float, float, float] | np.ndarray
    ) -> None:
        up_direction_array = np.asarray(up_direction)
        if np.allclose(self._state.up_direction, up_direction_array):
            return
        old_up = self._state.up_direction
        self._state.up_direction = np.asarray(up_direction_array)
        try:
            self._update_wxyz()
        except Exception:
            # Roll back so a caught error doesn't leave a desynced camera.
            self._state.up_direction = old_up
            raise
        self._state.update_timestamp = time.time()
        self._state.client._websock_connection.queue_message(
            _messages.SetCameraUpDirectionMessage(cast_vector(up_direction, 3))
        )

    def on_update(
        self, callback: Callable[[CameraHandle], NoneOrCoroutine]
    ) -> Callable[[CameraHandle], NoneOrCoroutine]:
        """Attach a callback to run when a new camera message is received.

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._state.camera_cb.append(callback)
        return callback

    def get_render(
        self,
        height: int,
        width: int,
        transport_format: Literal["png", "jpeg"] = "jpeg",
        timeout: float | None = None,
    ) -> np.ndarray:
        """Request a render from a client, block until it's done and received, then
        return it as a numpy array. This is an alias for :meth:`ClientHandle.get_render()`.

        Args:
            height: Height of rendered image. Should be <= the browser height.
            width: Width of rendered image. Should be <= the browser width.
            transport_format: Image transport format. JPEG will return a lossy (H, W, 3) RGB array. PNG will
                return a lossless (H, W, 4) RGBA array, but can cause memory issues on the frontend if called
                too quickly for higher-resolution images.
            timeout: Optional maximum seconds to wait for the frame. ``None``
                (default) waits indefinitely; a disconnect still raises promptly
                either way. Set this to bound a client that stays connected but
                never returns a frame.
        """
        return self._state.client.get_render(
            height, width, transport_format=transport_format, timeout=timeout
        )


NoneOrCoroutine = TypeVar("NoneOrCoroutine", None, Coroutine)


# Don't inherit from RenamedAttributeCompatShim during type checking, because
# this will unnecessarily suppress type errors. (from the overriding of
# __getattr__).
class ClientHandle(DeprecatedAttributeShim if not TYPE_CHECKING else object):
    """A handle is created for each client that connects to a server. Handles can be
    used to communicate with just one client, as well as for reading and writing of
    camera state.

    Similar to :class:`ViserServer`, client handles also expose scene and GUI
    interfaces at :attr:`ClientHandle.scene` and :attr:`ClientHandle.gui`. If
    these are used, for example via a client's
    :meth:`SceneApi.add_point_cloud()` method, created elements are local to
    only one specific client.
    """

    def __init__(
        self, conn: infra.WebsockClientConnection, server: ViserServer
    ) -> None:
        # Private attributes.
        self._websock_connection = conn
        self._viser_server = server

        # Public attributes.
        self.scene: SceneApi = SceneApi(
            self, thread_executor=server._thread_executor, event_loop=server._event_loop
        )
        """Handle for interacting with the 3D scene."""
        self.gui: GuiApi = GuiApi(
            self, thread_executor=server._thread_executor, event_loop=server._event_loop
        )
        """Handle for interacting with the GUI."""
        self.client_id: int = conn.client_id
        """Unique ID for this client."""
        self.camera: CameraHandle = CameraHandle(self)
        """Handle for reading from and manipulating the client's viewport camera."""

    def flush(self) -> None:
        """Flush the outgoing message buffer. Any buffered messages will immediately be
        sent. (by default they are windowed)"""
        self._viser_server._websock_server.flush_client(self.client_id)

    def atomic(self) -> ContextManager[None]:
        """Returns a context where: all outgoing messages are grouped and applied by
        clients atomically.

        This should be treated as a soft constraint that's helpful for things
        like animations, or when we want position and orientation updates to
        happen synchronously.

        Returns:
            Context manager.
        """
        return self._websock_connection.atomic()

    def send_file_download(
        self,
        filename: str,
        content: bytes,
        chunk_size: int = 1024 * 1024,
        save_immediately: bool = False,
    ) -> None:
        """Send a file for a client or clients to download.

        Args:
            filename: Name of the file to send. Used to infer MIME type.
            content: Content of the file.
            chunk_size: Number of bytes to send at a time.
            save_immediately: Whether to save the file immediately. If `False`,
                a link to the file will be shown as a notification. Being able to
                right click the link and choose "Save as..." can be useful.
        """
        mime_type = mimetypes.guess_type(filename, strict=False)[0]
        if mime_type is None:
            mime_type = "application/octet-stream"

        parts = [
            content[i * chunk_size : (i + 1) * chunk_size]
            for i in range(int(np.ceil(len(content) / chunk_size)))
        ]

        uuid = _make_uuid()
        self._websock_connection.queue_message(
            _messages.FileTransferStartDownload(
                save_immediately=save_immediately,
                transfer_uuid=uuid,
                filename=filename,
                mime_type=mime_type,
                part_count=len(parts),
                size_bytes=len(content),
            )
        )
        for i, part in enumerate(parts):
            self._websock_connection.queue_message(
                _messages.FileTransferPart(
                    None,
                    transfer_uuid=uuid,
                    part_index=i,
                    content=part,
                )
            )
            self.flush()

    @overload
    def add_notification(
        self,
        title: str,
        body: str,
        *,
        loading: bool = False,
        with_close_button: bool = True,
        auto_close_seconds: float | None = None,
        color: LiteralColor | tuple[int, int, int] | None = None,
    ) -> NotificationHandle: ...

    @overload
    @deprecated(
        "The `auto_close` argument has been deprecated. Use `auto_close_seconds` instead."
    )
    def add_notification(
        self,
        title: str,
        body: str,
        *,
        loading: bool = False,
        with_close_button: bool = True,
        auto_close: int | Literal[False] = False,
        color: LiteralColor | tuple[int, int, int] | None = None,
    ) -> NotificationHandle: ...

    def add_notification(
        self,
        title: str,
        body: str,
        *,
        loading: bool = False,
        with_close_button: bool = True,
        # In seconds: current API.
        auto_close_seconds: float | None = None,
        # In milliseconds: deprecated.
        auto_close: int | Literal[False] = False,
        color: LiteralColor | tuple[int, int, int] | None = None,
    ) -> NotificationHandle:
        """Add a notification to the client's interface.

        This method creates a new notification that will be displayed at the
        top left corner of the client's viewer. Notifications are useful for
        providing alerts or status updates to users.

        .. deprecated:: 1.0.0
            The `auto_close` argument is deprecated. Use `auto_close_seconds` instead.

        Args:
            title: Title to display on the notification.
            body: Message to display on the notification body.
            loading: Whether the notification shows loading icon.
            with_close_button: Whether the notification can be manually closed.
            auto_close_seconds: Time before the notification automatically
                closes; None if the notification does not close on its own.

        Returns:
            A handle that can be used to interact with the GUI element.
        """
        if auto_close is not False:
            warnings.warn(
                "The `auto_close` (milliseconds) argument has been deprecated. Use `auto_close_seconds` instead.",
                category=DeprecationWarning,
                stacklevel=2,
            )
            auto_close_seconds = auto_close / 1000.0
        handle = NotificationHandle(
            _NotificationHandleState(
                websock_interface=self._websock_connection,
                uuid=_make_uuid(),
                props=_messages.NotificationProps(
                    title=title,
                    body=body,
                    loading=loading,
                    with_close_button=with_close_button,
                    auto_close_seconds=auto_close_seconds,
                    color=color,
                ),
            )
        )
        handle._show()
        return handle

    @overload
    def get_render(
        self,
        height: int,
        width: int,
        *,
        wxyz: tuple[float, float, float, float] | np.ndarray,
        position: tuple[float, float, float] | np.ndarray,
        fov: float,
        transport_format: Literal["png", "jpeg"] = "jpeg",
        timeout: float | None = None,
    ) -> np.ndarray: ...

    @overload
    def get_render(
        self,
        height: int,
        width: int,
        *,
        transport_format: Literal["png", "jpeg"] = "jpeg",
        timeout: float | None = None,
    ) -> np.ndarray: ...

    def get_render(
        self,
        height: int,
        width: int,
        *,
        wxyz: tuple[float, float, float, float] | np.ndarray | None = None,
        position: tuple[float, float, float] | np.ndarray | None = None,
        fov: float | None = None,
        transport_format: Literal["png", "jpeg"] = "jpeg",
        timeout: float | None = None,
    ) -> np.ndarray:
        """Request a render from a client, block until it's done and received, then
        return it as a numpy array. If wxyz, position, and fov are not provided, the
        current camera state will be used.

        Args:
            height: Height of rendered image. Should be <= the browser height.
            width: Width of rendered image. Should be <= the browser width.
            wxyz: Camera orientation as a quaternion. If not provided, the current camera
                position will be used.
            position: Camera position. If not provided, the current camera position will
                be used.
            fov: Vertical field of view of the camera, in radians. If not provided, the
                current camera position will be used.
            transport_format: Image transport format. JPEG will return a lossy (H, W, 3) RGB array. PNG will
                return a lossless (H, W, 4) RGBA array, but can cause memory issues on the frontend if called
                too quickly for higher-resolution images.
            timeout: Optional maximum seconds to wait for the frame. ``None``
                (default) waits indefinitely; a disconnect still raises promptly
                either way. Set this to bound a client that stays connected but
                never returns a frame (raises ``TimeoutError``).
        """

        # Listen for a render reseponse message, which should contain the rendered
        # image.
        render_ready_event = threading.Event()
        out: np.ndarray | None = None

        connection = self._websock_connection

        render_uuid = _make_uuid()

        # THREE exits race to unregister the handler: a frame arriving
        # (got_render_cb, on the event loop), and the caller's disconnect /
        # timeout branches below. infra's unregister_handler raises ValueError
        # on a second remove, so exactly one exit may perform it; the losers
        # defer to the winner instead of double-unregistering.
        unregister_lock = threading.Lock()
        unregistered = False

        def unregister_once() -> bool:
            nonlocal unregistered
            with unregister_lock:
                if unregistered:
                    return False
                unregistered = True
            connection.unregister_handler(
                _messages.GetRenderResponseMessage, got_render_cb
            )
            return True

        def got_render_cb(
            client_id: int, message: _messages.GetRenderResponseMessage
        ) -> None:
            del client_id
            # Ignore responses for other concurrent get_render() calls on this
            # client; only ours matches our request's uuid.
            if message.render_uuid != render_uuid:
                return
            if not unregister_once():
                # The caller already gave up (timeout/disconnect) and
                # unregistered us; we can still be invoked once more if the
                # dispatch loop snapshotted the handler list before the
                # removal. The caller is gone -- drop the frame.
                return
            nonlocal out
            # An empty payload is the client's failure sentinel (capture threw,
            # or toBlob() returned null). Leave `out` as None and let the
            # waiter raise, rather than crashing the decode here (which would
            # never set the event and hang get_render() forever).
            if len(message.payload) > 0:
                import imageio.v3 as iio

                try:
                    out = iio.imread(
                        io.BytesIO(message.payload),
                        extension=f".{transport_format}",
                    )
                except Exception:
                    out = None
            render_ready_event.set()

        connection.register_handler(_messages.GetRenderResponseMessage, got_render_cb)
        self._websock_connection.queue_message(
            _messages.GetRenderRequestMessage(
                "image/jpeg" if transport_format == "jpeg" else "image/png",
                height=height,
                width=width,
                # Only used for JPEG. The main reason to use a lower quality version
                # value is (unfortunately) to make life easier for the Javascript
                # garbage collector.
                quality=80,
                position=cast_vector(
                    position if position is not None else self.camera.position, 3
                ),
                wxyz=cast_vector(wxyz if wxyz is not None else self.camera.wxyz, 4),
                fov=fov if fov is not None else self.camera.fov,
                render_uuid=render_uuid,
            )
        )
        # Poll rather than wait unbounded: a client that DISCONNECTS (tab
        # closed, network drop) never sends a response, so this raises as soon
        # as it leaves _connected_clients instead of hanging the caller (and,
        # from a sync callback, its pool worker). A client that stays
        # connected but never returns a frame (frozen/backgrounded tab, wedged
        # capture) is only bounded if the caller passes `timeout`.
        deadline = None if timeout is None else time.time() + timeout
        while not render_ready_event.wait(timeout=0.1):
            if self.client_id not in self._viser_server._connected_clients:
                if not unregister_once():
                    # got_render_cb won the race: a frame was delivered in the
                    # window between its unregister and its event.set(). Take
                    # the frame rather than raising on a request that in fact
                    # completed.
                    render_ready_event.wait()
                    break
                raise RuntimeError(
                    "Render request failed: the client disconnected before "
                    "returning a frame."
                )
            if deadline is not None and time.time() > deadline:
                if not unregister_once():
                    # Same race as above: the frame beat the deadline's
                    # unregister. Return it instead of raising TimeoutError.
                    render_ready_event.wait()
                    break
                raise TimeoutError(
                    f"Render request timed out after {timeout}s: the client "
                    "did not return a frame."
                )
        if out is None:
            raise RuntimeError(
                "Render request failed: the client could not capture a frame."
            )
        return out


class ViserServer(DeprecatedAttributeShim if not TYPE_CHECKING else object):
    """:class:`ViserServer` is the main class for working with viser. On
    instantiation, it (a) launches a thread with a web server and (b) provides
    a high-level API for interactive 3D visualization.

    **Core API.** Clients can connect via a web browser, and will be shown two
    components: a 3D scene and a 2D GUI panel. Methods belonging to
    :attr:`ViserServer.scene` can be used to add 3D primitives to the scene.
    Methods belonging to :attr:`ViserServer.gui` can be used to add 2D GUI
    elements.

    **Shared state.** Elements added to the server object, for example via a
    server's :meth:`SceneApi.add_point_cloud` or :meth:`GuiApi.add_button`,
    will have state that's shared and synchronized automatically between all
    connected clients. To show elements that are local to a single client, see
    :attr:`ClientHandle.scene` and :attr:`ClientHandle.gui`.

    Args:
        host: Host to bind server to.
        port: Port to bind server to.
        label: Label shown at the top of the GUI panel.
    """

    # Hide deprecated arguments from docstring and type checkers.
    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 8080,
        label: str | None = None,
        verbose: bool = True,
        **_deprecated_kwargs,
    ):
        # Check for port override environment variable.
        port_override = os.environ.get("_VISER_PORT_OVERRIDE")
        if port_override is not None:
            try:
                port = int(port_override)
            except ValueError:
                warnings.warn(
                    f"Invalid _VISER_PORT_OVERRIDE value: {port_override}. Using default port {port}."
                )

        # Create server.
        server = infra.WebsockServer(
            host=host,
            port=port,
            message_class=_messages.Message,
            http_server_root=Path(__file__).resolve().parent / "client" / "build",
            verbose=verbose,
            # End-of-replay marker: lets the client hold reconnect-sensitive
            # state (dock panes for same-uuid panels) dormant until the replay
            # provably finished, instead of guessing from store emptiness.
            backlog_done_message=_messages.ReplayDoneMessage(),
        )
        self._websock_server = server

        _client_autobuild.ensure_client_is_built()

        self._initial_camera = InitialCameraConfig(broadcast=server.queue_message)
        self._connection = server
        self._connected_clients: dict[int, ClientHandle] = {}
        self._client_lock = threading.Lock()
        self._client_connect_cb: list[Callable[[ClientHandle], None | Coroutine]] = []
        self._client_disconnect_cb: list[
            Callable[[ClientHandle], None | Coroutine]
        ] = []

        self._thread_executor = ThreadPoolExecutor(max_workers=32)

        # Run "garbage collector" on message buffer when new clients connect.
        @server.on_client_connect
        async def _(_: infra.WebsockClientConnection) -> None:
            self._run_garbage_collector()

        # For new clients, register and add a handler for camera messages.
        @server.on_client_connect
        async def _(conn: infra.WebsockClientConnection) -> None:
            client = ClientHandle(conn, server=self)
            first = True

            async def handle_camera_message(
                client_id: infra.ClientId, message: _messages.ViewerCameraMessage
            ) -> None:
                nonlocal first

                assert client_id == client.client_id

                # Update the client's camera.
                client.camera._state = _CameraHandleState(
                    client,
                    np.array(message.wxyz),
                    np.array(message.position),
                    fov=message.fov,
                    image_height=message.image_height,
                    image_width=message.image_width,
                    near=message.near,
                    far=message.far,
                    # Dolly limits are server-owned constraints, not something the
                    # client reports back, so they have to survive this rebuild —
                    # otherwise every incoming camera message would silently reset
                    # them. Carried over like camera_cb.
                    min_orbit_distance=client.camera._state.min_orbit_distance,
                    max_orbit_distance=client.camera._state.max_orbit_distance,
                    look_at=np.array(message.look_at),
                    up_direction=np.array(message.up_direction),
                    update_timestamp=time.time(),
                    camera_cb=client.camera._state.camera_cb,
                )

                # We consider a client to be connected after the first camera message is
                # received.
                if first:
                    first = False
                    # Register the client and snapshot the callback list in
                    # one critical section, then invoke OUTSIDE the lock: an
                    # async callback runs inline on the event loop, and any
                    # server API it calls that takes _client_lock (e.g.
                    # get_clients(), or on_scene_pointer registration) would
                    # deadlock against the lock this thread already holds.
                    # Exactly-once dispatch per (client, callback) pair only
                    # needs the mutate+snapshot to be atomic: a concurrent
                    # on_client_connect registration either lands in this
                    # snapshot, or its own already-connected replay sees the
                    # client in _connected_clients -- never both, never
                    # neither.
                    with self._client_lock:
                        self._connected_clients[conn.client_id] = client
                        connect_cbs = tuple(self._client_connect_cb)
                    await self._dispatch_client_callbacks(connect_cbs, client)

                for camera_cb in client.camera._state.camera_cb:
                    if asyncio.iscoroutinefunction(camera_cb):
                        await camera_cb(client.camera)
                    else:
                        self._thread_executor.submit(
                            camera_cb, client.camera
                        ).add_done_callback(print_threadpool_errors)

            conn.register_handler(_messages.ViewerCameraMessage, handle_camera_message)

        # Remove clients when they disconnect.
        @server.on_client_disconnect
        async def _(conn: infra.WebsockClientConnection) -> None:
            # Never hold _client_lock across an await: the awaited user
            # callbacks (and the synthesized drag-end callbacks below) run
            # inline on the event loop, and any server API they call that
            # takes the lock (e.g. get_clients()) would deadlock against
            # the lock this thread already holds. Pop FIRST so no observer
            # (get_clients(), connect-callback replay) can see a physically
            # dead client while its teardown awaits user code.
            with self._client_lock:
                handle = self._connected_clients.pop(conn.client_id, None)
                disconnect_cbs = tuple(self._client_disconnect_cb)
            if handle is None:
                return

            # Drop this client's in-flight upload buffers (shared GUI and the
            # client's own): nothing else removes them -- completion is the
            # only other pop -- so a tab closed mid-upload leaked its
            # accumulated parts forever.
            self.gui._drop_uploads_from_client(cast(infra.ClientId, conn.client_id))
            handle.gui._drop_uploads_from_client(cast(infra.ClientId, conn.client_id))

            # Drop any in-flight drag entries for this client; the
            # corresponding ``phase="end"`` will never arrive, so without
            # this the active-drag map leaks an entry per dropped drag and
            # ``on_drag_end`` is silently skipped. The popped handle is
            # passed in explicitly so the synthesized end events can still
            # resolve ``event.client`` without the client being publicly
            # listed.
            await self.scene._drop_active_drags_for_client(
                cast(infra.ClientId, conn.client_id), event_client=handle
            )
            await self._dispatch_client_callbacks(disconnect_cbs, handle)

        # Start the server.
        server.start()
        self._event_loop = server._broadcast_buffer.event_loop

        self.scene: SceneApi = SceneApi(
            self, thread_executor=self._thread_executor, event_loop=self._event_loop
        )
        """Handle for interacting with the 3D scene."""

        self.gui: GuiApi = GuiApi(
            self, thread_executor=self._thread_executor, event_loop=self._event_loop
        )
        """Handle for interacting with the GUI."""

        # Dispatch the share-tunnel handlers to the thread pool, NOT inline on
        # the event loop: request_share_url() blocks (HTTP round-trip to the
        # share backend, and connect_event.wait() with no timeout). Run inline,
        # a single ShareUrlRequest from any client would freeze the whole
        # event loop -- every client stalls -- for the round-trip, or forever
        # if the share backend is unreachable. On a pool thread the blocking is
        # confined to that worker.
        server.register_handler(
            _messages.ShareUrlDisconnect,
            lambda client_id, msg: self._thread_executor.submit(
                self.disconnect_share_url
            ).add_done_callback(print_threadpool_errors),
        )
        server.register_handler(
            _messages.ShareUrlRequest,
            lambda client_id, msg: self._thread_executor.submit(
                self.request_share_url
            ).add_done_callback(print_threadpool_errors),
        )

        # Form status print.
        import rich
        from rich import box, style
        from rich.panel import Panel
        from rich.table import Table

        port = server._port  # Port may have changed.
        if host == "0.0.0.0":
            # 0.0.0.0 is not a real IP and people are often confused by it;
            # we'll just print localhost. This is questionable from a security
            # perspective, but probably fine for our use cases.
            http_url = f"http://localhost:{port}"
            ws_url = f"ws://localhost:{port}"
        else:
            http_url = f"http://{host}:{port}"
            ws_url = f"ws://{host}:{port}"
        table = Table(
            title=None,
            show_header=False,
            box=box.MINIMAL,
            title_style=style.Style(bold=True),
        )
        table.add_row("HTTP", http_url)
        table.add_row("Websocket", ws_url)
        rich.print(
            Panel(
                table,
                title=f"[bold]viser[/bold] [dim](listening *:{port})[/dim]"
                if host == "0.0.0.0"
                else "[bold]viser[/bold]",
                expand=False,
            )
        )

        self._share_tunnel: ViserTunnel | None = None
        # Guards the share-tunnel slot's check-then-act. The handlers now run
        # on pool threads (not serialized on the event loop), so two
        # concurrent requests could both see None and each create a tunnel,
        # orphaning (leaking) the first.
        self._share_tunnel_lock = threading.Lock()

        # Create share tunnel if requested.
        # This is deprecated: we should use get_share_url() instead.
        share = _deprecated_kwargs.get("share", False)
        if share:
            self.request_share_url()

        self.scene.reset()
        self.scene.set_up_direction("+z")
        self.gui.reset()
        self.gui.set_panel_label(label)

    @property
    def initial_camera(self) -> InitialCameraConfig:
        """Configuration for initial camera pose.

        Set these values to control the initial camera position for new
        clients and serialized/embedded scenes. The API is designed to match
        :class:`viser.CameraHandle`, which is used for per-client camera control.

        Example usage::

            server.initial_camera.position = (5.0, 5.0, 3.0)
            server.initial_camera.look_at = (0.0, 0.0, 0.0)
        """
        return self._initial_camera

    def _run_garbage_collector(self, force: bool = False) -> None:
        """Purge from the persistent broadcast buffer:

        - Every tombstone message (``lifecycle_phase == "remove"``) for an
          entity -- new clients shouldn't replay removals of entities that
          never existed to them.
        - Every update message (``lifecycle_phase`` of ``update_dict`` or
          ``update_simple``) targeting an entity that was already removed. This
          includes the scene-node ``Set*Message`` pose/visibility variants
          (SetPosition, SetOrientation, SetBonePosition, SetBoneOrientation,
          SetSceneNodeVisibility), which are declared ``update_simple``.
        - Any remaining non-entity message carrying a ``name`` that matches a
          removed scene node (e.g. the click/drag binding messages); a
          ``name``-match against the tombstone set catches them generically.

        Two passes so purging is order-independent under concurrent writers:
        the first pass collects all tombstone entity ids, the second sweeps
        updates (and scene-adjacent Set* messages) targeting them.
        """
        buffer = self._websock_server._broadcast_buffer
        with buffer.buffer_lock:
            # Deletion floor: only messages EVERY active window generator has
            # already consumed may be purged. Do NOT gate on message_event --
            # it is not a consumption watermark (any one generator clears
            # it), so a BACKPRESSURED client's cursor can sit arbitrarily far
            # behind, and purging a remove-tombstone it hadn't consumed makes
            # it retain the entity forever (its cursor skips the hole),
            # permanently diverging it from other clients. With no active
            # generators everything is purgeable: a connecting client's
            # generator registers only when its producer starts, and a fresh
            # client must not replay removals of entities it never saw --
            # which is this GC's entire purpose.
            purge_floor = min(buffer.generator_cursors.values(), default=None)

            def deletable(msg_id: int) -> bool:
                return force or purge_floor is None or msg_id <= purge_floor

            # First pass: collect every tombstone's entity id. The entity id
            # set gates the second pass regardless of the floor; the tombstone
            # MESSAGE itself is only deleted once every active client has
            # consumed it.
            remove_message_ids: list[int] = []
            removed_ids_by_type: dict[str, set[str]] = {}
            for msg_id, message in buffer.message_from_id.items():
                if message.lifecycle_phase == "remove":
                    assert (
                        message.entity_type is not None
                        and message.entity_id_field is not None
                    )
                    if deletable(msg_id):
                        remove_message_ids.append(msg_id)
                    removed_ids_by_type.setdefault(message.entity_type, set()).add(
                        getattr(message, message.entity_id_field)
                    )

            # Second pass: purge updates whose target entity has a tombstone,
            # including scene-adjacent Set*Message variants that target a
            # removed scene node by `name` but aren't entity-declared. The
            # per-message taxonomy is Message.targets_entity_state -- the ONE
            # definition, shared with the same-name-replacement purge -- with
            # set-based id matching inlined here so the sweep stays a single
            # pass over the buffer rather than per-name predicate calls.
            # Skip the walk entirely when nothing was tombstoned this round.
            #
            # These deletes are NOT floor-gated, unlike the tombstones above:
            # an update targeting a removed entity is dead weight for EVERY
            # client. A laggard that hasn't consumed it still receives the
            # (floor-retained) tombstone, so its final state is identical --
            # while floor-gating it let a single backpressured client pin an
            # update that sorts AFTER its entity's remove in the buffer, and
            # every late-joiner then replayed "remove /x" (no-op) followed by
            # "update /x": a ghost node other clients don't have. push()
            # already purges pending updates on Remove with no floor gate;
            # this sweep follows the same reasoning.
            if removed_ids_by_type:
                for msg_id, message in buffer.message_from_id.items():
                    phase = message.lifecycle_phase
                    if phase in ("update_dict", "update_simple"):
                        assert (
                            message.entity_type is not None
                            and message.entity_id_field is not None
                        )
                        entity_id = getattr(message, message.entity_id_field)
                        if entity_id in removed_ids_by_type.get(
                            message.entity_type, ()
                        ):
                            remove_message_ids.append(msg_id)
                    elif phase is None:
                        name = getattr(message, "name", None)
                        if name is not None and name in removed_ids_by_type.get(
                            "scene", ()
                        ):
                            remove_message_ids.append(msg_id)

            for msg_id in remove_message_ids:
                message = buffer.message_from_id.pop(msg_id)
                buffer.id_from_redundancy_key.pop(message.redundancy_key(), None)

    def get_host(self) -> str:
        """Returns the host address of the Viser server.

        Returns:
            Host address as string.
        """
        return self._websock_server._host

    def get_port(self) -> int:
        """Returns the port of the Viser server. This could be different from the
        originally requested one.

        Returns:
            Port as integer.
        """
        return self._websock_server._port

    def request_share_url(self, verbose: bool = True) -> str | None:
        """Request a share URL for the Viser server, which allows for public access.
        On the first call, will block until a connecting with the share URL server is
        established. Afterwards, the URL will be returned directly.

        This is an experimental feature that relies on an external server; it shouldn't
        be relied on for critical applications.

        Args:
            verbose: Whether to print status messages.

        Returns:
            Share URL as string, or None if connection fails or is closed.
        """
        # Claim the tunnel slot atomically: only ONE concurrent request
        # creates a tunnel; the rest wait on it. The blocking waits below are
        # OUTSIDE the lock so requests don't serialize on the connection.
        with self._share_tunnel_lock:
            tunnel = self._share_tunnel
            we_created = tunnel is None
            if we_created:
                if verbose:
                    import rich

                    rich.print("[bold](viser)[/bold] Share URL requested!")
                tunnel = self._share_tunnel = ViserTunnel(
                    "share.viser.studio", self._websock_server._port
                )

        if not we_created:
            # Another request created (or is creating) the tunnel.
            assert tunnel is not None
            while tunnel.get_status() in ("ready", "connecting"):
                time.sleep(0.05)
            return tunnel.get_url()

        # We own the new tunnel: wire callbacks and wait for it to connect.
        assert tunnel is not None
        connect_event = threading.Event()

        @tunnel.on_disconnect
        def _() -> None:
            import rich

            rich.print("[bold](viser)[/bold] Disconnected from share URL")
            with self._share_tunnel_lock:
                # Only clear the slot if it still points at OUR tunnel (a
                # newer request may have replaced it).
                if self._share_tunnel is tunnel:
                    self._share_tunnel = None
            self._websock_server.queue_message(_messages.ShareUrlUpdated(None))

        @tunnel.on_connect
        def _(max_clients: int) -> None:
            share_url = tunnel.get_url()
            if verbose:
                import rich

                if share_url is None:
                    rich.print("[bold](viser)[/bold] Could not generate share URL")
                else:
                    rich.print(
                        f"[bold](viser)[/bold] Generated share URL (expires in 24 hours, max {max_clients} clients): {share_url}"
                    )
            self._websock_server.queue_message(_messages.ShareUrlUpdated(share_url))
            connect_event.set()

        # Wait for connect, but ALSO watch for failure: on_connect only fires
        # on success, and a failed tunnel (share backend unreachable) sets
        # status="failed" without touching connect_event -- a bare wait()
        # blocked the creator forever instead of returning None as documented.
        while not connect_event.wait(timeout=0.1):
            if tunnel.get_status() in ("failed", "closed"):
                return None
        return tunnel.get_url()

    def disconnect_share_url(self) -> None:
        """Disconnect from the share URL server."""
        with self._share_tunnel_lock:
            tunnel = self._share_tunnel
        if tunnel is not None:
            tunnel.close()
        else:
            import rich

            rich.print(
                "[bold](viser)[/bold] Tried to disconnect from share URL, but already disconnected"
            )

    def stop(self) -> None:
        """Stop the Viser server and associated threads and tunnels."""
        self._websock_server.stop()
        if self._share_tunnel is not None:
            self._share_tunnel.close()
        # Let the background event loop finish its connection teardown before
        # shutting the pool: that teardown submits disconnect/camera callbacks
        # to the pool, and websock_server.stop() only join()s the loop thread
        # for 0.1s -- so shutting the pool right after would make those late
        # submits raise "cannot schedule new futures after shutdown" and drop
        # the user's callbacks silently. Bounded so a hung callback can't
        # block stop() forever (in that pathological case the pool still
        # shuts and the straggler is dropped, as before this join).
        loop_thread = self._websock_server._server_thread
        if loop_thread is not None:
            loop_thread.join(timeout=5.0)
        # Release the callback/get_render worker pool: stop() otherwise left
        # its (up to 32) threads alive until the server object was GC'd out of
        # its callback ref-cycles, contradicting "stops associated threads".
        self._thread_executor.shutdown(wait=False)

    async def _dispatch_client_callbacks(
        self,
        callbacks: tuple[Callable[[ClientHandle], None | Coroutine], ...],
        client: ClientHandle,
    ) -> None:
        """Run connect/disconnect callbacks for one client: async callbacks
        awaited in order, sync callbacks on the thread pool, every callback
        exception-isolated so one failure cannot starve its siblings."""
        for cb in callbacks:
            if asyncio.iscoroutinefunction(cb):
                try:
                    await cb(client)
                except Exception as exc:
                    print_awaited_callback_error(exc)
            else:
                self._thread_executor.submit(cb, client).add_done_callback(
                    print_threadpool_errors
                )

    def get_clients(self) -> dict[int, ClientHandle]:
        """Creates and returns a copy of the mapping from connected client IDs to
        handles.

        Returns:
            Dictionary of clients.
        """
        with self._client_lock:
            return self._connected_clients.copy()

    def on_client_connect(
        self, cb: Callable[[ClientHandle], NoneOrCoroutine]
    ) -> Callable[[ClientHandle], NoneOrCoroutine]:
        """Attach a callback to run for newly connected clients.

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        with self._client_lock:
            clients = self._connected_clients.copy().values()
            self._client_connect_cb.append(cb)

        # Trigger callback on any already-connected clients.
        # If we have:
        #
        #     server = viser.ViserServer()
        #     server.on_client_connect(...)
        #
        # This makes sure that the the callback is applied to any clients that
        # connect between the two lines.
        for client in clients:
            if asyncio.iscoroutinefunction(cb):
                task = self._event_loop.create_task(cb(client))
                task.add_done_callback(print_task_error)
            else:
                self._thread_executor.submit(cb, client).add_done_callback(
                    print_threadpool_errors
                )

        return cb  # type: ignore

    def on_client_disconnect(
        self, cb: Callable[[ClientHandle], NoneOrCoroutine]
    ) -> Callable[[ClientHandle], NoneOrCoroutine]:
        """Attach a callback to run when clients disconnect.

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._client_disconnect_cb.append(cb)
        return cb

    def flush(self) -> None:
        """Flush the outgoing message buffer. Any buffered messages will immediately be
        sent. (by default they are windowed)"""
        self._websock_server.flush()

    def atomic(self) -> ContextManager[None]:
        """Returns a context where: all outgoing messages are grouped and applied by
        clients atomically.

        This should be treated as a soft constraint that's helpful for things
        like animations, or when we want position and orientation updates to
        happen synchronously.

        Returns:
            Context manager.
        """
        return self._websock_server.atomic()

    def send_file_download(
        self,
        filename: str,
        content: bytes,
        chunk_size: int = 1024 * 1024,
        save_immediately: bool = False,
    ) -> None:
        """Send a file for a client or clients to download.

        Args:
            filename: Name of the file to send. Used to infer MIME type.
            content: Content of the file.
            chunk_size: Number of bytes to send at a time.
            save_immediately: Whether to save the file immediately. If `False`,
                a link to the file will be shown as a notification. Being able to
                right click the link and choose "Save as..." can be useful.
        """
        for client in self.get_clients().values():
            client.send_file_download(filename, content, chunk_size, save_immediately)

    def get_event_loop(self) -> asyncio.AbstractEventLoop:
        """Get the asyncio event loop used by the Viser background thread. This
        can be useful for safe concurrent operations."""
        return self._event_loop

    def sleep_forever(self) -> None:
        """Equivalent to:

        while True:
            time.sleep(3600)
        """
        while True:
            time.sleep(3600)

    def _start_scene_recording(self) -> Any:
        """**Old API.**"""
        warnings.warn(
            "_start_scene_recording() has been renamed. See notes in https://github.com/viser-project/viser/pull/357 for the new API.",
            stacklevel=2,
        )

        serializer = self.get_scene_serializer()

        # We'll add a shim for the old API for now. We can remove this later.
        class _SceneRecordCompatibilityShim:
            def set_loop_start(self):
                warnings.warn(
                    "_start_scene_recording() has been renamed. See notes in https://github.com/viser-project/viser/pull/357 for the new API.",
                    stacklevel=2,
                )

            def insert_sleep(self, duration: float):
                warnings.warn(
                    "_start_scene_recording() has been renamed. See notes in https://github.com/viser-project/viser/pull/357 for the new API.",
                    stacklevel=2,
                )
                serializer.insert_sleep(duration)

            def end_and_serialize(self) -> bytes:
                warnings.warn(
                    "_start_scene_recording() has been renamed. See notes in https://github.com/viser-project/viser/pull/357 for the new API.",
                    stacklevel=2,
                )
                return serializer.serialize()

        return _SceneRecordCompatibilityShim()

    def get_scene_serializer(self) -> StateSerializer:
        """Get handle for serializing the scene state.

        This can be used for saving .viser files, which are used for offline
        visualization.
        """
        # Register + snapshot atomically (under _record_lock, which
        # queue_message also holds for its feed+push): otherwise a message
        # queued from another thread between the two lands in BOTH the live
        # recording and the snapshot, duplicating it in the .viser file.
        buffer = self._websock_server._broadcast_buffer
        with self._websock_server._record_lock:
            serializer = self._websock_server.get_message_serializer(
                filter=lambda message: message.include_in_scene_serialization
            )
            # Insert current scene state.
            with buffer.buffer_lock:
                messages = list(buffer.message_from_id.values())
            for message in messages:
                serializer._insert_message(message)
        return serializer
