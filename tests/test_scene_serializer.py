"""Tests for StateSerializer: the .viser file format round-trip, binary
buffer deduplication, and as_html() embedding."""

from __future__ import annotations

import base64
import dataclasses
import threading
from typing import Any

import msgspec.msgpack
import numpy as np
import pytest
import zstandard

import viser
from viser.infra import Message, StateSerializer

from .utils import viser_server as _server


class _FakeHandler:
    """Minimal stand-in for WebsockMessageHandler: just the serializer
    registry that StateSerializer.serialize() interacts with."""

    def __init__(self) -> None:
        self._record_handles: list[StateSerializer] = []
        self._record_lock = threading.RLock()


# Leading underscore: excluded from Message.get_subclasses(), so this test
# type never leaks into the real message registry.
@dataclasses.dataclass
class _ArrayTestMessage(Message):
    name: str
    array: np.ndarray

    def redundancy_key(self) -> str:
        return f"_ArrayTestMessage-{self.name}"


def _make_serializer() -> StateSerializer:
    handler = _FakeHandler()
    serializer = StateSerializer(handler, filter=lambda message: True)  # type: ignore[arg-type]
    handler._record_handles.append(serializer)
    return serializer


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


def _collect_placeholders(obj: Any) -> list[dict[str, Any]]:
    """Collect binary placeholder dicts (``{"__binary_index": i, "dtype": s}``)
    from a decoded message tree."""
    out: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        if "__binary_index" in obj and "dtype" in obj:
            out.append(obj)
        else:
            for value in obj.values():
                out.extend(_collect_placeholders(value))
    elif isinstance(obj, (list, tuple)):
        for value in obj:
            out.extend(_collect_placeholders(value))
    return out


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

    placeholders = [
        p for _time, message in meta["messages"] for p in _collect_placeholders(message)
    ]
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
    vertex_indices = {
        placeholder["__binary_index"]
        for _time, message in meta["messages"]
        for placeholder in _collect_placeholders(message)
        if buffers[placeholder["__binary_index"]] == vertices.tobytes()
    }
    assert len(vertex_indices) == 1, "identical vertices must share one buffer"
    assert faces.tobytes() in buffers


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


def test_dedup_keys_on_bytes_not_dtype() -> None:
    """Arrays with identical bytes but different dtypes share one stored
    buffer; each placeholder keeps its own dtype for the client-side view."""
    serializer = _make_serializer()
    serializer._insert_message(_ArrayTestMessage("f32", np.zeros(3, dtype=np.float32)))
    serializer._insert_message(_ArrayTestMessage("u32", np.zeros(3, dtype=np.uint32)))
    meta, buffers = _decode_viser_bytes(serializer.serialize())

    assert len(buffers) == 1
    assert buffers[0] == bytes(12)
    (placeholder_a,) = _collect_placeholders(meta["messages"][0][1])
    (placeholder_b,) = _collect_placeholders(meta["messages"][1][1])
    assert placeholder_a["__binary_index"] == placeholder_b["__binary_index"] == 0
    assert placeholder_a["dtype"] == "<f4"
    assert placeholder_b["dtype"] == "<u4"


def test_empty_and_noncontiguous_arrays() -> None:
    """Zero-length arrays (all byte-identical) dedup to one empty buffer, and
    non-contiguous arrays round-trip via their contiguous copy."""
    serializer = _make_serializer()
    serializer._insert_message(
        _ArrayTestMessage("empty_f32", np.empty(0, dtype=np.float32))
    )
    serializer._insert_message(
        _ArrayTestMessage("empty_u8", np.empty(0, dtype=np.uint8))
    )
    strided = np.arange(12, dtype=np.float32)[::2]
    assert not strided.flags.c_contiguous
    serializer._insert_message(_ArrayTestMessage("strided", strided))
    meta, buffers = _decode_viser_bytes(serializer.serialize())

    assert sorted(len(b) for b in buffers) == [0, 24]
    assert np.ascontiguousarray(strided).tobytes() in buffers
    for _time, message in meta["messages"]:
        for placeholder in _collect_placeholders(message):
            assert 0 <= placeholder["__binary_index"] < len(buffers)


def test_concurrent_serializers_are_independent() -> None:
    """Serializing one handle must not corrupt another's recorded state:
    placeholder remapping mutates message dicts, which must never be shared
    between serializers."""
    vertices = np.random.default_rng(1).random((8, 3)).astype(np.float32)
    faces = np.array([[0, 1, 2]], dtype=np.uint32)
    with _server() as server:
        server.scene.add_mesh_simple("/x", vertices.copy(), faces.copy())
        server.scene.add_mesh_simple("/y", vertices.copy(), faces.copy())
        serializer_a = server.get_scene_serializer()
        serializer_b = server.get_scene_serializer()
        data_a = serializer_a.serialize()
        data_b = serializer_b.serialize()

    for data in (data_a, data_b):
        _meta, buffers = _decode_viser_bytes(data)
        assert vertices.tobytes() in buffers
        assert faces.tobytes() in buffers


def test_serialize_is_deterministic() -> None:
    """Identical recorded state must produce identical bytes (multithreaded
    zstd included), so recordings are cacheable/diffable."""
    array = np.random.default_rng(2).random((50_000, 3)).astype(np.float32)

    def _serialize_once() -> bytes:
        serializer = _make_serializer()
        serializer._insert_message(_ArrayTestMessage("a", array))
        serializer._insert_message(_ArrayTestMessage("b", array.copy()))
        serializer.insert_sleep(1.0)
        return serializer.serialize()

    assert _serialize_once() == _serialize_once()


def test_message_queued_during_serialize_is_excluded_cleanly() -> None:
    """serialize() unregisters before encoding: a message queued from another
    thread mid-serialize must be fully absent (not recorded with a dangling
    buffer index) and the output must still decode."""
    with _server() as server:
        server.scene.add_frame("/pre")
        serializer = server.get_scene_serializer()

        import viser.infra._infra as infra_module

        encode_entered = threading.Event()
        writer_done = threading.Event()
        original_encode = infra_module.msgspec.msgpack.encode

        def blocking_encode(obj: Any) -> bytes:
            # Only the serializer's metadata dict passes through here during
            # this test window; hold it open while the writer queues.
            encode_entered.set()
            assert writer_done.wait(timeout=5.0)
            return original_encode(obj)

        def writer() -> None:
            assert encode_entered.wait(timeout=5.0)
            server.scene.add_icosphere(
                "/racy", radius=1.0, subdivisions=1, color=(255, 0, 0)
            )
            writer_done.set()

        thread = threading.Thread(target=writer)
        thread.start()
        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setattr(infra_module.msgspec.msgpack, "encode", blocking_encode)
            data = serializer.serialize()
        thread.join(timeout=5.0)
        assert not thread.is_alive()

    meta, buffers = _decode_viser_bytes(data)  # Integrity-checked in helper.
    names = {message.get("name") for _time, message in meta["messages"]}
    assert "/pre" in names
    assert "/racy" not in names
    for _time, message in meta["messages"]:
        for placeholder in _collect_placeholders(message):
            assert 0 <= placeholder["__binary_index"] < len(buffers)
