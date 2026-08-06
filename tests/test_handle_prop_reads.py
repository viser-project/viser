"""Reading a props field from a handle must return the live value.

Handles inherit their ``*Props`` dataclass for typing, so a props field
WITH a default would become a class attribute, which normal attribute
lookup finds before the ``__getattr__`` that forwards reads to the live
props object. Reads of such fields returned the class default forever
(writes were unaffected): ``frustum.variant`` stayed ``"wireframe"`` after
``variant="filled"``. The fix is structural -- props dataclasses carry no
field defaults (the user-facing defaults live in the scene API signatures,
and every props construction passes all fields explicitly) -- and this
module enforces it."""

from __future__ import annotations

import dataclasses
import inspect
import socket
from typing import Generator

import numpy as np
import pytest

import viser
import viser._client_autobuild
from viser import _messages


def test_props_dataclasses_have_no_field_defaults() -> None:
    """A default on a props field silently breaks handle reads (see module
    docstring); user-facing defaults belong in the scene/GUI API signatures
    instead."""
    offenders = [
        f"{name}.{field.name}"
        for name in dir(_messages)
        for cls in [getattr(_messages, name)]
        if inspect.isclass(cls)
        and name.endswith("Props")
        and dataclasses.is_dataclass(cls)
        for field in dataclasses.fields(cls)
        if field.default is not dataclasses.MISSING
        or field.default_factory is not dataclasses.MISSING
    ]
    assert not offenders, f"Props fields must not have defaults: {offenders}"


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
