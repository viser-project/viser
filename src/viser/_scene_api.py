from __future__ import annotations

import asyncio
import dataclasses
import io
import threading
import time
import warnings
from collections.abc import Coroutine
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Optional,
    Tuple,
    TypeVar,
    Union,
    cast,
    overload,
)

import numpy as np
from typing_extensions import Literal, ParamSpec, TypeAlias, deprecated

from viser._backwards_compat_shims import deprecated_positional_shim

from . import _messages
from . import transforms as tf
from ._assignable_props_api import colors_to_uint8
from ._image_encoding import cv2_imencode_with_fallback
from ._scene_handles import (
    AmbientLightHandle,
    ArrowsHandle,
    BatchedAxesHandle,
    BatchedGlbHandle,
    BatchedMeshHandle,
    BoneState,
    BoxHandle,
    CameraFrustumHandle,
    CylinderHandle,
    DirectionalLightHandle,
    DragPhase,
    FrameHandle,
    GaussianSplatHandle,
    GlbHandle,
    GridHandle,
    Gui3dContainerHandle,
    HemisphereLightHandle,
    IcosphereHandle,
    ImageHandle,
    LabelHandle,
    LineSegmentsHandle,
    MeshHandle,
    MeshSkinnedBoneHandle,
    MeshSkinnedHandle,
    PointCloudHandle,
    PointLightHandle,
    RectAreaLightHandle,
    SceneClickEvent,
    SceneNodeDragEvent,
    SceneNodeHandle,
    SceneNodePointerEvent,
    ScenePointerEvent,
    SceneRectSelectEvent,
    SplineCatmullRomHandle,
    SplineCubicBezierHandle,
    SpotLightHandle,
    TransformControlsEvent,
    TransformControlsHandle,
    _DragInput,
    _normalize_node_name,
    _RaycastSupportedSceneNodeHandle,
    _TransformControlsState,
)
from ._threadpool_exceptions import (
    print_awaited_callback_error,
    print_threadpool_errors,
)

if TYPE_CHECKING:
    import trimesh

    from ._viser import ClientHandle, ViserServer
    from .infra import ClientId


P = ParamSpec("P")


RgbTupleOrArray: TypeAlias = Union[
    Tuple[int, int, int], Tuple[float, float, float], np.ndarray
]

NoneOrCoroutine = TypeVar("NoneOrCoroutine", None, Coroutine)


@dataclasses.dataclass
class _PointerCallbackEntry:
    callback: Callable[[Any], None | Coroutine]
    event_type: _messages.ScenePointerEventType
    modifier: _messages.KeyModifier | None
    event_class: type


def _modifier_matches_filter(
    held: _messages.KeyModifier | None,
    filter_modifier: _messages.KeyModifier | None,
) -> bool:
    """Return whether a canonical held-modifier string matches a
    :data:`KeyModifier` filter.

    Both inputs are already canonicalized by the wire layer (server-side
    receives them from clients post-canonicalization; user-supplied
    filters go through ``_normalize_key_modifier``), so this is just
    string equality.

    Mirrored client-side in ``matchesModifierFilter``
    (``src/viser/client/src/dragUtils.ts``). Drift = silent missed
    events or spurious teardowns.
    """
    return held == filter_modifier


def _drag_input_matches_filter(
    input: _DragInput,
    filter_button: _messages.DragButton,
    filter_modifier: _messages.KeyModifier | None,
) -> bool:
    """Return whether a drag input matches a registered binding filter."""
    if filter_button != input.button:
        return False
    return _modifier_matches_filter(input.modifier, filter_modifier)


def _encode_rgb(rgb: RgbTupleOrArray) -> tuple[int, int, int]:
    if isinstance(rgb, np.ndarray):
        assert rgb.shape == (3,)
    rgb_fixed = tuple(
        int(value) if np.issubdtype(type(value), np.integer) else int(value * 255)
        for value in rgb
    )
    assert len(rgb_fixed) == 3
    return rgb_fixed  # type: ignore


def _encode_image_binary(
    image: np.ndarray,
    format: Literal["auto", "png", "jpeg"],
    jpeg_quality: int | None = None,
) -> tuple[Literal["jpeg", "png"], bytes]:
    image = colors_to_uint8(image)

    # Resolve "auto" format
    resolved_format: Literal["jpeg", "png"]
    if format == "auto":
        resolved_format = "png" if image.shape[2] == 4 else "jpeg"
    else:
        resolved_format = format

    # Convert RGB to BGR for OpenCV encoding.
    encoded = cv2_imencode_with_fallback(
        resolved_format, image, jpeg_quality, channel_ordering="rgb"
    )
    return resolved_format, encoded


TVector = TypeVar("TVector", bound=tuple)


def cast_vector(vector: TVector | np.ndarray, length: int) -> TVector:
    if not isinstance(vector, tuple):
        assert cast(np.ndarray, vector).shape == (length,), (
            f"Expected vector of shape {(length,)}, but got {vector.shape} instead"
        )
    return cast(TVector, tuple(map(float, vector)))


def _warn_wireframe_conflicts(
    wireframe: bool, material: str, flat_shading: bool
) -> None:
    """Warn about arguments that are ignored when wireframe rendering is on.

    Called one level below the public ``add_*`` method, so ``stacklevel=3``
    points the warning at the user's call site (warn -> here -> add_* -> user).
    """
    if wireframe and material != "standard":
        warnings.warn(
            f"Invalid combination of {wireframe=} and {material=}. Material argument will be ignored.",
            stacklevel=3,
        )
    if wireframe and flat_shading:
        warnings.warn(
            f"Invalid combination of {wireframe=} and {flat_shading=}. Flat shading argument will be ignored.",
            stacklevel=3,
        )


def _validate_batched_transforms(
    batched_wxyzs: Any, batched_positions: Any, batched_scales: Any
) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray], int]:
    """Coerce and shape-check the per-instance transform arrays shared by the
    batched scene primitives. Returns ``(wxyzs, positions, scales, count)``.
    ``wxyzs`` and ``positions`` keep their input dtype (cast to float32 at
    message construction); ``scales`` is cast to float32 here.
    """
    batched_wxyzs = np.asarray(batched_wxyzs)
    batched_positions = np.asarray(batched_positions)
    count = batched_wxyzs.shape[0]
    assert batched_wxyzs.shape == (count, 4)
    assert batched_positions.shape == (count, 3)
    if batched_scales is not None:
        batched_scales = np.asarray(batched_scales, dtype=np.float32)
        assert batched_scales.shape in ((count,), (count, 3))
    return batched_wxyzs, batched_positions, batched_scales, count


MISSING_SENTINEL = "MISSING"
MISSING_SENTINEL_TYPE = Literal["MISSING"]


class SceneApi:
    """Interface for adding 3D primitives to the scene.

    Used by both our global server object, for sharing the same GUI elements
    with all clients, and by individual client handles."""

    def __init__(
        self,
        owner: ViserServer | ClientHandle,  # Who do I belong to?
        thread_executor: ThreadPoolExecutor,
        event_loop: asyncio.AbstractEventLoop,
    ) -> None:
        from ._viser import ViserServer

        self._thread_executor = thread_executor
        self._event_loop = event_loop

        self._owner = owner
        """Entity that owns this API."""

        self._websock_interface = (
            owner._websock_server
            if isinstance(owner, ViserServer)
            else owner._websock_connection
        )
        """Interface for sending and listening to messages."""

        self._handle_from_transform_controls_name: dict[
            str, TransformControlsHandle
        ] = {}
        self._handle_from_node_name: dict[str, SceneNodeHandle] = {}
        self._node_lifecycle_lock = threading.RLock()
        """Serializes scene-node lifecycle transitions (remove, same-name
        supersede) against interaction-callback (de)registration. All
        critical sections are short and synchronous (no awaits inside).
        Reentrant because teardown cascades re-enter on the same thread
        (a 3D GUI container's _on_remove removes its children, which can
        include nested scene-node handles). Without this lock, a
        registration racing a remove/supersede from another thread could
        publish a name-keyed binding into the persistent buffer AFTER the
        teardown's empty-bindings emit -- a ghost a same-name successor
        would inherit on late-joining clients."""
        self._children_from_node_name: dict[str, set[str]] = {}
        # Tracks handles with an in-flight drag gesture, plus the last
        # message we processed for that drag. Populated on
        # ``phase="start"``, refreshed on ``phase="update"``, cleared on
        # ``phase="end"``. Lets us dispatch ``on_drag_end`` even when
        # the user calls ``handle.remove()`` mid-drag (which pops the
        # handle from ``_handle_from_node_name``) and when a client
        # disconnects mid-drag (where the ``end`` message never
        # arrives) -- see ``_drop_active_drags_for_client``. Without
        # this the end callback is silently dropped and per-drag user
        # state leaks. Keyed by ``(client_id, node_name)`` because two
        # clients can drag the same node concurrently -- keying by name
        # alone would let one client's start overwrite the other's,
        # and ``end`` from the first client would pop the wrong entry.
        self._active_drag_handles: dict[
            tuple[ClientId, str],
            tuple[_RaycastSupportedSceneNodeHandle, _messages.SceneNodeDragMessage],
        ] = {}
        # Same idea for transform-control gizmos: track in-flight drags so a
        # late ``update``/``end`` still dispatches after the gizmo (or an
        # ancestor) is removed mid-drag -- which pops the handle from
        # ``_handle_from_transform_controls_name`` -- and so ``on_drag_end``
        # fires (and the entry is released) on a mid-drag disconnect.
        self._active_transform_drag_handles: dict[
            tuple[ClientId, str], TransformControlsHandle
        ] = {}

        # Enable/disable of ``ScenePointerEnableMessage`` is
        # reference-counted per ``event_type``: enable when the first
        # callback for that type registers, disable when the last is
        # removed.
        self._scene_pointer_cb: list[_PointerCallbackEntry] = []
        self._scene_pointer_done_cb: list[Callable[[], None | Coroutine]] = []

        # Set up world axes handle.
        self.world_axes: FrameHandle = self.add_frame(
            "/WorldAxes",
            axes_radius=0.0125,
        )
        """Handle for the world axes, which are created by default."""

        self.world_axes.visible = False

        self._websock_interface.register_handler(
            _messages.TransformControlsUpdateMessage,
            self._handle_transform_controls_updates,
        )
        self._websock_interface.register_handler(
            _messages.TransformControlsDragStartMessage,
            self._handle_transform_controls_drag_start,
        )
        self._websock_interface.register_handler(
            _messages.TransformControlsDragEndMessage,
            self._handle_transform_controls_drag_end,
        )
        self._websock_interface.register_handler(
            _messages.SceneNodeClickMessage,
            self._handle_node_click_updates,
        )
        self._websock_interface.register_handler(
            _messages.SceneNodeDragMessage, self._handle_node_drag
        )
        self._websock_interface.register_handler(
            _messages.ScenePointerMessage,
            self._handle_scene_pointer_updates,
        )

    def _is_drag_active_for(self, name: str) -> bool:
        """Whether the named scene node currently has any in-flight drag
        gesture (from any connected client). Used by ``remove()`` to
        decide whether to clear ``drag_cb`` immediately or preserve it
        until the in-flight drag's ``end`` message arrives.

        Iterates a snapshot: this runs on the caller's thread while the
        event loop's message handlers mutate the dict, and a live dict view
        raises "dictionary changed size during iteration". (list(dict) is a
        single C-level copy, atomic under the GIL.)"""
        return any(key[1] == name for key in list(self._active_drag_handles))

    async def _drop_active_drags_for_client(self, client_id: ClientId) -> None:
        """Drop any in-flight drag entries for a disconnecting client,
        synthesizing a ``phase="end"`` event so user state allocated in
        ``on_drag_start`` can be released. Without this, a mid-drag
        disconnect both leaks the ``_active_drag_handles`` entry (the
        entry pins a ``SceneNodeHandle`` reference, and
        ``_is_drag_active_for`` will return spurious-true for the
        leaked node name -- preventing a future ``remove()`` from
        clearing its callbacks) and silently skips ``on_drag_end``."""
        # Per-entry exception isolation: a throwing async end callback must
        # not strand the REMAINING entries (each pins a handle and blocks a
        # future remove() from clearing its callbacks) or abort the caller's
        # disconnect teardown.
        stale_keys = [k for k in self._active_drag_handles if k[0] == client_id]
        for k in stale_keys:
            entry = self._active_drag_handles.pop(k, None)
            if entry is None:
                continue
            handle, last_msg = entry
            # Synthesize an end event using the most recently observed
            # client-reported positions.
            synthetic = dataclasses.replace(last_msg, phase="end")
            try:
                await self._dispatch_drag_callbacks(client_id, handle, synthetic)
            except Exception as exc:
                print_awaited_callback_error(exc)

        # Same for in-flight transform-control gizmo drags.
        stale_tc_keys = [
            k for k in self._active_transform_drag_handles if k[0] == client_id
        ]
        for k in stale_tc_keys:
            tc_handle = self._active_transform_drag_handles.pop(k, None)
            if tc_handle is None:
                continue
            try:
                await self._fire_transform_controls_callbacks(
                    client_id, tc_handle, "end"
                )
            except Exception as exc:
                print_awaited_callback_error(exc)

    def _ensure_ancestors_exist(self, name: str) -> None:
        """Create intermediate frame nodes for any missing ancestors of `name`."""
        parts = name.split("/")
        for i in range(2, len(parts)):  # skip root ("") and the node itself
            ancestor = "/".join(parts[:i])
            if ancestor not in self._handle_from_node_name:
                self.add_frame(ancestor, show_axes=False)

    def set_up_direction(
        self,
        direction: Literal["+x", "+y", "+z", "-x", "-y", "-z"]
        | tuple[float, float, float]
        | np.ndarray,
    ) -> None:
        """Set the global up direction of the scene. By default we follow +Z-up
        (similar to Blender, 3DS Max, ROS, etc), the most common alternative is
        +Y (OpenGL, Maya, etc).

        In practice, the impact of this can improve (1) the ergonomics of
        camera controls, which will default to the same up direction as the
        scene, and (2) lighting, because the default lights and environment map
        are oriented to match the scene's up direction.

        Args:
            direction: New up direction. Can either be a string (one of +x, +y,
                +z, -x, -y, -z) or a length-3 direction vector.
        """
        if isinstance(direction, str):
            direction = {
                "+x": (1, 0, 0),
                "+y": (0, 1, 0),
                "+z": (0, 0, 1),
                "-x": (-1, 0, 0),
                "-y": (0, -1, 0),
                "-z": (0, 0, -1),
            }[direction]
        assert not isinstance(direction, str)

        default_three_up = np.array([0.0, 1.0, 0.0])
        direction = np.asarray(direction)

        def rotate_between(before: np.ndarray, after: np.ndarray) -> tf.SO3:
            assert before.shape == after.shape == (3,)
            before = before / np.linalg.norm(before)
            after = after / np.linalg.norm(after)

            angle = np.arccos(np.clip(np.dot(before, after), -1, 1))
            axis = np.cross(before, after)
            if np.allclose(axis, np.zeros(3), rtol=1e-3, atol=1e-5):
                unit_vector = np.arange(3) == np.argmin(np.abs(before))
                axis = np.cross(before, unit_vector)
            axis = axis / np.linalg.norm(axis)
            return tf.SO3.exp(angle * axis)

        R_threeworld_world = rotate_between(direction, default_three_up)

        # Rotate the world frame such that:
        #     If we set +Y to up, +X and +Z should face the camera.
        #     If we set +Z to up, +X and +Y should face the camera.
        # In App.tsx, the camera is initialized at [-3, 3, -3] in the threejs
        # coordinate frame.
        desired_fwd = np.array([-1.0, 0.0, -1.0]) / np.sqrt(2.0)
        current_fwd = R_threeworld_world @ (np.ones(3) / np.sqrt(3.0))
        current_fwd = current_fwd * np.array([1.0, 0.0, 1.0])
        current_fwd = current_fwd / np.linalg.norm(current_fwd)
        R_threeworld_world = (
            tf.SO3.from_y_radians(  # Rotate around the null space / up direction.
                np.arctan2(
                    np.cross(current_fwd, desired_fwd)[1],
                    np.dot(current_fwd, desired_fwd),
                ),
            )
            @ R_threeworld_world
        )

        if not np.any(np.isnan(R_threeworld_world.wxyz)):
            # Set the orientation of the root node.
            self._websock_interface.queue_message(
                _messages.SetOrientationMessage(
                    "", cast_vector(R_threeworld_world.wxyz, 4)
                )
            )

    def set_global_visibility(self, visible: bool) -> None:
        """Set visibility for all scene nodes. If set to False, all scene nodes
        will be hidden.

        This can be useful when we've called
        :meth:`SceneApi.set_background_image()`, and want to hide everything
        except for the background.

        Args:
            visible: Whether or not all scene nodes should be visible.
        """
        self._websock_interface.queue_message(
            _messages.SetSceneNodeVisibilityMessage("", visible)
        )

    @deprecated_positional_shim
    def add_light_directional(
        self,
        name: str,
        *,
        color: Tuple[int, int, int] = (255, 255, 255),
        intensity: float = 1.0,
        cast_shadow: bool = False,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> DirectionalLightHandle:
        """
        Add a directional light to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            color: Color of the light.
            intensity: Light's strength/intensity.
            cast_shadow: If set to true light will cast dynamic shadows
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """

        message = _messages.DirectionalLightMessage(
            name, _messages.DirectionalLightProps(color, intensity, cast_shadow)
        )
        return DirectionalLightHandle._make(
            self, message, name, wxyz, position, visible
        )

    @deprecated_positional_shim
    def add_light_ambient(
        self,
        name: str,
        *,
        color: Tuple[int, int, int] = (255, 255, 255),
        intensity: float = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> AmbientLightHandle:
        """
        Add an ambient light to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            color: Color of the light.
            intensity: Light's strength/intensity.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """

        message = _messages.AmbientLightMessage(
            name, _messages.AmbientLightProps(color, intensity)
        )
        return AmbientLightHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_light_hemisphere(
        self,
        name: str,
        *,
        sky_color: Tuple[int, int, int] = (255, 255, 255),
        ground_color: Tuple[int, int, int] = (255, 255, 255),
        intensity: float = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> HemisphereLightHandle:
        """
        Add a hemisphere light to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            sky_color: The light's sky color.
            ground_color: The light's ground color.
            intensity: Light's strength/intensity.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """

        message = _messages.HemisphereLightMessage(
            name, _messages.HemisphereLightProps(sky_color, ground_color, intensity)
        )
        return HemisphereLightHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_light_point(
        self,
        name: str,
        *,
        color: Tuple[int, int, int] = (255, 255, 255),
        intensity: float = 1.0,
        distance: float = 0.0,
        decay: float = 2.0,
        cast_shadow: bool = False,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> PointLightHandle:
        """
        Add a point light to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            color: Color of the light.
            intensity: Light's strength/intensity.
            distance: Maximum distance of light.
            decay: The amount the light dims along the distance of the light.
            cast_shadow: If set to true light will cast dynamic shadows
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """

        message = _messages.PointLightMessage(
            name,
            _messages.PointLightProps(
                color=color,
                intensity=intensity,
                distance=distance,
                decay=decay,
                cast_shadow=cast_shadow,
            ),
        )
        return PointLightHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_light_rectarea(
        self,
        name: str,
        *,
        color: Tuple[int, int, int] = (255, 255, 255),
        intensity: float = 1.0,
        width: float = 10.0,
        height: float = 10.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> RectAreaLightHandle:
        """
        Add a rectangular area light to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            color: Color of the light.
            intensity: Light's strength/intensity.
            width: The width of the light.
            height: The height of the light.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """

        message = _messages.RectAreaLightMessage(
            name=name,
            props=_messages.RectAreaLightProps(
                color=color,
                intensity=intensity,
                width=width,
                height=height,
            ),
        )
        return RectAreaLightHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_light_spot(
        self,
        name: str,
        *,
        color: Tuple[int, int, int] = (255, 255, 255),
        distance: float = 0.0,
        angle: float = np.pi / 3,
        penumbra: float = 0.0,
        decay: float = 2.0,
        intensity: float = 1.0,
        cast_shadow: bool = False,
        direction: tuple[float, float, float] = (0.0, 0.0, -1.0),
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> SpotLightHandle:
        """
        Add a spot light to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            color: Color of the light.
            distance: Maximum distance of light.
            angle: Maximum extent of the spotlight, in radians, from its direction.
                Should be no more than Math.PI/2.
            penumbra: Percent of the spotlight cone that is attenuated due to penumbra.
                Between 0 and 1.
            decay: The amount the light dims along the distance of the light.
            intensity: Light's strength/intensity.
            cast_shadow: If set to true light will cast dynamic shadows
            direction: Direction that the spotlight points in its local frame.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """

        message = _messages.SpotLightMessage(
            name,
            _messages.SpotLightProps(
                color,
                intensity,
                distance,
                angle,
                penumbra,
                decay,
                cast_shadow,
                direction,
            ),
        )
        return SpotLightHandle._make(self, message, name, wxyz, position, visible)

    def configure_environment_map(
        self,
        hdri: None
        | Literal[
            "apartment",
            "city",
            "dawn",
            "forest",
            "lobby",
            "night",
            "park",
            "studio",
            "sunset",
            "warehouse",
        ] = "warehouse",
        *,
        background: bool = False,
        background_blurriness: float = 0.0,
        background_intensity: float = 1.0,
        background_wxyz: tuple[float, float, float, float] | np.ndarray = (
            1.0,
            0.0,
            0.0,
            0.0,
        ),
        environment_intensity: float = 1.0,
        environment_wxyz: tuple[float, float, float, float] | np.ndarray = (
            1.0,
            0.0,
            0.0,
            0.0,
        ),
    ) -> None:
        """Configure the environment map for the scene. This will set some lights and background.

        Args:
            hdri: Preset HDRI environment to use.
            background: Show or hide the environment map in the background.
            background_blurriness: Blur factor of the environment map background (0-1).
            background_intensity: Intensity of the background.
            background_wxyz: Orientation of the background.
            environment_intensity: Intensity of the environment lighting.
            environment_wxyz: Orientation of the environment lighting.
        """
        self._websock_interface.queue_message(
            _messages.EnvironmentMapMessage(
                hdri=hdri,
                background=background,
                background_blurriness=background_blurriness,
                background_intensity=background_intensity,
                background_wxyz=cast_vector(background_wxyz, 4),
                environment_intensity=environment_intensity,
                environment_wxyz=cast_vector(environment_wxyz, 4),
            )
        )

    def configure_fog(
        self,
        near: float,
        far: float,
        *,
        color: RgbTupleOrArray = (255, 255, 255),
        enabled: bool = True,
    ) -> None:
        """Configure distance-based fog for the scene.

        When enabled, objects further from the camera will fade into the fog
        color, providing a depth cue. Uses linear fog, where ``near`` and
        ``far`` define the range over which the fog transitions from
        transparent to fully opaque.

        Args:
            near: Distance from the camera at which fog begins.
            far: Distance from the camera at which fog is fully opaque.
            color: Fog color as an RGB tuple (0-255 per channel) or
                a float tuple (0.0-1.0 per channel).
            enabled: Whether fog is enabled.
        """
        self._websock_interface.queue_message(
            _messages.FogMessage(
                near=near,
                far=far,
                color=_encode_rgb(color),
                enabled=enabled,
            )
        )

    def configure_default_lights(
        self,
        enabled: bool = True,
        cast_shadow: bool = True,
    ) -> None:
        """Configure the default lights in the scene.

        This does not affect lighting from the environment map. To turn these off,
        see :meth:`SceneApi.configure_environment_map()`.

        Args:
            enabled: Whether or not the lights are enabled.
            cast_shadow: Whether to cast shadows. Disabling can improve performance.
        """
        self._websock_interface.queue_message(
            _messages.EnableLightsMessage(enabled, cast_shadow)
        )

    if not TYPE_CHECKING:

        def enable_default_lights(self, *args, **kwargs) -> None:
            warnings.warn(
                "The 'enable_default_lights' method has been renamed to 'configure_default_lights'.",
                DeprecationWarning,
            )
            return self.configure_default_lights(*args, **kwargs)

        def set_environment_map(self, *args, **kwargs) -> None:
            warnings.warn(
                "The 'set_environment_map' method has been renamed to 'configure_environment_map'.",
                DeprecationWarning,
            )
            return self.configure_environment_map(*args, **kwargs)

    @deprecated_positional_shim
    def add_glb(
        self,
        name: str,
        glb_data: bytes,
        *,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
    ) -> GlbHandle:
        """Add a general 3D asset via binary glTF (GLB).

        For glTF files, it's often simpler to use `trimesh.load()` with
        `.add_mesh_trimesh()`. This will call `.add_glb()` under the hood.

        For glTF features not supported by trimesh, glTF to GLB conversion can
        also be done programatically with libraries like `pygltflib`.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
              define a kinematic tree.
            glb_data: A binary payload.
            scale: Scale for resizing the GLB asset. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.
            cast_shadow: Whether this node should cast shadows.
            receive_shadow: Whether this node should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.

        Returns:
            Handle for manipulating scene node.
        """
        message = _messages.GlbMessage(
            name,
            _messages.GlbProps(
                glb_data=glb_data,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                scale=scale,
            ),
        )
        return GlbHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_line_segments(
        self,
        name: str,
        points: np.ndarray,
        colors: np.ndarray | RgbTupleOrArray,
        *,
        line_width: float = 1,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> LineSegmentsHandle:
        """Add line segments to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can
                be used to define a kinematic tree.
            points: A numpy array of shape (N, 2, 3) defining start/end points
                for each of N line segments.
            colors: Colors of the line segments. Can be a single color as an RGB tuple or
                np.ndarray of shape (3,) to apply to all segments, or an np.ndarray of
                shape (N, 2, 3) to specify colors for each point of each segment.
            line_width: Width of the lines.
            scale: Scale of the line segments. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not these line segments are initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        points_array = np.asarray(points, dtype=np.float32)
        if (
            points_array.shape[-1] != 3
            or points_array.ndim != 3
            or points_array.shape[1] != 2
        ):
            raise ValueError("Points should have shape (N, 2, 3) for N line segments.")

        colors_array = colors_to_uint8(np.asarray(colors))
        assert colors_array.shape in {
            points_array.shape,
            (3,),
        }, "Shape of colors should be (N, 2, 3) or (3,)."

        message = _messages.LineSegmentsMessage(
            name=name,
            props=_messages.LineSegmentsProps(
                points=points_array,
                colors=colors_array,
                line_width=line_width,
                scale=scale,
            ),
        )
        return LineSegmentsHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_arrows(
        self,
        name: str,
        points: np.ndarray,
        colors: np.ndarray | RgbTupleOrArray,
        *,
        shaft_radius: float = 0.02,
        head_radius: float = 0.05,
        head_length: float = 0.1,
        line_width: float = 1,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> ArrowsHandle:
        """Add arrows to the scene.

        For more complex arrow geometry or material options, consider using
        :meth:`add_batched_meshes_simple` directly with custom cylinder/cone meshes.

        Args:
            name: A scene tree name. Names in the format of /parent/child can
                be used to define a kinematic tree.
            points: A numpy array of shape (N, 2, 3) defining start/end points
                for each of N arrows.
            colors: Colors of the arrows. Can be a single color as an RGB tuple or
                np.ndarray of shape (3,) to apply to all arrows, or an np.ndarray of
                shape (N, 3) to specify a color per arrow.
            shaft_radius: Radius of the arrow shaft.
            head_radius: Radius of the arrow head cone.
            head_length: Length of the arrow head.
            line_width: Width of the lines (fallback rendering).
            scale: Scale of the arrows. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not these arrows are initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        points_array = np.asarray(points, dtype=np.float32)
        if (
            points_array.ndim != 3
            or points_array.shape[1] != 2
            or points_array.shape[2] != 3
        ):
            raise ValueError("points should have shape (N, 2, 3) for N arrows.")

        colors_array = colors_to_uint8(np.asarray(colors))
        assert colors_array.shape in {
            (points_array.shape[0], 3),
            (3,),
        }, "Shape of colors should be (N, 3) or (3,)."

        message = _messages.ArrowMessage(
            name=name,
            props=_messages.ArrowProps(
                points=points_array,
                colors=colors_array,
                shaft_radius=shaft_radius,
                head_radius=head_radius,
                head_length=head_length,
                line_width=line_width,
                scale=scale,
            ),
        )
        return ArrowsHandle._make(self, message, name, wxyz, position, visible)

    @overload
    def add_spline_catmull_rom(
        self,
        name: str,
        points: np.ndarray,
        *,
        curve_type: Literal["centripetal", "chordal", "catmullrom"] = "centripetal",
        tension: float = 0.5,
        closed: bool = False,
        line_width: float = 1,
        color: RgbTupleOrArray = (20, 20, 20),
        segments: int | None = None,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> SplineCatmullRomHandle: ...

    @overload
    @deprecated("The `positions` parameter is deprecated. Use `points` instead.")
    def add_spline_catmull_rom(
        self,
        name: str,
        positions: tuple[tuple[float, float, float], ...],
        *,
        curve_type: Literal["centripetal", "chordal", "catmullrom"] = "centripetal",
        tension: float = 0.5,
        closed: bool = False,
        line_width: float = 1,
        color: RgbTupleOrArray = (20, 20, 20),
        segments: int | None = None,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> SplineCatmullRomHandle: ...

    @deprecated_positional_shim
    def add_spline_catmull_rom(  # pyright: ignore[reportInconsistentOverload]
        self,
        name: str,
        # `points` is actually required, we are keeping it optional at runtime for backwards-compatibility purposes.
        points: np.ndarray | MISSING_SENTINEL_TYPE = MISSING_SENTINEL,
        curve_type: Literal["centripetal", "chordal", "catmullrom"] = "centripetal",
        tension: float = 0.5,
        closed: bool = False,
        line_width: float = 1,
        color: RgbTupleOrArray = (20, 20, 20),
        segments: int | None = None,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
        **_deprecated_kwargs,
    ) -> SplineCatmullRomHandle:
        """Add a spline to the scene using Catmull-Rom interpolation.

        This method creates a spline based on a set of points and interpolates
        them using the Catmull-Rom algorithm. This can be used to create smooth curves.

        .. note::

            If many splines are needed, :meth:`add_line_segments()` supports
            batching and will be more efficient.

        .. warning::

            The `positions` parameter is deprecated and will be removed in the future. Use `points` instead.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            points: A tuple of 3D points (x, y, z) defining the spline's path.
            curve_type: Type of the curve ('centripetal', 'chordal', 'catmullrom').
            tension: Tension of the curve. Affects the tightness of the curve.
            closed: Boolean indicating if the spline is closed (forms a loop).
            line_width: Width of the spline line.
            color: Color of the spline as an RGB tuple.
            segments: Number of segments to divide the spline into.
            scale: Scale of the spline. A single float for uniform scaling or a
                tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        # Handle backward compatibility: support old 'positions' parameter.
        if "positions" in _deprecated_kwargs:
            if points is not MISSING_SENTINEL:
                raise ValueError(
                    "Cannot specify both 'points' and 'positions' parameters"
                )
            points = _deprecated_kwargs.pop("positions")
            warnings.warn(
                "The 'positions' parameter is deprecated. Use 'points' instead.",
                DeprecationWarning,
                stacklevel=2,
            )
        if _deprecated_kwargs:
            raise TypeError(
                f"Unexpected keyword arguments: {list(_deprecated_kwargs.keys())}"
            )
        if points is MISSING_SENTINEL:
            raise ValueError(
                "The 'points' parameter must be provided for a Catmull-Rom spline."
            )
        message = _messages.CatmullRomSplineMessage(
            name,
            _messages.CatmullRomSplineProps(
                points=np.asarray(points, dtype=np.float32),
                curve_type=curve_type,
                tension=tension,
                closed=closed,
                line_width=line_width,
                color=_encode_rgb(color),
                segments=segments,
                scale=scale,
            ),
        )
        return SplineCatmullRomHandle._make(
            self, message, name, wxyz, position, visible
        )

    # Important: this method is redeclared in a `if TYPE_CHECKING:` block below.
    # The 'official' API is the redeclared version, which has stricter type hints.
    #
    # The implementation version here is looser for backwards compatibility reasons.
    # It will be changed in the future to match the redeclared version.
    #
    @overload
    def add_spline_cubic_bezier(
        self,
        name: str,
        points: np.ndarray,
        control_points: np.ndarray,
        *,
        line_width: float = 1.0,
        color: RgbTupleOrArray = (20, 20, 20),
        segments: int | None = None,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> SplineCubicBezierHandle: ...

    @overload
    @deprecated(
        "The `positions` parameter is deprecated. Use `points` instead.",
    )
    def add_spline_cubic_bezier(
        self,
        name: str,
        positions: tuple[tuple[float, float, float], ...],
        control_points: tuple[tuple[float, float, float], ...],
        *,
        line_width: float = 1.0,
        color: RgbTupleOrArray = (20, 20, 20),
        segments: int | None = None,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> SplineCubicBezierHandle: ...

    @deprecated_positional_shim
    def add_spline_cubic_bezier(  # pyright: ignore[reportInconsistentOverload]
        self,
        name: str,
        # `points` and `control_points` are actually required, we are keeping
        # them optional at runtime for backwards-compatibility purposes.
        points: tuple[tuple[float, float, float], ...]
        | np.ndarray
        | MISSING_SENTINEL_TYPE = MISSING_SENTINEL,
        control_points: tuple[tuple[float, float, float], ...]
        | np.ndarray
        | MISSING_SENTINEL_TYPE = MISSING_SENTINEL,
        *,
        line_width: float = 1.0,
        color: RgbTupleOrArray = (20, 20, 20),
        segments: int | None = None,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
        **_deprecated_kwargs,
    ) -> SplineCubicBezierHandle:
        """Add a spline to the scene using Cubic Bezier interpolation.

        This method allows for the creation of a cubic Bezier spline based on given
        points and control points. It is useful for creating complex, smooth,
        curving shapes.

        .. note::

            If many splines are needed, :meth:`add_line_segments()` supports
            batching and will be more efficient.

        .. warning::

            The `positions` parameter is deprecated and will be removed in the future. Use `points` instead.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            points: A tuple of 3D points (x, y, z) defining the spline's key points.
            control_points: A tuple of control points for Bezier curve shaping. Must have
                exactly `2 * len(points) - 2` control points. For a cubic Bezier with N
                points, the curve passes through points[0], points[1], ..., points[N-1],
                with two control points between each consecutive pair of points.
            line_width: Width of the spline line.
            color: Color of the spline as an RGB tuple.
            segments: Number of segments to divide the spline into.
            scale: Scale of the spline. A single float for uniform scaling or a
                tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        # Handle backward compatibility: support old 'positions' parameter.
        if "positions" in _deprecated_kwargs:
            if points is not MISSING_SENTINEL:
                raise ValueError(
                    "Cannot specify both 'points' and 'positions' parameters"
                )
            points = _deprecated_kwargs.pop("positions")
            warnings.warn(
                "The 'positions' parameter is deprecated. Use 'points' instead.",
                DeprecationWarning,
                stacklevel=2,
            )
        if _deprecated_kwargs:
            raise TypeError(
                f"Unexpected keyword arguments: {list(_deprecated_kwargs.keys())}"
            )
        if points is MISSING_SENTINEL or control_points is MISSING_SENTINEL:
            raise ValueError(
                "Both 'points' and 'control_points' must be provided for a cubic Bezier spline."
            )
        assert len(control_points) == (2 * len(points) - 2)
        message = _messages.CubicBezierSplineMessage(
            name,
            _messages.CubicBezierSplineProps(
                points=np.asarray(points, dtype=np.float32),
                control_points=np.asarray(control_points, dtype=np.float32),
                line_width=line_width,
                color=_encode_rgb(color),
                segments=segments,
                scale=scale,
            ),
        )
        return SplineCubicBezierHandle._make(
            self, message, name, wxyz, position, visible
        )

    @deprecated_positional_shim
    def add_camera_frustum(
        self,
        name: str,
        fov: float,
        aspect: float,
        *,
        scale: float | tuple[float, float, float] = 0.3,
        line_width: float = 2.0,
        color: RgbTupleOrArray = (20, 20, 20),
        image: np.ndarray | None = None,
        format: Literal["auto", "png", "jpeg"] = "auto",
        jpeg_quality: int | None = None,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        variant: Literal["wireframe", "filled"] = "wireframe",
    ) -> CameraFrustumHandle:
        """Add a camera frustum to the scene for visualization.

        This method adds a frustum representation, typically used to visualize the
        field of view of a camera. It's helpful for understanding the perspective
        and coverage of a camera in the 3D space.

        Like all cameras in the viser Python API, frustums follow the OpenCV [+Z forward,
        +X right, +Y down] convention. fov is vertical in radians; aspect is width over height.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            fov: Field of view of the camera (in radians).
            aspect: Aspect ratio of the camera (width over height).
            scale: Scale factor for the size of the frustum. A single float
                for uniform scaling or a tuple of (x, y, z) for per-axis scaling.
            line_width: Width of the frustum lines, in screen space. Defaults to `2.0`.
            color: Color of the frustum as an RGB tuple.
            image: Optional image to be displayed on the frustum.
            format: Format to transport and display the image using. 'auto' will use PNG for RGBA images and JPEG for RGB.
            jpeg_quality: Quality of the jpeg image (if jpeg format is used).
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.
            cast_shadow: Whether this frustum should cast shadows.
            receive_shadow: Whether this frustum should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            variant: Variant of the frustum visualization. 'wireframe' shows lines only, 'filled' adds semi-transparent faces.

        Returns:
            Handle for manipulating scene node.
        """
        if image is not None:
            resolved_format, binary = _encode_image_binary(
                image, format, jpeg_quality=jpeg_quality
            )
        else:
            resolved_format = "png" if format == "auto" else format
            binary = None

        message = _messages.CameraFrustumMessage(
            name=name,
            props=_messages.CameraFrustumProps(
                fov=fov,
                aspect=aspect,
                scale=scale,
                line_width=line_width,
                color=_encode_rgb(color),
                _format=resolved_format,
                _image_data=binary,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                variant=variant,
            ),
        )
        handle = CameraFrustumHandle._make(self, message, name, wxyz, position, visible)
        handle._image = image
        handle._jpeg_quality = jpeg_quality
        handle._user_format = format
        return handle

    @deprecated_positional_shim
    def add_frame(
        self,
        name: str,
        show_axes: bool = True,
        *,
        axes_length: float = 0.5,
        axes_radius: float = 0.025,
        origin_radius: float | None = None,
        origin_color: RgbTupleOrArray = (236, 236, 0),
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> FrameHandle:
        """Add a coordinate frame to the scene.

        This method is used for adding a visual representation of a coordinate
        frame, which can help in understanding the orientation and position of
        objects in 3D space.

        For cases where we want to visualize many coordinate frames, like
        trajectories containing thousands or tens of thousands of frames,
        batching and calling :meth:`add_batched_axes()` may be a better choice
        than calling :meth:`add_frame()` in a loop.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            show_axes: Boolean to indicate whether to show the frame as a set of axes + origin sphere.
            axes_length: Length of each axis.
            axes_radius: Radius of each axis.
            origin_radius: Radius of the origin sphere. If not set, defaults to `2 * axes_radius`.
            scale: Scale of the coordinate frame. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        if origin_radius is None:
            origin_radius = axes_radius * 2
        message = _messages.FrameMessage(
            name=name,
            props=_messages.FrameProps(
                show_axes=show_axes,
                axes_length=axes_length,
                axes_radius=axes_radius,
                origin_radius=origin_radius,
                origin_color=_encode_rgb(origin_color),
                scale=scale,
            ),
        )
        return FrameHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_batched_axes(
        self,
        name: str,
        batched_wxyzs: tuple[tuple[float, float, float, float], ...] | np.ndarray,
        batched_positions: tuple[tuple[float, float, float], ...] | np.ndarray,
        batched_scales: tuple[float, ...] | np.ndarray | None = None,
        *,
        axes_length: float = 0.5,
        axes_radius: float = 0.025,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> BatchedAxesHandle:
        """Visualize batched sets of coordinate frame axes.

        The functionality of :meth:`add_batched_axes()` overlaps significantly
        with :meth:`add_frame()` when `show_axes=True`. The primary difference
        is that :meth:`add_batched_axes()` supports multiple axes via the
        `wxyzs_batched` (shape Nx4) and `positions_batched` (shape Nx3)
        arguments.

        Axes that are batched and rendered via a single call to
        `add_batched_axes()` are instanced on the client; this will be much
        faster to render than `add_frame()` called in a loop.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            batched_wxyzs: Float array of shape (N,4).
            batched_positions: Float array of shape (N,3).
            batched_scales: Float array of shape (N,) for uniform scales or (N,3) for per-axis (XYZ) scales. None means scale of 1.0.
            axes_length: Length of each axis.
            axes_radius: Radius of each axis.
            scale: Scale of the batched axes. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
                This will be applied to all axes.
            position: Translation to parent frame from local frame (t_pl).
                This will be applied to all axes.
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        batched_wxyzs, batched_positions, batched_scales, _ = (
            _validate_batched_transforms(
                batched_wxyzs, batched_positions, batched_scales
            )
        )

        props = _messages.BatchedAxesProps(
            batched_wxyzs=np.asarray(batched_wxyzs, dtype=np.float32),
            batched_positions=np.asarray(batched_positions, dtype=np.float32),
            batched_scales=batched_scales,
            axes_length=axes_length,
            axes_radius=axes_radius,
            scale=scale,
        )
        message = _messages.BatchedAxesMessage(
            name=name,
            props=props,
        )
        return BatchedAxesHandle._make(self, message, name, wxyz, position, visible)

    @partial(
        deprecated_positional_shim,
        deprecated_kwargs=("width_segments", "height_segments"),
    )
    def add_grid(
        self,
        name: str,
        width: float = 10.0,
        height: float = 10.0,
        *,
        plane: Literal["xz", "xy", "yx", "yz", "zx", "zy"] = "xy",
        cell_color: RgbTupleOrArray = (200, 200, 200),
        cell_thickness: float = 1.0,
        cell_size: float = 0.5,
        section_color: RgbTupleOrArray = (140, 140, 140),
        section_thickness: float = 1.0,
        section_size: float = 1.0,
        infinite_grid: bool = False,
        fade_distance: float = 100.0,
        fade_strength: float = 1.0,
        fade_from: Literal["camera", "origin"] = "camera",
        shadow_opacity: float = 0.125,
        plane_color: RgbTupleOrArray = (255, 255, 255),
        plane_opacity: float = 0.0,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> GridHandle:
        """Add a 2D grid to the scene.

        This can be useful as a size, orientation, or ground plane reference.

        Args:
            name: Name of the grid.
            width: Width of the grid.
            height: Height of the grid.
            plane: The plane in which the grid is oriented (e.g., 'xy', 'yz').
            cell_color: Color of the grid cells as an RGB tuple.
            cell_thickness: Thickness of the grid lines.
            cell_size: Size of each cell in the grid.
            section_color: Color of the grid sections as an RGB tuple.
            section_thickness: Thickness of the section lines.
            section_size: Size of each section in the grid.
            shadow_opacity: Opacity of shadows casted onto grid plane, 0: no shadows, 1: black shadows
            plane_color: Color of the ground plane as an RGB tuple.
            plane_opacity: Opacity of the ground plane, 0: invisible, 1: fully opaque.
            infinite_grid: Whether the grid should appear infinite. If `True`, the width and height are ignored.
            fade_distance: Distance at which the grid fades out.
            fade_strength: Strength of the fade effect.
            fade_from: Whether the grid should fade based on distance from the camera or the origin.
            scale: Scale of the grid. A single float for uniform scaling or a
                tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        message = _messages.GridMessage(
            name=name,
            props=_messages.GridProps(
                width=width,
                height=height,
                plane=plane,
                cell_color=_encode_rgb(cell_color),
                cell_thickness=cell_thickness,
                cell_size=cell_size,
                section_color=_encode_rgb(section_color),
                section_thickness=section_thickness,
                section_size=section_size,
                infinite_grid=infinite_grid,
                fade_distance=fade_distance,
                fade_strength=fade_strength,
                fade_from=fade_from,
                shadow_opacity=shadow_opacity,
                plane_color=_encode_rgb(plane_color),
                plane_opacity=plane_opacity,
                scale=scale,
            ),
        )
        return GridHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_label(
        self,
        name: str,
        text: str,
        *,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
        font_size_mode: Literal["screen", "scene"] = "screen",
        font_screen_scale: float = 1.0,
        font_scene_height: float = 0.075,
        depth_test: bool = False,
        anchor: Literal[
            "top-left",
            "top-center",
            "top-right",
            "center-left",
            "center-center",
            "center-right",
            "bottom-left",
            "bottom-center",
            "bottom-right",
        ] = "top-left",
    ) -> LabelHandle:
        """Add a 2D label to the scene.

        This method creates a text label in the 3D scene, which can be used to annotate
        or provide information about specific points or objects.

        Args:
            name: Name of the label.
            text: Text content of the label.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.
            font_size_mode: Font sizing mode. 'screen' for screen-space sizing (constant pixel size), 'scene' for world-space sizing (size in scene units).
            font_screen_scale: Scale factor for screen-space font size. Only used when font_size_mode='screen'.
            font_scene_height: Font height in scene units. Only used when font_size_mode='scene'.
            depth_test: Whether to enable depth testing for the label.
            anchor: Anchor position of the label relative to its position.

        Returns:
            Handle for manipulating scene node.
        """
        message = _messages.LabelMessage(
            name,
            _messages.LabelProps(
                text=text,
                font_size_mode=font_size_mode,
                font_screen_scale=font_screen_scale,
                font_scene_height=font_scene_height,
                depth_test=depth_test,
                anchor=anchor,
            ),
        )
        return LabelHandle._make(self, message, name, wxyz, position, visible=visible)

    @deprecated_positional_shim
    def add_point_cloud(
        self,
        name: str,
        points: np.ndarray,
        colors: np.ndarray | RgbTupleOrArray,
        *,
        point_size: float = 0.1,
        point_shape: Literal[
            "square", "diamond", "circle", "rounded", "sparkle"
        ] = "square",
        precision: Literal["float16", "float32"] = "float16",
        scale: float | tuple[float, float, float] = 1.0,
        point_shading: Literal["flat", "gradient"] = "gradient",
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> PointCloudHandle:
        """Add a point cloud to the scene.

        Args:
            name: Name of scene node. Determines location in kinematic tree.
            points: Location of points. Should have shape (N, 3).
            colors: Colors of the points. Can be a single color as an RGB tuple or
                np.ndarray of shape (3,) to apply to all points, or an np.ndarray of
                shape (N, 3) to specify colors for each point.
            point_size: Size of each point.
            point_shape: Shape to draw each point.
            precision: Precision of the point cloud data. The input points array
                will be cast to this precision.
            scale: Scale of the point cloud. A single float for uniform scaling
                or a tuple of (x, y, z) for per-axis scaling.
            point_shading: Shading mode for points. "flat" renders solid colors.
                "gradient" adds center-to-edge shading for a sphere-like look.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        colors_cast = colors_to_uint8(np.asarray(colors))
        assert len(points.shape) == 2 and points.shape[-1] == 3, (
            "Shape of points should be (N, 3)."
        )
        assert colors_cast.shape in {
            points.shape,
            (3,),
        }, "Shape of colors should be (N, 3) or (3,)."
        message = _messages.PointCloudMessage(
            name=name,
            props=_messages.PointCloudProps(
                points=np.asarray(
                    points,
                    dtype={
                        "float16": np.float16,
                        "float32": np.float32,
                    }[precision],
                ),
                colors=colors_cast,
                point_size=point_size,
                point_shape=point_shape,
                precision=precision,
                scale=scale,
                point_shading=point_shading,
            ),
        )
        return PointCloudHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_mesh_skinned(
        self,
        name: str,
        vertices: np.ndarray,
        faces: np.ndarray,
        *,
        bone_wxyzs: tuple[tuple[float, float, float, float], ...] | np.ndarray,
        bone_positions: tuple[tuple[float, float, float], ...] | np.ndarray,
        skin_weights: np.ndarray,
        color: RgbTupleOrArray = (90, 200, 255),
        wireframe: bool = False,
        opacity: float | None = None,
        material: Literal["standard", "toon3", "toon5"] = "standard",
        flat_shading: bool = False,
        side: Literal["front", "back", "double"] = "front",
        scale: float | tuple[float, float, float] = 1.0,
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        wxyz: Tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: Tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> MeshSkinnedHandle:
        """Add a skinned mesh to the scene, which we can deform using a set of
        bone transformations.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            vertices: A numpy array of vertex positions. Should have shape (V, 3).
            faces: A numpy array of faces, where each face is represented by indices of
                vertices. Should have shape (F,)
            bone_wxyzs: Nested tuple or array of initial bone orientations.
            bone_positions: Nested tuple or array of initial bone positions.
            skin_weights: A numpy array of skin weights. Should have shape (V, B) where B
                is the number of bones. Only the top 4 bone weights for each
                vertex will be used.
            color: Color of the mesh as an RGB tuple.
            wireframe: Boolean indicating if the mesh should be rendered as a wireframe.
            opacity: Opacity of the mesh. None means opaque.
            material: Material type of the mesh ('standard', 'toon3', 'toon5').
                This argument is ignored when wireframe=True.
            flat_shading: Whether to do flat shading. This argument is ignored
                when wireframe=True.
            side: Side of the surface to render ('front', 'back', 'double').
            scale: Scale of the mesh. A single float for uniform scaling or a tuple
                of (x, y, z) for per-axis scaling.
            cast_shadow: Whether this skinned mesh should cast shadows.
            receive_shadow: Whether this skinned mesh should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this mesh is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        _warn_wireframe_conflicts(wireframe, material, flat_shading)

        assert len(bone_wxyzs) == len(bone_positions)
        num_bones = len(bone_wxyzs)
        if num_bones == 0:
            raise ValueError("A skinned mesh requires at least one bone.")
        assert skin_weights.shape == (vertices.shape[0], num_bones)

        # Take up to the four biggest weights per vertex. The client expects
        # exactly four bone indices/weights per vertex, so when the rig has
        # fewer than four bones we pad with zero-weight (index 0) entries, which
        # have no effect on the skinning result.
        num_vertices = vertices.shape[0]
        num_influences = min(4, num_bones)
        pad = 4 - num_influences
        top_skin_indices = np.argsort(skin_weights, axis=-1)[:, -num_influences:]
        top_skin_weights = skin_weights[
            np.arange(num_vertices)[:, None], top_skin_indices
        ]
        if pad > 0:
            top_skin_indices = np.pad(top_skin_indices, ((0, 0), (0, pad)))
            top_skin_weights = np.pad(top_skin_weights, ((0, 0), (0, pad)))
        assert top_skin_weights.shape == top_skin_indices.shape == (num_vertices, 4)

        bone_wxyzs = np.asarray(bone_wxyzs)
        bone_positions = np.asarray(bone_positions)
        assert bone_wxyzs.shape == (num_bones, 4)
        assert bone_positions.shape == (num_bones, 3)
        message = _messages.SkinnedMeshMessage(
            name=name,
            props=_messages.SkinnedMeshProps(
                vertices=np.asarray(vertices, dtype=np.float32),
                faces=np.asarray(faces, dtype=np.uint32),
                color=_encode_rgb(color),
                wireframe=wireframe,
                opacity=opacity,
                flat_shading=flat_shading,
                side=side,
                material=material,
                scale=scale,
                bone_wxyzs=np.asarray(bone_wxyzs, dtype=np.float32),
                bone_positions=np.asarray(bone_positions, dtype=np.float32),
                skin_indices=top_skin_indices.astype(np.uint16),
                skin_weights=np.asarray(top_skin_weights, dtype=np.float32),
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
            ),
        )
        handle = MeshHandle._make(self, message, name, wxyz, position, visible)
        return MeshSkinnedHandle(
            handle._impl,
            bones=tuple(
                MeshSkinnedBoneHandle(
                    _impl=BoneState(
                        name=name,
                        websock_interface=self._websock_interface,
                        bone_index=i,
                        wxyz=bone_wxyzs[i].copy(),
                        position=bone_positions[i].copy(),
                    )
                )
                for i in range(num_bones)
            ),
        )

    @deprecated_positional_shim
    def add_mesh_simple(
        self,
        name: str,
        vertices: np.ndarray,
        faces: np.ndarray,
        *,
        color: RgbTupleOrArray = (90, 200, 255),
        wireframe: bool = False,
        opacity: float | None = None,
        material: Literal["standard", "toon3", "toon5"] = "standard",
        flat_shading: bool = False,
        side: Literal["front", "back", "double"] = "front",
        scale: float | tuple[float, float, float] = 1.0,
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> MeshHandle:
        """Add a mesh to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            vertices: A numpy array of vertex positions. Should have shape (V, 3).
            faces: A numpy array of faces, where each face is represented by indices of
                vertices. Should have shape (F,)
            color: Color of the mesh as an RGB tuple.
            wireframe: Boolean indicating if the mesh should be rendered as a wireframe.
            opacity: Opacity of the mesh. None means opaque.
            material: Material type of the mesh ('standard', 'toon3', 'toon5').
                This argument is ignored when wireframe=True.
            flat_shading: Whether to do flat shading. This argument is ignored
                when wireframe=True.
            side: Side of the surface to render ('front', 'back', 'double').
            scale: Scale of the mesh. A single float for uniform scaling or a tuple
                of (x, y, z) for per-axis scaling.
            cast_shadow: Whether this mesh should cast shadows.
            receive_shadow: Whether this mesh should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this mesh is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        _warn_wireframe_conflicts(wireframe, material, flat_shading)
        message = _messages.MeshMessage(
            name=name,
            props=_messages.MeshProps(
                vertices=np.asarray(vertices, dtype=np.float32),
                faces=np.asarray(faces, dtype=np.uint32),
                color=_encode_rgb(color),
                wireframe=wireframe,
                opacity=opacity,
                flat_shading=flat_shading,
                side=side,
                material=material,
                scale=scale,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
            ),
        )
        return MeshHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_mesh_trimesh(
        self,
        name: str,
        mesh: trimesh.Trimesh,
        *,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
    ) -> GlbHandle:
        """Add a trimesh mesh to the scene. Internally calls `self.add_glb()`.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
              define a kinematic tree.
            mesh: A trimesh mesh object.
            scale: Scale for resizing the mesh. A single float for uniform scaling
                or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.
            cast_shadow: Whether this mesh should cast shadows.
            receive_shadow: Whether this mesh should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.

        Returns:
            Handle for manipulating scene node.
        """

        with io.BytesIO() as data_buffer:
            mesh.export(data_buffer, file_type="glb")
            glb_data = data_buffer.getvalue()
            return self.add_glb(
                name,
                glb_data=glb_data,
                scale=scale,
                wxyz=wxyz,
                position=position,
                visible=visible,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
            )

    @deprecated_positional_shim
    def add_batched_meshes_simple(
        self,
        name: str,
        vertices: np.ndarray,
        faces: np.ndarray,
        batched_wxyzs: tuple[tuple[float, float, float, float], ...] | np.ndarray,
        batched_positions: tuple[tuple[float, float, float], ...] | np.ndarray,
        *,
        batched_scales: tuple[float, ...] | np.ndarray | None = None,
        batched_colors: np.ndarray | RgbTupleOrArray = (90, 200, 255),
        batched_opacities: tuple[float, ...] | np.ndarray | None = None,
        lod: Literal["auto", "off"] | tuple[tuple[float, float], ...] = "auto",
        wireframe: bool = False,
        opacity: float | None = None,
        material: Literal["standard", "toon3", "toon5"] = "standard",
        flat_shading: bool = False,
        side: Literal["front", "back", "double"] = "front",
        cast_shadow: bool = True,
        receive_shadow: bool = True,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> BatchedMeshHandle:
        """Add batched meshes to the scene.

        Note:
            Batched mesh instances are optimized for rendering many instances of the
            same mesh efficiently.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            vertices: A numpy array of vertex positions. Should have shape (V, 3).
            faces: A numpy array of faces, where each face is represented by indices of
                vertices. Should have shape (F, 3).
            batched_wxyzs: Float array of shape (N, 4) for orientations.
            batched_positions: Float array of shape (N, 3) for positions.
            batched_scales: Float array of shape (N,) for uniform scales or (N,3) for per-axis (XYZ) scales. None means scale of 1.0.
            batched_colors: Colors of the mesh instances. Can be a single color as an RGB tuple
                to apply to all instances, or an np.ndarray of shape (N, 3) to specify colors
                for each instance. Defaults to (90, 200, 255).
            batched_opacities: Per-instance opacity multipliers, shape (N,). Each value is
                multiplied with the global opacity parameter. None means all instances use
                the global opacity.
            lod: LOD settings, either "off", "auto", or a tuple of (distance, ratio) pairs.
            wireframe: Boolean indicating if the meshes should be rendered as wireframes.
            opacity: Opacity of the meshes. None means opaque.
            material: Material type of the meshes ('standard', 'toon3', 'toon5').
                This argument is ignored when wireframe=True.
            flat_shading: Whether to do flat shading. This argument is ignored
                when wireframe=True.
            side: Side of the surface to render ('front', 'back', 'double').
            cast_shadow: Whether these meshes should cast shadows.
            receive_shadow: Whether these meshes should receive shadows.
            scale: Scale of the batched meshes. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not these meshes are initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        _warn_wireframe_conflicts(wireframe, material, flat_shading)

        batched_wxyzs, batched_positions, batched_scales, num_instances = (
            _validate_batched_transforms(
                batched_wxyzs, batched_positions, batched_scales
            )
        )

        # Handle batched opacities.
        if batched_opacities is not None:
            batched_opacities = np.asarray(batched_opacities, dtype=np.float32)
            assert batched_opacities.shape == (num_instances,)

        # Handle batched colors.
        batched_colors_array = None
        if batched_colors is not None:
            batched_colors_array = colors_to_uint8(np.asarray(batched_colors))
            # Validate length against the instance count (like the other
            # per-instance arrays above); otherwise a mismatched-length color
            # array is sent verbatim and the client silently drops all colors.
            assert batched_colors_array.shape in ((3,), (num_instances, 3)), (
                f"batched_colors must have shape (3,) or ({num_instances}, 3), "
                f"got {batched_colors_array.shape}."
            )

        message = _messages.BatchedMeshesMessage(
            name=name,
            props=_messages.BatchedMeshesProps(
                vertices=np.asarray(vertices, dtype=np.float32),
                faces=np.asarray(faces, dtype=np.uint32),
                batched_wxyzs=np.asarray(batched_wxyzs, dtype=np.float32),
                batched_positions=np.asarray(batched_positions, dtype=np.float32),
                batched_scales=batched_scales,
                batched_colors=batched_colors_array,
                wireframe=wireframe,
                opacity=opacity,
                flat_shading=flat_shading,
                side=side,
                material=material,
                lod=lod,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                batched_opacities=batched_opacities,
                scale=scale,
            ),
        )
        return BatchedMeshHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_batched_meshes_trimesh(
        self,
        name: str,
        mesh: trimesh.Trimesh,
        batched_wxyzs: tuple[tuple[float, float, float, float], ...] | np.ndarray,
        batched_positions: tuple[tuple[float, float, float], ...] | np.ndarray,
        *,
        batched_scales: tuple[float, ...] | np.ndarray | None = None,
        lod: Literal["auto", "off"] | tuple[tuple[float, float], ...] = "auto",
        cast_shadow: bool = True,
        receive_shadow: bool = True,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> BatchedGlbHandle:
        """Add batched trimesh meshes to the scene.

        Note:
            Batched mesh instances are optimized for rendering many instances of the
            same mesh. However, there are some limitations:
            - Animations in the GLB file are not supported
            - The node hierarchy from the GLB file is flattened
            - Each mesh in the GLB is instanced separately

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
              define a kinematic tree.
            mesh: A trimesh mesh object.
            batched_wxyzs: Float array of shape (N, 4) for orientations.
            batched_positions: Float array of shape (N, 3) for positions.
            batched_scales: Float array of shape (N,) for uniform scales or (N,3) for per-axis (XYZ) scales. None means scale of 1.0.
            lod: LOD settings, either "off", "auto", or a tuple of (distance, ratio) pairs.
            cast_shadow: Whether these meshes should cast shadows.
            receive_shadow: Whether these meshes should receive shadows.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        batched_wxyzs, batched_positions, batched_scales, _ = (
            _validate_batched_transforms(
                batched_wxyzs, batched_positions, batched_scales
            )
        )

        with io.BytesIO() as data_buffer:
            mesh.export(data_buffer, file_type="glb")
            glb_data = data_buffer.getvalue()
            message = _messages.BatchedGlbMessage(
                name=name,
                props=_messages.BatchedGlbProps(
                    glb_data=glb_data,
                    batched_wxyzs=np.asarray(batched_wxyzs, dtype=np.float32),
                    batched_positions=np.asarray(batched_positions, dtype=np.float32),
                    batched_scales=batched_scales,
                    lod=lod,
                    cast_shadow=cast_shadow,
                    receive_shadow=receive_shadow,
                    scale=scale,
                ),
            )
            return BatchedGlbHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_batched_glb(
        self,
        name: str,
        glb_data: bytes,
        batched_wxyzs: tuple[tuple[float, float, float, float], ...] | np.ndarray,
        batched_positions: tuple[tuple[float, float, float], ...] | np.ndarray,
        *,
        batched_scales: tuple[float, ...] | np.ndarray | None = None,
        lod: Literal["auto", "off"] | tuple[tuple[float, float], ...] = "auto",
        cast_shadow: bool = True,
        receive_shadow: bool = True,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> BatchedGlbHandle:
        """Add batched GLB assets to the scene.

        Note:
            Batched GLB instances are optimized for rendering many instances of the
            same GLB asset. However, there are some limitations:
            - Animations in the GLB file are not supported
            - The node hierarchy from the GLB file is flattened
            - Each mesh in the GLB is instanced separately

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
              define a kinematic tree.
            glb_data: A binary GLB payload.
            batched_wxyzs: Float array of shape (N, 4) for orientations.
            batched_positions: Float array of shape (N, 3) for positions.
            batched_scales: Float array of shape (N,) for uniform scales or (N,3) for per-axis (XYZ) scales. None means scale of 1.0.
            lod: LOD settings, either "off", "auto", or a tuple of (distance, ratio) pairs.
            cast_shadow: Whether these GLB assets should cast shadows.
            receive_shadow: Whether these GLB assets should receive shadows.
            scale: Scale of the batched GLB. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        batched_wxyzs, batched_positions, batched_scales, _ = (
            _validate_batched_transforms(
                batched_wxyzs, batched_positions, batched_scales
            )
        )

        message = _messages.BatchedGlbMessage(
            name=name,
            props=_messages.BatchedGlbProps(
                glb_data=glb_data,
                batched_wxyzs=np.asarray(batched_wxyzs, dtype=np.float32),
                batched_positions=np.asarray(batched_positions, dtype=np.float32),
                batched_scales=batched_scales,
                lod=lod,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                scale=scale,
            ),
        )
        return BatchedGlbHandle._make(self, message, name, wxyz, position, visible)

    def _add_gaussian_splats(self, *args, **kwargs) -> GaussianSplatHandle:
        """Backwards compatibility shim. Use `add_gaussian_splats()` instead."""
        return self.add_gaussian_splats(*args, **kwargs)

    @deprecated_positional_shim
    def add_gaussian_splats(
        self,
        name: str,
        centers: np.ndarray,
        covariances: np.ndarray,
        rgbs: np.ndarray,
        opacities: np.ndarray,
        *,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: Tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: Tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> GaussianSplatHandle:
        """Add a model to render using Gaussian Splatting.

        **Experimental.** This feature is experimental and still under
        development. It may be changed or removed.

        Arguments:
            name: Scene node name.
            centers: Centers of Gaussians. (N, 3).
            covariances: Second moment for each Gaussian. (N, 3, 3).
            rgbs: Color for each Gaussian. (N, 3).
            opacities: Opacity for each Gaussian. (N, 1).
            scale: Scale of the Gaussian splats. A single float for uniform
                scaling or a tuple of (x, y, z) for per-axis scaling.
            wxyz: R_parent_local transformation.
            position: t_parent_local transformation.
            visible: Initial visibility of scene node.

        Returns:
            Scene node handle.
        """
        num_gaussians = centers.shape[0]
        assert centers.shape == (num_gaussians, 3)
        assert rgbs.shape == (num_gaussians, 3)
        assert opacities.shape == (num_gaussians, 1)
        assert covariances.shape == (num_gaussians, 3, 3)

        # Get upper-triangular terms of covariance matrix.
        cov_triu = covariances.reshape((-1, 9))[:, np.array([0, 1, 2, 4, 5, 8])]
        buffer = np.concatenate(
            [
                # First texelFetch.
                # - xyz (96 bits): centers.
                np.ascontiguousarray(centers, dtype=np.float32).view(np.uint8),
                # - w (32 bits): this is reserved for use by the renderer.
                np.zeros((num_gaussians, 4), dtype=np.uint8),
                # Second texelFetch.
                # - xyz (96 bits): upper-triangular terms of covariance.
                # ascontiguousarray: .view() requires a contiguous array, and
                # cov_triu is non-contiguous from the advanced indexing above.
                np.ascontiguousarray(cov_triu, dtype=np.float16).view(np.uint8),
                # - w (32 bits): rgba.
                colors_to_uint8(rgbs),
                colors_to_uint8(opacities),
            ],
            axis=-1,
        ).view(np.uint32)
        assert buffer.shape == (num_gaussians, 8)

        message = _messages.GaussianSplatsMessage(
            name=name,
            props=_messages.GaussianSplatsProps(
                buffer=buffer,
                scale=scale,
            ),
        )
        node_handle = GaussianSplatHandle._make(
            self, message, name, wxyz, position, visible
        )
        return node_handle

    @deprecated_positional_shim
    def add_box(
        self,
        name: str,
        color: RgbTupleOrArray = (255, 0, 0),
        dimensions: tuple[float, float, float] | np.ndarray = (1.0, 1.0, 1.0),
        *,
        wireframe: bool = False,
        opacity: float | None = None,
        material: Literal["standard", "toon3", "toon5"] = "standard",
        flat_shading: bool = True,
        side: Literal["front", "back", "double"] = "front",
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> BoxHandle:
        """Add a box to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            color: Color of the box as an RGB tuple.
            dimensions: Dimensions of the box (x, y, z).
            wireframe: Boolean indicating if the box should be rendered as a wireframe.
            opacity: Opacity of the box. None means opaque.
            material: Material type of the box ('standard', 'toon3', 'toon5').
            flat_shading: Whether to do flat shading.
            side: Side of the surface to render ('front', 'back', 'double').
            cast_shadow: Whether this box should cast shadows.
            receive_shadow: Whether this box should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            scale: Scale of the box. A single float for uniform scaling or a
                tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this box is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        assert len(dimensions) == 3, f"Expected 3 dimensions, got {len(dimensions)}"
        dimensions_tuple = (
            float(dimensions[0]),
            float(dimensions[1]),
            float(dimensions[2]),
        )

        message = _messages.BoxMessage(
            name=name,
            props=_messages.BoxProps(
                dimensions=dimensions_tuple,
                color=_encode_rgb(color),
                wireframe=wireframe,
                opacity=opacity,
                flat_shading=flat_shading,
                side=side,
                material=material,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                scale=scale,
            ),
        )
        return BoxHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_icosphere(
        self,
        name: str,
        radius: float = 1.0,
        color: RgbTupleOrArray = (255, 0, 0),
        *,
        subdivisions: int = 3,
        scale: float | tuple[float, float, float] = 1.0,
        wireframe: bool = False,
        opacity: float | None = None,
        material: Literal["standard", "toon3", "toon5"] = "standard",
        flat_shading: bool = False,
        side: Literal["front", "back", "double"] = "front",
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> IcosphereHandle:
        """Add an icosphere to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            radius: Radius of the icosphere.
            color: Color of the icosphere as an RGB tuple.
            subdivisions: Number of subdivisions to use when creating the icosphere.
            wireframe: Boolean indicating if the icosphere should be rendered as a wireframe.
            scale: Scale of the icosphere. A single float for uniform scaling
                or a tuple of (x, y, z) for per-axis scaling.
            opacity: Opacity of the icosphere. None means opaque.
            material: Material type of the icosphere ('standard', 'toon3', 'toon5').
            flat_shading: Whether to do flat shading.
            side: Side of the surface to render ('front', 'back', 'double').
            cast_shadow: Whether this icosphere should cast shadows.
            receive_shadow: Whether this icosphere should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this icosphere is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        message = _messages.IcosphereMessage(
            name=name,
            props=_messages.IcosphereProps(
                radius=radius,
                subdivisions=subdivisions,
                color=_encode_rgb(color),
                scale=scale,
                wireframe=wireframe,
                opacity=opacity,
                flat_shading=flat_shading,
                side=side,
                material=material,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
            ),
        )
        return IcosphereHandle._make(self, message, name, wxyz, position, visible)

    @deprecated_positional_shim
    def add_cylinder(
        self,
        name: str,
        radius: float = 1.0,
        height: float = 1.0,
        color: RgbTupleOrArray = (255, 0, 0),
        *,
        radial_segments: int = 32,
        wireframe: bool = False,
        opacity: float | None = None,
        material: Literal["standard", "toon3", "toon5"] = "standard",
        flat_shading: bool = False,
        side: Literal["front", "back", "double"] = "front",
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> CylinderHandle:
        """Add a cylinder to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            radius: Radius of the cylinder.
            height: Height of the cylinder.
            color: Color of the cylinder as an RGB tuple.
            radial_segments: Number of segmented faces around the circumference of the cylinder.
            wireframe: Boolean indicating if the cylinder should be rendered as a wireframe.
            opacity: Opacity of the cylinder. None means opaque.
            material: Material type of the cylinder ('standard', 'toon3', 'toon5').
            flat_shading: Whether to do flat shading.
            side: Side of the surface to render ('front', 'back', 'double').
            cast_shadow: Whether this cylinder should cast shadows.
            receive_shadow: Whether this cylinder should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            scale: Scale of the cylinder. A single float for uniform scaling or a
                tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this cylinder is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        message = _messages.CylinderMessage(
            name=name,
            props=_messages.CylinderProps(
                radius=radius,
                height=height,
                color=_encode_rgb(color),
                radial_segments=radial_segments,
                wireframe=wireframe,
                opacity=opacity,
                flat_shading=flat_shading,
                side=side,
                material=material,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                scale=scale,
            ),
        )
        return CylinderHandle._make(self, message, name, wxyz, position, visible)

    def set_background_image(
        self,
        image: np.ndarray | None,
        format: Literal["auto", "png", "jpeg"] = "auto",
        *,
        jpeg_quality: int | None = None,
        depth: np.ndarray | None = None,
    ) -> None:
        """Set a background image for the scene, optionally with depth compositing.

        Args:
            image: The image to set as the background. Should have shape (H, W, 3).
            format: Format to transport and display the image using. 'auto' will use PNG for RGBA images and JPEG for RGB.
            jpeg_quality: Quality of the jpeg image (if jpeg format is used).
            depth: Optional depth image to use to composite background with scene elements.
        """
        if image is None:
            resolved_format = "png" if format == "auto" else format
            rgb_bytes = None
        else:
            resolved_format, rgb_bytes = _encode_image_binary(
                image, format, jpeg_quality=jpeg_quality
            )

        # Encode depth if provided. We use a 3-channel PNG to represent a fixed point
        # depth at each pixel.
        depth_bytes = None
        if depth is not None:
            # Convert to fixed-point.
            # We'll support from 0 -> (2^24 - 1) / 100_000.
            #
            # This translates to a range of [0, 167.77215], with a precision of 1e-5.
            assert len(depth.shape) == 2 or (
                len(depth.shape) == 3 and depth.shape[2] == 1
            ), "Depth should have shape (H,W) or (H,W,1)."
            depth = np.clip(depth * 100_000, 0, 2**24 - 1).astype(np.uint32)
            assert depth is not None  # Appease mypy.
            intdepth: np.ndarray = depth.reshape((*depth.shape[:2], 1)).view(np.uint8)
            assert intdepth.shape == (*depth.shape[:2], 4)

            # cv2 expects BGR format, so we'll need to re-order on the client
            # side. This will compromise performance slightly if OpenCV is not
            # installed.
            depth_bgr = intdepth
            depth_bytes = cv2_imencode_with_fallback(
                "png", depth_bgr, jpeg_quality=None, channel_ordering="bgr"
            )

        self._websock_interface.queue_message(
            _messages.BackgroundImageMessage(
                format=resolved_format,
                rgb_data=rgb_bytes,
                depth_data=depth_bytes,
            )
        )

    @deprecated_positional_shim
    def add_image(
        self,
        name: str,
        image: np.ndarray,
        render_width: float,
        render_height: float,
        *,
        format: Literal["auto", "png", "jpeg"] = "auto",
        jpeg_quality: int | None = None,
        cast_shadow: bool = True,
        receive_shadow: bool | float = True,
        scale: float | tuple[float, float, float] = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> ImageHandle:
        """Add a 2D image to the scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            image: A numpy array representing the image.
            render_width: Width at which the image should be rendered in the scene.
            render_height: Height at which the image should be rendered in the scene.
            format: Format to transport and display the image using. 'auto' will use PNG for RGBA images and JPEG for RGB.
            jpeg_quality: Quality of the jpeg image (if jpeg format is used).
            cast_shadow: Whether this image should cast shadows.
            receive_shadow: Whether this image should receive shadows. If True,
                receives shadows normally. If False, no shadows. If a float
                (0-1), shadows are rendered with a fixed opacity regardless of
                lighting conditions.
            scale: Scale of the image. A single float for uniform scaling or a
                tuple of (x, y, z) for per-axis scaling.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this image is initially visible.

        Returns:
            Handle for manipulating scene node.
        """
        resolved_format, binary = _encode_image_binary(
            image, format, jpeg_quality=jpeg_quality
        )
        message = _messages.ImageMessage(
            name=name,
            props=_messages.ImageProps(
                _format=resolved_format,
                _data=binary,
                render_width=render_width,
                render_height=render_height,
                cast_shadow=cast_shadow,
                receive_shadow=receive_shadow,
                scale=scale,
            ),
        )
        handle = ImageHandle._make(self, message, name, wxyz, position, visible)
        handle._image = image
        handle._jpeg_quality = jpeg_quality
        handle._user_format = format
        return handle

    @deprecated_positional_shim
    def add_transform_controls(
        self,
        name: str,
        scale: float = 1.0,
        *,
        line_width: float = 2.5,
        fixed: bool = False,
        active_axes: tuple[bool, bool, bool] = (True, True, True),
        disable_axes: bool = False,
        disable_sliders: bool = False,
        disable_rotations: bool = False,
        translation_limits: tuple[
            tuple[float, float], tuple[float, float], tuple[float, float]
        ] = ((-1000.0, 1000.0), (-1000.0, 1000.0), (-1000.0, 1000.0)),
        rotation_limits: tuple[
            tuple[float, float], tuple[float, float], tuple[float, float]
        ] = ((-1000.0, 1000.0), (-1000.0, 1000.0), (-1000.0, 1000.0)),
        depth_test: bool = True,
        opacity: float = 1.0,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> TransformControlsHandle:
        """Add a transform gizmo for interacting with the scene.

        This method adds a transform control (gizmo) to the scene, allowing for interactive
        manipulation of objects in terms of their position, rotation, and scale.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            scale: Scale of the transform controls.
            line_width: Width of the lines used in the gizmo.
            fixed: Boolean indicating if the gizmo should be fixed in position.
            active_axes: Tuple of booleans indicating active axes.
            disable_axes: Boolean to disable axes interaction. These are used
                for translation in the X, Y, or Z directions.
            disable_sliders: Boolean to disable slider interaction. These are
                used for translation on the XY, YZ, or XZ planes.
            disable_rotations: Boolean to disable rotation interaction. These
                are used for rotation around the X, Y, or Z axes.
            translation_limits: Limits for translation.
            rotation_limits: Limits for rotation.
            depth_test: Boolean indicating if depth testing should be used when
                rendering. Setting to False can be used to render the gizmo
                event when occluded by other objects.
            opacity: Opacity of the gizmo.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation from parent frame to local frame (t_pl).
            visible: Whether or not this gizmo is initially visible.

        Returns:
            Handle for manipulating (and reading state of) scene node.
        """
        # Normalize the name up front so the node map, the transform-controls
        # registry, and the pose-sync messages below all key off the same
        # (leading-slash) name the client uses.
        name = _normalize_node_name(name)

        message = _messages.TransformControlsMessage(
            name=name,
            props=_messages.TransformControlsProps(
                scale=scale,
                line_width=line_width,
                fixed=fixed,
                active_axes=active_axes,
                disable_axes=disable_axes,
                disable_sliders=disable_sliders,
                disable_rotations=disable_rotations,
                translation_limits=translation_limits,
                rotation_limits=rotation_limits,
                depth_test=depth_test,
                opacity=opacity,
            ),
        )

        def sync_cb(client_id: ClientId, state: TransformControlsHandle) -> None:
            message_orientation = _messages.SetOrientationMessage(
                name=name,
                wxyz=tuple(map(float, state._impl.wxyz)),  # type: ignore
            )
            message_orientation.excluded_self_client = client_id
            self._websock_interface.queue_message(message_orientation)

            message_position = _messages.SetPositionMessage(
                name=name,
                position=tuple(map(float, state._impl.position)),  # type: ignore
            )
            message_position.excluded_self_client = client_id
            self._websock_interface.queue_message(message_position)

        node_handle = SceneNodeHandle._make(
            self, message, name, wxyz, position, visible
        )
        state_aux = _TransformControlsState(
            last_updated=time.time(),
            update_cb=[],
            sync_cb=sync_cb,
        )
        handle = TransformControlsHandle(node_handle._impl, state_aux)
        # Store the typed handle (not the plain SceneNodeHandle from `_make`) in
        # the node map so removal via `reset()` / re-add dedup goes through the
        # same path that cleans up the transform-controls registry. Under the
        # lifecycle lock, and only while the registry still points at the
        # handle _make just registered: a concurrent remove()/reset() or
        # same-name re-add in the gap must not have its result overwritten
        # with a dead handle.
        with self._node_lifecycle_lock:
            if self._handle_from_node_name.get(name) is node_handle:
                self._handle_from_transform_controls_name[name] = handle
                self._handle_from_node_name[name] = handle
        return handle

    def reset(self) -> None:
        """Reset the scene."""

        # Remove all scene nodes.
        handles = list(self._handle_from_node_name.values())
        for handle in handles:
            if handle.name == "/WorldAxes":
                continue
            # Skip handles already removed by cascading.
            if handle._impl.removed:
                continue
            handle.remove()

        # Clear the background image.
        self.set_background_image(image=None)

    def _get_client_handle(self, client_id: ClientId) -> ClientHandle:
        """Private helper for getting a client handle from its ID."""
        # Avoid circular imports.
        from ._viser import ViserServer

        # Implementation-wise, note that MessageApi is never directly instantiated.
        # Instead, it serves as a mixin/base class for either ViserServer, which
        # maintains a registry of connected clients, or ClientHandle, which should
        # only ever be dealing with its own client_id.
        if isinstance(self._owner, ViserServer):
            handle = self._owner._connected_clients.get(client_id)
            if handle is None:
                # A client mid-teardown is no longer publicly listed, but the
                # synthesized drag-end events dispatched during its disconnect
                # still need to resolve ``event.client``.
                handle = self._owner._disconnecting_clients.get(client_id)
            if handle is None:
                raise KeyError(f"No connected client with id {client_id}.")
            return handle
        else:
            assert client_id == self._owner.client_id
            return self._owner

    async def _handle_transform_controls_updates(
        self, client_id: ClientId, message: _messages.TransformControlsUpdateMessage
    ) -> None:
        """Apply pose update and fire `update_cb` with phase="update"."""
        # Prefer the active-drag map so a late update still resolves after the
        # gizmo was removed mid-drag (which pops it from the live registry).
        handle = self._active_transform_drag_handles.get(
            (client_id, message.name)
        ) or self._handle_from_transform_controls_name.get(message.name, None)
        if handle is None:
            return

        handle._impl.wxyz = np.array(message.wxyz)
        handle._impl.position = np.array(message.position)
        handle._impl_aux.last_updated = time.time()

        await self._fire_transform_controls_callbacks(client_id, handle, "update")
        # Fire the callback even for a removed gizmo (late update during teardown),
        # but skip the cross-client pose broadcast: sync_cb queues PERSISTENT
        # Set{Orientation,Position} messages keyed by node name, which would
        # linger in the broadcast buffer for the removed name (the
        # RemoveSceneNodeMessage uses a different redundancy key and won't purge
        # them) and corrupt the pose of a future same-name node.
        if handle._impl_aux.sync_cb is not None and not handle._impl.removed:
            handle._impl_aux.sync_cb(client_id, handle)

    async def _handle_transform_controls_drag_start(
        self, client_id: ClientId, message: _messages.TransformControlsDragStartMessage
    ) -> None:
        handle = self._handle_from_transform_controls_name.get(message.name, None)
        if handle is None:
            return
        self._active_transform_drag_handles[(client_id, message.name)] = handle
        await self._fire_transform_controls_callbacks(client_id, handle, "start")

    async def _handle_transform_controls_drag_end(
        self, client_id: ClientId, message: _messages.TransformControlsDragEndMessage
    ) -> None:
        handle = self._active_transform_drag_handles.pop(
            (client_id, message.name), None
        ) or self._handle_from_transform_controls_name.get(message.name, None)
        if handle is None:
            return
        await self._fire_transform_controls_callbacks(client_id, handle, "end")

    async def _fire_transform_controls_callbacks(
        self,
        client_id: ClientId,
        handle: TransformControlsHandle,
        phase: DragPhase,
    ) -> None:
        event = TransformControlsEvent(
            client=self._get_client_handle(client_id),
            client_id=client_id,
            target=handle,
            phase=phase,
        )
        for cb in handle._impl_aux.update_cb:
            await self._dispatch_callback(cb, event)

    async def _dispatch_callback(
        self,
        cb: Callable[[Any], None | Coroutine],
        event: Any,
    ) -> None:
        """Run a user callback either via ``await`` (async) or via the
        thread pool (sync). Exceptions are reported and isolated in BOTH
        branches (print_awaited_callback_error / print_threadpool_errors):
        one throwing callback must not starve its sibling callbacks or
        abort the caller (message dispatch, disconnect teardown)."""
        if asyncio.iscoroutinefunction(cb):
            try:
                await cb(event)
            except Exception as exc:
                print_awaited_callback_error(exc)
        else:
            self._thread_executor.submit(cb, event).add_done_callback(
                print_threadpool_errors
            )

    async def _handle_node_click_updates(
        self, client_id: ClientId, message: _messages.SceneNodeClickMessage
    ) -> None:
        """Callback for handling click messages."""
        handle = self._handle_from_node_name.get(message.name, None)
        if handle is None or handle._impl.click_cb is None:
            return
        event = SceneNodePointerEvent(
            client=self._get_client_handle(client_id),
            client_id=client_id,
            event="click",
            target=cast(_RaycastSupportedSceneNodeHandle, handle),
            ray_origin=message.ray_origin,
            ray_direction=message.ray_direction,
            screen_pos=message.screen_pos,
            instance_index=message.instance_index,
            modifier=message.modifier,
        )
        # Snapshot the list -- a callback may register/remove other
        # callbacks during dispatch; mutations should not affect the
        # in-flight iteration.
        for entry in list(handle._impl.click_cb):
            if not _modifier_matches_filter(message.modifier, entry.modifier):
                continue
            await self._dispatch_callback(entry.callback, event)

    async def _handle_node_drag(
        self,
        client_id: ClientId,
        message: _messages.SceneNodeDragMessage,
    ) -> None:
        """Dispatch a scene-node drag start/update/end message to matching
        callbacks.

        Note on ordering: sync callbacks are submitted to a thread pool
        fire-and-forget, so two drags messages dispatched back-to-back
        (e.g. start + update) can race -- the update's callback may run
        before the start's callback finishes, leaving user state
        half-initialized. Async callbacks are awaited in order and don't
        have this issue, so for stateful gestures define your callbacks
        as ``async def`` (with no internal ``await`` s, so each runs
        atomically on the event loop)."""
        # On phase="start", look up the handle in the live registry and
        # remember it (with the message, so a synthetic end on
        # disconnect can carry the latest positions). On update, refresh
        # the stored message. On update/end, prefer the active-drag map
        # so we can still dispatch even if the node was removed
        # mid-drag -- the user's on_drag_end MUST fire so per-drag state
        # can be released. The active-drag entry is always cleared on
        # ``end``, even when dispatch falls through.
        active_key = (client_id, message.name)
        handle: SceneNodeHandle | None
        if message.phase == "start":
            handle = self._handle_from_node_name.get(message.name, None)
            if isinstance(handle, _RaycastSupportedSceneNodeHandle):
                self._active_drag_handles[active_key] = (handle, message)
        else:
            entry = self._active_drag_handles.get(active_key)
            if entry is not None:
                handle = entry[0]
                if message.phase == "update":
                    self._active_drag_handles[active_key] = (handle, message)
            else:
                handle = self._handle_from_node_name.get(message.name, None)
        if message.phase == "end":
            self._active_drag_handles.pop(active_key, None)
        if not isinstance(handle, _RaycastSupportedSceneNodeHandle):
            return

        await self._dispatch_drag_callbacks(client_id, handle, message)

    async def _dispatch_drag_callbacks(
        self,
        client_id: ClientId,
        handle: _RaycastSupportedSceneNodeHandle,
        message: _messages.SceneNodeDragMessage,
    ) -> None:
        """Run all matching ``handle`` drag callbacks for ``message``.

        Shared by ``_handle_node_drag`` (live messages) and
        ``_drop_active_drags_for_client`` (synthetic end on disconnect)."""
        input = _DragInput(button=message.button, modifier=message.modifier)
        matching = handle._dispatch_drag(input)
        if not matching:
            return

        event = SceneNodeDragEvent(
            client=self._get_client_handle(client_id),
            client_id=client_id,
            target=cast(_RaycastSupportedSceneNodeHandle, handle),
            phase=message.phase,
            instance_index=message.instance_index,
            start_position=message.start_position,
            start_screen_pos=message.start_screen_pos,
            end_position=message.end_position,
            end_screen_pos=message.end_screen_pos,
            button=message.button,
            modifier=message.modifier,
        )
        for cb in matching:
            await self._dispatch_callback(cb, event)

    async def _handle_scene_pointer_updates(
        self, client_id: ClientId, message: _messages.ScenePointerMessage
    ):
        """Dispatch a scene-level click or rect-select to matching
        callbacks (new typed APIs and legacy ``on_pointer_event``)."""
        if not self._scene_pointer_cb:
            return
        client = self._get_client_handle(client_id)
        modifier = message.modifier

        # Build the typed event once for the actual gesture; the legacy
        # union-shape event is also built once. ``ScenePointerEvent``
        # remains a separate path because it lumps clicks and rect-
        # selects into one shape with Optional ray fields.
        typed_event: SceneClickEvent | SceneRectSelectEvent
        if message.event_type == "click":
            assert message.ray_origin is not None
            assert message.ray_direction is not None
            typed_event = SceneClickEvent(
                client=client,
                client_id=client_id,
                ray_origin=message.ray_origin,
                ray_direction=message.ray_direction,
                screen_pos=message.screen_pos[0],
                modifier=modifier,
            )
        else:
            typed_event = SceneRectSelectEvent(
                client=client,
                client_id=client_id,
                screen_min=message.screen_pos[0],
                screen_max=message.screen_pos[1],
                modifier=modifier,
            )
        legacy_event = ScenePointerEvent(
            client=client,
            client_id=client_id,
            event_type=message.event_type,
            ray_origin=message.ray_origin,
            ray_direction=message.ray_direction,
            screen_pos=message.screen_pos,
            modifier=modifier,
        )

        # Snapshot the list -- a callback may register/remove other
        # callbacks during dispatch; mutations should not affect the
        # in-flight iteration.
        for entry in list(self._scene_pointer_cb):
            if entry.event_type != message.event_type:
                continue
            if not _modifier_matches_filter(modifier, entry.modifier):
                continue
            event = (
                legacy_event if entry.event_class is ScenePointerEvent else typed_event
            )
            await self._dispatch_callback(entry.callback, event)

    def on_click(
        self,
        *,
        modifier: _messages.KeyModifier | None = None,
    ) -> Callable[
        [Callable[[SceneClickEvent], None]], Callable[[SceneClickEvent], None]
    ]:
        """Register a callback for clicks anywhere in the scene
        (background and meshes both, after the per-node ``on_click``
        for any clickable mesh under the cursor).

        Multiple callbacks can be registered. Each fires only when its
        ``modifier`` filter matches the modifiers held at click time.

        Args:
            modifier: Modifier-combo filter. Default ``None`` matches
                "no modifiers held". ``"cmd/ctrl"``, ``"shift"``,
                ``"cmd/ctrl+shift"``, etc. are exact matches (listed
                modifiers held, others not). ``cmd/ctrl`` matches
                whenever either Cmd or Ctrl is held.
        """
        return self._register_scene_pointer_callback("click", modifier, SceneClickEvent)

    def on_rect_select(
        self,
        *,
        modifier: _messages.KeyModifier | None = None,
    ) -> Callable[
        [Callable[[SceneRectSelectEvent], None]],
        Callable[[SceneRectSelectEvent], None],
    ]:
        """Register a callback for rectangle-select gestures (drag a
        box on the canvas).

        Multiple callbacks can be registered. Each fires only when its
        ``modifier`` filter matches the modifiers held at gesture
        start. The selection rectangle is drawn on the canvas only
        when the held modifiers match at least one registered
        callback's filter.

        Args:
            modifier: See :meth:`on_click` for semantics.
        """
        return self._register_scene_pointer_callback(
            "rect-select", modifier, SceneRectSelectEvent
        )

    @deprecated(
        "Use on_click() (with SceneClickEvent) or on_rect_select() "
        "(with SceneRectSelectEvent) instead."
    )
    def on_pointer_event(
        self,
        event_type: Literal["click", "rect-select"],
        *,
        modifier: _messages.KeyModifier | None = None,
    ) -> Callable[
        [Callable[[ScenePointerEvent], None]], Callable[[ScenePointerEvent], None]
    ]:
        """Legacy registration that hands callbacks the union-shaped
        :class:`ScenePointerEvent`. Single-slot semantics: re-registering
        replaces the existing pointer callback (and fires any pending
        :meth:`on_pointer_callback_removed` cleanups).

        .. deprecated::
            Use :meth:`on_click` or :meth:`on_rect_select` instead.
            They produce the typed :class:`SceneClickEvent` /
            :class:`SceneRectSelectEvent` and accept multiple
            coexisting callbacks.
        """
        register = self._register_scene_pointer_callback(
            event_type, modifier, ScenePointerEvent
        )

        def decorator(
            func: Callable[[ScenePointerEvent], None],
        ) -> Callable[[ScenePointerEvent], None]:
            # Preserve legacy "one pointer callback at a time" semantic
            # -- replace any prior on_pointer_event/on_click/on_rect_select
            # registrations and fire their cleanup hooks before adding.
            self._remove_all_pointer_callbacks()
            return register(func)

        return decorator

    def _register_scene_pointer_callback(
        self,
        event_type: _messages.ScenePointerEventType,
        modifier: _messages.KeyModifier | None,
        event_class: type,
    ) -> Any:
        normalized_modifier = _messages._normalize_key_modifier(modifier)

        from ._viser import ClientHandle, ViserServer

        def decorator(func: Callable[[Any], None]) -> Callable[[Any], None]:
            # Server-scope and client-scope share the same client-side
            # enable toggle. Coexistence would let one scope's
            # disable silently deactivate the other's callbacks;
            # enforce exclusivity instead.
            if isinstance(self._owner, ViserServer):
                for client in self._owner.get_clients().values():
                    client.scene._remove_all_pointer_callbacks()
            elif isinstance(self._owner, ClientHandle):
                self._owner._viser_server.scene._remove_all_pointer_callbacks()

            self._scene_pointer_cb.append(
                _PointerCallbackEntry(
                    callback=func,
                    event_type=event_type,
                    modifier=normalized_modifier,
                    event_class=event_class,
                )
            )
            self._sync_scene_pointer_filters(event_type)
            return func

        return decorator

    def _sync_scene_pointer_filters(
        self, event_type: _messages.ScenePointerEventType
    ) -> None:
        """Send the current modifier-filter set for ``event_type`` to the
        client. An empty set disables the event type. Duplicates are
        collapsed -- multiple callbacks under the same filter only need
        one wire entry to gate gesture engagement."""
        modifiers = cast(
            Tuple[Optional[_messages.KeyModifier], ...],
            tuple(
                {
                    entry.modifier
                    for entry in self._scene_pointer_cb
                    if entry.event_type == event_type
                }
            ),
        )
        self._websock_interface.queue_message(
            _messages.ScenePointerEnableMessage(
                event_type=event_type, modifiers=modifiers
            )
        )

    @deprecated(
        "Run cleanup inline right after remove_click_callback() / "
        "remove_rect_select_callback() instead."
    )
    def on_pointer_callback_removed(
        self,
        func: Callable[[], NoneOrCoroutine],
    ) -> Callable[[], NoneOrCoroutine]:
        """Add a cleanup callback fired when the scene pointer
        registration list becomes empty.

        .. deprecated::
            Paired with the deprecated :meth:`on_pointer_event` /
            :meth:`remove_pointer_callback`. With :meth:`on_click` /
            :meth:`on_rect_select` (which can coexist) and
            :meth:`remove_click_callback` /
            :meth:`remove_rect_select_callback`, run cleanup inline
            right after the per-event removal.

        Args:
            func: Callback for when scene pointer events are removed.
        """
        self._scene_pointer_done_cb.append(func)
        return func

    def remove_click_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove scene-level click callbacks registered via
        :meth:`on_click`. Pass a specific function to remove just that
        registration, or ``"all"`` to clear every click registration."""
        self._remove_pointer_callback("click", callback)

    def remove_rect_select_callback(
        self, callback: Literal["all"] | Callable = "all"
    ) -> None:
        """Remove rect-select callbacks registered via
        :meth:`on_rect_select`. Pass a specific function to remove just
        that registration, or ``"all"`` to clear every rect-select
        registration."""
        self._remove_pointer_callback("rect-select", callback)

    def _remove_pointer_callback(
        self,
        event_type: _messages.ScenePointerEventType,
        callback: Literal["all"] | Callable,
    ) -> None:
        before = len(self._scene_pointer_cb)
        if callback == "all":
            self._scene_pointer_cb = [
                entry
                for entry in self._scene_pointer_cb
                if entry.event_type != event_type
            ]
        else:
            self._scene_pointer_cb = [
                entry
                for entry in self._scene_pointer_cb
                if not (entry.event_type == event_type and entry.callback == callback)
            ]
        if len(self._scene_pointer_cb) == before:
            return
        self._sync_scene_pointer_filters(event_type)
        # Fire cleanup callbacks once the user's last registration is
        # gone -- same teardown contract as the legacy
        # ``remove_pointer_callback()`` path.
        if not self._scene_pointer_cb:
            self._fire_scene_pointer_done_callbacks()

    @deprecated("Use remove_click_callback() or remove_rect_select_callback() instead.")
    def remove_pointer_callback(
        self,
    ) -> None:
        """Remove all attached scene pointer event callbacks. This will
        trigger any callback attached to
        :meth:`on_pointer_callback_removed()`.

        .. deprecated::
            Paired with the deprecated :meth:`on_pointer_event`. Use
            :meth:`remove_click_callback` and/or
            :meth:`remove_rect_select_callback` for the per-event-type
            equivalents.
        """
        self._remove_all_pointer_callbacks()

    def _remove_all_pointer_callbacks(self) -> None:
        if not self._scene_pointer_cb:
            return

        # Empty the callback list, then sync the disable for every
        # event_type that had at least one entry.
        seen_event_types: set[_messages.ScenePointerEventType] = {
            entry.event_type for entry in self._scene_pointer_cb
        }
        self._scene_pointer_cb = []
        for event_type in seen_event_types:
            self._sync_scene_pointer_filters(event_type)
        self._owner.flush()
        self._fire_scene_pointer_done_callbacks()

    def _fire_scene_pointer_done_callbacks(self) -> None:
        # Snapshot -- each cleanup may unregister itself via the same
        # handle without breaking iteration. Exceptions are reported and
        # isolated like every other callback path: one throwing cleanup
        # must not starve its siblings or leave the list uncleared.
        for cleanup in list(self._scene_pointer_done_cb):
            if asyncio.iscoroutinefunction(cleanup):
                task = self._event_loop.create_task(cleanup())
                task.add_done_callback(
                    lambda t: (
                        print_awaited_callback_error(t.exception())  # type: ignore[arg-type]
                        if not t.cancelled() and t.exception() is not None
                        else None
                    )
                )
            else:
                try:
                    cleanup()
                except Exception as exc:
                    print_awaited_callback_error(exc)
        self._scene_pointer_done_cb = []

    @deprecated_positional_shim
    def add_3d_gui_container(
        self,
        name: str,
        *,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
        visible: bool = True,
    ) -> Gui3dContainerHandle:
        """Add a 3D gui container to the scene. The returned container handle can be
        used as a context to place GUI elements into the 3D scene.

        Args:
            name: A scene tree name. Names in the format of /parent/child can be used to
                define a kinematic tree.
            wxyz: Quaternion rotation to parent frame from local frame (R_pl).
            position: Translation to parent frame from local frame (t_pl).
            visible: Whether or not this scene node is initially visible.

        Returns:
            Handle for manipulating scene node. Can be used as a context to place GUI
            elements inside of the container.
        """

        # Avoids circular import.
        from ._gui_handles import _make_uuid

        # New name to make the type checker happy; ViserServer and ClientHandle inherit
        # from both GuiApi and MessageApi. The pattern below is unideal.
        gui_api = self._owner.gui

        # Normalize the name so the dedup check below matches the (leading-slash)
        # key the node map actually uses.
        name = _normalize_node_name(name)

        # Remove the 3D GUI container if it already exists. This will make sure
        # contained GUI elements are removed, preventing potential memory leaks.
        if name in self._handle_from_node_name:
            self._handle_from_node_name[name].remove()

        container_id = _make_uuid()
        message = _messages.Gui3DMessage(
            name=name,
            props=_messages.Gui3DProps(
                order=time.time(),
                container_uuid=container_id,
            ),
        )
        node_handle = SceneNodeHandle._make(
            self, message, name, wxyz, position, visible=visible
        )
        handle = Gui3dContainerHandle(node_handle._impl, gui_api, container_id)
        # Store the typed handle (not the plain SceneNodeHandle from `_make`) in
        # the node map so removal via `reset()` / re-add dedup / cascading parent
        # removal cleans up the container's GUI children and registry entry.
        # Under the lifecycle lock, and only while the registry still points
        # at the handle _make just registered: a concurrent remove()/reset()
        # or same-name re-add in the gap must not have its result overwritten
        # with a dead handle.
        with self._node_lifecycle_lock:
            if self._handle_from_node_name.get(name) is node_handle:
                self._handle_from_node_name[name] = handle
        return handle

    def get_handle_by_name(self, name: str) -> SceneNodeHandle | None:
        """Get the scene node handle for the given `name`, if it exists.

        .. warning::
            We recommend holding onto the handle returned by the original
            ``add_*()`` call instead of using this method. This method returns
            a generic :class:`SceneNodeHandle`, so subclass-specific properties
            and methods won't be type-checked.

        Args:
            name: Name of the scene node.

        Returns:
            Scene node handle, or None if no such node exists.
        """
        return self._handle_from_node_name.get(_normalize_node_name(name), None)

    def remove_by_name(self, name: str) -> None:
        """Remove the scene node with the given `name` and any of its children.

        .. warning::
            We recommend holding onto the handle returned by the original
            ``add_*()`` call and calling :meth:`SceneNodeHandle.remove()`
            directly instead of using this method.
        """
        name = _normalize_node_name(name.rstrip("/"))  # '/parent/' => '/parent'
        handle = self._handle_from_node_name.get(name)
        if handle is not None:
            handle.remove()

    def as_html(self, dark_mode: bool = False) -> str:
        """Get a standalone HTML string for the current scene.

        Returns a self-contained HTML document that can be saved to a file
        or embedded in other contexts.

        This method is only available when called on ``server.scene``, not on
        individual client scene APIs.

        See also :meth:`viser.infra.StateSerializer.as_html()`.

        Args:
            dark_mode: Use dark color scheme.

        Returns:
            A complete HTML document as a string.
        """
        from ._viser import ViserServer

        assert isinstance(self._owner, ViserServer), (
            "as_html() is only available on server.scene, not on client scene APIs."
        )

        # Clear any previous recording state to allow multiple calls.
        self._owner._websock_server._record_handles.clear()

        return self._owner.get_scene_serializer().as_html(dark_mode)

    def show(self, height: int = 400, dark_mode: bool = False) -> None:
        """Display the scene in a Jupyter notebook or web browser.

        In Jupyter notebooks/labs, displays an inline IFrame with the embedded
        scene. When running as a script, opens the visualization in the default
        web browser.

        This method is only available when called on ``server.scene``, not on
        individual client scene APIs.

        See also :meth:`viser.infra.StateSerializer.show()`, which can also be
        used for dynamic scenes.

        Args:
            height: Height of the embedded viewer in pixels.
            dark_mode: Use dark color scheme.
        """
        from ._viser import ViserServer

        assert isinstance(self._owner, ViserServer), (
            "show() is only available on server.scene, not on client scene APIs."
        )

        # Clear any previous recording state to allow multiple show() calls.
        self._owner._websock_server._record_handles.clear()

        self._owner.get_scene_serializer().show(height, dark_mode)
