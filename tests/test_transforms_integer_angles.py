"""Scalar-angle constructors accept Python integers like other real scalars."""

import numpy as np
import pytest

import viser.transforms as vtf


@pytest.mark.parametrize("axis", ["x", "y", "z"])
@pytest.mark.parametrize("angle", [0, 1, -2])
def test_so3_integer_scalar_angles(axis, angle):
    factory = getattr(vtf.SO3, f"from_{axis}_radians")
    rotation = factory(angle)
    np.testing.assert_allclose(rotation.as_matrix(), factory(float(angle)).as_matrix())
    np.testing.assert_allclose(np.linalg.norm(rotation.wxyz), 1.0)


@pytest.mark.parametrize("axis", ["x", "y", "z"])
@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("batched", [False, True])
def test_so3_scalar_angle_dtype_preserved(axis, dtype, batched):
    angle = np.array([0.0, 1.0, -2.0] if batched else 1.0, dtype=dtype)
    rotation = getattr(vtf.SO3, f"from_{axis}_radians")(angle)
    assert rotation.wxyz.dtype == dtype
    assert rotation.wxyz.shape == ((3, 4) if batched else (4,))
    np.testing.assert_allclose(np.linalg.norm(rotation.wxyz, axis=-1), 1.0, atol=1e-7)


def test_so3_rpy_mixed_integer_scalar_angles():
    rotation = vtf.SO3.from_rpy_radians(0, 1.0, -2)
    expected = vtf.SO3.from_rpy_radians(0.0, 1.0, -2.0)
    np.testing.assert_allclose(rotation.as_matrix(), expected.as_matrix())
