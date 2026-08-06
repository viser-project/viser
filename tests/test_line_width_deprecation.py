"""The deprecated ``line_width`` argument must keep its old screen-space
pixel behavior: it maps to ``thickness`` with ``thickness_units="screen"``
and warns. The renamed ``thickness`` defaults to world units."""

from __future__ import annotations

import socket
from typing import Generator

import numpy as np
import pytest

import viser
import viser._client_autobuild


def _find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


@pytest.fixture()
def server() -> Generator[viser.ViserServer, None, None]:
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server: viser.ViserServer | None = None
    for attempt in range(3):
        try:
            server = viser.ViserServer(port=_find_free_port(), verbose=False)
            break
        except OSError:
            if attempt == 2:
                raise
    assert server is not None
    yield server
    server.stop()


_SEGMENT_POINTS = np.zeros((1, 2, 3), dtype=np.float32)
_SPLINE_POINTS = np.zeros((4, 3), dtype=np.float32)
_CONTROL_POINTS = np.zeros((6, 3), dtype=np.float32)


def test_thickness_defaults_to_world_units(server: viser.ViserServer) -> None:
    handle = server.scene.add_line_segments(
        "/segments", points=_SEGMENT_POINTS, colors=(255, 0, 0)
    )
    assert handle.thickness == 0.01
    assert handle.thickness_units == "world"
    frustum = server.scene.add_camera_frustum("/frustum", fov=1.0, aspect=1.5)
    assert frustum.thickness == 0.02
    assert frustum.thickness_units == "world"


def test_line_width_maps_to_screen_pixels(server: viser.ViserServer) -> None:
    """Old code passing line_width= must render pixel-identical to before."""
    with pytest.warns(DeprecationWarning, match="line_width"):
        segments = server.scene.add_line_segments(
            "/segments",
            points=_SEGMENT_POINTS,
            colors=(255, 0, 0),
            line_width=3.0,  # pyright: ignore[reportArgumentType]
        )
    assert segments.thickness == 3.0
    assert segments.thickness_units == "screen"

    with pytest.warns(DeprecationWarning, match="line_width"):
        frustum = server.scene.add_camera_frustum(
            "/frustum",
            fov=1.0,
            aspect=1.5,
            line_width=2.0,  # pyright: ignore[reportArgumentType]
        )
    assert frustum.thickness == 2.0
    assert frustum.thickness_units == "screen"

    with pytest.warns(DeprecationWarning, match="line_width"):
        catmull = server.scene.add_spline_catmull_rom(
            "/catmull",
            points=_SPLINE_POINTS,
            line_width=4.0,  # pyright: ignore[reportArgumentType]
        )
    assert catmull.thickness == 4.0
    assert catmull.thickness_units == "screen"

    with pytest.warns(DeprecationWarning, match="line_width"):
        bezier = server.scene.add_spline_cubic_bezier(
            "/bezier",
            points=_SPLINE_POINTS,
            control_points=_CONTROL_POINTS,
            line_width=5.0,  # pyright: ignore[reportArgumentType]
        )
    assert bezier.thickness == 5.0
    assert bezier.thickness_units == "screen"


def test_handle_line_width_alias(server: viser.ViserServer) -> None:
    handle = server.scene.add_line_segments(
        "/segments", points=_SEGMENT_POINTS, colors=(255, 0, 0), thickness=0.05
    )
    with pytest.warns(DeprecationWarning, match="line_width"):
        assert handle.line_width == 0.05
    with pytest.warns(DeprecationWarning, match="line_width"):
        handle.line_width = 0.07
    assert handle.thickness == 0.07


def test_unknown_kwargs_still_rejected(server: viser.ViserServer) -> None:
    with pytest.raises(TypeError, match="Unexpected keyword"):
        server.scene.add_line_segments(
            "/segments",
            points=_SEGMENT_POINTS,
            colors=(255, 0, 0),
            line_widht=3.0,  # type: ignore
        )
