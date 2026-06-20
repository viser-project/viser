"""Regression tests for point-cloud ``precision`` <-> ``points`` dtype coupling.

The casting was silently broken by the property-assignment refactor (#464): the
``PointCloudHandle`` override that cast ``points`` by ``precision`` stopped being
called, so changing ``precision`` after construction left the buffer at the old
dtype. These pin the behavior that ``precision`` and ``points`` stay consistent
regardless of assignment order.
"""

from unittest.mock import patch

import numpy as np

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_point_cloud_precision_roundtrip() -> None:
    server = viser.ViserServer()
    try:
        pc = server.scene.add_point_cloud(
            "/pc",
            points=np.random.rand(10, 3),
            colors=(255, 0, 0),
            precision="float16",
        )
        # Construction casts to the requested precision.
        assert pc.points.dtype == np.float16

        # Changing precision re-casts the existing buffer in place.
        pc.precision = "float32"
        assert pc.points.dtype == np.float32

        # A subsequent points assignment is stored at the current precision.
        # The float64 input is deliberately off-dtype to exercise the cast.
        pc.points = np.random.rand(10, 3)  # type: ignore
        assert pc.points.dtype == np.float32

        # ... and the same holds in the other order: assign points, then flip
        # precision back.
        pc.points = np.random.rand(10, 3)  # type: ignore
        pc.precision = "float16"
        assert pc.points.dtype == np.float16

        # Assigning the same precision is a no-op (no error, dtype unchanged).
        pc.precision = "float16"
        assert pc.points.dtype == np.float16
    finally:
        server.stop()


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_points_assignment_coerced_to_precision() -> None:
    """A ``points`` assignment is always stored at the cloud's current
    precision, regardless of the input array's dtype."""
    server = viser.ViserServer()
    try:
        # precision="float32": a float64 array (wider, not in the type
        # annotation) is downcast to float32.
        pc = server.scene.add_point_cloud(
            "/pc32",
            points=np.zeros((3, 3)),
            colors=(255, 0, 0),
            precision="float32",
        )
        src64 = np.array(
            [[1 / 3, 2 / 3, 0.1], [0.2, 0.3, 0.4], [1.0, 2.0, 3.0]], dtype=np.float64
        )
        pc.points = src64  # type: ignore
        assert pc.points.dtype == np.float32
        # Values match the float32 downcast (i.e. genuinely re-cast, not stored
        # as float64).
        assert np.array_equal(pc.points, src64.astype(np.float32))

        # precision="float16": a float32 array -- which *is* allowed by the
        # `points` type annotation -- is still coerced down to float16.
        pc16 = server.scene.add_point_cloud(
            "/pc16",
            points=np.zeros((3, 3)),
            colors=(255, 0, 0),
            precision="float16",
        )
        src32 = np.array(
            [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]], dtype=np.float32
        )
        pc16.points = src32
        assert pc16.points.dtype == np.float16
        assert np.array_equal(pc16.points, src32.astype(np.float16))
    finally:
        server.stop()
