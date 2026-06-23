from __future__ import annotations

import dataclasses
from typing import Tuple, cast

import numpy as np
import numpy.typing as npt
from typing_extensions import override

from . import _base, hints
from ._so2 import SO2
from .utils import broadcast_leading_axes, get_epsilon


@dataclasses.dataclass(frozen=True)
class SE2(
    _base.SEBase[SO2],
    matrix_dim=3,
    parameters_dim=4,
    tangent_dim=3,
    space_dim=2,
):
    """Special Euclidean group for proper rigid transforms in 2D. Broadcasting
    rules are the same as for numpy.

    Ported to numpy from `jaxlie.SE2`.

    Internal parameterization is `(cos, sin, x, y)`. Tangent parameterization is `(vx,
    vy, omega)`.
    """

    # SE2-specific.

    unit_complex_xy: npt.NDArray[np.floating]
    """Internal parameters. `(cos, sin, x, y)`. Shape should be `(*, 4)`."""

    @override
    def __repr__(self) -> str:
        unit_complex = np.round(self.unit_complex_xy[..., :2], 5)
        xy = np.round(self.unit_complex_xy[..., 2:], 5)
        return f"{self.__class__.__name__}(unit_complex={unit_complex}, xy={xy})"

    @staticmethod
    def from_xy_theta(x: hints.Scalar, y: hints.Scalar, theta: hints.Scalar) -> SE2:
        """Construct a transformation from standard 2D pose parameters.

        This is not the same as integrating over a length-3 twist.
        """
        cos = np.cos(theta)
        sin = np.sin(theta)
        return SE2(unit_complex_xy=np.stack([cos, sin, x, y], axis=-1))

    # SE-specific.

    @classmethod
    @override
    def from_rotation_and_translation(
        cls,
        rotation: SO2,
        translation: npt.NDArray[np.floating],
    ) -> SE2:
        assert translation.shape[-1:] == (2,)
        rotation, translation = broadcast_leading_axes((rotation, translation))
        return SE2(
            unit_complex_xy=np.concatenate(
                [rotation.unit_complex, translation], axis=-1
            )
        )

    @override
    def rotation(self) -> SO2:
        return SO2(unit_complex=self.unit_complex_xy[..., :2])

    @override
    def translation(self) -> npt.NDArray[np.floating]:
        return self.unit_complex_xy[..., 2:]

    # Factory.

    @classmethod
    @override
    def identity(
        cls, batch_axes: Tuple[int, ...] = (), dtype: npt.DTypeLike = np.float64
    ) -> SE2:
        return SE2(
            unit_complex_xy=np.broadcast_to(
                np.array([1.0, 0.0, 0.0, 0.0], dtype=dtype), (*batch_axes, 4)
            )
        )

    @classmethod
    @override
    def from_matrix(cls, matrix: npt.NDArray[np.floating]) -> SE2:
        assert matrix.shape[-2:] == (3, 3) or matrix.shape[-2:] == (2, 3)
        # Currently assumes bottom row is [0, 0, 1].
        return SE2.from_rotation_and_translation(
            rotation=SO2.from_matrix(matrix[..., :2, :2]),
            translation=matrix[..., :2, 2],
        )

    # Accessors.

    @override
    def parameters(self) -> npt.NDArray[np.floating]:
        return self.unit_complex_xy

    @override
    def as_matrix(self) -> npt.NDArray[np.floating]:
        cos, sin, x, y = np.moveaxis(self.unit_complex_xy, -1, 0)
        out = np.stack(
            [
                cos,
                -sin,
                x,
                sin,
                cos,
                y,
                np.zeros_like(x),
                np.zeros_like(x),
                np.ones_like(x),
            ],
            axis=-1,
        ).reshape((*self.get_batch_axes(), 3, 3))
        return out

    # Operations.

    @classmethod
    @override
    def exp(cls, tangent: npt.NDArray[np.floating]) -> SE2:
        # Reference:
        # > https://github.com/strasdat/Sophus/blob/a0fe89a323e20c42d3cecb590937eb7a06b8343a/sophus/se2.hpp#L558
        # Also see:
        # > http://ethaneade.com/lie.pdf

        assert tangent.shape[-1:] == (3,)

        theta = tangent[..., 2]
        use_taylor = np.abs(theta) < get_epsilon(tangent.dtype)

        # Shim to avoid NaNs in np.where branches, which cause failures for
        # reverse-mode AD in JAX. This isn't needed for vanilla numpy.
        safe_theta = cast(
            np.ndarray,
            np.where(
                use_taylor,
                np.ones_like(theta),  # Any non-zero value should do here.
                theta,
            ),
        )

        theta_sq = theta**2
        sin_over_theta = np.where(
            use_taylor,
            1.0 - theta_sq / 6.0,
            np.sin(safe_theta) / safe_theta,
        )
        one_minus_cos_over_theta = np.where(
            use_taylor,
            0.5 * theta - theta * theta_sq / 24.0,
            # (1 - cos t) / t, written as 2 sin^2(t/2) / t to avoid the
            # catastrophic cancellation in (1 - cos t) for small t.
            2.0 * np.sin(safe_theta / 2.0) ** 2 / safe_theta,
        )

        V = np.stack(
            [
                sin_over_theta,
                -one_minus_cos_over_theta,
                one_minus_cos_over_theta,
                sin_over_theta,
            ],
            axis=-1,
        ).reshape((*tangent.shape[:-1], 2, 2))

        return SE2.from_rotation_and_translation(
            rotation=SO2.from_radians(theta),
            translation=np.einsum("...ij,...j->...i", V, tangent[..., :2]).astype(
                tangent.dtype
            ),
        )

    @override
    def log(self) -> npt.NDArray[np.floating]:
        # Reference:
        # > https://github.com/strasdat/Sophus/blob/a0fe89a323e20c42d3cecb590937eb7a06b8343a/sophus/se2.hpp#L160
        # Also see:
        # > http://ethaneade.com/lie.pdf

        theta = self.rotation().log()[..., 0]

        half_theta = theta / 2.0
        use_taylor = np.abs(theta) < get_epsilon(theta.dtype)

        # Shim to avoid NaNs in np.where branches (0/0 at theta == 0), which
        # also cause failures for reverse-mode AD in JAX.
        safe_half_theta = np.where(
            use_taylor,
            np.ones_like(half_theta),  # Any non-zero value should do here.
            half_theta,
        )

        half_theta_over_tan_half_theta = np.where(
            use_taylor,
            # Taylor approximation.
            1.0 - theta**2 / 12.0,
            # (theta / 2) / tan(theta / 2) -- equivalent to the textbook
            # -(theta/2) sin(theta) / (cos(theta) - 1), but tan(theta/2) avoids
            # the catastrophic cancellation in (cos(theta) - 1) for small theta.
            half_theta / np.tan(safe_half_theta),
        )

        V_inv = np.stack(
            [
                half_theta_over_tan_half_theta,
                half_theta,
                -half_theta,
                half_theta_over_tan_half_theta,
            ],
            axis=-1,
        ).reshape((*theta.shape, 2, 2))

        tangent = np.concatenate(
            [
                np.einsum("...ij,...j->...i", V_inv, self.translation()),
                theta[..., None],
            ],
            axis=-1,
        )
        return tangent.astype(self.unit_complex_xy.dtype)

    @override
    def adjoint(self: SE2) -> npt.NDArray[np.floating]:
        cos, sin, x, y = np.moveaxis(self.unit_complex_xy, -1, 0)
        return np.stack(
            [
                cos,
                -sin,
                y,
                sin,
                cos,
                -x,
                np.zeros_like(x),
                np.zeros_like(x),
                np.ones_like(x),
            ],
            axis=-1,
        ).reshape((*self.get_batch_axes(), 3, 3))

    @classmethod
    @override
    def sample_uniform(
        cls,
        rng: np.random.Generator,
        batch_axes: Tuple[int, ...] = (),
        dtype: npt.DTypeLike = np.float64,
    ) -> SE2:
        return SE2.from_rotation_and_translation(
            SO2.sample_uniform(rng, batch_axes=batch_axes, dtype=dtype),
            rng.uniform(low=-1.0, high=1.0, size=(*batch_axes, 2)).astype(dtype),
        )
