from __future__ import annotations

import dataclasses
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Generator, Sequence, Tuple, cast

import imageio.v3 as iio
import numpy as np
import numpy.typing as npt

from ..transforms import SO3


def _resize_nearest(array: npt.NDArray, target_shape: Tuple[int, int]) -> npt.NDArray:
    """Resize array to target shape using nearest neighbor interpolation.

    Args:
        array: Input array with shape (H, W) or (H, W, C).
        target_shape: Target (height, width).

    Returns:
        Resized array with shape (target_shape[0], target_shape[1]) or
        (target_shape[0], target_shape[1], C) if input has channels.
    """
    h_src, w_src = array.shape[:2]
    h_tgt, w_tgt = target_shape

    # Compute indices for nearest neighbor sampling.
    row_indices = (np.arange(h_tgt) * h_src / h_tgt).astype(np.int32)
    col_indices = (np.arange(w_tgt) * w_src / w_tgt).astype(np.int32)

    # Apply indexing to resize.
    return array[row_indices[:, None], col_indices[None, :]]


class Record3dLoader:
    """Helper for loading frames for Record3D captures."""

    # NOTE(hangg): Consider moving this module into
    # `examples/7_record3d_visualizer.py` since it is usecase-specific.

    def __init__(self, data_dir: Path):
        metadata_path = data_dir / "metadata"

        # Read metadata.
        metadata = json.loads(metadata_path.read_text())

        K: np.ndarray = np.array(metadata["K"], np.float32).reshape(3, 3).T
        fps = metadata["fps"]

        T_world_cameras: np.ndarray = np.array(metadata["poses"], np.float32)
        # Convert quaternions (xyzw format) to rotation matrices.
        rotation_matrices = SO3.from_quaternion_xyzw(T_world_cameras[:, :4]).as_matrix()
        T_world_cameras = np.concatenate(
            [
                rotation_matrices,
                T_world_cameras[:, 4:, None],
            ],
            -1,
        )
        T_world_cameras = (T_world_cameras @ np.diag([1, -1, -1, 1])).astype(np.float32)

        self._data_dir = data_dir
        self.K = K
        self.fps = fps
        self.T_world_cameras = T_world_cameras

        rgbd_dir = data_dir / "rgbd"
        self.rgb_paths = sorted(rgbd_dir.glob("*.jpg"), key=lambda p: int(p.stem))
        self.depth_paths = [
            rgb_path.with_suffix(".depth") for rgb_path in self.rgb_paths
        ]
        self.conf_paths = [rgb_path.with_suffix(".conf") for rgb_path in self.rgb_paths]

    def num_frames(self) -> int:
        return len(self.rgb_paths)

    def get_frames(
        self,
        indices: Sequence[int],
        *,
        max_workers: int | None = None,
    ) -> Generator[Record3dFrame, None, None]:
        """Load multiple frames in parallel.

        Args:
            indices: Sequence of frame indices to load.
            max_workers: Maximum number of worker threads. Defaults to
                None (lets ThreadPoolExecutor choose).

        Returns:
            Generator of Record3dFrame objects, in the same order as indices.
        """
        # Threads are fine here because pyliblzfse should release the GIL, we
        # can overlap with IO, etc..
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            yield from executor.map(self.get_frame, indices)

    def get_frame(self, index: int) -> Record3dFrame:
        # `pyliblzfse` can be hard to install on some Windows systems and is
        # only needed for Record3D, so we don't do a global import.
        try:
            import liblzfse
        except ImportError:
            print("liblzfse is missing. Please install with `pip install pyliblzfse`.")
            sys.exit(1)

        # Read conf.
        conf: np.ndarray = np.frombuffer(
            liblzfse.decompress(self.conf_paths[index].read_bytes()), dtype=np.uint8
        )
        if conf.shape[0] == 640 * 480:
            conf = conf.reshape((640, 480))  # For a FaceID camera 3D Video
        elif conf.shape[0] == 256 * 192:
            conf = conf.reshape((256, 192))  # For a LiDAR 3D Video
        else:
            assert False, f"Unexpected conf shape {conf.shape}"

        # Read depth.
        depth: np.ndarray = np.frombuffer(
            liblzfse.decompress(self.depth_paths[index].read_bytes()), dtype=np.float32
        ).copy()
        if depth.shape[0] == 640 * 480:
            depth = depth.reshape((640, 480))  # For a FaceID camera 3D Video
        elif depth.shape[0] == 256 * 192:
            depth = depth.reshape((256, 192))  # For a LiDAR 3D Video
        else:
            assert False, f"Unexpected depth shape {depth.shape}"

        # Read RGB.
        rgb = iio.imread(self.rgb_paths[index])
        return Record3dFrame(
            K=self.K,
            rgb=rgb,
            depth=depth,
            mask=conf == 2,
            T_world_camera=self.T_world_cameras[index],
        )


@dataclasses.dataclass
class Record3dFrame:
    """A single frame from a Record3D capture."""

    K: npt.NDArray[np.float32]
    rgb: npt.NDArray[np.uint8]
    depth: npt.NDArray[np.float32]
    mask: npt.NDArray[np.bool_]
    T_world_camera: npt.NDArray[np.float32]

    def get_point_cloud(
        self, downsample_factor: int = 1
    ) -> Tuple[npt.NDArray[np.float32], npt.NDArray[np.uint8]]:
        rgb = self.rgb[::downsample_factor, ::downsample_factor]
        target_shape = (rgb.shape[0], rgb.shape[1])
        depth = _resize_nearest(self.depth, target_shape)
        mask = cast(
            npt.NDArray[np.bool_],
            _resize_nearest(self.mask, target_shape),
        )
        assert depth.shape == rgb.shape[:2]

        K = self.K
        T_world_camera = self.T_world_camera

        img_wh = rgb.shape[:2][::-1]

        grid = (
            np.stack(np.meshgrid(np.arange(img_wh[0]), np.arange(img_wh[1])), 2) + 0.5
        )
        grid = grid * downsample_factor

        homo_grid = np.pad(grid[mask], np.array([[0, 0], [0, 1]]), constant_values=1)
        local_dirs = np.einsum("ij,bj->bi", np.linalg.inv(K), homo_grid)
        dirs = np.einsum("ij,bj->bi", T_world_camera[:3, :3], local_dirs)
        points = (T_world_camera[:, -1] + dirs * depth[mask, None]).astype(np.float32)  # type: ignore
        point_colors = rgb[mask]

        return points, point_colors
