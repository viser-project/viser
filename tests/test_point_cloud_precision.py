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
