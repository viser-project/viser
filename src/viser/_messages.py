"""Message type definitions. For synchronization with the TypeScript definitions, see
`_typescript_interface_gen.py.`"""

from __future__ import annotations

import dataclasses
import uuid
from typing import Any, ClassVar, Dict, Optional, Tuple, Type, TypeVar, Union

import numpy as np
import numpy.typing as npt
from typing_extensions import Literal, override

from . import infra, theme, uplot


@dataclasses.dataclass(frozen=True)
class GuiSliderMark:
    value: float
    label: Optional[str]


LiteralColor = Literal[
    "dark",
    "gray",
    "red",
    "pink",
    "grape",
    "violet",
    "indigo",
    "blue",
    "cyan",
    "green",
    "lime",
    "yellow",
    "orange",
    "teal",
]


TagLiteral = Literal["GuiComponentMessage", "SceneNodeMessage"]

LabelAnchor = Literal[
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center-center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]


class Message(infra.Message):
    _tags: ClassVar[Tuple[TagLiteral, ...]] = tuple()

    @override
    def redundancy_key(self) -> str:
        """Returns a unique key for this message, used for detecting redundant
        messages.

        For example: if we send 1000 GUI value updates for the same GUI
        element, we should only keep the latest message.
        """
        parts = [type(self).__name__]

        # Scene node manipulation messages all have a "name" field.
        node_name = getattr(self, "name", None)
        if node_name is not None:
            parts.append(node_name)

        # GUI and notification messages all have an "uuid" field.
        node_name = getattr(self, "uuid", None)
        if node_name is not None:
            parts.append(node_name)

        return "_".join(parts)

    @classmethod
    def __init_subclass__(cls, tag: TagLiteral | None = None):
        """Tag will be used to create a union type in TypeScript."""
        super().__init_subclass__()
        if tag is not None:
            cls._tags = cls._tags + (tag,)


@dataclasses.dataclass
class _CreateSceneNodeMessage(Message, tag="SceneNodeMessage"):
    name: str

    @override
    def redundancy_key(self) -> str:
        """All scene nodes will have the same redundancy key."""
        return f"create-or-remove-scene-{self.name}"


@dataclasses.dataclass
class RemoveSceneNodeMessage(Message):
    """Remove a particular node from the scene."""

    name: str

    @override
    def redundancy_key(self) -> str:
        # This is intentionally the same as the redundancy key for
        # _CreateSceneNodeMessage: this way, when we remove a scene node the
        # message for creating the scene node will automatically be culled.
        return f"create-or-remove-scene-{self.name}"


@dataclasses.dataclass
class _CreateGuiComponentMessage(Message, tag="GuiComponentMessage"):
    uuid: str

    @override
    def redundancy_key(self) -> str:
        return f"create-or-remove-gui-{self.uuid}"


@dataclasses.dataclass
class GuiRemoveMessage(Message):
    """Sent server->client to remove a GUI element."""

    uuid: str

    @override
    def redundancy_key(self) -> str:
        # Intentionally the same as the redundancy key for
        # _CreateGuiComponentMessage.
        return f"create-or-remove-gui-{self.uuid}"


T = TypeVar("T", bound=Type[Message])


@dataclasses.dataclass
class RunJavascriptMessage(Message):
    """Message for running some arbitrary Javascript on the client.
    We use this to set up the Plotly.js package, via the plotly.min.js source
    code."""

    source: str

    @override
    def redundancy_key(self) -> str:
        # Never cull these messages.
        return str(uuid.uuid4())


@dataclasses.dataclass
class NotificationMessage(Message):
    """Notification message."""

    mode: Literal["show", "update"]
    uuid: str
    props: NotificationProps

    @override
    def redundancy_key(self) -> str:
        # Include mode in the key so "show" and "update" messages are kept
        # separately. Without this, an "update" message would cull the "show"
        # message, preventing the notification from being created.
        return f"{type(self).__name__}_{self.uuid}_{self.mode}"


@dataclasses.dataclass
class NotificationProps:
    title: str
    """Title of the notification."""
    body: str
    """Body text of the notification."""
    loading: bool
    """Whether to show a loading indicator."""
    with_close_button: bool
    """Whether to show a close button."""
    auto_close_seconds: Union[float, None]
    """Time in seconds after which the notification should auto-close, or
    False to disable auto-close."""
    color: Union[LiteralColor, Tuple[int, int, int], None]
    """Color of the notification."""


@dataclasses.dataclass
class RemoveNotificationMessage(Message):
    """Remove a specific notification."""

    uuid: str


@dataclasses.dataclass
class ViewerCameraMessage(Message):
    """Message for a posed viewer camera.
    Pose is in the form T_world_camera, OpenCV convention, +Z forward."""

    wxyz: Tuple[float, float, float, float]
    position: Tuple[float, float, float]
    fov: float
    near: float
    far: float
    image_height: int
    image_width: int
    look_at: Tuple[float, float, float]
    up_direction: Tuple[float, float, float]


# The list of scene pointer events supported by the viser frontend.
ScenePointerEventType = Literal["click", "rect-select"]


@dataclasses.dataclass
class ScenePointerMessage(Message):
    """Message for a raycast-like pointer in the scene.
    origin is the viewing camera position, in world coordinates.
    direction is the vector if a ray is projected from the camera through the
    clicked pixel,
    """

    # Later we can add `double_click`, `move`, `down`, `up`, etc.
    event_type: ScenePointerEventType
    ray_origin: Optional[Tuple[float, float, float]]
    ray_direction: Optional[Tuple[float, float, float]]
    screen_pos: Tuple[Tuple[float, float], ...]


@dataclasses.dataclass
class ScenePointerEnableMessage(Message):
    """Message to enable/disable scene click events."""

    enable: bool
    event_type: ScenePointerEventType

    @override
    def redundancy_key(self) -> str:
        return (
            type(self).__name__ + "-" + self.event_type + "-" + str(self.enable).lower()
        )


@dataclasses.dataclass
class CameraFrustumMessage(_CreateSceneNodeMessage):
    """Variant of CameraMessage used for visualizing camera frustums.

    OpenCV convention, +Z forward."""

    props: CameraFrustumProps


@dataclasses.dataclass
class CameraFrustumProps:
    fov: float
    """Field of view of the camera (in radians). """
    aspect: float
    """Aspect ratio of the camera (width over height)."""
    line_width: float
    """Width of the frustum lines."""
    color: Tuple[int, int, int]
    """Color of the frustum as RGB integers. """
    _format: Literal["jpeg", "png"]
    """Format of the provided image ('jpeg' or 'png')."""
    _image_data: Optional[bytes]
    """Optional image to be displayed on the frustum."""
    cast_shadow: bool
    """Whether or not to cast shadows. """
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """
    variant: Literal["wireframe", "filled"] = "wireframe"
    """Variant of the frustum visualization. 'wireframe' shows lines only,
    'filled' adds semi-transparent faces. """
    scale: Union[float, Tuple[float, float, float]] = 0.3
    """Scale factor for the size of the frustum. A single float for uniform
    scaling or a tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class GlbMessage(_CreateSceneNodeMessage):
    """GlTF message."""

    props: GlbProps


@dataclasses.dataclass
class GlbProps:
    glb_data: bytes
    """A binary payload containing the GLB data. """
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """A scale for resizing the GLB asset. A single float for uniform scaling
    or a tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class FrameMessage(_CreateSceneNodeMessage):
    """Coordinate frame message."""

    props: FrameProps


@dataclasses.dataclass
class FrameProps:
    show_axes: bool
    """Boolean to indicate whether to show the frame as a set of axes +
    origin sphere."""
    axes_length: float
    """Length of each axis."""
    axes_radius: float
    """Radius of each axis."""
    origin_radius: float
    """Radius of the origin sphere."""
    origin_color: Tuple[int, int, int]
    """Color of the origin sphere as RGB integers. """
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the coordinate frame. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class BatchedAxesMessage(_CreateSceneNodeMessage):
    """Batched axes message.

    Positions and orientations should follow a `T_parent_local` convention, which
    corresponds to the R matrix and t vector in `p_parent = [R | t] p_local`."""

    props: BatchedAxesProps


@dataclasses.dataclass
class BatchedAxesProps:
    batched_wxyzs: npt.NDArray[np.float32]
    """Float array of shape (N,4) representing quaternion rotations.
    """
    batched_positions: npt.NDArray[np.float32]
    """Float array of shape (N,3) representing positions."""
    batched_scales: Optional[npt.NDArray[np.float32]]
    """Float array of shape (N,) or (N,3) representing uniform or per-axis
    (XYZ) scales."""
    axes_length: float
    """Length of each axis."""
    axes_radius: float
    """Radius of each axis."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the batched axes. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class GridMessage(_CreateSceneNodeMessage):
    """Grid message. Helpful for visualizing things like ground planes."""

    props: GridProps


@dataclasses.dataclass
class GridProps:
    width: float
    """Width of the grid."""
    height: float
    """Height of the grid."""
    plane: Literal["xz", "xy", "yx", "yz", "zx", "zy"]
    """The plane in which the grid is oriented. """
    cell_color: Tuple[int, int, int]
    """Color of the grid cells as RGB integers. """
    cell_thickness: float
    """Thickness of the grid lines."""
    cell_size: float
    """Size of each cell in the grid."""
    section_color: Tuple[int, int, int]
    """Color of the grid sections as RGB integers. """
    section_thickness: float
    """Thickness of the section lines."""
    section_size: float
    """Size of each section in the grid."""

    infinite_grid: bool
    """Whether the grid should be infinite. If `True`, the width and height are ignored."""
    fade_distance: float
    """Distance at which the grid fades out."""
    fade_strength: float
    """Strength of the fade effect."""
    fade_from: Literal["camera", "origin"]
    """Whether the grid should fade based on distance from the camera or the origin."""

    shadow_opacity: float
    """If true, shadows are casted onto the grid plane."""

    plane_color: Tuple[int, int, int]
    """Color of the ground plane as RGB integers."""
    plane_opacity: float
    """Opacity of the ground plane, 0: invisible, 1: fully opaque."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the grid. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class LabelMessage(_CreateSceneNodeMessage):
    """Add a 2D label to the scene."""

    props: LabelProps


@dataclasses.dataclass
class LabelProps:
    text: str
    """Text content of the label."""
    font_size_mode: Literal["screen", "scene"]
    """Font size mode: 'screen' for screen-space sizing, 'scene' for world-space sizing."""
    font_screen_scale: float
    """Scale factor for screen-space font size. Only used when font_size_mode='screen'."""
    font_scene_height: float
    """Font height in scene units. Only used when font_size_mode='scene'."""
    depth_test: bool
    """Whether to enable depth testing for the label."""
    anchor: LabelAnchor
    """Anchor position of the label relative to its position."""


@dataclasses.dataclass
class Gui3DMessage(_CreateSceneNodeMessage):
    """Add a 3D gui element to the scene."""

    props: Gui3DProps


@dataclasses.dataclass
class Gui3DProps:
    order: float
    """Order value for arranging GUI elements. """
    container_uuid: str
    """Identifier for the container."""


@dataclasses.dataclass
class PointCloudMessage(_CreateSceneNodeMessage):
    """Point cloud message.

    Positions are internally canonicalized to float32, colors to uint8.

    Float color inputs should be in the range [0,1], int color inputs should be in the
    range [0,255]."""

    props: PointCloudProps


@dataclasses.dataclass
class PointCloudProps:
    points: Union[npt.NDArray[np.float16], npt.NDArray[np.float32]]
    """Location of points. Should have shape (N, 3)."""
    colors: npt.NDArray[np.uint8]
    """Colors of points. Should have shape (N, 3) or (3,)."""
    point_size: float
    """Size of each point."""
    point_shape: Literal["square", "diamond", "circle", "rounded", "sparkle"]
    """Shape to draw each point."""
    precision: Literal["float16", "float32"]
    """Precision of the point cloud. Assignments to `points` are automatically casted
    based on the current precision value. Updates to `points` should therefore happen
    *after* updates to `precision`."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the point cloud. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""

    def __post_init__(self):
        # Check shapes.
        assert len(self.points.shape) == 2
        assert self.colors.shape in ((3,), (self.points.shape[0], 3))
        assert self.points.shape[-1] == 3

        # Check dtypes.
        if self.precision == "float16":
            assert self.points.dtype == np.float16
        else:
            assert self.points.dtype == np.float32
        assert self.colors.dtype == np.uint8


@dataclasses.dataclass
class DirectionalLightMessage(_CreateSceneNodeMessage):
    """Directional light message."""

    props: DirectionalLightProps


@dataclasses.dataclass
class DirectionalLightProps:
    color: Tuple[int, int, int]
    """Color of the directional light."""
    intensity: float
    """Intensity of the directional light."""
    cast_shadow: bool
    """If set to true mesh will cast a shadow. """


@dataclasses.dataclass
class AmbientLightMessage(_CreateSceneNodeMessage):
    """Ambient light message."""

    props: AmbientLightProps


@dataclasses.dataclass
class AmbientLightProps:
    color: Tuple[int, int, int]
    """Color of the ambient light."""
    intensity: float
    """Intensity of the ambient light."""


@dataclasses.dataclass
class HemisphereLightMessage(_CreateSceneNodeMessage):
    """Hemisphere light message."""

    props: HemisphereLightProps


@dataclasses.dataclass
class HemisphereLightProps:
    sky_color: Tuple[int, int, int]
    """Sky color of the hemisphere light."""
    ground_color: Tuple[int, int, int]
    """Ground color of the hemisphere light. """
    intensity: float
    """Intensity of the hemisphere light."""


@dataclasses.dataclass
class PointLightMessage(_CreateSceneNodeMessage):
    """Point light message."""

    props: PointLightProps


@dataclasses.dataclass
class PointLightProps:
    color: Tuple[int, int, int]
    """Color of the point light."""
    intensity: float
    """Intensity of the point light."""
    distance: float
    """Distance of the point light."""
    decay: float
    """Decay of the point light."""
    cast_shadow: bool
    """If set to true mesh will cast a shadow. """


@dataclasses.dataclass
class RectAreaLightMessage(_CreateSceneNodeMessage):
    """Rectangular Area light message."""

    props: RectAreaLightProps


@dataclasses.dataclass
class RectAreaLightProps:
    color: Tuple[int, int, int]
    """Color of the rectangular area light."""
    intensity: float
    """Intensity of the rectangular area light. """
    width: float
    """Width of the rectangular area light."""
    height: float
    """Height of the rectangular area light. """


@dataclasses.dataclass
class SpotLightMessage(_CreateSceneNodeMessage):
    """Spot light message."""

    props: SpotLightProps


@dataclasses.dataclass
class SpotLightProps:
    color: Tuple[int, int, int]
    """Color of the spot light."""
    intensity: float
    """Intensity of the spot light."""
    distance: float
    """Distance of the spot light."""
    angle: float
    """Angle of the spot light."""
    penumbra: float
    """Penumbra of the spot light."""
    decay: float
    """Decay of the spot light."""
    cast_shadow: bool
    """If set to true mesh will cast a shadow. """

    def __post_init__(self):
        assert self.angle <= np.pi / 2
        assert self.angle >= 0


@dataclasses.dataclass
class EnvironmentMapMessage(Message):
    """Environment Map message."""

    hdri: Union[
        Literal[
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
        ],
        None,
    ]
    background: bool
    background_blurriness: float
    background_intensity: float
    background_wxyz: Tuple[float, float, float, float]
    environment_intensity: float
    environment_wxyz: Tuple[float, float, float, float]


@dataclasses.dataclass
class EnableLightsMessage(Message):
    """Default light message."""

    enabled: bool
    cast_shadow: bool


@dataclasses.dataclass
class MeshMessage(_CreateSceneNodeMessage):
    """Mesh message.

    Vertices are internally canonicalized to float32, faces to uint32."""

    props: MeshProps


@dataclasses.dataclass
class BoxMessage(_CreateSceneNodeMessage):
    """Box message."""

    props: BoxProps


@dataclasses.dataclass
class IcosphereMessage(_CreateSceneNodeMessage):
    """Icosphere message."""

    props: IcosphereProps


@dataclasses.dataclass
class CylinderMessage(_CreateSceneNodeMessage):
    """Cylinder message."""

    props: CylinderProps


@dataclasses.dataclass
class MeshProps:
    vertices: npt.NDArray[np.float32]
    """A numpy array of vertex positions. Should have shape (V, 3).
    """
    faces: npt.NDArray[np.uint32]
    """A numpy array of faces, where each face is represented by indices of
    vertices. Should have shape (F, 3). """
    color: Tuple[int, int, int]
    """Color of the mesh as RGB integers. """
    wireframe: bool
    """Boolean indicating if the mesh should be rendered as a wireframe.
    """
    opacity: Optional[float]
    """Opacity of the mesh. None means opaque. """
    flat_shading: bool
    """Whether to do flat shading."""
    side: Literal["front", "back", "double"]
    """Side of the surface to render."""
    material: Literal["standard", "toon3", "toon5"]
    """Material type of the mesh."""
    scale: Union[float, Tuple[float, float, float]]
    """Scale of the mesh. A single float for uniform scaling or a tuple of
    (x, y, z) for per-axis scaling."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """

    def __post_init__(self):
        # Check shapes.
        assert self.vertices.shape[-1] == 3
        assert self.faces.shape[-1] == 3


@dataclasses.dataclass
class BoxProps:
    dimensions: Tuple[float, float, float]
    """Dimensions of the box (x, y, z). """
    color: Tuple[int, int, int]
    """Color of the box as RGB integers. """
    wireframe: bool
    """Boolean indicating if the box should be rendered as a wireframe.
    """
    opacity: Optional[float]
    """Opacity of the box. None means opaque. """
    flat_shading: bool
    """Whether to do flat shading."""
    side: Literal["front", "back", "double"]
    """Side of the surface to render."""
    material: Literal["standard", "toon3", "toon5"]
    """Material type of the box."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the box. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class IcosphereProps:
    radius: float
    """Radius of the icosphere."""
    subdivisions: int
    """Number of subdivisions to use when creating the icosphere."""
    color: Tuple[int, int, int]
    """Color of the icosphere as RGB integers. """
    wireframe: bool
    """Boolean indicating if the icosphere should be rendered as a wireframe.
    """
    opacity: Optional[float]
    """Opacity of the icosphere. None means opaque. """
    flat_shading: bool
    """Whether to do flat shading."""
    side: Literal["front", "back", "double"]
    """Side of the surface to render."""
    material: Literal["standard", "toon3", "toon5"]
    """Material type of the icosphere."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the icosphere. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class CylinderProps:
    radius: float
    """Radius of the cylinder."""
    height: float
    """Height of the cylinder."""
    color: Tuple[int, int, int]
    """Color of the cylinder as RGB integers."""
    radial_segments: int
    """Number of segmented faces around the circumference of the cylinder."""
    wireframe: bool
    """Boolean indicating if the cylinder should be rendered as a wireframe."""
    opacity: Optional[float]
    """Opacity of the cylinder. None means opaque."""
    flat_shading: bool
    """Whether to do flat shading."""
    side: Literal["front", "back", "double"]
    """Side of the surface to render."""
    material: Literal["standard", "toon3", "toon5"]
    """Material type of the cylinder."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the cylinder. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class SkinnedMeshMessage(_CreateSceneNodeMessage):
    """Skinned mesh message."""

    props: SkinnedMeshProps


@dataclasses.dataclass
class SkinnedMeshProps(MeshProps):
    """Mesh message.

    Vertices are internally canonicalized to float32, faces to uint32."""

    bone_wxyzs: npt.NDArray[np.float32]
    """Array of quaternions representing bone orientations (B, 4)."""
    bone_positions: npt.NDArray[np.float32]
    """Array of positions representing bone positions (B, 3)."""
    skin_indices: npt.NDArray[np.uint16]
    """Array of skin indices. Should have shape (V, 4)."""
    skin_weights: npt.NDArray[np.float32]
    """Array of skin weights. Should have shape (V, 4)."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """

    def __post_init__(self):
        # Check shapes.
        assert self.bone_wxyzs.shape[-1] == 4
        assert self.bone_positions.shape[-1] == 3
        assert self.bone_wxyzs.shape[0] == self.bone_positions.shape[0]
        assert self.vertices.shape[-1] == 3
        assert self.faces.shape[-1] == 3
        assert self.skin_weights is not None
        assert (
            self.skin_indices.shape
            == self.skin_weights.shape
            == (self.vertices.shape[0], 4)
        )


@dataclasses.dataclass
class BatchedMeshesMessage(_CreateSceneNodeMessage):
    """Message from server->client carrying batched meshes information."""

    props: BatchedMeshesProps


@dataclasses.dataclass
class _BatchedMeshExtraProps:
    batched_wxyzs: npt.NDArray[np.float32]
    """Float array of shape (N, 4) representing quaternion rotations.
    """
    batched_positions: npt.NDArray[np.float32]
    """Float array of shape (N, 3) representing positions."""
    batched_scales: Optional[npt.NDArray[np.float32]]
    """Float array of shape (N,) or (N,3) representing uniform or per-axis
    (XYZ) scales."""
    lod: Union[Literal["auto", "off"], Tuple[Tuple[float, float], ...]]
    """LOD settings. Either "auto", "off", or a tuple of (distance, ratio) pairs."""

    def __post_init__(self):
        # Check shapes.
        assert self.batched_wxyzs.shape[-1] == 4
        assert self.batched_positions.shape[-1] == 3
        assert self.batched_wxyzs.shape[0] == self.batched_positions.shape[0]
        if self.batched_scales is not None:
            assert self.batched_scales.shape in (
                (self.batched_wxyzs.shape[0],),
                (self.batched_wxyzs.shape[0], 3),
            )


@dataclasses.dataclass
class BatchedMeshesProps(_BatchedMeshExtraProps):
    """Batched meshes message."""

    vertices: npt.NDArray[np.float32]
    """A numpy array of vertex positions. Should have shape (V, 3)."""
    faces: npt.NDArray[np.uint32]
    """A numpy array of faces, where each face is represented by indices of vertices. Should have shape (F, 3)."""
    batched_colors: npt.NDArray[np.uint8]
    """A numpy array of colors, where each color is represented by RGB integers. Should have shape (N, 3) or (3,)."""
    wireframe: bool
    """Boolean indicating if the mesh should be rendered as a wireframe."""
    opacity: Optional[float]
    """Opacity of the mesh. None means opaque."""
    flat_shading: bool
    """Whether to do flat shading."""
    side: Literal["front", "back", "double"]
    """Side of the surface to render."""
    material: Literal["standard", "toon3", "toon5"]
    """Material type of the mesh."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: bool
    """Whether or not to receive shadows."""
    batched_opacities: Optional[npt.NDArray[np.float32]] = None
    """Per-instance opacity multipliers, shape (N,). Multiplied with global opacity."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the batched meshes. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class BatchedGlbMessage(_CreateSceneNodeMessage):
    """Message from server->client carrying batched GLB information."""

    props: BatchedGlbProps


@dataclasses.dataclass
class BatchedGlbProps(_BatchedMeshExtraProps):
    """Batched GLB message."""

    glb_data: bytes
    """A binary payload containing the GLB data. """
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: bool
    """Whether or not to receive shadows."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the batched GLB. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class SetBoneOrientationMessage(Message):
    """Server -> client message to set a skinned mesh bone's orientation.

    As with all other messages, transforms take the `T_parent_local` convention."""

    name: str
    bone_index: int
    wxyz: Tuple[float, float, float, float]

    @override
    def redundancy_key(self) -> str:
        return type(self).__name__ + "-" + self.name + "-" + str(self.bone_index)


@dataclasses.dataclass
class SetBonePositionMessage(Message):
    """Server -> client message to set a skinned mesh bone's position.

    As with all other messages, transforms take the `T_parent_local` convention."""

    name: str
    bone_index: int
    position: Tuple[float, float, float]

    @override
    def redundancy_key(self) -> str:
        return type(self).__name__ + "-" + self.name + "-" + str(self.bone_index)


@dataclasses.dataclass
class TransformControlsMessage(_CreateSceneNodeMessage):
    """Message for transform gizmos."""

    props: TransformControlsProps


@dataclasses.dataclass
class TransformControlsProps:
    scale: float
    """Scale of the transform controls."""
    line_width: float
    """Width of the lines used in the gizmo."""
    fixed: bool
    """Boolean indicating if the gizmo should be fixed in position."""
    active_axes: Tuple[bool, bool, bool]
    """Tuple of booleans indicating active axes."""
    disable_axes: bool
    """Tuple of booleans indicating if axes are disabled. These are used for
    translation in the X, Y, or Z directions. """
    disable_sliders: bool
    """Tuple of booleans indicating if sliders are disabled. These are used for
    translation on the XY, YZ, or XZ planes. """
    disable_rotations: bool
    """Tuple of booleans indicating if rotations are disabled. These are used
    for rotation around the X, Y, or Z axes. """
    translation_limits: Tuple[
        Tuple[float, float], Tuple[float, float], Tuple[float, float]
    ]
    """Limits for translation."""
    rotation_limits: Tuple[
        Tuple[float, float], Tuple[float, float], Tuple[float, float]
    ]
    """Limits for rotation."""
    depth_test: bool
    """Boolean indicating if depth testing should be used when rendering.
    Setting to False can be used to render the gizmo even when occluded by
    other objects."""
    opacity: float
    """Opacity of the gizmo."""


@dataclasses.dataclass
class SetCameraPositionMessage(Message):
    """Server -> client message to set the camera's position."""

    position: Tuple[float, float, float]
    initial: bool = False
    """If True, this is an initial camera setup that can be overridden by URL params."""


@dataclasses.dataclass
class SetCameraUpDirectionMessage(Message):
    """Server -> client message to set the camera's up direction."""

    position: Tuple[float, float, float]
    initial: bool = False
    """If True, this is an initial camera setup that can be overridden by URL params."""


@dataclasses.dataclass
class SetCameraLookAtMessage(Message):
    """Server -> client message to set the camera's look-at point."""

    look_at: Tuple[float, float, float]
    initial: bool = False
    """If True, this is an initial camera setup that can be overridden by URL params."""


@dataclasses.dataclass
class SetCameraNearMessage(Message):
    """Server -> client message to set the camera's near clipping plane."""

    near: float
    initial: bool = False
    """If True, this is an initial camera setup that can be overridden by URL params."""


@dataclasses.dataclass
class SetCameraFarMessage(Message):
    """Server -> client message to set the camera's far clipping plane."""

    far: float
    initial: bool = False
    """If True, this is an initial camera setup that can be overridden by URL params."""


@dataclasses.dataclass
class SetCameraFovMessage(Message):
    """Server -> client message to set the camera's field of view."""

    fov: float
    initial: bool = False
    """If True, this is an initial camera setup that can be overridden by URL params."""


@dataclasses.dataclass
class SetOrientationMessage(Message):
    """Server -> client message to set a scene node's orientation.

    As with all other messages, transforms take the `T_parent_local` convention."""

    name: str
    wxyz: Tuple[float, float, float, float]


@dataclasses.dataclass
class SetPositionMessage(Message):
    """Server -> client message to set a scene node's position.

    As with all other messages, transforms take the `T_parent_local` convention."""

    name: str
    position: Tuple[float, float, float]


@dataclasses.dataclass
class TransformControlsUpdateMessage(Message):
    """Client -> server message when a transform control is updated.

    As with all other messages, transforms take the `T_parent_local` convention."""

    name: str
    wxyz: Tuple[float, float, float, float]
    position: Tuple[float, float, float]


@dataclasses.dataclass
class TransformControlsDragStartMessage(Message):
    """Client -> server message when a transform control drag starts."""

    name: str


@dataclasses.dataclass
class TransformControlsDragEndMessage(Message):
    """Client -> server message when a transform control drag ends."""

    name: str


@dataclasses.dataclass
class BackgroundImageMessage(Message):
    """Message for rendering a background image."""

    format: Literal["jpeg", "png"]
    rgb_data: Optional[bytes]
    depth_data: Optional[bytes]


@dataclasses.dataclass
class ImageMessage(_CreateSceneNodeMessage):
    """Message for rendering 2D images."""

    props: ImageProps


@dataclasses.dataclass
class ImageProps:
    _format: Literal["jpeg", "png"]
    """Format of the provided image ('jpeg' or 'png')."""
    _data: bytes
    """Binary data of the image."""
    render_width: float
    """Width at which the image should be rendered in the scene."""
    render_height: float
    """Height at which the image should be rendered in the scene."""
    cast_shadow: bool
    """Whether or not to cast shadows."""
    receive_shadow: Union[bool, float]
    """Whether to receive shadows. If True, receives shadows normally. If
    False, no shadows. If a float (0-1), shadows are rendered with a fixed
    opacity regardless of lighting conditions. """
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the image. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class SetSceneNodeVisibilityMessage(Message):
    """Set the visibility of a particular node in the scene."""

    name: str
    visible: bool


@dataclasses.dataclass
class SetSceneNodeClickableMessage(Message):
    """Set the clickability of a particular node in the scene."""

    name: str
    clickable: bool


@dataclasses.dataclass
class SceneNodeClickMessage(Message):
    """Message for clicked objects."""

    name: str
    instance_index: Optional[int]
    """Instance index. Currently only used for batched axes."""
    ray_origin: Tuple[float, float, float]
    ray_direction: Tuple[float, float, float]
    screen_pos: Tuple[float, float]


@dataclasses.dataclass
class ResetGuiMessage(Message):
    """Reset GUI."""


@dataclasses.dataclass
class GuiBaseProps:
    """Base message type containing fields commonly used by GUI inputs."""

    order: float
    """Order value for arranging GUI elements. """
    label: str
    """Label text for the GUI element."""
    hint: Optional[str]
    """Optional hint text for the GUI element."""
    visible: bool
    """Visibility state of the GUI element."""
    disabled: bool
    """Disabled state of the GUI element."""


@dataclasses.dataclass
class GuiFolderProps:
    order: float
    """Order value for arranging GUI elements. """
    label: str
    """Label text for the GUI folder."""
    visible: bool
    """Visibility state of the GUI folder."""
    expand_by_default: bool
    """Whether the folder should be expanded by default."""


@dataclasses.dataclass
class GuiFolderMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiFolderProps


@dataclasses.dataclass
class GuiMarkdownProps:
    order: float
    """Order value for arranging GUI elements. """
    _markdown: str
    """(Private) Markdown content to be displayed."""
    visible: bool
    """Visibility state of the markdown element."""


@dataclasses.dataclass
class GuiMarkdownMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiMarkdownProps


@dataclasses.dataclass
class GuiHtmlProps:
    order: float
    """Order value for arranging GUI elements. """
    content: str
    """HTML content to be displayed."""
    visible: bool
    """Visibility state of the markdown element."""


@dataclasses.dataclass
class GuiHtmlMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiHtmlProps


@dataclasses.dataclass
class GuiProgressBarProps:
    order: float
    """Order value for arranging GUI elements. """
    animated: bool
    """Whether the progress bar should be animated."""
    color: Union[LiteralColor, Tuple[int, int, int], None]
    """Color of the progress bar."""
    visible: bool
    """Visibility state of the progress bar."""


@dataclasses.dataclass
class GuiProgressBarMessage(_CreateGuiComponentMessage):
    value: float
    container_uuid: str
    props: GuiProgressBarProps


@dataclasses.dataclass
class GuiPlotlyProps:
    order: float
    """Order value for arranging GUI elements. """
    _plotly_json_str: str
    """(Private) JSON string representation of the Plotly figure."""
    aspect: float
    """Aspect ratio of the plot."""
    visible: bool
    """Visibility state of the plot."""


@dataclasses.dataclass
class GuiPlotlyMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiPlotlyProps


@dataclasses.dataclass
class GuiUplotProps:
    order: float
    """Order value for arranging GUI elements. """
    data: Tuple[npt.NDArray[np.float64], ...]
    """Tuple of 1D numpy arrays containing chart data. First array is x-axis data,
    subsequent arrays are y-axis data for each series. All arrays must have matching
    lengths. Minimum 2 arrays required."""
    mode: Union[Literal[1, 2], None]
    """Chart layout mode: 1 = aligned (all series share axes), 2 = faceted (each series
    gets its own subplot panel). Defaults to 1."""
    title: Union[str, None]
    """Chart title displayed at the top of the plot."""
    series: Tuple[uplot.Series, ...]
    """Series configuration objects defining visual appearance (colors, line styles, labels)
    and behavior for each data array. Must match data tuple length."""
    bands: Union[Tuple[uplot.Band, ...], None]
    """High/low range visualizations between adjacent series indices. Useful for confidence
    intervals, error bounds, or min/max ranges."""
    scales: Union[Dict[str, uplot.Scale], None]
    """Scale definitions controlling data-to-pixel mapping and axis ranges. Enables features
    like auto-ranging, manual bounds, time-based scaling, and logarithmic distributions.
    Multiple scales support dual-axis charts."""
    axes: Union[Tuple[uplot.Axis, ...], None]
    """Axis configuration for positioning (top/right/bottom/left), tick formatting, grid
    styling, and spacing. Controls visual appearance of chart axes."""
    legend: Union[uplot.Legend, None]
    """Legend display options including positioning, styling, and custom value formatting
    for hover states."""
    cursor: Union[uplot.Cursor, None]
    """Interactive cursor behavior including hover detection, drag-to-zoom, and crosshair
    appearance. Controls user interaction with the chart."""
    focus: Union[uplot.Focus, None]
    """Visual highlighting when hovering over series. Controls alpha transparency of
    non-focused series to emphasize the active one."""
    aspect: float
    """Width-to-height ratio for chart display (width/height). 1.0 = square, >1.0 = wider.
    """
    visible: bool
    """Whether the chart is visible in the interface."""


@dataclasses.dataclass
class GuiUplotMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiUplotProps


@dataclasses.dataclass
class GuiImageProps:
    order: float
    """Order value for arranging GUI elements. """
    label: Optional[str]
    """Label text for the image."""
    _data: Optional[bytes]
    """Binary data of the image."""
    _format: Literal["jpeg", "png"]
    """Format of the provided image ('jpeg' or 'png')."""
    visible: bool
    """Visibility state of the image."""


@dataclasses.dataclass
class GuiImageMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiImageProps


@dataclasses.dataclass
class GuiTabGroupProps:
    _tab_labels: Tuple[str, ...]
    """(Private) Tuple of labels for each tab."""
    _tab_icons_html: Tuple[Union[str, None], ...]
    """(Private) Tuple of HTML strings for icons of each tab, or None if no icon."""
    _tab_container_ids: Tuple[str, ...]
    """(Private) Tuple of container IDs for each tab."""
    order: float
    """Order value for arranging GUI elements. """
    visible: bool
    """Visibility state of the tab group."""


@dataclasses.dataclass
class GuiTabGroupMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiTabGroupProps


@dataclasses.dataclass
class GuiModalMessage(Message):
    order: float
    uuid: str
    title: str

    @override
    def redundancy_key(self) -> str:
        return f"modal-{self.uuid}"


@dataclasses.dataclass
class GuiCloseModalMessage(Message):
    uuid: str

    @override
    def redundancy_key(self) -> str:
        return f"modal-{self.uuid}"


@dataclasses.dataclass
class GuiButtonProps(GuiBaseProps):
    color: Union[LiteralColor, Tuple[int, int, int], None]
    """Color of the button."""
    _icon_html: Optional[str]
    """(Private) HTML string for the icon to be displayed on the button."""
    _hold_callback_freqs: Tuple[float, ...]
    """(Private) Tuple of frequencies (Hz) at which hold callbacks should be triggered."""


@dataclasses.dataclass
class GuiButtonMessage(_CreateGuiComponentMessage):
    value: bool
    container_uuid: str
    props: GuiButtonProps


@dataclasses.dataclass
class GuiButtonHoldMessage(Message):
    """Message sent from client->server when a button is being held.

    Sent periodically at the specified frequency while the button is pressed."""

    uuid: str
    frequency: float
    """The frequency (Hz) at which this hold message was triggered."""


@dataclasses.dataclass
class GuiUploadButtonProps(GuiBaseProps):
    color: Union[LiteralColor, Tuple[int, int, int], None]
    """Color of the upload button."""
    _icon_html: Optional[str]
    """(Private) HTML string for the icon to be displayed on the upload button."""
    mime_type: str
    """MIME type of the files that can be uploaded."""


@dataclasses.dataclass
class GuiUploadButtonMessage(_CreateGuiComponentMessage):
    container_uuid: str
    props: GuiUploadButtonProps


@dataclasses.dataclass
class GuiSliderProps(GuiBaseProps):
    min: float
    """Minimum value for the slider."""
    max: float
    """Maximum value for the slider."""
    step: float
    """Step size for the slider."""
    precision: int
    """Number of decimal places to display for the slider value."""
    _marks: Optional[Tuple[GuiSliderMark, ...]]
    """(Private) Optional tuple of GuiSliderMark objects to display custom marks on the slider."""


@dataclasses.dataclass
class GuiSliderMessage(_CreateGuiComponentMessage):
    value: float
    container_uuid: str
    props: GuiSliderProps


@dataclasses.dataclass
class GuiMultiSliderProps(GuiBaseProps):
    min: float
    """Minimum value for the multi-slider."""
    max: float
    """Maximum value for the multi-slider."""
    step: float
    """Step size for the multi-slider."""
    min_range: Optional[float]
    """Minimum allowed range between slider handles."""
    precision: int
    """Number of decimal places to display for the multi-slider values."""
    fixed_endpoints: bool
    """If True, the first and last handles cannot be moved."""
    _marks: Optional[Tuple[GuiSliderMark, ...]]
    """(Private) Optional tuple of GuiSliderMark objects to display custom marks on the multi-slider."""


@dataclasses.dataclass
class GuiMultiSliderMessage(_CreateGuiComponentMessage):
    value: Tuple[float, ...]
    container_uuid: str
    props: GuiMultiSliderProps


@dataclasses.dataclass
class GuiNumberProps(GuiBaseProps):
    precision: int
    """Number of decimal places to display for the number value."""
    step: float
    """Step size for incrementing/decrementing the number value."""
    min: Optional[float]
    """Minimum allowed value for the number input."""
    max: Optional[float]
    """Maximum allowed value for the number input."""


@dataclasses.dataclass
class GuiNumberMessage(_CreateGuiComponentMessage):
    value: float
    container_uuid: str
    props: GuiNumberProps


@dataclasses.dataclass
class GuiRgbProps(GuiBaseProps):
    pass


@dataclasses.dataclass
class GuiRgbMessage(_CreateGuiComponentMessage):
    value: Tuple[int, int, int]
    container_uuid: str
    props: GuiRgbProps


@dataclasses.dataclass
class GuiRgbaProps(GuiBaseProps):
    pass


@dataclasses.dataclass
class GuiRgbaMessage(_CreateGuiComponentMessage):
    value: Tuple[int, int, int, int]
    container_uuid: str
    props: GuiRgbaProps


@dataclasses.dataclass
class GuiCheckboxProps(GuiBaseProps):
    pass


@dataclasses.dataclass
class GuiCheckboxMessage(_CreateGuiComponentMessage):
    value: bool
    container_uuid: str
    props: GuiCheckboxProps


@dataclasses.dataclass
class GuiVector2Props(GuiBaseProps):
    min: Optional[Tuple[float, float]]
    """Minimum allowed values for each component of the vector."""
    max: Optional[Tuple[float, float]]
    """Maximum allowed values for each component of the vector."""
    step: float
    """Step size for incrementing/decrementing each component of the vector."""
    precision: int
    """Number of decimal places to display for each component of the vector."""


@dataclasses.dataclass
class GuiVector2Message(_CreateGuiComponentMessage):
    value: Tuple[float, float]
    container_uuid: str
    props: GuiVector2Props


@dataclasses.dataclass
class GuiVector3Props(GuiBaseProps):
    min: Optional[Tuple[float, float, float]]
    """Minimum allowed values for each component of the vector."""
    max: Optional[Tuple[float, float, float]]
    """Maximum allowed values for each component of the vector."""
    step: float
    """Step size for incrementing/decrementing each component of the vector."""
    precision: int
    """Number of decimal places to display for each component of the vector."""


@dataclasses.dataclass
class GuiVector3Message(_CreateGuiComponentMessage):
    value: Tuple[float, float, float]
    container_uuid: str
    props: GuiVector3Props


@dataclasses.dataclass
class GuiTextProps(GuiBaseProps):
    multiline: bool


@dataclasses.dataclass
class GuiTextMessage(_CreateGuiComponentMessage):
    value: str
    container_uuid: str
    props: GuiTextProps


@dataclasses.dataclass
class GuiDropdownProps(GuiBaseProps):
    # This will actually be manually overridden for better types.
    options: Tuple[str, ...]
    """Tuple of options for the dropdown."""


@dataclasses.dataclass
class GuiDropdownMessage(_CreateGuiComponentMessage):
    value: str
    container_uuid: str
    props: GuiDropdownProps


@dataclasses.dataclass
class GuiButtonGroupProps(GuiBaseProps):
    options: Tuple[str, ...]
    """Tuple of buttons for the button group."""


@dataclasses.dataclass
class GuiButtonGroupMessage(_CreateGuiComponentMessage):
    value: str
    container_uuid: str
    props: GuiButtonGroupProps


@dataclasses.dataclass
class GuiUpdateMessage(Message):
    """Sent client<->server when any property of a GUI component is changed."""

    uuid: str
    updates: Dict[str, Any]
    """Mapping from property name to new value."""

    @override
    def redundancy_key(self) -> str:
        return (
            type(self).__name__
            + "-"
            + self.uuid
            + "-"
            + ",".join(list(self.updates.keys()))
        )


@dataclasses.dataclass
class SceneNodeUpdateMessage(Message):
    """Sent client<->server when any property of a scene node is changed."""

    name: str
    updates: Dict[str, Any]
    """Mapping from property name to new value."""

    @override
    def redundancy_key(self) -> str:
        return (
            type(self).__name__
            + "-"
            + self.name
            + "-"
            + ",".join(list(self.updates.keys()))
        )


@dataclasses.dataclass
class ThemeConfigurationMessage(Message):
    """Message from server->client to configure parts of the GUI."""

    titlebar_content: Optional[theme.TitlebarConfig]
    control_layout: Literal["floating", "collapsible", "fixed"]
    control_width: Literal["small", "medium", "large"]
    show_logo: bool
    show_share_button: bool
    dark_mode: bool
    colors: Optional[Tuple[str, str, str, str, str, str, str, str, str, str]]


@dataclasses.dataclass
class LineSegmentsMessage(_CreateSceneNodeMessage):
    """Message from server->client carrying line segments information."""

    props: LineSegmentsProps


@dataclasses.dataclass
class LineSegmentsProps:
    points: npt.NDArray[np.float32]
    """A numpy array of shape (N, 2, 3) containing a batched set of line
    segments."""
    line_width: float
    """Width of the lines."""
    colors: npt.NDArray[np.uint8]
    """Numpy array of shape (N, 2, 3) containing a color for each point.
    """
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the line segments. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class CatmullRomSplineMessage(_CreateSceneNodeMessage):
    """Message from server->client carrying Catmull-Rom spline information."""

    props: CatmullRomSplineProps


@dataclasses.dataclass
class CatmullRomSplineProps:
    points: npt.NDArray[np.float32]
    """Array with shape (N, 3) defining the spline's path."""
    curve_type: Literal["centripetal", "chordal", "catmullrom"]
    """Type of the curve ('centripetal', 'chordal', 'catmullrom')."""
    tension: float
    """Tension of the curve. Affects the tightness of the curve."""
    closed: bool
    """Boolean indicating if the spline is closed (forms a loop)."""
    line_width: float
    """Width of the spline line."""
    color: Tuple[int, int, int]
    """Color of the spline as RGB integers."""
    segments: Optional[int]
    """Number of segments to divide the spline into."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the spline. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class CubicBezierSplineMessage(_CreateSceneNodeMessage):
    """Message from server->client carrying Cubic Bezier spline information."""

    props: CubicBezierSplineProps


@dataclasses.dataclass
class CubicBezierSplineProps:
    points: npt.NDArray[np.float32]
    """Array of shape (N, 3) defining the spline's key points."""
    control_points: npt.NDArray[np.float32]
    """Array of shape (2*N-2, 3) defining control points for Bezier curve shaping."""
    line_width: float
    """Width of the spline line."""
    color: Tuple[int, int, int]
    """Color of the spline as RGB integers."""
    segments: Optional[int]
    """Number of segments to divide the spline into."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the spline. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class GaussianSplatsMessage(_CreateSceneNodeMessage):
    """Message from server->client carrying splattable Gaussians."""

    props: GaussianSplatsProps


@dataclasses.dataclass
class GaussianSplatsProps:
    # Memory layout is borrowed from:
    # https://github.com/antimatter15/splat
    buffer: npt.NDArray[np.uint32]
    """Our buffer will contain:
    - x as f32
    - y as f32
    - z as f32
    - (unused)
    - cov1 (f16), cov2 (f16)
    - cov3 (f16), cov4 (f16)
    - cov5 (f16), cov6 (f16)
    - rgba (int32)

    Where cov1-6 are the upper-triangular terms of covariance matrices."""
    scale: Union[float, Tuple[float, float, float]] = 1.0
    """Scale of the Gaussian splats. A single float for uniform scaling or a
    tuple of (x, y, z) for per-axis scaling."""


@dataclasses.dataclass
class GetRenderRequestMessage(Message):
    """Message from server->client requesting a render from a specified camera
    pose."""

    format: Literal["image/jpeg", "image/png"]
    height: int
    width: int
    quality: int

    wxyz: Tuple[float, float, float, float]
    position: Tuple[float, float, float]
    fov: float


@dataclasses.dataclass
class GetRenderResponseMessage(Message):
    """Message from client->server carrying a render."""

    payload: bytes


@dataclasses.dataclass
class FileTransferStartUpload(Message):
    """Signal that a file is about to be sent.

    This message is used to upload files from clients to the server.
    """

    source_component_uuid: str
    transfer_uuid: str
    filename: str
    mime_type: str
    part_count: int
    size_bytes: int

    @override
    def redundancy_key(self) -> str:
        return type(self).__name__ + "-" + self.transfer_uuid


@dataclasses.dataclass
class FileTransferStartDownload(Message):
    """Signal that a file is about to be sent.

    This message is used to send files to clients from the server.
    """

    save_immediately: bool
    transfer_uuid: str
    filename: str
    mime_type: str
    part_count: int
    size_bytes: int

    @override
    def redundancy_key(self) -> str:
        return type(self).__name__ + "-" + self.transfer_uuid


@dataclasses.dataclass
class FileTransferPart(Message):
    """Send a file for clients to download or upload files from client."""

    source_component_uuid: Optional[str]
    transfer_uuid: str
    part_index: int
    content: bytes

    @override
    def redundancy_key(self) -> str:
        return (
            type(self).__name__ + "-" + self.transfer_uuid + "-" + str(self.part_index)
        )


@dataclasses.dataclass
class FileTransferPartAck(Message):
    """Send a file for clients to download or upload files from client."""

    source_component_uuid: Optional[str]
    transfer_uuid: str
    transferred_bytes: int
    total_bytes: int

    @override
    def redundancy_key(self) -> str:
        return (
            type(self).__name__
            + "-"
            + self.transfer_uuid
            + "-"
            + str(self.transferred_bytes)
        )


@dataclasses.dataclass
class ShareUrlRequest(Message):
    """Message from client->server to connect to the share URL server."""


@dataclasses.dataclass
class ShareUrlUpdated(Message):
    """Message from server->client to indicate that the share URL has been updated."""

    share_url: Optional[str]


@dataclasses.dataclass
class ShareUrlDisconnect(Message):
    """Message from client->server to disconnect from the share URL server."""


@dataclasses.dataclass
class SetGuiPanelLabelMessage(Message):
    """Message from server->client to set the label of the GUI panel."""

    label: Optional[str]
