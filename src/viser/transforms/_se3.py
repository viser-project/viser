from __future__ import annotations

import dataclasses
from typing import Tuple, cast

import numpy as np
import numpy.typing as npt
from typing_extensions import override

from . import _base
from ._so3 import SO3
from .utils import broadcast_leading_axes, get_epsilon


def _skew(omega: npt.NDArray[np.floating]) -> npt.NDArray[np.floating]:
    """Returns the skew-symmetric form of a length-3 vector."""

    wx, wy, wz = np.moveaxis(omega, -1, 0)
    zeros = np.zeros_like(wx)
    return np.stack(
        [zeros, -wz, wy, wz, zeros, -wx, -wy, wx, zeros],
        axis=-1,
    ).reshape((*omega.shape[:-1], 3, 3))


@dataclasses.dataclass(frozen=True)
class SE3(
    _base.SEBase[SO3],
    matrix_dim=4,
    parameters_dim=7,
    tangent_dim=6,
    space_dim=3,
):
    """Special Euclidean group for proper rigid transforms in 3D. Broadcasting
    rules are the same as for numpy.

    Ported to numpy from `jaxlie.SE3`.

    Internal parameterization is `(qw, qx, qy, qz, x, y, z)`. Tangent parameterization
    is `(vx, vy, vz, omega_x, omega_y, omega_z)`.
    """

    # SE3-specific.

    wxyz_xyz: npt.NDArray[np.floating]
    """Internal parameters. wxyz quaternion followed by xyz translation. Shape should be `(*, 7)`."""

    @override
    def __repr__(self) -> str:
        quat = np.round(self.wxyz_xyz[..., :4], 5)
        trans = np.round(self.wxyz_xyz[..., 4:], 5)
        return f"{self.__class__.__name__}(wxyz={quat}, xyz={trans})"

    # SE-specific.

    @classmethod
    @override
    def from_rotation_and_translation(
        cls,
        rotation: SO3,
        translation: npt.NDArray[np.floating],
    ) -> SE3:
        assert translation.shape[-1:] == (3,)
        rotation, translation = broadcast_leading_axes((rotation, translation))
        return SE3(wxyz_xyz=np.concatenate([rotation.wxyz, translation], axis=-1))

    @override
    def rotation(self) -> SO3:
        return SO3(wxyz=self.wxyz_xyz[..., :4])

    @override
    def translation(self) -> npt.NDArray[np.floating]:
        return self.wxyz_xyz[..., 4:]

    # Factory.

    @classmethod
    @override
    def identity(
        cls, batch_axes: Tuple[int, ...] = (), dtype: npt.DTypeLike = np.float64
    ) -> SE3:
        return SE3(
            wxyz_xyz=np.broadcast_to(
                np.array([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], dtype=dtype),
                (*batch_axes, 7),
            )
        )

    @classmethod
    @override
    def from_matrix(cls, matrix: npt.NDArray[np.floating]) -> SE3:
        assert matrix.shape[-2:] == (4, 4) or matrix.shape[-2:] == (3, 4)
        # Currently assumes bottom row is [0, 0, 0, 1].
        return SE3.from_rotation_and_translation(
            rotation=SO3.from_matrix(matrix[..., :3, :3]),
            translation=matrix[..., :3, 3],
        )

    # Accessors.

    @override
    def as_matrix(self) -> npt.NDArray[np.floating]:
        out = np.zeros((*self.get_batch_axes(), 4, 4), dtype=self.wxyz_xyz.dtype)
        out[..., :3, :3] = self.rotation().as_matrix()
        out[..., :3, 3] = self.translation()
        out[..., 3, 3] = 1.0
        return out

    @override
    def parameters(self) -> npt.NDArray[np.floating]:
        return self.wxyz_xyz

    # Operations.

    @classmethod
    @override
    def exp(cls, tangent: npt.NDArray[np.floating]) -> SE3:
        # Reference:
        # > https://github.com/strasdat/Sophus/blob/a0fe89a323e20c42d3cecb590937eb7a06b8343a/sophus/se3.hpp#L761

        # (x, y, z, omega_x, omega_y, omega_z)
        assert tangent.shape[-1:] == (6,)

        rotation = SO3.exp(tangent[..., 3:])

        theta_squared = np.sum(np.square(tangent[..., 3:]), axis=-1)
        use_taylor = theta_squared < get_epsilon(theta_squared.dtype)

        # Shim to avoid NaNs in np.where branches, which cause failures for
        # reverse-mode AD in JAX. This isn't needed for vanilla numpy.
        theta_squared_safe = cast(
            np.ndarray,
            np.where(
                use_taylor,
                np.ones_like(theta_squared),  # Any non-zero value should do here.
                theta_squared,
            ),
        )
        del theta_squared
        theta_safe = np.sqrt(theta_squared_safe)

        skew_omega = _skew(tangent[..., 3:])
        V = np.where(
            use_taylor[..., None, None],
            rotation.as_matrix(),
            (
                np.eye(3)
                + ((1.0 - np.cos(theta_safe)) / (theta_squared_safe))[..., None, None]
                * skew_omega
                + (
                    (theta_safe - np.sin(theta_safe))
                    / (theta_squared_safe * theta_safe)
                )[..., None, None]
                * np.einsum("...ij,...jk->...ik", skew_omega, skew_omega)
            ),
        )

        return SE3.from_rotation_and_translation(
            rotation=rotation,
            translation=np.einsum("...ij,...j->...i", V, tangent[..., :3]).astype(
                tangent.dtype
            ),
        )

    @override
    def log(self) -> npt.NDArray[np.floating]:
        # Reference:
        # > https://github.com/strasdat/Sophus/blob/a0fe89a323e20c42d3cecb590937eb7a06b8343a/sophus/se3.hpp#L223
        omega = self.rotation().log()
        theta_squared = np.sum(np.square(omega), axis=-1)
        use_taylor = theta_squared < get_epsilon(theta_squared.dtype)

        skew_omega = _skew(omega)

        # Shim to avoid NaNs in np.where branches, which cause failures for
        # reverse-mode AD in JAX. This isn't needed for vanilla numpy.
        theta_squared_safe = np.where(
            use_taylor,
            np.ones_like(theta_squared),  # Any non-zero value should do here.
            theta_squared,
        )
        del theta_squared
        theta_safe = np.sqrt(theta_squared_safe)
        half_theta_safe = theta_safe / 2.0

        V_inv = np.where(
            use_taylor[..., None, None],
            np.eye(3)
            - 0.5 * skew_omega
            + np.einsum("...ij,...jk->...ik", skew_omega, skew_omega) / 12.0,
            (
                np.eye(3)
                - 0.5 * skew_omega
                + (
                    (
                        1.0
                        - theta_safe
                        * np.cos(half_theta_safe)
                        / (2.0 * np.sin(half_theta_safe))
                    )
                    / theta_squared_safe
                )[..., None, None]
                * np.einsum("...ij,...jk->...ik", skew_omega, skew_omega)
            ),
        )
        return np.concatenate(
            [np.einsum("...ij,...j->...i", V_inv, self.translation()), omega], axis=-1
        ).astype(self.wxyz_xyz.dtype)

    @override
    def adjoint(self) -> npt.NDArray[np.floating]:
        R = self.rotation().as_matrix()
        return np.concatenate(
            [
                np.concatenate(
                    [R, np.einsum("...ij,...jk->...ik", _skew(self.translation()), R)],
                    axis=-1,
                ),
                np.concatenate(
                    [np.zeros((*self.get_batch_axes(), 3, 3), dtype=R.dtype), R],
                    axis=-1,
                ),
            ],
            axis=-2,
        )

    @classmethod
    @override
    def sample_uniform(
        cls,
        rng: np.random.Generator,
        batch_axes: Tuple[int, ...] = (),
        dtype: npt.DTypeLike = np.float64,
    ) -> SE3:
        return SE3.from_rotation_and_translation(
            rotation=SO3.sample_uniform(rng, batch_axes=batch_axes, dtype=dtype),
            translation=rng.uniform(low=-1.0, high=1.0, size=(*batch_axes, 3)).astype(
                dtype=dtype
            ),
        )
