from __future__ import annotations

import dataclasses
from typing import Tuple

import numpy as np
import numpy.typing as npt
from typing_extensions import override

from . import _base, hints
from .utils import broadcast_leading_axes


@dataclasses.dataclass(frozen=True)
class SO2(
    _base.SOBase,
    matrix_dim=2,
    parameters_dim=2,
    tangent_dim=1,
    space_dim=2,
):
    """Special orthogonal group for 2D rotations. Broadcasting rules are the
    same as for numpy.

    Ported to numpy from `jaxlie.SO2`.

    Internal parameterization is `(cos, sin)`. Tangent parameterization is `(omega,)`.
    """

    # SO2-specific.

    unit_complex: npt.NDArray[np.floating]
    """Internal parameters. `(cos, sin)`. Shape should be `(*, 2)`."""

    @override
    def __repr__(self) -> str:
        unit_complex = np.round(self.unit_complex, 5)
        return f"{self.__class__.__name__}(unit_complex={unit_complex})"

    @staticmethod
    def from_radians(theta: hints.Scalar) -> SO2:
        """Construct a rotation object from a scalar angle."""
        cos = np.cos(theta)
        sin = np.sin(theta)
        return SO2(unit_complex=np.stack([cos, sin], axis=-1))

    def as_radians(self) -> npt.NDArray[np.floating]:
        """Compute a scalar angle from a rotation object."""
        radians = self.log()[..., 0]
        return radians

    # Factory.

    @classmethod
    @override
    def identity(
        cls, batch_axes: Tuple[int, ...] = (), dtype: npt.DTypeLike = np.float64
    ) -> SO2:
        return SO2(
            unit_complex=np.stack(
                [np.ones(batch_axes, dtype=dtype), np.zeros(batch_axes, dtype=dtype)],
                axis=-1,
            )
        )

    @classmethod
    @override
    def from_matrix(cls, matrix: npt.NDArray[np.floating]) -> SO2:
        assert matrix.shape[-2:] == (2, 2)
        return SO2(unit_complex=np.array(matrix[..., :, 0]))

    # Accessors.

    @override
    def as_matrix(self) -> npt.NDArray[np.floating]:
        cos_sin = self.unit_complex
        out = np.stack(
            [
                # [cos, -sin],
                cos_sin * np.array([1, -1], dtype=cos_sin.dtype),
                # [sin, cos],
                cos_sin[..., ::-1],
            ],
            axis=-2,
        )
        assert out.shape == (*self.get_batch_axes(), 2, 2)
        return out  # type: ignore

    @override
    def parameters(self) -> npt.NDArray[np.floating]:
        return self.unit_complex

    # Operations.

    @override
    def apply(self, target: npt.NDArray[np.floating]) -> npt.NDArray[np.floating]:
        assert target.shape[-1:] == (2,)
        self, target = broadcast_leading_axes((self, target))
        return np.einsum("...ij,...j->...i", self.as_matrix(), target)

    @override
    def multiply(self, other: SO2) -> SO2:  # type: ignore
        return SO2(
            unit_complex=np.einsum(
                "...ij,...j->...i", self.as_matrix(), other.unit_complex
            )
        )

    @classmethod
    @override
    def exp(cls, tangent: npt.NDArray[np.floating]) -> SO2:
        assert tangent.shape[-1] == 1
        cos = np.cos(tangent)
        sin = np.sin(tangent)
        return SO2(unit_complex=np.concatenate([cos, sin], axis=-1))

    @override
    def log(self) -> npt.NDArray[np.floating]:
        return np.arctan2(
            self.unit_complex[..., 1, None], self.unit_complex[..., 0, None]
        )

    @override
    def adjoint(self) -> npt.NDArray[np.floating]:
        return np.ones((*self.get_batch_axes(), 1, 1), dtype=self.unit_complex.dtype)

    @override
    def inverse(self) -> SO2:
        unit_complex = self.unit_complex.copy()
        unit_complex[..., 1] *= -1
        return SO2(unit_complex)

    @override
    def normalize(self) -> SO2:
        return SO2(
            unit_complex=self.unit_complex
            / np.linalg.norm(self.unit_complex, axis=-1, keepdims=True)
        )

    @classmethod
    @override
    def sample_uniform(
        cls,
        rng: np.random.Generator,
        batch_axes: Tuple[int, ...] = (),
        dtype: npt.DTypeLike = np.float64,
    ) -> SO2:
        out = SO2.from_radians(
            rng.uniform(0.0, 2.0 * np.pi, size=batch_axes).astype(dtype=dtype)
        )
        assert out.get_batch_axes() == batch_axes
        return out
