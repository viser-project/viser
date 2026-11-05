"""Tests for general operation definitions."""

from typing import List, Tuple, Type

import numpy as np
import numpy.typing as onpt
import pytest

import viser.transforms as vtf

from .utils import (
    assert_arrays_close,
    assert_transforms_close,
    general_group_test,
    sample_transform,
)


@general_group_test
def test_sample_uniform_valid(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check that sample_uniform() returns valid group members."""
    T = sample_transform(
        Group, batch_axes, dtype
    )  # Calls sample_uniform under the hood.
    assert_transforms_close(T, T.normalize())


@general_group_test
def test_log_exp_bijective(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check 1-to-1 mapping for log <=> exp operations."""
    transform = sample_transform(Group, batch_axes, dtype)

    tangent = transform.log()
    assert tangent.shape == (*batch_axes, Group.tangent_dim)

    exp_transform = Group.exp(tangent)
    assert_transforms_close(transform, exp_transform)
    assert_arrays_close(tangent, exp_transform.log())


@general_group_test
def test_inverse_bijective(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check inverse of inverse."""
    transform = sample_transform(Group, batch_axes, dtype)
    assert_transforms_close(transform, transform.inverse().inverse())


@general_group_test
def test_matrix_bijective(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check that we can convert to and from matrices."""
    transform = sample_transform(Group, batch_axes, dtype)
    assert_transforms_close(transform, Group.from_matrix(transform.as_matrix()))


@pytest.mark.parametrize(
    "Group, matrix",
    [
        (vtf.SO2, [[0, -1], [1, 0]]),
        (vtf.SE2, [[0, -1, 1], [1, 0, 2], [0, 0, 1]]),
        (vtf.SO3, [[1, 0, 0], [0, 0, -1], [0, 1, 0]]),
        (vtf.SO3, [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]),
        (vtf.SO3, [[0, -1, 0], [1, 0, 0], [0, 0, 1]]),
        (vtf.SO3, [[0, 0, 1], [1, 0, 0], [0, 1, 0]]),
        (vtf.SO3, [[0, 1, 0], [1, 0, 0], [0, 0, -1]]),
        (vtf.SE3, [[1, 0, 0, 1], [0, 0, -1, 2], [0, 1, 0, 3], [0, 0, 0, 1]]),
    ],
)
@pytest.mark.parametrize("dtype", [np.int16, np.int32, np.int64])
def test_from_matrix_integer_dtype(
    Group: Type[vtf.MatrixLieGroup], matrix: List[List[int]], dtype: onpt.DTypeLike
):
    """Check that integer matrices behave like their floating point equivalents."""
    integer_matrix = np.array(matrix, dtype=dtype)
    float_matrix = integer_matrix.astype(np.result_type(dtype, np.float32))

    transform = Group.from_matrix(integer_matrix)
    expected = Group.from_matrix(float_matrix)

    assert transform.parameters().dtype == float_matrix.dtype
    assert_transforms_close(transform, expected)
    assert_arrays_close(transform.as_matrix(), float_matrix)
    assert_arrays_close(transform.log(), expected.log())


@general_group_test
def test_adjoint(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check adjoint definition."""
    transform = sample_transform(Group, batch_axes, dtype)
    omega = np.random.randn(*batch_axes, Group.tangent_dim).astype(dtype=dtype)
    assert_transforms_close(
        transform @ Group.exp(omega),
        Group.exp(np.einsum("...ij,...j->...i", transform.adjoint(), omega))
        @ transform,
    )


@general_group_test
def test_repr(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Smoke test for __repr__ implementations."""
    transform = sample_transform(Group, batch_axes, dtype)
    print(transform)


@general_group_test
def test_apply(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check group action interfaces."""
    T_w_b = sample_transform(Group, batch_axes, dtype)
    p_b = np.random.randn(*batch_axes, Group.space_dim).astype(dtype)

    if Group.matrix_dim == Group.space_dim:
        assert_arrays_close(
            T_w_b @ p_b,
            T_w_b.apply(p_b),
            np.einsum("...ij,...j->...i", T_w_b.as_matrix(), p_b),
        )
    else:
        # Homogeneous coordinates.
        assert Group.matrix_dim == Group.space_dim + 1
        assert_arrays_close(
            T_w_b @ p_b,
            T_w_b.apply(p_b),
            np.einsum(
                "...ij,...j->...i",
                T_w_b.as_matrix(),
                np.concatenate([p_b, np.ones_like(p_b[..., :1])], axis=-1),
            )[..., :-1],
        )


@general_group_test
def test_multiply(
    Group: Type[vtf.MatrixLieGroup], batch_axes: Tuple[int, ...], dtype: onpt.DTypeLike
):
    """Check multiply interfaces."""
    T_w_b = sample_transform(Group, batch_axes, dtype)
    T_b_a = sample_transform(Group, batch_axes, dtype)
    assert_arrays_close(
        np.einsum(
            "...ij,...jk->...ik", T_w_b.as_matrix(), np.linalg.inv(T_w_b.as_matrix())
        ),
        np.broadcast_to(
            np.eye(Group.matrix_dim, dtype=dtype),
            (*batch_axes, Group.matrix_dim, Group.matrix_dim),
        ),
    )
    assert_transforms_close(T_w_b @ T_b_a, Group.multiply(T_w_b, T_b_a))


def test_small_angle_log_exp_precision():
    """Regression: SE2/SE3 exp->log round-trip must stay near machine precision
    even for small rotation angles.

    The closed-form V / V_inv coefficients ((1 - cos t)/t, (t - sin t)/t^3,
    1 - (t/2) cot(t/2)) used to lose precision in a band just above the (far too
    tight) Taylor threshold -- e.g. SE3 float32 round-trip error ~4e-3 near
    t ~ 3e-3. The reformulated / widened-Taylor coefficients keep the error at
    the noise floor across the whole small-angle range.
    """
    # Sweep angles spanning the previously-bad band, well below the old
    # thresholds up through ~1 rad.
    thetas = np.logspace(-6, 0, 60)
    for dtype, atol in ((np.float32, 1e-5), (np.float64, 1e-10)):
        axis = np.array([0.3, -0.5, 0.8])
        axis = axis / np.linalg.norm(axis)
        for theta_f in thetas:
            theta = np.asarray(theta_f, dtype=dtype)

            tangent_se2 = np.array([0.7, -0.4, theta], dtype=dtype)
            roundtrip_se2 = vtf.SE2.exp(tangent_se2).log()
            assert np.max(np.abs(roundtrip_se2 - tangent_se2)) < atol, (
                "SE2",
                np.dtype(dtype).name,
                float(theta),
            )

            tangent_se3 = np.concatenate(
                [np.array([0.7, -0.4, 0.9]), axis * theta]
            ).astype(dtype)
            roundtrip_se3 = vtf.SE3.exp(tangent_se3).log()
            assert np.max(np.abs(roundtrip_se3 - tangent_se3)) < atol, (
                "SE3",
                np.dtype(dtype).name,
                float(theta),
            )
