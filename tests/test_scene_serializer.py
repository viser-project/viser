"""Tests for StateSerializer: the .viser file format round-trip, binary
buffer deduplication, and as_html() embedding."""

from __future__ import annotations

import base64
from contextlib import contextmanager
from typing import Any, Generator

import msgspec.msgpack
import numpy as np
import zstandard

import viser


@contextmanager
def _server() -> Generator[viser.ViserServer, None, None]:
    server = viser.ViserServer(port=0, verbose=False)
    try:
        yield server
    finally:
        server.stop()


def _decode_viser_bytes(data: bytes) -> tuple[dict[str, Any], list[bytes]]:
    """Decode serialized .viser bytes the same way the client does
    (FilePlayback.tsx + BinaryMessageDecode.ts): zstd decompress, read the
    msgpack length header, decode metadata, then slice out the 8-byte-aligned
    binary buffers."""
    inner_size = int.from_bytes(data[:8], "little")
    inner = zstandard.ZstdDecompressor().decompress(
        data[8:], max_output_size=inner_size
    )
    assert len(inner) == inner_size

    msgpack_length = int.from_bytes(inner[:8], "little")
    meta = msgspec.msgpack.decode(inner[8 : 8 + msgpack_length])

    buffers: list[bytes] = []
    offset = 8 + msgpack_length
    for length in meta["binaryBufferLengths"]:
        offset += (8 - offset % 8) % 8  # Alignment padding.
        assert offset % 8 == 0
        buffers.append(inner[offset : offset + length])
        offset += length
    assert offset == inner_size, "binary buffers must exactly fill the payload"
    return meta, buffers


def _collect_placeholders(obj: Any, out: list[dict[str, Any]]) -> None:
    """Collect binary placeholder dicts (``{"__binary_index": i, "dtype": s}``)
    from a decoded message tree."""
    if isinstance(obj, dict):
        if "__binary_index" in obj and "dtype" in obj:
            out.append(obj)
        else:
            for value in obj.values():
                _collect_placeholders(value, out)
    elif isinstance(obj, (list, tuple)):
        for value in obj:
            _collect_placeholders(value, out)


def test_serialize_round_trip() -> None:
    """Serialized scenes must decode to the original binary contents, with
    every placeholder index valid and durationSeconds preserved."""
    vertices = np.array(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float32
    )
    faces = np.array([[0, 1, 2]], dtype=np.uint32)
    with _server() as server:
        server.scene.add_mesh_simple("/mesh", vertices, faces)
        serializer = server.get_scene_serializer()
        serializer.insert_sleep(0.5)
        data = serializer.serialize()

    meta, buffers = _decode_viser_bytes(data)
    assert meta["durationSeconds"] == 0.5
    assert meta["viserVersion"] == viser.__version__

    placeholders: list[dict[str, Any]] = []
    for _time, message in meta["messages"]:
        _collect_placeholders(message, placeholders)
    assert len(placeholders) > 0
    for placeholder in placeholders:
        assert 0 <= placeholder["__binary_index"] < len(buffers)

    # The mesh's vertex and face bytes must appear among the stored buffers.
    stored = set(buffers)
    assert vertices.tobytes() in stored
    assert faces.tobytes() in stored


def test_serialize_dedupes_identical_buffers() -> None:
    """Byte-identical arrays serialized in different messages must be stored
    once, with all placeholders remapped onto the shared buffer."""
    vertices = np.random.default_rng(0).random((16, 3)).astype(np.float32)
    faces = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.uint32)
    with _server() as server:
        # Two nodes with byte-identical geometry (separate array copies, so
        # dedup must key on content rather than object identity).
        server.scene.add_mesh_simple("/a", vertices.copy(), faces.copy())
        server.scene.add_mesh_simple("/b", vertices.copy(), faces.copy())
        data = server.get_scene_serializer().serialize()

    meta, buffers = _decode_viser_bytes(data)

    # Dedup invariant: stored buffers are pairwise distinct.
    assert len(set(buffers)) == len(buffers)

    # Both meshes' placeholders resolve to the same stored vertex bytes.
    vertex_indices = set()
    for _time, message in meta["messages"]:
        placeholders: list[dict[str, Any]] = []
        _collect_placeholders(message, placeholders)
        for placeholder in placeholders:
            if buffers[placeholder["__binary_index"]] == vertices.tobytes():
                vertex_indices.add(placeholder["__binary_index"])
    assert len(vertex_indices) == 1, "identical vertices must share one buffer"
    assert vertices.tobytes() in set(buffers)
    assert faces.tobytes() in set(buffers)


def test_as_html_embeds_decodable_payload() -> None:
    """The base64 payload injected by as_html() must decode as a .viser
    recording containing the scene's messages."""
    with _server() as server:
        server.scene.add_box("/box", dimensions=(1.0, 1.0, 1.0))
        html = server.scene.as_html()

    marker = 'window.__VISER_EMBED_DATA__="'
    start = html.index(marker) + len(marker)
    end = html.index('"', start)
    data = base64.b64decode(html[start:end])

    meta, _buffers = _decode_viser_bytes(data)
    message_types = {message["type"] for _time, message in meta["messages"]}
    assert "BoxMessage" in message_types
