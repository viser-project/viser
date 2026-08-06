"""Reading a props field from a handle must return the live value.

Handles inherit their ``*Props`` dataclass for typing, and dataclass fields
WITH defaults become class attributes, which normal attribute lookup finds
before ``__getattr__``. Reads of such fields used to return the class
default forever (writes were unaffected). See props_getattribute in
_assignable_props_api.py."""

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


def test_defaulted_props_read_live_values(server: viser.ViserServer) -> None:
    frustum = server.scene.add_camera_frustum(
        "/frustum", fov=1.0, aspect=1.5, variant="filled", scale=0.7
    )
    assert frustum.variant == "filled"
    assert frustum.scale == 0.7


def test_defaulted_props_read_after_assignment(server: viser.ViserServer) -> None:
    frustum = server.scene.add_camera_frustum("/frustum", fov=1.0, aspect=1.5)
    assert frustum.variant == "wireframe"
    frustum.variant = "filled"
    assert frustum.variant == "filled"
    handle = server.scene.add_line_segments(
        "/segments", points=np.zeros((1, 2, 3), dtype=np.float32), colors=(255, 0, 0)
    )
    handle.thickness_units = "screen"
    assert handle.thickness_units == "screen"
