from __future__ import annotations

import copy
import threading
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import trimesh

import viser

from .. import transforms as tf

if TYPE_CHECKING:
    import yourdfpy


class BatchedViserUrdf:
    """Render a fixed-size batch of one URDF with shared visual geometry.

    Each visual geometry is exported once and instanced across the robots using
    :meth:`viser.SceneApi.add_batched_meshes_trimesh`. Joint updates evaluate
    yourdfpy forward kinematics in a Python loop, only for the selected robots
    when ``robot_indices`` is supplied.

    Configurations have shape ``(num_robots, num_actuated_joints)`` in the order
    returned by :meth:`get_actuated_joint_names`. Fixed joints and mimic joints
    are handled by yourdfpy. Only fixed, revolute, continuous, and prismatic
    joints are supported. Joint limits are reported, but not enforced.

    Base poses are relative to ``root_node_name``. The helper owns its
    ``<root_node_name>/visual`` subtree, but not the caller's root frame. Create
    that frame yourself to move or hide the entire batch. Use distinct roots for
    independent helpers. A new helper at the same root replaces the previous
    visual subtree. The number of robots cannot change after construction.

    URDF visual origins, mesh scales, and materials are preserved. Collision
    meshes, additional global scaling, and per-instance materials are not
    supported. The usual batched-GLB rendering limitations also apply.

    Args:
        target: Server or client to add the batch to.
        urdf_or_path: URDF path or a yourdfpy model with a visual scene. A supplied
            model is copied, so its configuration and geometry are not mutated.
            Its current configuration initializes every robot in the batch.
        num_robots: Positive, fixed number of robot instances.
        root_node_name: Parent scene node name, starting with ``/``.
    """

    def __init__(
        self,
        target: viser.ViserServer | viser.ClientHandle,
        urdf_or_path: yourdfpy.URDF | Path,
        num_robots: int,
        *,
        root_node_name: str = "/",
    ) -> None:
        try:
            import yourdfpy
        except ImportError as e:
            raise ImportError(
                "yourdfpy is required for BatchedViserUrdf. "
                "Install it with `pip install viser[urdf]`."
            ) from e

        if (
            not isinstance(num_robots, (int, np.integer))
            or isinstance(num_robots, bool)
            or num_robots <= 0
        ):
            raise ValueError("num_robots must be a positive integer")
        if not root_node_name.startswith("/") or (
            root_node_name != "/" and root_node_name.endswith("/")
        ):
            raise ValueError("root_node_name must start with / and not end with /")

        if isinstance(urdf_or_path, Path):
            urdf = yourdfpy.URDF.load(
                urdf_or_path,
                build_scene_graph=True,
                build_collision_scene_graph=False,
                load_meshes=True,
                load_collision_meshes=False,
                filename_handler=partial(
                    yourdfpy.filename_handler_magic, dir=urdf_or_path.parent
                ),
            )
        elif isinstance(urdf_or_path, yourdfpy.URDF):
            # Use trimesh's copy implementation for scenes: its transient graph
            # caches may contain unpicklable dict views, which deepcopy cannot
            # handle. All other model state is deep-copied with shared aliases
            # preserved (joint_map, robot.joints, and actuated_joints).
            scene_copies = {
                id(scene): scene.copy()
                for scene in (urdf_or_path.scene, urdf_or_path.collision_scene)
                if scene is not None
            }
            urdf = copy.deepcopy(urdf_or_path, scene_copies)
        else:
            raise TypeError("urdf_or_path must be a pathlib.Path or yourdfpy.URDF")

        for joint in urdf.joint_map.values():
            if joint.type not in ("fixed", "revolute", "continuous", "prismatic"):
                raise ValueError(
                    f"Unsupported joint type {joint.type!r} for joint {joint.name!r}"
                )
        scene = urdf.scene
        if scene is None:
            raise ValueError("The URDF must have a visual scene graph configured")

        # Geometry keys need not equal scene node names, and a link may have
        # several visual nodes. Bake only each link<-geometry transform, leaving
        # the base<-link FK transforms to the per-instance poses.
        geometry: list[tuple[str, trimesh.Trimesh]] = []
        for node_name in scene.graph.nodes_geometry:
            link_name = node_name
            while link_name not in urdf.link_map:
                parent = scene.graph.transforms.parents.get(link_name)
                if parent is None or parent == link_name:
                    raise ValueError(f"Visual node {node_name!r} has no URDF link")
                link_name = parent
            transform, geometry_name = scene.graph.get(
                frame_to=node_name, frame_from=link_name
            )
            mesh = scene.geometry[geometry_name]
            if not isinstance(mesh, trimesh.Trimesh):
                raise TypeError(f"Visual node {node_name!r} is not a triangle mesh")
            mesh = mesh.copy()
            mesh.apply_transform(transform)
            geometry.append((link_name, mesh))

        self._target = target
        self._urdf = urdf
        self._num_robots = int(num_robots)
        self._lock = threading.RLock()
        self._removed = False
        self._link_names = tuple(dict.fromkeys(link for link, _ in geometry))
        self._mesh_link_indices = tuple(
            self._link_names.index(link) for link, _ in geometry
        )
        self._base_wxyzs = np.tile([1.0, 0.0, 0.0, 0.0], (num_robots, 1))
        self._base_positions = np.zeros((num_robots, 3))
        initial_cfg = self._validate_array(
            np.tile(urdf.cfg, (num_robots, 1)),
            (self._num_robots, len(self.get_actuated_joint_names())),
            "configurations",
        )
        self._link_transforms = self._compute_link_transforms(initial_cfg)
        wxyzs, positions = self._compose_poses(self._link_transforms)
        self._meshes: list[viser.BatchedGlbHandle] = []
        visual_name = root_node_name.rstrip("/") + "/visual"
        with target.atomic():
            previous = target.scene.get_handle_by_name(visual_name)
            if previous is not None:
                previous.remove()
            self._visual_root_frame = target.scene.add_frame(
                visual_name, show_axes=False
            )
            try:
                for index, (_, mesh) in enumerate(geometry):
                    link_index = self._mesh_link_indices[index]
                    self._meshes.append(
                        target.scene.add_batched_meshes_trimesh(
                            f"{visual_name}/mesh_{index}",
                            mesh,
                            batched_wxyzs=wxyzs[:, link_index],
                            batched_positions=positions[:, link_index],
                        )
                    )
            except Exception:
                self._visual_root_frame.remove()
                raise

    def update_cfg(
        self, configurations: np.ndarray, *, robot_indices: np.ndarray | None = None
    ) -> None:
        """Update joint configurations without re-exporting meshes.

        By default, ``configurations`` has shape ``(N, J)`` and updates all
        robots. With ``robot_indices``, it has shape ``(K, J)`` and row ``k``
        updates robot ``robot_indices[k]``. Indices must be a one-dimensional
        integer array with unique entries in ``[0, N)``; order is preserved.
        An empty integer array with ``(0, J)`` configurations is a no-op.

        Forward kinematics is evaluated only for the selected robots. Mesh
        properties contain all N instances, and changed properties send full
        arrays through the existing dense protocol. Inputs must be real and finite;
        validation failures leave all displayed poses unchanged.
        """
        with self._lock:
            self._require_active()
            indices = self._validate_robot_indices(robot_indices)
            count = self._num_robots if indices is None else len(indices)
            configurations = self._validate_array(
                configurations,
                (count, len(self.get_actuated_joint_names())),
                "configurations",
            )
            if count == 0:
                return
            transforms = self._compute_link_transforms(configurations)
            if indices is not None:
                merged = self._link_transforms.copy()
                merged[indices] = transforms
                transforms = merged
            self._publish_poses(*self._compose_poses(transforms))
            self._link_transforms = transforms

    def update_base_poses(
        self,
        *,
        batched_wxyzs: np.ndarray,
        batched_positions: np.ndarray,
        robot_indices: np.ndarray | None = None,
    ) -> None:
        """Set root-relative base poses without recomputing forward kinematics.

        Arrays have shape ``(N, 4)`` and ``(N, 3)`` by default, or ``(K, 4)``
        and ``(K, 3)`` for the K rows specified by ``robot_indices``. Indices
        follow :meth:`update_cfg` conventions. Quaternions use ``wxyz``
        order and are normalized; zero quaternions are rejected. Both arrays must
        be real and finite, so complex arrays are rejected before conversion.
        Inputs are copied and later caller mutations do not affect the batch.
        """
        with self._lock:
            self._require_active()
            indices = self._validate_robot_indices(robot_indices)
            count = self._num_robots if indices is None else len(indices)
            wxyzs = self._validate_array(batched_wxyzs, (count, 4), "batched_wxyzs")
            positions = self._validate_array(
                batched_positions, (count, 3), "batched_positions"
            )
            if count == 0:
                return
            # Rescale before taking norms to avoid overflow for finite inputs.
            magnitude = np.max(np.abs(wxyzs), axis=-1, keepdims=True)
            if np.any(magnitude == 0):
                raise ValueError("batched_wxyzs must contain nonzero quaternions")
            wxyzs /= magnitude
            wxyzs /= np.linalg.norm(wxyzs, axis=-1, keepdims=True)
            if indices is not None:
                all_wxyzs = self._base_wxyzs.copy()
                all_positions = self._base_positions.copy()
                all_wxyzs[indices] = wxyzs
                all_positions[indices] = positions
                wxyzs, positions = all_wxyzs, all_positions
            poses = self._compose_poses(self._link_transforms, wxyzs, positions)
            self._publish_poses(*poses)
            self._base_wxyzs = wxyzs
            self._base_positions = positions

    def get_actuated_joint_names(self) -> tuple[str, ...]:
        """Return actuated joint names in the order expected by :meth:`update_cfg`."""
        return tuple(self._urdf.actuated_joint_names)

    def get_actuated_joint_limits(
        self,
    ) -> dict[str, tuple[float | None, float | None]]:
        """Return joint limits, matching :class:`ViserUrdf` conventions."""
        return {
            joint.name: (-np.pi, np.pi)
            if joint.limit is None
            else (joint.limit.lower, joint.limit.upper)
            for joint in self._urdf.actuated_joints
        }

    @property
    def show_visual(self) -> bool:
        """Whether the owned visual subtree is visible."""
        return self._is_active() and self._visual_root_frame.visible

    @show_visual.setter
    def show_visual(self, visible: bool) -> None:
        with self._lock:
            self._require_active()
            self._visual_root_frame.visible = visible

    def remove(self) -> None:
        """Remove the owned visual subtree, preserving the caller's root/siblings.

        Repeated removal is a no-op. Updates after removal raise RuntimeError.
        """
        with self._lock:
            if self._is_active():
                self._visual_root_frame.remove()
            self._removed = True

    def _is_active(self) -> bool:
        return (
            not self._removed
            and self._target.scene.get_handle_by_name(self._visual_root_frame.name)
            is self._visual_root_frame
        )

    def _require_active(self) -> None:
        if not self._is_active():
            raise RuntimeError("This BatchedViserUrdf has been removed or replaced")

    @staticmethod
    def _validate_array(
        value: np.ndarray, shape: tuple[int, int], name: str
    ) -> np.ndarray:
        array = np.asarray(value)
        if np.iscomplexobj(array) or (
            array.dtype.kind == "O"
            and any(np.iscomplexobj(item) for item in array.flat)
        ):
            raise ValueError(f"{name} must be a real array")
        array = np.array(array, dtype=np.float64, copy=True)
        if array.shape != shape or not np.all(np.isfinite(array)):
            raise ValueError(f"{name} must be a finite array with shape {shape}")
        return array

    def _validate_robot_indices(self, value: np.ndarray | None) -> np.ndarray | None:
        if value is None:
            return None
        indices = np.asarray(value)
        if (
            indices.ndim != 1
            or not np.issubdtype(indices.dtype, np.integer)
            or np.any(indices < 0)
            or np.any(indices >= self._num_robots)
            or len(np.unique(indices)) != len(indices)
        ):
            raise ValueError(
                "robot_indices must be a 1D integer array with unique entries "
                f"in [0, {self._num_robots})"
            )
        return indices.astype(np.intp, copy=True)

    def _compute_link_transforms(self, configurations: np.ndarray) -> np.ndarray:
        transforms = np.empty((len(configurations), len(self._link_names), 4, 4))
        for robot_index, configuration in enumerate(configurations):
            self._urdf.update_cfg(configuration)
            for link_index, link_name in enumerate(self._link_names):
                transforms[robot_index, link_index] = self._urdf.get_transform(
                    link_name
                )
        return transforms

    def _compose_poses(
        self,
        transforms: np.ndarray,
        base_wxyzs: np.ndarray | None = None,
        base_positions: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        if base_wxyzs is None:
            base_wxyzs = self._base_wxyzs
        if base_positions is None:
            base_positions = self._base_positions
        base_rotations = tf.SO3(base_wxyzs).as_matrix()[:, None]
        rotations = base_rotations @ transforms[..., :3, :3]
        positions = (base_rotations @ transforms[..., :3, 3, None])[
            ..., 0
        ] + base_positions[:, None]
        if (
            not np.all(np.isfinite(positions))
            or not np.all(np.isfinite(rotations))
            or np.any(np.abs(positions) > np.finfo(np.float32).max)
        ):
            raise ValueError("Computed poses must be finite and fit in float32")
        return tf.SO3.from_matrix(rotations).wxyz, positions

    def _publish_poses(self, wxyzs: np.ndarray, positions: np.ndarray) -> None:
        with self._target.atomic():
            for handle, link_index in zip(self._meshes, self._mesh_link_indices):
                handle.batched_wxyzs = wxyzs[:, link_index].astype(np.float32)
                handle.batched_positions = positions[:, link_index].astype(np.float32)
