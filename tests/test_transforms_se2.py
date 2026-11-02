"""Tests for construction of 2D rigid transforms."""

import numpy as np
import pytest

from viser.transforms import SE2


@pytest.mark.parametrize(
    "x, y, theta",
    [
        (1.0, 2.0, 0.5),
        (np.array(1.0), np.array(2.0), np.array(0.5)),
        (np.array([1.0, 2.0]), 0.0, 0.0),
        (0.0, np.array([1.0, 2.0]), 0.5),
        (1.0, 2.0, np.array([0.0, 0.5])),
        (np.array([1.0, 2.0]), np.array([3.0, 4.0]), np.array([0.0, 0.5])),
        (np.array([[1.0], [2.0]]), np.array([[3.0, 4.0, 5.0]]), 0.5),
        (np.array([[1.0], [2.0]]), 3.0, np.array([[0.0, 0.5, 1.0]])),
        (np.empty((0, 1)), np.ones((1, 3)), 0.5),
    ],
)
def test_from_xy_theta_broadcasting(x, y, theta):
    transform = SE2.from_xy_theta(x, y, theta)
    x, y, theta = np.broadcast_arrays(x, y, theta)
    assert transform.get_batch_axes() == x.shape
    np.testing.assert_allclose(transform.translation(), np.stack([x, y], axis=-1))
    np.testing.assert_allclose(
        transform.rotation().parameters(),
        np.stack([np.cos(theta), np.sin(theta)], axis=-1),
    )


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("broadcast", [False, True])
def test_from_xy_theta_dtype(dtype, broadcast):
    x = np.array([[1.0], [2.0]], dtype=dtype)
    y = np.array([[3.0, 4.0, 5.0]] if broadcast else [[3.0], [4.0]], dtype=dtype)
    theta = np.array(0.5, dtype=dtype) if broadcast else np.full_like(x, 0.5)
    transform = SE2.from_xy_theta(x, y, theta)
    assert transform.parameters().dtype == dtype


def test_from_xy_theta_mixed_dtype():
    x = np.array([1.0, 2.0], dtype=np.float32)
    y = np.array([3.0, 4.0], dtype=np.float64)
    theta = np.array([0.0, 0.5], dtype=np.float32)
    transform = SE2.from_xy_theta(x, y, theta)
    expected = np.stack([np.cos(theta), np.sin(theta), x, y], axis=-1)
    np.testing.assert_array_equal(transform.parameters(), expected)
    assert transform.parameters().dtype == expected.dtype


@pytest.mark.parametrize("argument", range(3))
def test_from_xy_theta_incompatible_shapes(argument):
    args = [np.zeros(2), np.zeros(2), np.zeros(2)]
    args[argument] = np.zeros(3)
    with pytest.raises(ValueError):
        SE2.from_xy_theta(*args)
