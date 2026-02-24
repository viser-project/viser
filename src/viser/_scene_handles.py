from __future__ import annotations

import copy
import dataclasses
import warnings
from collections.abc import Coroutine
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Generic,
    Literal,
    Protocol,
    TypeVar,
    Union,
    cast,
)

import numpy as np
import numpy.typing as npt
from typing_extensions import Self, deprecated, override

from . import _messages
from ._assignable_props_api import AssignablePropsBase
from .infra._infra import WebsockClientConnection, WebsockServer

if TYPE_CHECKING:
    from ._gui_api import GuiApi
    from ._scene_api import SceneApi
    from ._viser import ClientHandle
    from .infra import ClientId


@dataclasses.dataclass(frozen=True)
class ScenePointerEvent:
    """Event passed to pointer callbacks for the scene (currently only clicks)."""

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    event_type: _messages.ScenePointerEventType
    """Type of event that was triggered. Currently we only support clicks and box selections."""
    ray_origin: tuple[float, float, float] | None
    """Origin of 3D ray corresponding to this click, in world coordinates."""
    ray_direction: tuple[float, float, float] | None
    """Direction of 3D ray corresponding to this click, in world coordinates."""
    screen_pos: tuple[tuple[float, float], ...]
    """Screen position of the click on the screen (OpenCV image coordinates, 0 to 1).
    (0, 0) is the upper-left corner, (1, 1) is the bottom-right corner.
    For a box selection, this includes the min- and max- corners of the box."""

    @property
    @deprecated("The `event` property is deprecated. Use `event_type` instead.")
    def event(self):
        """Deprecated. Use `event_type` instead.

        .. deprecated:: 0.2.23
            The `event` property is deprecated. Use `event_type` instead.
        """
        return self.event_type


TSceneNodeHandle = TypeVar("TSceneNodeHandle", bound="SceneNodeHandle")


@dataclasses.dataclass
class _SceneNodeHandleState:
    name: str
    props: Any  # _messages.*Prop object.
    """Message containing properties of this scene node that are sent to the
    client."""
    api: SceneApi
    wxyz: np.ndarray = dataclasses.field(
        default_factory=lambda: np.array([1.0, 0.0, 0.0, 0.0])
    )
    position: np.ndarray = dataclasses.field(
        default_factory=lambda: np.array([0.0, 0.0, 0.0])
    )
    visible: bool = True
    click_cb: list[
        Callable[[SceneNodePointerEvent[_ClickableSceneNodeHandle]], None | Coroutine]
    ] = dataclasses.field(default_factory=list)
    removed: bool = False


class _SceneNodeMessage(Protocol):
    name: str
    props: Any


class SceneNodeHandle(AssignablePropsBase[_SceneNodeHandleState]):
    """Handle base class for interacting with scene nodes."""

    @override
    def _queue_update(self, name: str, value: Any) -> None:
        self._impl.api._websock_interface.queue_message(
            _messages.SceneNodeUpdateMessage(self._impl.name, {name: value})
        )

    @property
    def name(self) -> str:
        """Read-only name of the scene node."""
        return self._impl.name

    @classmethod
    def _make(
        cls: type[TSceneNodeHandle],
        api: SceneApi,
        message: _SceneNodeMessage,
        name: str,
        wxyz: tuple[float, float, float, float] | np.ndarray,
        position: tuple[float, float, float] | np.ndarray,
        visible: bool,
    ) -> TSceneNodeHandle:
        """Create scene node: send state to client(s) and set up
        server-side state."""
        # Send message.
        assert isinstance(message, _messages.Message)
        api._websock_interface.queue_message(message)

        out = cls(_SceneNodeHandleState(name, copy.deepcopy(message.props), api))
        api._handle_from_node_name[name] = out

        out.wxyz = wxyz
        out.position = position

        # Toggle visibility to make sure we send a
        # SetSceneNodeVisibilityMessage to the client.
        out._impl.visible = not visible
        out.visible = visible
        return out

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Orientation of the scene node. This is the quaternion representation of the R
        in `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.wxyz

    @wxyz.setter
    def wxyz(self, wxyz: tuple[float, float, float, float] | np.ndarray) -> None:
        from ._scene_api import cast_vector

        wxyz_cast = cast_vector(wxyz, 4)
        wxyz_array = np.asarray(wxyz)
        if np.allclose(wxyz_cast, self._impl.wxyz):
            return
        self._impl.wxyz[:] = wxyz_array
        self._impl.api._websock_interface.queue_message(
            _messages.SetOrientationMessage(self._impl.name, wxyz_cast)
        )

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Position of the scene node. This is equivalent to the t in
        `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.position

    @position.setter
    def position(self, position: tuple[float, float, float] | np.ndarray) -> None:
        from ._scene_api import cast_vector

        position_cast = cast_vector(position, 3)
        position_array = np.asarray(position)
        if np.allclose(position_array, self._impl.position):
            return
        self._impl.position[:] = position_array
        self._impl.api._websock_interface.queue_message(
            _messages.SetPositionMessage(self._impl.name, position_cast)
        )

    @property
    def visible(self) -> bool:
        """Whether the scene node is visible or not. Synchronized to clients automatically when assigned."""
        return self._impl.visible

    @visible.setter
    def visible(self, visible: bool) -> None:
        if visible == self._impl.visible:
            return
        self._impl.api._websock_interface.queue_message(
            _messages.SetSceneNodeVisibilityMessage(self._impl.name, visible)
        )
        self._impl.visible = visible

    def remove(self) -> None:
        """Remove the node from the scene."""
        # Warn if already removed.
        if self._impl.removed:
            warnings.warn(f"Attempted to remove already removed node: {self.name}")
            return

        self._impl.removed = True
        self._impl.api._handle_from_node_name.pop(self._impl.name)
        self._impl.api._websock_interface.queue_message(
            _messages.RemoveSceneNodeMessage(self._impl.name)
        )


@dataclasses.dataclass(frozen=True)
class SceneNodePointerEvent(Generic[TSceneNodeHandle]):
    """Event passed to pointer callbacks for scene nodes (currently only clicks)."""

    client: ClientHandle
    """Client that triggered this event."""
    client_id: int
    """ID of client that triggered this event."""
    event: Literal["click"]
    """Type of event that was triggered. Currently we only support clicks."""
    target: TSceneNodeHandle
    """Scene node that was clicked."""
    ray_origin: tuple[float, float, float]
    """Origin of 3D ray corresponding to this click, in world coordinates."""
    ray_direction: tuple[float, float, float]
    """Direction of 3D ray corresponding to this click, in world coordinates."""
    screen_pos: tuple[float, float]
    """Screen position of the click on the screen (OpenCV image coordinates, 0 to 1).
    (0, 0) is the upper-left corner, (1, 1) is the bottom-right corner."""
    instance_index: int | None
    """Instance ID of the clicked object, if applicable. Currently this is `None` for all objects except for the output of :meth:`SceneApi.add_batched_axes()`."""


@dataclasses.dataclass(frozen=True)
class TransformControlsEvent:
    """Event passed to callbacks for transform control updates."""

    client: ClientHandle | None
    """Client that triggered this event."""
    client_id: int | None
    """ID of client that triggered this event."""
    target: TransformControlsHandle
    """Transform controls handle that was affected."""


NoneOrCoroutine = TypeVar("NoneOrCoroutine", None, Coroutine)


class _ClickableSceneNodeHandle(SceneNodeHandle):
    def on_click(
        self: Self,
        func: Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine],
    ) -> Callable[[SceneNodePointerEvent[Self]], NoneOrCoroutine]:
        """Attach a callback for when a scene node is clicked.

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl.api._websock_interface.queue_message(
            _messages.SetSceneNodeClickableMessage(self._impl.name, True)
        )
        if self._impl.click_cb is None:
            self._impl.click_cb = []
        self._impl.click_cb.append(
            cast(
                Callable[
                    [SceneNodePointerEvent[_ClickableSceneNodeHandle]],
                    # `Union[X, Y]` instead of `X | Y` for Python 3.8 support.
                    Union[None, Coroutine],
                ],
                func,
            )
        )
        return func

    def remove_click_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove click callbacks from scene node.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._impl.click_cb.clear()
        else:
            self._impl.click_cb = [cb for cb in self._impl.click_cb if cb != callback]
        if len(self._impl.click_cb) == 0:
            self._impl.api._websock_interface.queue_message(
                _messages.SetSceneNodeClickableMessage(self._impl.name, False)
            )

    def remove(self) -> None:
        """Remove the node from the scene."""
        if len(self._impl.click_cb) > 0:
            # SetSceneNodeClickableMessage can still remain in the message
            # buffer, even if a scene node is removed. This could cause a new
            # scene node to be mistakenly considered clickable if it is made
            # with the same name. We ideally would fix this with better state
            # management... in the meantime we can just set the flag to False.
            self._impl.api._websock_interface.queue_message(
                _messages.SetSceneNodeClickableMessage(self._impl.name, False)
            )
        super().remove()


class CameraFrustumHandle(
    _ClickableSceneNodeHandle,
    _messages.CameraFrustumProps,
):
    """Handle for camera frustums."""

    _image: np.ndarray | None
    _jpeg_quality: int | None
    _user_format: Literal["auto", "jpeg", "png"]

    @property
    def image(self) -> np.ndarray | None:
        """Current content of the image. Synchronized automatically when assigned."""
        return self._image

    @image.setter
    def image(self, image: np.ndarray | None) -> None:
        from ._scene_api import _encode_image_binary

        if image is None:
            self._image_data = None
            return

        self._image = image
        resolved_format, data = _encode_image_binary(
            image, self._user_format, jpeg_quality=self._jpeg_quality
        )
        self._format = resolved_format
        self._image_data = data

    @property
    def format(self) -> Literal["auto", "jpeg", "png"]:
        """Image format. 'auto' will use PNG for RGBA images and JPEG for RGB."""
        return self._user_format

    @format.setter
    def format(self, value: Literal["auto", "jpeg", "png"]) -> None:
        import warnings

        from ._scene_api import _encode_image_binary

        # Skip if format isn't changing.
        if self._user_format == value:
            return

        self._user_format = value

        # Re-encode image. if we have one.
        if self._image is not None:
            if value == "jpeg" and self._image.shape[2] == 4:
                warnings.warn(
                    "Converting RGBA image to JPEG will discard the alpha channel."
                )
            resolved_format, data = _encode_image_binary(
                self._image, value, jpeg_quality=self._jpeg_quality
            )
            self._format = resolved_format
            self._image_data = data

    def compute_canonical_frustum_size(self) -> tuple[float, float, float]:
        """Compute the X, Y, and Z dimensions of the frustum if it had
        `.scale=1.0`. These dimensions will change whenever `.fov` or `.aspect`
        are changed.

        To set the distance between a frustum's origin and image plane to 1, we
        can run:

        .. code-block:: python

            frustum.scale = 1.0 / frustum.compute_canonical_frustum_size()[2]


        `.scale` can be a float for uniform scaling or a 3-tuple for per-axis
        scaling of the X, Y, and Z dimensions. It aims to preserve the visual
        volume of the frustum regardless of the aspect ratio or FOV. This
        method allows more precise computation and control of the frustum's
        dimensions.
        """
        # Math used in the client implementation.
        y = np.tan(self.fov / 2.0)
        x = y * self.aspect
        z = 1.0
        volume_scale = np.cbrt((x * y * z) / 3.0)

        z /= volume_scale

        # x and y need to be doubled, since on the client they correspond to
        # NDC-style spans [-1, 1].
        return x * 2.0, y * 2.0, z


class DirectionalLightHandle(
    SceneNodeHandle,
    _messages.DirectionalLightProps,
):
    """Handle for directional lights."""


class AmbientLightHandle(
    SceneNodeHandle,
    _messages.AmbientLightProps,
):
    """Handle for ambient lights."""


class HemisphereLightHandle(
    SceneNodeHandle,
    _messages.HemisphereLightProps,
):
    """Handle for hemisphere lights."""


class PointLightHandle(
    SceneNodeHandle,
    _messages.PointLightProps,
):
    """Handle for point lights."""


class RectAreaLightHandle(
    SceneNodeHandle,
    _messages.RectAreaLightProps,
):
    """Handle for rectangular area lights."""


class SpotLightHandle(
    SceneNodeHandle,
    _messages.SpotLightProps,
):
    """Handle for spot lights."""


class PointCloudHandle(
    SceneNodeHandle,
    _messages.PointCloudProps,
):
    """Handle for point clouds. Does not support click events."""

    @override
    def _cast_array_dtypes(
        self,
        prop_hints: Dict[str, Any],
        prop_name: str,
        value: np.ndarray,
    ) -> np.ndarray:
        """Casts assigned `points` based on the current value of `precision`."""
        if prop_name == "points":
            return value.astype(
                {"float16": np.float16, "float32": np.float32}[self.precision]
            )
        return super()._cast_array_dtypes(prop_hints, prop_name, value)


class BatchedAxesHandle(
    _ClickableSceneNodeHandle,
    _messages.BatchedAxesProps,
):
    """Handle for batched coordinate frames."""


class FrameHandle(
    _ClickableSceneNodeHandle,
    _messages.FrameProps,
):
    """Handle for coordinate frames."""


class MeshHandle(
    _ClickableSceneNodeHandle,
    _messages.MeshProps,
):
    """Handle for mesh objects."""


class BoxHandle(
    _ClickableSceneNodeHandle,
    _messages.BoxProps,
):
    """Handle for box objects."""


class IcosphereHandle(
    _ClickableSceneNodeHandle,
    _messages.IcosphereProps,
):
    """Handle for icosphere objects."""


class CylinderHandle(
    _ClickableSceneNodeHandle,
    _messages.CylinderProps,
):
    """Handle for cylinder objects."""


class BatchedMeshHandle(
    _ClickableSceneNodeHandle,
    _messages.BatchedMeshesProps,
):
    """Handle for batched mesh objects."""


class BatchedGlbHandle(
    _ClickableSceneNodeHandle,
    _messages.BatchedGlbProps,
):
    """Handle for batched GLB objects."""


class GaussianSplatHandle(
    _ClickableSceneNodeHandle,
    _messages.GaussianSplatsProps,
):
    """Handle for Gaussian splatting objects.

    **Work-in-progress.** Gaussian rendering is still under development.

    Buffer layout per Gaussian (8 uint32 elements = 32 bytes):
        - [0:3]: centers (3x float32)
        - [3]: reserved for renderer
        - [4:7]: covariance upper-triangular (6x float16)
        - [7]: RGBA (4x uint8)
    """

    def _ensure_buffer_size(self, num_gaussians: int) -> None:
        """Ensure the internal buffer can hold the specified number of Gaussians.

        If the buffer is already the correct size, this is a no-op. Otherwise,
        a new buffer is allocated with default values (white color, full opacity,
        small identity-like covariances, centers at origin).
        """
        if self.buffer.shape[0] == num_gaussians:
            return

        # Create new buffer with default values.
        new_buffer = np.zeros((num_gaussians, 8), dtype=np.uint32)

        # Set default RGBA to white, fully opaque (255, 255, 255, 255).
        new_buffer[:, 7] = 0xFFFFFFFF

        # Set default covariances to small identity-like values.
        # Store as 6 float16 values: [cov00, cov01, cov02, cov11, cov12, cov22].
        default_cov = np.array([0.01, 0.0, 0.0, 0.01, 0.0, 0.01], dtype=np.float16)
        new_buffer[:, 4:7] = np.tile(default_cov.view(np.uint32), (num_gaussians, 1))

        self.buffer = new_buffer

    @property
    def centers(self) -> npt.NDArray[np.float32]:
        """Centers of the Gaussians. Shape: (N, 3). Synchronized automatically when assigned."""
        return self.buffer[:, 0:3].view(np.float32)

    @centers.setter
    def centers(self, centers: np.ndarray) -> None:
        assert centers.ndim == 2 and centers.shape[1] == 3, (
            f"centers must have shape (N, 3), got {centers.shape}"
        )
        self._ensure_buffer_size(centers.shape[0])
        self.buffer[:, 0:3] = centers.astype(np.float32).view(np.uint32)
        self._queue_update("buffer", self.buffer)

    @property
    def rgbs(self) -> npt.NDArray[np.uint8]:
        """Colors of the Gaussians. Shape: (N, 3). Values in [0, 1]. Synchronized automatically when assigned."""
        rgba = self.buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        return rgba[:, :3]

    @rgbs.setter
    def rgbs(self, rgbs: np.ndarray) -> None:
        from ._assignable_props_api import colors_to_uint8

        assert rgbs.ndim == 2 and rgbs.shape[1] == 3, (
            f"rgbs must have shape (N, 3), got {rgbs.shape}"
        )
        self._ensure_buffer_size(rgbs.shape[0])
        rgba = self.buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        rgba[:, :3] = colors_to_uint8(rgbs)
        self.buffer[:, 7:8] = rgba.view(np.uint32)
        self._queue_update("buffer", self.buffer)

    @property
    def opacities(self) -> npt.NDArray[np.uint8]:
        """Opacities of the Gaussians. Shape: (N, 1). Values in [0, 1]. Synchronized automatically when assigned."""
        buffer = self.buffer
        rgba = buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        return rgba[:, 3:4]

    @opacities.setter
    def opacities(self, opacities: np.ndarray) -> None:
        from ._assignable_props_api import colors_to_uint8

        assert opacities.ndim == 2 and opacities.shape[1] == 1, (
            f"opacities must have shape (N, 1), got {opacities.shape}"
        )
        self._ensure_buffer_size(opacities.shape[0])
        rgba = self.buffer[:, 7:8].view(np.uint8).reshape(-1, 4)
        rgba[:, 3:4] = colors_to_uint8(opacities)
        self.buffer[:, 7:8] = rgba.view(np.uint32)
        self._queue_update("buffer", self.buffer)

    @property
    def covariances(self) -> npt.NDArray[np.float32]:
        """Covariances of the Gaussians. Shape: (N, 3, 3). Synchronized automatically when assigned."""
        # Extract upper-triangular terms stored as 6 float16 values.
        cov_triu_f16 = self.buffer[:, 4:7].view(np.float16).reshape(-1, 6)
        cov_triu = cov_triu_f16.astype(np.float32)
        # Reconstruct symmetric 3x3 matrix.
        n = cov_triu.shape[0]
        cov = np.zeros((n, 3, 3), dtype=np.float32)
        cov[:, 0, 0] = cov_triu[:, 0]
        cov[:, 0, 1] = cov_triu[:, 1]
        cov[:, 0, 2] = cov_triu[:, 2]
        cov[:, 1, 0] = cov_triu[:, 1]  # Symmetric.
        cov[:, 1, 1] = cov_triu[:, 3]
        cov[:, 1, 2] = cov_triu[:, 4]
        cov[:, 2, 0] = cov_triu[:, 2]  # Symmetric.
        cov[:, 2, 1] = cov_triu[:, 4]  # Symmetric.
        cov[:, 2, 2] = cov_triu[:, 5]
        return cov

    @covariances.setter
    def covariances(self, covariances: np.ndarray) -> None:
        assert covariances.ndim == 3 and covariances.shape[1:] == (3, 3), (
            f"covariances must have shape (N, 3, 3), got {covariances.shape}"
        )
        self._ensure_buffer_size(covariances.shape[0])
        # Extract upper-triangular terms: indices [0,1,2,4,5,8] from flattened 3x3.
        cov_triu = covariances.reshape((-1, 9))[:, np.array([0, 1, 2, 4, 5, 8])]
        cov_triu_f16 = cov_triu.astype(np.float16)
        self.buffer[:, 4:7] = np.ascontiguousarray(cov_triu_f16).view(np.uint32)
        self._queue_update("buffer", self.buffer)


class MeshSkinnedHandle(
    _ClickableSceneNodeHandle,
    _messages.SkinnedMeshProps,
):
    """Handle for skinned mesh objects."""

    def __init__(
        self, impl: _SceneNodeHandleState, bones: tuple[MeshSkinnedBoneHandle, ...]
    ):
        super().__init__(impl)
        self.bones = bones


@dataclasses.dataclass
class BoneState:
    name: str
    websock_interface: WebsockServer | WebsockClientConnection
    bone_index: int
    wxyz: np.ndarray
    position: np.ndarray


@dataclasses.dataclass
class MeshSkinnedBoneHandle:
    """Handle for reading and writing the poses of bones in a skinned mesh."""

    _impl: BoneState

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Orientation of the bone. This is the quaternion representation of the R
        in `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.wxyz

    @wxyz.setter
    def wxyz(self, wxyz: tuple[float, float, float, float] | np.ndarray) -> None:
        from ._scene_api import cast_vector

        wxyz_cast = cast_vector(wxyz, 4)
        wxyz_array = np.asarray(wxyz)
        if np.allclose(wxyz_cast, self._impl.wxyz):
            return
        self._impl.wxyz[:] = wxyz_array
        self._impl.websock_interface.queue_message(
            _messages.SetBoneOrientationMessage(
                self._impl.name, self._impl.bone_index, wxyz_cast
            )
        )

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Position of the bone. This is equivalent to the t in
        `p_parent = [R | t] p_local`. Synchronized to clients automatically when assigned.
        """
        return self._impl.position

    @position.setter
    def position(self, position: tuple[float, float, float] | np.ndarray) -> None:
        from ._scene_api import cast_vector

        position_cast = cast_vector(position, 3)
        position_array = np.asarray(position)
        if np.allclose(position_array, self._impl.position):
            return
        self._impl.position[:] = position_array
        self._impl.websock_interface.queue_message(
            _messages.SetBonePositionMessage(
                self._impl.name, self._impl.bone_index, position_cast
            )
        )


class GridHandle(
    SceneNodeHandle,
    _messages.GridProps,
):
    """Handle for grid objects."""


class LineSegmentsHandle(
    SceneNodeHandle,
    _messages.LineSegmentsProps,
):
    """Handle for line segments objects."""


class SplineCatmullRomHandle(
    SceneNodeHandle,
    _messages.CatmullRomSplineProps,
):
    """Handle for Catmull-Rom splines."""

    @property
    @deprecated("The 'positions' property is deprecated. Use 'points' instead.")
    def positions(self) -> tuple[tuple[float, float, float], ...]:
        """Get the spline positions. Deprecated: use 'points' instead.

        .. deprecated:: 1.0.0
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
        """
        import warnings

        warnings.warn(
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return tuple(tuple(x) for x in self.points.tolist())  # type: ignore

    @positions.setter
    @deprecated("The 'positions' property is deprecated. Use 'points' instead.")
    def positions(self, positions: tuple[tuple[float, float, float], ...]) -> None:
        import warnings

        warnings.warn(
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        self.points = np.asarray(positions)


class SplineCubicBezierHandle(
    SceneNodeHandle,
    _messages.CubicBezierSplineProps,
):
    """Handle for cubic Bezier splines."""

    @property
    @deprecated(
        "The 'positions' tuple property is deprecated. Use 'points' numpy array instead."
    )
    def positions(self) -> tuple[tuple[float, float, float], ...]:
        """Get the spline positions. Deprecated: use 'points' instead.

        .. deprecated:: 1.0.0
            The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.
        """
        return tuple(tuple(p) for p in self.points.tolist())  # type: ignore

    @positions.setter
    @deprecated(
        "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead."
    )
    def positions(self, positions: tuple[tuple[float, float, float], ...]) -> None:
        import warnings

        warnings.warn(
            "The 'positions' tuple property is deprecated. Use the 'points' numpy array instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        self.points = np.asarray(positions)


class GlbHandle(
    _ClickableSceneNodeHandle,
    _messages.GlbProps,
):
    """Handle for GLB objects."""


class ImageHandle(
    _ClickableSceneNodeHandle,
    _messages.ImageProps,
):
    """Handle for 2D images, rendered in 3D."""

    _image: np.ndarray
    _jpeg_quality: int | None
    _user_format: Literal["auto", "jpeg", "png"]

    @property
    def image(self) -> np.ndarray:
        """Current content of the image. Synchronized automatically when assigned."""
        assert self._image is not None
        return self._image

    @image.setter
    def image(self, image: np.ndarray) -> None:
        from ._scene_api import _encode_image_binary

        self._image = image
        resolved_format, data = _encode_image_binary(
            image, self._user_format, jpeg_quality=self._jpeg_quality
        )
        self._format = resolved_format
        self._data = data

    @property
    def format(self) -> Literal["auto", "jpeg", "png"]:
        """Image format. 'auto' will use PNG for RGBA images and JPEG for RGB."""
        return self._user_format

    @format.setter
    def format(self, value: Literal["auto", "jpeg", "png"]) -> None:
        import warnings

        from ._scene_api import _encode_image_binary

        # Skip if format isn't changing.
        if self._user_format == value:
            return

        self._user_format = value

        # Re-encode image.
        if value == "jpeg" and self._image.shape[2] == 4:
            warnings.warn(
                "Converting RGBA image to JPEG will discard the alpha channel."
            )
        resolved_format, data = _encode_image_binary(
            self._image, value, jpeg_quality=self._jpeg_quality
        )
        self._format = resolved_format
        self._data = data


class LabelHandle(
    SceneNodeHandle,
    _messages.LabelProps,
):
    """Handle for 2D label objects. Does not support click events."""


@dataclasses.dataclass
class _TransformControlsState:
    last_updated: float
    update_cb: list[Callable[[TransformControlsEvent], None | Coroutine]]
    drag_start_cb: list[Callable[[TransformControlsEvent], None | Coroutine]] = (
        dataclasses.field(default_factory=list)
    )
    drag_end_cb: list[Callable[[TransformControlsEvent], None | Coroutine]] = (
        dataclasses.field(default_factory=list)
    )
    sync_cb: None | Callable[[ClientId, TransformControlsHandle], None] = None


class TransformControlsHandle(
    SceneNodeHandle,
    _messages.TransformControlsProps,
):
    """Handle for interacting with transform control gizmos."""

    def __init__(self, impl: _SceneNodeHandleState, impl_aux: _TransformControlsState):
        super().__init__(impl)
        self._impl_aux = impl_aux

    @property
    def update_timestamp(self) -> float:
        return self._impl_aux.last_updated

    def on_update(
        self, func: Callable[[TransformControlsEvent], NoneOrCoroutine]
    ) -> Callable[[TransformControlsEvent], NoneOrCoroutine]:
        """Attach a callback for when the gizmo is moved.

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl_aux.update_cb.append(func)
        return func

    def remove_update_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove update callbacks from the transform controls.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._impl_aux.update_cb.clear()
        else:
            self._impl_aux.update_cb = [
                cb for cb in self._impl_aux.update_cb if cb != callback
            ]

    def on_drag_start(
        self, func: Callable[[TransformControlsEvent], NoneOrCoroutine]
    ) -> Callable[[TransformControlsEvent], NoneOrCoroutine]:
        """Attach a callback for when dragging starts ("mouse down").

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl_aux.drag_start_cb.append(func)
        return func

    def on_drag_end(
        self, func: Callable[[TransformControlsEvent], NoneOrCoroutine]
    ) -> Callable[[TransformControlsEvent], NoneOrCoroutine]:
        """Attach a callback for when dragging end ("mouse up").

        The callback can be either a standard function or an async function:
        - Standard functions (def) will be executed in a threadpool.
        - Async functions (async def) will be executed in the event loop.

        Using async functions can be useful for reducing race conditions.
        """
        self._impl_aux.drag_end_cb.append(func)
        return func

    def remove_drag_start_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove drag start callbacks from the transform controls.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._impl_aux.drag_start_cb.clear()
        else:
            self._impl_aux.drag_start_cb = [
                cb for cb in self._impl_aux.drag_start_cb if cb != callback
            ]

    def remove_drag_end_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove drag end callbacks from the transform controls.

        Args:
            callback: Either "all" to remove all callbacks, or a specific callback function to remove.
        """
        if callback == "all":
            self._impl_aux.drag_end_cb.clear()
        else:
            self._impl_aux.drag_end_cb = [
                cb for cb in self._impl_aux.drag_end_cb if cb != callback
            ]

    def remove(self) -> None:
        """Remove the node from the scene."""
        self._impl.api._handle_from_transform_controls_name.pop(self.name)
        super().remove()


class Gui3dContainerHandle(
    SceneNodeHandle,
    _messages.Gui3DProps,
):
    """Use as a context to place GUI elements into a 3D GUI container."""

    def __init__(self, impl: _SceneNodeHandleState, gui_api: GuiApi, container_id: str):
        super().__init__(impl)
        self._gui_api = gui_api
        self._container_id = container_id
        self._container_id_restore = None
        self._children = {}
        self._gui_api._container_handle_from_uuid[self._container_id] = self

    def __enter__(self) -> Gui3dContainerHandle:
        self._container_id_restore = self._gui_api._get_container_uuid()
        self._gui_api._set_container_uuid(self._container_id)
        return self

    def __exit__(self, *args) -> None:
        del args
        assert self._container_id_restore is not None
        self._gui_api._set_container_uuid(self._container_id_restore)
        self._container_id_restore = None

    def remove(self) -> None:
        """Permanently remove this GUI container from the visualizer."""

        # Call scene node remove.
        super().remove()

        # Clean up contained GUI elements.
        for child in tuple(self._children.values()):
            child.remove()
        self._gui_api._container_handle_from_uuid.pop(self._container_id)
