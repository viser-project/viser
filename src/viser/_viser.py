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

import imageio.v3 as iio
import numpy as np
import numpy.typing as npt
from typing_extensions import Literal, deprecated

from . import _client_autobuild, _messages, infra
from . import transforms as tf
from ._backwards_compat_shims import DeprecatedAttributeShim
from ._gui_api import GuiApi, LiteralColor, _make_uuid
from ._notification_handle import NotificationHandle, _NotificationHandleState
from ._scene_api import SceneApi, cast_vector
from ._threadpool_exceptions import print_threadpool_errors
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
        z = self._state.look_at - self._state.position
        z /= np.linalg.norm(z)
        y = tf.SO3.exp(z * np.pi) @ self._state.up_direction
        y = y - np.dot(z, y) * z
        y /= np.linalg.norm(y)
        x = np.cross(y, z)
        self._state.wxyz = tf.SO3.from_matrix(np.stack([x, y, z], axis=1)).wxyz.astype(
            np.float64
        )

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
        self._state.look_at = look_at_array
        self._state.update_timestamp = time.time()
        self._update_wxyz()
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
        self._state.up_direction = np.asarray(up_direction_array)
        self._update_wxyz()
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
    ) -> np.ndarray:
        """Request a render from a client, block until it's done and received, then
        return it as a numpy array. This is an alias for :meth:`ClientHandle.get_render()`.

        Args:
            height: Height of rendered image. Should be <= the browser height.
            width: Width of rendered image. Should be <= the browser width.
            transport_format: Image transport format. JPEG will return a lossy (H, W, 3) RGB array. PNG will
                return a lossless (H, W, 4) RGBA array, but can cause memory issues on the frontend if called
                too quickly for higher-resolution images.
        """
        return self._state.client.get_render(
            height, width, transport_format=transport_format
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
        handle._sync_with_client("show")
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
    ) -> np.ndarray: ...

    @overload
    def get_render(
        self,
        height: int,
        width: int,
        *,
        transport_format: Literal["png", "jpeg"] = "jpeg",
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
        """

        # Listen for a render reseponse message, which should contain the rendered
        # image.
        render_ready_event = threading.Event()
        out: np.ndarray | None = None

        connection = self._websock_connection

        def got_render_cb(
            client_id: int, message: _messages.GetRenderResponseMessage
        ) -> None:
            del client_id
            connection.unregister_handler(
                _messages.GetRenderResponseMessage, got_render_cb
            )
            nonlocal out
            out = iio.imread(
                io.BytesIO(message.payload),
                extension=f".{transport_format}",
            )
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
            )
        )
        render_ready_event.wait()
        assert out is not None
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
        # Check for port override environment variable
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
            http_server_root=Path(__file__).absolute().parent / "client" / "build",
            verbose=verbose,
            client_api_version=1,
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
                    look_at=np.array(message.look_at),
                    up_direction=np.array(message.up_direction),
                    update_timestamp=time.time(),
                    camera_cb=client.camera._state.camera_cb,
                )

                # We consider a client to be connected after the first camera message is
                # received.
                if first:
                    first = False
                    with self._client_lock:
                        self._connected_clients[conn.client_id] = client
                        for cb in self._client_connect_cb:
                            if asyncio.iscoroutinefunction(cb):
                                await cb(client)
                            else:
                                self._thread_executor.submit(
                                    cb, client
                                ).add_done_callback(print_threadpool_errors)

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
            with self._client_lock:
                if conn.client_id not in self._connected_clients:
                    return

                handle = self._connected_clients.pop(conn.client_id)
                for cb in self._client_disconnect_cb:
                    if asyncio.iscoroutinefunction(cb):
                        await cb(handle)
                    else:
                        self._thread_executor.submit(cb, handle).add_done_callback(
                            print_threadpool_errors
                        )

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

        server.register_handler(
            _messages.ShareUrlDisconnect,
            lambda client_id, msg: self.disconnect_share_url(),
        )

        def request_share_url_no_return() -> None:  # To suppress type error.
            self.request_share_url()

        server.register_handler(
            _messages.ShareUrlRequest,
            lambda client_id, msg: cast(None, request_share_url_no_return()),
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
        """Clean up old messages. This is not elegant; a refactor of our
        message persistence logic will significantly reduce complexity."""
        buffer = self._websock_server._broadcast_buffer
        with buffer.buffer_lock:
            # Skip garbage collection if we have messages that are queeud but
            # not yet processed by the window generators.
            #
            # This makes sure that we don't accidentally cull messages before
            # they're sent to existing clients. RemoveSceneNodeMessage, for example,
            # needs to be sent to old clients but not new ones.
            if (
                not force
                and self._websock_server._broadcast_buffer.message_event.is_set()
            ):
                return

            remove_message_ids: list[int] = []

            remove_scene_names: set[str] = set()
            remove_gui_uuids: set[str] = set()

            for id, message in reversed(buffer.message_from_id.items()):
                # Find scene nodes or GUI elements that were removed.
                if isinstance(message, _messages.RemoveSceneNodeMessage):
                    remove_message_ids.append(id)
                    remove_scene_names.add(message.name)
                elif isinstance(message, _messages.GuiRemoveMessage):
                    remove_message_ids.append(id)
                    remove_gui_uuids.add(message.uuid)
                elif isinstance(message, _messages.GuiCloseModalMessage):
                    remove_message_ids.append(id)

                # For removed elements, no need to send any update messages.
                if (
                    isinstance(
                        message,
                        (
                            _messages.SetPositionMessage,
                            _messages.SetOrientationMessage,
                            _messages.SetBonePositionMessage,
                            _messages.SetBoneOrientationMessage,
                            _messages.SetSceneNodeClickableMessage,
                            _messages.SetSceneNodeVisibilityMessage,
                        ),
                    )
                    and message.name in remove_scene_names
                ):
                    remove_message_ids.append(id)

                if (
                    isinstance(message, _messages.GuiUpdateMessage)
                    and message.uuid in remove_gui_uuids
                ):
                    remove_message_ids.append(id)

            # Remove old messages.
            for id in remove_message_ids:
                message = buffer.message_from_id.pop(id)
                buffer.id_from_redundancy_key.pop(message.redundancy_key())

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

        Returns:
            Share URL as string, or None if connection fails or is closed.
        """
        if self._share_tunnel is not None:
            # Tunnel already exists.
            while self._share_tunnel.get_status() in ("ready", "connecting"):
                time.sleep(0.05)
            return self._share_tunnel.get_url()
        else:
            # Create a new tunnel!.
            if verbose:
                import rich

                rich.print("[bold](viser)[/bold] Share URL requested!")

            connect_event = threading.Event()

            self._share_tunnel = ViserTunnel(
                "share.viser.studio", self._websock_server._port
            )

            @self._share_tunnel.on_disconnect
            def _() -> None:
                import rich

                rich.print("[bold](viser)[/bold] Disconnected from share URL")
                self._share_tunnel = None
                self._websock_server.queue_message(_messages.ShareUrlUpdated(None))

            @self._share_tunnel.on_connect
            def _(max_clients: int) -> None:
                assert self._share_tunnel is not None
                share_url = self._share_tunnel.get_url()
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

            connect_event.wait()

            url = self._share_tunnel.get_url()
            return url

    def disconnect_share_url(self) -> None:
        """Disconnect from the share URL server."""
        if self._share_tunnel is not None:
            self._share_tunnel.close()
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
                self._event_loop.create_task(cb(client))
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
        serializer = self._websock_server.get_message_serializer(
            # Don't record GUI messages. This feels brittle.
            filter=lambda message: "Gui" not in type(message).__name__
        )
        # Insert current scene state.
        for message in self._websock_server._broadcast_buffer.message_from_id.values():
            serializer._insert_message(message)
        return serializer
