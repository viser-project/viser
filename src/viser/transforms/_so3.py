from __future__ import annotations

import dataclasses
from typing import NamedTuple, Tuple

import numpy as onp
import numpy.typing as onpt
from typing_extensions import override

from . import _base, hints
from .utils import broadcast_leading_axes, get_epsilon


class RollPitchYaw(NamedTuple):
    """Struct containing roll, pitch, and yaw Euler angles."""

    roll: onpt.NDArray[onp.floating]
    pitch: onpt.NDArray[onp.floating]
    yaw: onpt.NDArray[onp.floating]


@dataclasses.dataclass(frozen=True)
class SO3(
    _base.SOBase,
    matrix_dim=3,
    parameters_dim=4,
    tangent_dim=3,
    space_dim=3,
):
    """Special orthogonal group for 3D rotations. Broadcasting rules are the same as
    for numpy.

    Ported to numpy from `jaxlie.SO3`.

    Internal parameterization is `(qw, qx, qy, qz)`. Tangent parameterization is
    `(omega_x, omega_y, omega_z)`.
    """

    wxyz: onpt.NDArray[onp.floating]
    """Internal parameters. `(w, x, y, z)` quaternion. Shape should be `(*, 4)`."""

    @override
    def __repr__(self) -> str:
        wxyz = onp.round(self.wxyz, 5)
        return f"{self.__class__.__name__}(wxyz={wxyz})"

    @staticmethod
    def from_x_radians(theta: hints.Scalar) -> SO3:
        """Generates a x-axis rotation.

        Args:
            angle: X rotation, in radians.

        Returns:
            Output.
        """
        zeros = onp.zeros_like(theta)
        return SO3.exp(onp.stack([theta, zeros, zeros], axis=-1))

    @staticmethod
    def from_y_radians(theta: hints.Scalar) -> SO3:
        """Generates a y-axis rotation.

        Args:
            angle: Y rotation, in radians.

        Returns:
            Output.
        """
        zeros = onp.zeros_like(theta)
        return SO3.exp(onp.stack([zeros, theta, zeros], axis=-1))

    @staticmethod
    def from_z_radians(theta: hints.Scalar) -> SO3:
        """Generates a z-axis rotation.

        Args:
            angle: Z rotation, in radians.

        Returns:
            Output.
        """
        zeros = onp.zeros_like(theta)
        return SO3.exp(onp.stack([zeros, zeros, theta], axis=-1))

    @staticmethod
    def from_rpy_radians(
        roll: hints.Scalar,
        pitch: hints.Scalar,
        yaw: hints.Scalar,
    ) -> SO3:
        """Generates a transform from a set of Euler angles. Uses the ZYX mobile robot
        convention.

        Args:
            roll: X rotation, in radians. Applied first.
            pitch: Y rotation, in radians. Applied second.
            yaw: Z rotation, in radians. Applied last.

        Returns:
            Output.
        """
        return (
            SO3.from_z_radians(yaw)
            @ SO3.from_y_radians(pitch)
            @ SO3.from_x_radians(roll)
        )

    @staticmethod
    def from_quaternion_xyzw(xyzw: onpt.NDArray[onp.floating]) -> SO3:
        """Construct a rotation from an `xyzw` quaternion.

        Note that `wxyz` quaternions can be constructed using the default dataclass
        constructor.

        Args:
            xyzw: xyzw quaternion. Shape should be ``(*, 4)``.

        Returns:
            Output.
        """
        assert xyzw.shape[-1:] == (4,)
        return SO3(onp.roll(xyzw, axis=-1, shift=1))

    def as_quaternion_xyzw(self) -> onpt.NDArray[onp.floating]:
        """Grab parameters as xyzw quaternion."""
        return onp.roll(self.wxyz, axis=-1, shift=-1)

    def as_rpy_radians(self) -> RollPitchYaw:
        """Computes roll, pitch, and yaw angles. Uses the ZYX mobile robot convention.

        Returns:
            NamedTuple containing Euler angles in radians.
        """
        return RollPitchYaw(
            roll=self.compute_roll_radians(),
            pitch=self.compute_pitch_radians(),
            yaw=self.compute_yaw_radians(),
        )

    def compute_roll_radians(self) -> onpt.NDArray[onp.floating]:
        """Compute roll angle. Uses the ZYX mobile robot convention.

        Returns:
            Euler angle in radians.
        """
        # https://en.wikipedia.org/wiki/Conversion_between_quaternions_and_Euler_angles#Quaternion_to_Euler_angles_conversion
        q0, q1, q2, q3 = onp.moveaxis(self.wxyz, -1, 0)
        return onp.arctan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1**2 + q2**2))

    def compute_pitch_radians(self) -> onpt.NDArray[onp.floating]:
        """Compute pitch angle. Uses the ZYX mobile robot convention.

        Returns:
            Euler angle in radians.
        """
        # https://en.wikipedia.org/wiki/Conversion_between_quaternions_and_Euler_angles#Quaternion_to_Euler_angles_conversion
        q0, q1, q2, q3 = onp.moveaxis(self.wxyz, -1, 0)
        return onp.arcsin(2 * (q0 * q2 - q3 * q1))

    def compute_yaw_radians(self) -> onpt.NDArray[onp.floating]:
        """Compute yaw angle. Uses the ZYX mobile robot convention.

        Returns:
            Euler angle in radians.
        """
        # https://en.wikipedia.org/wiki/Conversion_between_quaternions_and_Euler_angles#Quaternion_to_Euler_angles_conversion
        q0, q1, q2, q3 = onp.moveaxis(self.wxyz, -1, 0)
        return onp.arctan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2**2 + q3**2))

    # Factory.

    @classmethod
    @override
    def identity(
        cls, batch_axes: Tuple[int, ...] = (), dtype: onpt.DTypeLike = onp.float64
    ) -> SO3:
        return SO3(
            wxyz=onp.broadcast_to(
                onp.array([1.0, 0.0, 0.0, 0.0], dtype=dtype), (*batch_axes, 4)
            )
        )

    @classmethod
    @override
    def from_matrix(cls, matrix: onpt.NDArray[onp.floating]) -> SO3:
        assert matrix.shape[-2:] == (3, 3)

        # Modified from:
        # > "Converting a Rotation Matrix to a Quaternion" from Mike Day
        # > https://d3cw3dd2w32x2b.cloudfront.net/wp-content/uploads/2015/01/matrix-to-quat.pdf

        def case0(m):
            t = 1 + m[..., 0, 0] - m[..., 1, 1] - m[..., 2, 2]
            q = onp.stack(
                [
                    m[..., 2, 1] - m[..., 1, 2],
                    t,
                    m[..., 1, 0] + m[..., 0, 1],
                    m[..., 0, 2] + m[..., 2, 0],
                ],
                axis=-1,
            )
            return t, q

        def case1(m):
            t = 1 - m[..., 0, 0] + m[..., 1, 1] - m[..., 2, 2]
            q = onp.stack(
                [
                    m[..., 0, 2] - m[..., 2, 0],
                    m[..., 1, 0] + m[..., 0, 1],
                    t,
                    m[..., 2, 1] + m[..., 1, 2],
                ],
                axis=-1,
            )
            return t, q

        def case2(m):
            t = 1 - m[..., 0, 0] - m[..., 1, 1] + m[..., 2, 2]
            q = onp.stack(
                [
                    m[..., 1, 0] - m[..., 0, 1],
                    m[..., 0, 2] + m[..., 2, 0],
                    m[..., 2, 1] + m[..., 1, 2],
                    t,
                ],
                axis=-1,
            )
            return t, q

        def case3(m):
            t = 1 + m[..., 0, 0] + m[..., 1, 1] + m[..., 2, 2]
            q = onp.stack(
                [
                    t,
                    m[..., 2, 1] - m[..., 1, 2],
                    m[..., 0, 2] - m[..., 2, 0],
                    m[..., 1, 0] - m[..., 0, 1],
                ],
                axis=-1,
            )
            return t, q

        # Compute four cases, then pick the most precise one.
        # Probably worth revisiting this!
        case0_t, case0_q = case0(matrix)
        case1_t, case1_q = case1(matrix)
        case2_t, case2_q = case2(matrix)
        case3_t, case3_q = case3(matrix)

        cond0 = matrix[..., 2, 2] < 0
        cond1 = matrix[..., 0, 0] > matrix[..., 1, 1]
        cond2 = matrix[..., 0, 0] < -matrix[..., 1, 1]

        t = onp.where(
            cond0,
            onp.where(cond1, case0_t, case1_t),
            onp.where(cond2, case2_t, case3_t),
        )
        q = onp.where(
            cond0[..., None],
            onp.where(cond1[..., None], case0_q, case1_q),
            onp.where(cond2[..., None], case2_q, case3_q),
        )
        return SO3(wxyz=(q * 0.5 / onp.sqrt(t[..., None])).astype(matrix.dtype))

    # Accessors.

    @override
    def as_matrix(self) -> onpt.NDArray[onp.floating]:
        norm_sq = onp.sum(onp.square(self.wxyz), axis=-1, keepdims=True)
        q = self.wxyz * onp.sqrt(2.0 / norm_sq)  # (*, 4)
        q_outer = onp.einsum("...i,...j->...ij", q, q)  # (*, 4, 4)
        return (
            onp.stack(
                [
                    1.0 - q_outer[..., 2, 2] - q_outer[..., 3, 3],
                    q_outer[..., 1, 2] - q_outer[..., 3, 0],
                    q_outer[..., 1, 3] + q_outer[..., 2, 0],
                    q_outer[..., 1, 2] + q_outer[..., 3, 0],
                    1.0 - q_outer[..., 1, 1] - q_outer[..., 3, 3],
                    q_outer[..., 2, 3] - q_outer[..., 1, 0],
                    q_outer[..., 1, 3] - q_outer[..., 2, 0],
                    q_outer[..., 2, 3] + q_outer[..., 1, 0],
                    1.0 - q_outer[..., 1, 1] - q_outer[..., 2, 2],
                ],
                axis=-1,
            )
            .reshape(*q.shape[:-1], 3, 3)
            .astype(self.wxyz.dtype)
        )

    @override
    def parameters(self) -> onpt.NDArray[onp.floating]:
        return self.wxyz

    # Operations.

    @override
    def apply(self, target: onpt.NDArray[onp.floating]) -> onpt.NDArray[onp.floating]:
        assert target.shape[-1:] == (3,)
        self, target = broadcast_leading_axes((self, target))

        # Compute using quaternion multiplys.
        padded_target = onp.concatenate(
            [onp.zeros((*self.get_batch_axes(), 1), dtype=target.dtype), target],
            axis=-1,
        )
        return (self @ SO3(wxyz=padded_target) @ self.inverse()).wxyz[..., 1:]

    @override
    def multiply(self, other: SO3) -> SO3:  # type: ignore
        w0, x0, y0, z0 = onp.moveaxis(self.wxyz, -1, 0)
        w1, x1, y1, z1 = onp.moveaxis(other.wxyz, -1, 0)
        return SO3(
            wxyz=onp.stack(
                [
                    -x0 * x1 - y0 * y1 - z0 * z1 + w0 * w1,
                    x0 * w1 + y0 * z1 - z0 * y1 + w0 * x1,
                    -x0 * z1 + y0 * w1 + z0 * x1 + w0 * y1,
                    x0 * y1 - y0 * x1 + z0 * w1 + w0 * z1,
                ],
                axis=-1,
            )
        )

    @classmethod
    @override
    def exp(cls, tangent: onpt.NDArray[onp.floating]) -> SO3:
        # Reference:
        # > https://github.com/strasdat/Sophus/blob/a0fe89a323e20c42d3cecb590937eb7a06b8343a/sophus/so3.hpp#L583

        assert tangent.shape[-1:] == (3,)

        theta_squared = onp.sum(onp.square(tangent), axis=-1)
        theta_pow_4 = theta_squared * theta_squared
        use_taylor = theta_squared < get_epsilon(tangent.dtype)

        # Shim to avoid NaNs in onp.where branches, which cause failures for
        # reverse-mode AD in JAX. This isn't needed for vanilla numpy.
        safe_theta = onp.sqrt(
            onp.where(
                use_taylor,
                onp.ones_like(theta_squared),  # Any constant value should do here.
                theta_squared,
            )
        )

        # Fun fact: when safe_theta is a `float32` _scalar_, this
        # multiplication will promote `safe_half_theta` to `float64`. We'll
        # cast at the end to make sure our input/output dtypes match.
        safe_half_theta = 0.5 * safe_theta
        real_factor = onp.where(
            use_taylor,
            1.0 - theta_squared / 8.0 + theta_pow_4 / 384.0,
            onp.cos(safe_half_theta),
        )
        imaginary_factor = onp.where(
            use_taylor,
            0.5 - theta_squared / 48.0 + theta_pow_4 / 3840.0,
            onp.sin(safe_half_theta) / safe_theta,
        )

        return SO3(
            wxyz=onp.concatenate(
                [
                    real_factor[..., None],
                    imaginary_factor[..., None] * tangent,
                ],
                axis=-1,
            ).astype(tangent.dtype)
        )

    @override
    def log(self) -> onpt.NDArray[onp.floating]:
        # Reference:
        # > https://github.com/strasdat/Sophus/blob/a0fe89a323e20c42d3cecb590937eb7a06b8343a/sophus/so3.hpp#L247

        w = self.wxyz[..., 0]
        norm_sq = onp.sum(onp.square(self.wxyz[..., 1:]), axis=-1)
        use_taylor = norm_sq < get_epsilon(norm_sq.dtype)

        # Shim to avoid NaNs in onp.where branches, which cause failures for
        # reverse-mode AD in JAX. This isn't needed for vanilla numpy.
        norm_safe = onp.sqrt(
            onp.where(
                use_taylor,
                1.0,  # Any non-zero value should do here.
                norm_sq,
            )
        )
        w_safe = onp.where(use_taylor, w, 1.0)
        atan_n_over_w = onp.arctan2(
            onp.where(w < 0, -norm_safe, norm_safe),
            onp.abs(w),
        )
        atan_factor = onp.where(
            use_taylor,
            2.0 / w_safe - 2.0 / 3.0 * norm_sq / w_safe**3,
            onp.where(
                onp.abs(w) < get_epsilon(w.dtype),
                onp.where(w > 0, 1.0, -1.0).astype(dtype=w.dtype) * onp.pi / norm_safe,
                2.0 * atan_n_over_w / norm_safe,
            ),
        )
        return (atan_factor[..., None] * self.wxyz[..., 1:]).astype(self.wxyz.dtype)

    @override
    def adjoint(self) -> onpt.NDArray[onp.floating]:
        return self.as_matrix()

    @override
    def inverse(self) -> SO3:
        # Negate complex terms.
        wxyz = self.wxyz.copy()
        wxyz[..., 1:] *= -1
        return SO3(wxyz)

    @override
    def normalize(self) -> SO3:
        return SO3(wxyz=self.wxyz / onp.linalg.norm(self.wxyz, axis=-1, keepdims=True))

    @classmethod
    @override
    def sample_uniform(
        cls,
        rng: onp.random.Generator,
        batch_axes: Tuple[int, ...] = (),
        dtype: onpt.DTypeLike = onp.float64,
    ) -> SO3:
        # Uniformly sample over S^3.
        # > Reference: http://planning.cs.uiuc.edu/node198.html
        u1, u2, u3 = onp.moveaxis(
            rng.uniform(
                low=onp.zeros(3),
                high=onp.array([1.0, 2.0 * onp.pi, 2.0 * onp.pi]),
                size=(*batch_axes, 3),
            ),
            -1,
            0,
        )
        a = onp.sqrt(1.0 - u1)
        b = onp.sqrt(u1)

        return SO3(
            wxyz=onp.stack(
                [
                    a * onp.sin(u2),
                    a * onp.cos(u2),
                    b * onp.sin(u3),
                    b * onp.cos(u3),
                ],
                axis=-1,
            ).astype(dtype=dtype)
        )
