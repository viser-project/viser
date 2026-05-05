"""Tests for general operation definitions."""

from typing import Tuple, Type

import numpy as np
import numpy.typing as onpt

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
