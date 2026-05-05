from __future__ import annotations

import functools
import random
from typing import Any, Callable, TypeVar, cast

import numpy as np
import numpy.typing as npt
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

import viser.transforms as vtf

T = TypeVar("T", bound=vtf.MatrixLieGroup)


def sample_transform(
    Group: type[T], batch_axes: tuple[int, ...], dtype: npt.DTypeLike
) -> T:
    """Sample a random transform from a group."""
    seed = random.getrandbits(32)
    strategy = random.randint(0, 2)

    if strategy == 0:
        # Uniform sampling.
        return cast(
            T,
            Group.sample_uniform(
                np.random.default_rng(seed), batch_axes=batch_axes, dtype=dtype
            ),
        )
    elif strategy == 1:
        # Sample from normally-sampled tangent vector.
        return cast(
            T,
            Group.exp(
                np.random.randn(*batch_axes, Group.tangent_dim).astype(dtype=dtype)
            ),
        )
    elif strategy == 2:
        # Sample near identity.
        return cast(
            T,
            Group.exp(
                np.random.randn(*batch_axes, Group.tangent_dim).astype(dtype=dtype)
                * 1e-7
            ),
        )
    else:
        assert False


def general_group_test(
    f: Callable[[type[vtf.MatrixLieGroup], tuple[int, ...], npt.DTypeLike], None],
    max_examples: int = 15,
) -> Callable[[type[vtf.MatrixLieGroup], tuple[int, ...], npt.DTypeLike, Any], None]:
    """Decorator for defining tests that run on all group types."""

    # Disregard unused argument.
    def f_wrapped(
        Group: type[vtf.MatrixLieGroup],
        batch_axes: tuple[int, ...],
        dtype: npt.DTypeLike,
        _random_module: Any,
    ) -> None:
        f(Group, batch_axes, dtype)

    # Disable timing check (first run requires JIT tracing and will be slower).
    wrapped: Any = settings(deadline=None, max_examples=max_examples)(f_wrapped)

    # Add _random_module parameter.
    wrapped = given(_random_module=st.random_module())(wrapped)

    # Parametrize tests with each group type.
    wrapped = pytest.mark.parametrize(
        "Group",
        [
            vtf.SO2,
            vtf.SE2,
            vtf.SO3,
            vtf.SE3,
        ],
    )(wrapped)

    # Parametrize tests with each group type.
    wrapped = pytest.mark.parametrize(
        "batch_axes",
        [
            (),
            (1,),
            (3, 1, 2, 1),
        ],
    )(wrapped)

    # Parametrize tests with each group type.
    wrapped = pytest.mark.parametrize(
        "dtype",
        [np.float32, np.float64],
    )(wrapped)
    return wrapped


general_group_test_faster = functools.partial(general_group_test, max_examples=5)


def assert_transforms_close(a: vtf.MatrixLieGroup, b: vtf.MatrixLieGroup):
    """Make sure two transforms are equivalent."""
    # Check matrix representation.
    assert_arrays_close(a.as_matrix(), b.as_matrix())

    # Flip signs for quaternions.
    p1 = a.parameters().copy()
    p2 = b.parameters().copy()
    if isinstance(a, vtf.SO3):
        p1 = p1 * np.sign(np.sum(p1, axis=-1, keepdims=True))
        p2 = p2 * np.sign(np.sum(p2, axis=-1, keepdims=True))
    elif isinstance(a, vtf.SE3):
        p1[..., :4] *= np.sign(np.sum(p1[..., :4], axis=-1, keepdims=True))
        p2[..., :4] *= np.sign(np.sum(p2[..., :4], axis=-1, keepdims=True))

    # Make sure parameters are equal.
    assert_arrays_close(p1, p2)


def assert_arrays_close(*arrays: npt.NDArray[np.floating] | float):
    """Make sure two arrays are close. (and not NaN)"""
    for array1, array2 in zip(arrays[:-1], arrays[1:]):
        assert np.asarray(array1).dtype == np.asarray(array2).dtype

        if isinstance(array1, (float, int)) or array1.dtype == np.float64:
            rtol = 1e-7
            atol = 1e-7
        else:
            rtol = 1e-3
            atol = 1e-3

        np.testing.assert_allclose(array1, array2, rtol=rtol, atol=atol)
        assert not np.any(np.isnan(array1))
        assert not np.any(np.isnan(array2))
