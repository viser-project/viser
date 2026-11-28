"""Tests for behavior that the server's fast paths need to preserve, plus
regressions. Timing lives in ``benchmarks/``; the few
complexity checks here count operations instead of seconds."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import struct
import sys
import threading
import time
from typing import Any, AsyncGenerator, Dict, Optional, Tuple, Union

import msgspec
import numpy as np
import numpy.typing as npt
import pytest
import zstandard

import viser
from viser import _messages as vm
from viser._assignable_props_api import array_snapshot, arrays_equal
from viser.infra import _infra
from viser.infra._async_message_buffer import AsyncMessageBuffer
from viser.infra._messages import (
    _deserialize_converters,
    _make_converter,
    _prepare_for_serialization,
    _wire_converters,
)

from .infra_utils import broadcast_messages
from .thread_isolation import run_isolated


@pytest.fixture()
def server():
    out = viser.ViserServer(port=0, verbose=False)
    yield out
    out.stop()


def _updates(server: viser.ViserServer, name: str, prop: str) -> list[Any]:
    return [
        m.updates[prop]
        for m in broadcast_messages(server)
        if isinstance(m, vm.SceneNodeUpdateMessage)
        and m.name == name
        and prop in m.updates
    ]


def _positions(server: viser.ViserServer, name: str) -> list[Any]:
    return [
        m.position
        for m in broadcast_messages(server)
        if isinstance(m, vm.SetPositionMessage) and m.name == name
    ]


# --- Poses ------------------------------------------------------------------


def test_inplace_pose_update_is_sent(server: viser.ViserServer) -> None:
    """``handle.position += x`` mutates what the getter returned and assigns it
    back. The setter used to see "no change" and drop it."""
    frame = server.scene.add_frame("/f", position=(1.0, 2.0, 3.0))
    frame.position += np.array([1.0, 0.0, 0.0])
    assert tuple(frame.position) == (2.0, 2.0, 3.0)
    assert _positions(server, "/f") == [(2.0, 2.0, 3.0)]

    position = frame.position
    position[2] = 10.0
    assert tuple(frame.position) == (2.0, 2.0, 3.0)  # Not assigned yet.
    frame.position = position
    assert _positions(server, "/f") == [(2.0, 2.0, 10.0)]


def test_inplace_bone_update_is_sent(server: viser.ViserServer) -> None:
    mesh = server.scene.add_mesh_skinned(
        "/m",
        np.zeros((3, 3)),
        np.array([[0, 1, 2]]),
        bone_wxyzs=((1.0, 0.0, 0.0, 0.0),),
        bone_positions=((0.0, 0.0, 0.0),),
        skin_weights=np.ones((3, 1)),
    )
    mesh.bones[0].position += 1.0
    assert [
        m.position
        for m in broadcast_messages(server)
        if isinstance(m, vm.SetBonePositionMessage)
    ] == [(1.0, 1.0, 1.0)]


def test_unchanged_pose_is_not_resent(server: viser.ViserServer) -> None:
    frame = server.scene.add_frame("/f", position=(1.0, 2.0, 3.0))
    counter = server._websock_server._broadcast_buffer.message_counter
    frame.position = (1.0, 2.0, 3.0)
    frame.position = np.array([1, 2, 3])
    frame.wxyz = frame.wxyz
    assert server._websock_server._broadcast_buffer.message_counter == counter


# --- Array props ------------------------------------------------------------


def test_inplace_array_prop_update_is_sent(server: viser.ViserServer) -> None:
    cloud = server.scene.add_point_cloud(
        "/p", np.zeros((10, 3)), (255, 0, 0), precision="float32"
    )
    cloud.points += 1.0
    (update,) = _updates(server, "/p", "points")
    assert (update == 1.0).all()
    cloud.points += 1.0
    (update,) = _updates(server, "/p", "points")
    assert (update == 2.0).all()
    assert (cloud.points == 2.0).all()


def test_array_props_are_shared_until_read(server: viser.ViserServer) -> None:
    """Handles and their queued messages share a single, immutable array."""
    points = np.random.uniform(size=(10, 3)).astype(np.float32)
    cloud = server.scene.add_point_cloud("/p", points, (1, 2, 3), precision="float32")
    (create,) = [
        m for m in broadcast_messages(server) if isinstance(m, vm.PointCloudMessage)
    ]
    assert create.props.points is cloud._impl.props.points
    assert not create.props.points.flags.writeable

    # Reads return something writable that doesn't alias the message.
    read = cloud.points
    assert read.flags.writeable
    assert cloud.points is read
    read[:] = -1.0
    np.testing.assert_array_equal(create.props.points, points)

    # Same for updates.
    cloud.points = points * 2.0
    (update,) = _updates(server, "/p", "points")
    assert update is cloud._impl.props.points
    cloud.points[:] = 0.0
    np.testing.assert_array_equal(update, points * 2.0)


@pytest.mark.parametrize("dtype", [np.float16, np.float32, np.float64])
@pytest.mark.parametrize("order", ["C", "F"])
def test_array_update_never_aliases_caller(
    server: viser.ViserServer, dtype: Any, order: Any
) -> None:
    cloud = server.scene.add_point_cloud(
        "/p", np.zeros((10, 3)), (1, 2, 3), precision="float32"
    )
    points = np.ones((10, 3), dtype=dtype, order=order)
    cloud.points = points  # type: ignore
    points[:] = 5.0
    assert (cloud._impl.props.points == 1.0).all()
    (update,) = _updates(server, "/p", "points")
    assert (update == 1.0).all()
    assert update.dtype == np.float32


def test_array_props_accept_sequences(server: viser.ViserServer) -> None:
    """Assigning a tuple to a color array prop used to raise AttributeError, and
    lists assigned to integer arrays were sent to clients as lists."""
    cloud = server.scene.add_point_cloud("/p", np.zeros((10, 3)), (1, 2, 3))
    cloud.colors = (255, 128, 0)  # type: ignore
    (update,) = _updates(server, "/p", "colors")
    assert update.dtype == np.uint8 and update.tolist() == [255, 128, 0]

    mesh = server.scene.add_mesh_simple("/m", np.zeros((4, 3)), np.array([[0, 1, 2]]))
    mesh.faces = [[1, 2, 3]]  # type: ignore
    (update,) = _updates(server, "/m", "faces")
    assert isinstance(update, np.ndarray) and update.dtype == np.uint32


def test_optional_array_prop_is_cast(server: viser.ViserServer) -> None:
    axes = server.scene.add_batched_axes(
        "/a", np.tile([1.0, 0.0, 0.0, 0.0], (2, 1)), np.zeros((2, 3))
    )
    axes.batched_scales = np.ones(2, dtype=np.float64)  # type: ignore
    (update,) = _updates(server, "/a", "batched_scales")
    assert update.dtype == np.float32
    axes.batched_scales = None
    (update,) = _updates(server, "/a", "batched_scales")
    assert update is None


def test_splat_count_change_sends_one_update(server: viser.ViserServer) -> None:
    """Assigning a different number of centers used to send (and render) a
    buffer of defaults first."""
    splats = server.scene.add_gaussian_splats(
        "/s",
        centers=np.zeros((2, 3)),
        covariances=np.tile(np.eye(3), (2, 1, 1)),
        rgbs=np.zeros((2, 3)),
        opacities=np.ones((2, 1)),
    )
    buffer = server._websock_server._broadcast_buffer
    counter = buffer.message_counter
    splats.centers = np.full((5, 3), 2.0)
    assert buffer.message_counter == counter + 1
    (update,) = _updates(server, "/s", "buffer")
    assert update.shape == (5, 8)
    np.testing.assert_array_equal(splats.centers, np.full((5, 3), 2.0))
    assert (splats.rgbs == 255).all()


@pytest.mark.parametrize(
    "shape", [(), (0,), (0, 3), (1,), (5, 3), (100_000, 3), (3, 100_000), (1, 1 << 20)]
)
def test_arrays_equal_matches_numpy(shape: tuple[int, ...]) -> None:
    rng = np.random.default_rng(0)
    a = rng.uniform(size=shape)
    assert arrays_equal(a, a.copy())
    assert not arrays_equal(a, np.zeros(shape + (2,)))
    if a.size == 0:
        return
    for index in {0, a.size // 2, a.size - 1}:
        b = np.array(a)
        b.reshape(-1)[index] += 1.0
        assert not arrays_equal(a, b)
    b = np.array(a)
    b.reshape(-1)[-1] = np.nan
    assert not arrays_equal(b, b)  # Same as np.array_equal.


def test_array_snapshot() -> None:
    a = np.asfortranarray(np.arange(6).reshape(2, 3))
    snapshot = array_snapshot(a)
    assert snapshot.flags.c_contiguous and not snapshot.flags.writeable
    assert not np.shares_memory(a, snapshot)
    np.testing.assert_array_equal(a, snapshot)


# --- Serialization ----------------------------------------------------------


@dataclasses.dataclass
class _Inner:
    a: Any
    b: Any


_VALUES = [
    None,
    True,
    1,
    1.5,
    "s",
    b"b",
    (),
    (1, 2.0, 3),
    (1.0, 2.0),
    [1, (2, "x")],
    {"k": (1, np.float32(2.0))},
    np.float32(1.5),
    np.int64(3),
    np.bool_(True),
    np.str_("s"),
    (np.float64(1.0), 2, np.int32(3)),
    np.arange(6, dtype=np.float32).reshape(2, 3),
    np.zeros((0, 3), dtype=np.float32),
    np.asfortranarray(np.arange(6, dtype=np.float32).reshape(2, 3)),
    (np.arange(3), "x"),
    _Inner(np.float32(1.0), (np.arange(2),)),
]
_ANNOTATIONS: list[Any] = [
    Any,
    str,
    float,
    int,
    bool,
    Tuple[float, float],
    Tuple[float, float, float],
    Tuple[int, ...],
    Tuple[str, ...],
    Optional[Tuple[float, float, float]],
    Union[float, Tuple[float, float, float]],
    Dict[str, Any],
    npt.NDArray[np.float32],
    _Inner,
]


@pytest.mark.filterwarnings("ignore")
@pytest.mark.parametrize("annotation", _ANNOTATIONS, ids=str)
def test_compiled_converters_match_reference(annotation: Any) -> None:
    for value in _VALUES:
        if isinstance(value, _Inner) and annotation not in (Any, _Inner):
            continue
        buffers: list[memoryview] = []
        ref_buffers: list[memoryview] = []
        try:
            expected = msgspec.msgpack.encode(
                _prepare_for_serialization(value, annotation, ref_buffers)
            )
        except Exception as e:
            with pytest.raises(type(e)):
                msgspec.msgpack.encode(_make_converter(annotation)(value, buffers))
            continue
        actual = msgspec.msgpack.encode(_make_converter(annotation)(value, buffers))
        assert actual == expected, (value, annotation)
        assert [bytes(b) for b in buffers] == [bytes(b) for b in ref_buffers]


def test_all_message_types_have_converters() -> None:
    for cls in vm.Message.get_subclasses():
        _wire_converters(cls)
        _deserialize_converters(cls)


# --- Message delivery -------------------------------------------------------


class _CountingDict(dict):
    """Counts how many entries are visited."""

    visited = 0

    def get(self, key, default=None):
        self.visited += 1
        return super().get(key, default)

    def __iter__(self):
        for key in super().__iter__():
            self.visited += 1
            yield key

    def __reversed__(self):
        for key in super().__reversed__():
            self.visited += 1
            yield key


def test_replay_cost_is_independent_of_history() -> None:
    """Connecting used to walk every message id ever sent, one by one."""

    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        for i in range(3_000):
            buffer.push(vm.SetPositionMessage("/a", (i, 0.0, 0.0)))
        buffer.push(vm.SetPositionMessage("/b", (0.0, 0.0, 0.0)))
        buffer.message_counter += 10_000_000
        buffer.push(vm.SetPositionMessage("/c", (0.0, 0.0, 0.0)))

        counting = buffer.message_from_id = _CountingDict(buffer.message_from_id)
        marker = vm.ReplayDoneMessage()
        gen = buffer.window_generator(0, backlog_done_message=marker)
        out: list[Any] = []
        while marker not in out:
            out.extend(await asyncio.wait_for(gen.__anext__(), timeout=5.0))
        await gen.aclose()
        assert [getattr(m, "name", None) for m in out] == ["/a", "/b", "/c", None]
        assert 0 < counting.visited < 100

    run_isolated(lambda: asyncio.run(scenario()))


def test_updates_do_not_rescan_older_state() -> None:
    """Large updates used to scan all buffered messages, for each client."""
    num_static, num_updates = 20_000, 3_000

    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        for i in range(num_static):
            buffer.push(vm.SetPositionMessage(f"/{i}", (0.0, 0.0, 0.0)))
        gen = buffer.window_generator(0)

        async def receive(count: int) -> list[str]:
            names: list[str] = []
            while len(names) < count:
                window = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
                names.extend(m.name for m in window)  # type: ignore
            return names

        await receive(num_static)
        counting = buffer.message_from_id = _CountingDict(buffer.message_from_id)
        for i in range(num_updates):
            buffer.push(vm.SetPositionMessage(f"/{i}", (1.0, 0.0, 0.0)))
        counting.visited = 0
        assert await receive(num_updates) == [f"/{i}" for i in range(num_updates)]
        assert 0 < counting.visited < 3 * num_updates
        await gen.aclose()

    run_isolated(lambda: asyncio.run(scenario()))


def test_replay_preserves_order_with_concurrent_changes() -> None:
    """Messages pushed or superseded while a large backlog is being replayed are
    delivered exactly once and in order."""

    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        n = 5_000
        for i in range(n):
            buffer.push(vm.SetPositionMessage(f"/{i}", (0.0, 0.0, 0.0)))
        marker = vm.ReplayDoneMessage()
        gen = buffer.window_generator(0, backlog_done_message=marker)
        seen: list[Any] = list(await gen.__anext__())
        buffer.push(vm.SetPositionMessage(f"/{n - 1}", (1.0, 0.0, 0.0)))  # Supersede.
        buffer.push(vm.SetPositionMessage("/0", (1.0, 0.0, 0.0)))  # Already sent.
        buffer.push(vm.SetPositionMessage("/new", (1.0, 0.0, 0.0)))
        while getattr(seen[-1], "name", None) != "/new":
            seen.extend(await asyncio.wait_for(gen.__anext__(), timeout=5.0))
        await gen.aclose()

        names = [getattr(m, "name", "MARKER") for m in seen]
        assert names == [f"/{i}" for i in range(n - 1)] + [
            "MARKER",
            f"/{n - 1}",
            "/0",
            "/new",
        ]

    run_isolated(lambda: asyncio.run(scenario()))


def test_no_lost_wakeups_from_threads() -> None:
    """Pushes coalesce their event loop wakeups; none may be lost."""

    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=False
        )
        buffer.window_duration_sec = 0.0
        n = 2_000

        def push(t: int) -> None:
            for i in range(n):
                buffer.push(vm.SetPositionMessage(f"/{t}/{i}", (0.0, 0.0, 0.0)))
                if i % 500 == 0:
                    buffer.atomic_start()
                    buffer.push(vm.SetPositionMessage(f"/{t}/a{i}", (0.0, 0.0, 0.0)))
                    buffer.atomic_end()

        threads = [threading.Thread(target=push, args=(t,)) for t in range(4)]
        expected = 4 * (n + n // 500)
        gen = buffer.window_generator(0)
        count = 0
        for thread in threads:
            thread.start()
        while count < expected:
            count += len(await asyncio.wait_for(gen.__anext__(), timeout=5.0))
        assert count == expected
        await gen.aclose()
        for thread in threads:
            thread.join()

    run_isolated(lambda: asyncio.run(scenario()))


def test_wakeup_may_run_before_scheduling_returns() -> None:
    """The event loop thread can run a wakeup while the pushing thread is still
    inside call_soon_threadsafe(). That used to leave the "wakeup scheduled" flag
    set forever, which permanently stalled delivery."""

    class EagerLoop:
        num_calls = 0

        def call_soon_threadsafe(self, fn: Any) -> None:
            self.num_calls += 1
            fn()

    async def scenario() -> None:
        loop = EagerLoop()
        buffer = AsyncMessageBuffer(loop, persistent_messages=True)  # type: ignore
        buffer.generator_cursors[0] = -1
        for i in range(3):
            buffer.push(vm.SetPositionMessage(f"/{i}", (0.0, 0.0, 0.0)))
            assert not buffer._wake_scheduled
            assert loop.num_calls == i + 1

    run_isolated(lambda: asyncio.run(scenario()))


class _FakeWebsocket:
    """Collects payloads like a browser would, reassembling fragments."""

    def __init__(self) -> None:
        self.payloads: list[bytes] = []
        self.largest_fragment = 0

    async def send(self, data: Any) -> None:
        fragments = [data] if isinstance(data, bytes) else list(data)
        for f in fragments:
            assert isinstance(f, (bytes, memoryview))
            self.largest_fragment = max(self.largest_fragment, len(f))
        self.payloads.append(b"".join(fragments))
        await asyncio.sleep(0)  # Let other producers run.


def _decode(payload: bytes) -> list[dict]:
    size, compressed_size = struct.unpack("<QQ", payload[:16])
    data = msgspec.msgpack.decode(
        zstandard.ZstdDecompressor().decompress(
            payload[16 : 16 + compressed_size], max_output_size=size
        )
    )
    offset = 16 + compressed_size
    arrays = []
    for length in data["binaryBufferLengths"]:
        offset += -offset % 8
        arrays.append(payload[offset : offset + length])
        offset += length
    assert offset == len(payload)

    def restore(obj: Any) -> Any:
        if isinstance(obj, dict):
            if "__binary_index" in obj:
                return np.frombuffer(arrays[obj["__binary_index"]], dtype=obj["dtype"])
            return {k: restore(v) for k, v in obj.items()}
        return [restore(v) for v in obj] if isinstance(obj, list) else obj

    return [restore(m) for m in data["messages"]]


@contextlib.asynccontextmanager
async def _producers(
    buffer: AsyncMessageBuffer,
    sockets: list[_FakeWebsocket],
    marker: Any = None,
    first_client_id: int = 0,
) -> AsyncGenerator[None, None]:
    """Run a producer for each socket."""
    tasks = [
        asyncio.create_task(
            _infra._message_producer(ws, buffer, i, asyncio.Lock(), marker)  # type: ignore
        )
        for i, ws in enumerate(sockets, start=first_client_id)
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _wait_for(ws: _FakeWebsocket, name: str | None) -> None:
    """Wait for a message. The end-of-replay marker doesn't have a name."""
    deadline = time.monotonic() + 10.0
    while not any(m.get("name") == name for p in ws.payloads[-1:] for m in _decode(p)):
        assert time.monotonic() < deadline
        await asyncio.sleep(0.01)


def _run_producers(
    push: Any, num_clients: int, marker: Any
) -> tuple[list[_FakeWebsocket], list[list[dict]]]:
    async def scenario():
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        push(buffer)
        sockets = [_FakeWebsocket() for _ in range(num_clients)]
        async with _producers(buffer, sockets, marker):
            for ws in sockets:
                await _wait_for(ws, None)
            buffer.push(vm.SetPositionMessage("/live", (1.0, 2.0, 3.0)))
            buffer.push(vm.SetPositionMessage("/live2", (1.0, 2.0, 3.0)))
            for ws in sockets:
                await _wait_for(ws, "/live2")
        return sockets

    sockets = run_isolated(lambda: asyncio.run(scenario()))
    return sockets, [[m for p in ws.payloads for m in _decode(p)] for ws in sockets]


def test_large_replay_is_split_and_lossless() -> None:
    arrays = [
        np.random.default_rng(i).integers(0, 255, (1_500_001,), dtype=np.uint8)
        for i in range(20)
    ]

    def push(buffer: AsyncMessageBuffer) -> None:
        for i, a in enumerate(arrays):
            buffer.push(vm.SceneNodeUpdateMessage(f"/{i}", {"x": a}))
        # One empty array, one that's a fragment by itself.
        buffer.push(
            vm.SceneNodeUpdateMessage(
                "/last", {"e": np.zeros((0, 3), np.float32), "x": arrays[0][:8]}
            )
        )

    (ws,), (messages,) = _run_producers(push, 1, vm.ReplayDoneMessage())
    assert [m.get("name") for m in messages] == (
        [f"/{i}" for i in range(20)] + ["/last", None, "/live", "/live2"]
    )
    for m, a in zip(messages, arrays):
        np.testing.assert_array_equal(m["updates"]["x"], a)
    assert messages[20]["updates"]["e"].size == 0
    assert max(map(len, ws.payloads)) < _infra._REPLAY_SPLIT_BYTES + 2_000_000
    assert ws.largest_fragment <= _infra._FRAGMENT_BYTES


def test_shared_encoding_respects_excluded_client() -> None:
    """Windows are encoded once for clients that are in sync, but clients must
    still not receive messages they're excluded from."""

    def push(buffer: AsyncMessageBuffer) -> None:
        for i in range(10):
            m = vm.SetPositionMessage(f"/{i}", (0.0, 0.0, 0.0))
            if i % 2 == 0:
                m.excluded_self_client = 1  # type: ignore
            buffer.push(m)

    _, received = _run_producers(push, 3, vm.ReplayDoneMessage())
    all_names = [f"/{i}" for i in range(10)] + [None, "/live", "/live2"]
    odd_names = [f"/{i}" for i in range(1, 10, 2)] + [None, "/live", "/live2"]
    for i, messages in enumerate(received):
        assert [m.get("name") for m in messages] == (odd_names if i == 1 else all_names)


# --- Bookkeeping ------------------------------------------------------------


def test_tombstone_index(server: viser.ViserServer) -> None:
    buffer = server._websock_server._broadcast_buffer

    def check() -> None:
        assert buffer.tombstone_ids == {
            i
            for i, m in buffer.message_from_id.items()
            if m.lifecycle_phase == "remove"
        }

    for i in range(5):
        server.scene.add_frame(f"/{i}")
    for i in range(5):
        server.scene.remove_by_name(f"/{i}")
    check()
    assert len(buffer.tombstone_ids) >= 5
    server.scene.add_frame("/0")  # Supersedes a tombstone.
    check()
    server._run_garbage_collector(force=True)
    check()
    assert len(buffer.tombstone_ids) == 0


def test_children_bookkeeping_does_not_leak(server: viser.ViserServer) -> None:
    before = dict(server.scene._children_from_node_name)
    for _ in range(3):
        parent = server.scene.add_frame("/p")
        child = server.scene.add_frame("/p/c")
        server.scene.add_frame("/p/c/d")
        child.remove()
        server.scene.add_frame("/p/c/d")
        parent.remove()
    assert server.scene.get_handle_by_name("/p/c/d") is None
    assert server.scene._children_from_node_name == before


def test_readd_after_remove_resets_pose(server: viser.ViserServer) -> None:
    """A create coalesces with a removal of the same name. Clients that haven't
    received the removal treat the create as a replacement and keep the old pose,
    unless it's explicitly reset."""
    buffer = server._websock_server._broadcast_buffer
    for client_is_behind in (True, False):
        handle = server.scene.add_frame("/f", position=(1.0, 2.0, 3.0))
        handle.wxyz = (0.0, 1.0, 0.0, 0.0)
        buffer.generator_cursors[0] = buffer.message_counter - 1
        handle.remove()
        if not client_is_behind:
            buffer.generator_cursors[0] = buffer.message_counter - 1
        server.scene.add_frame("/f")
        assert _positions(server, "/f") == [(0.0, 0.0, 0.0)] * client_is_behind
        assert [
            m.wxyz
            for m in broadcast_messages(server)
            if isinstance(m, vm.SetOrientationMessage) and m.name == "/f"
        ] == [(1.0, 0.0, 0.0, 0.0)] * client_is_behind
        server.scene.remove_by_name("/f")
        buffer.generator_cursors.clear()
        server._run_garbage_collector(force=True)


# --- Edge cases -------------------------------------------------------------


def test_all_inplace_patterns_are_sent(server: viser.ViserServer) -> None:
    cloud = server.scene.add_point_cloud(
        "/p", np.zeros((4, 3)), (1, 2, 3), precision="float32"
    )

    def latest() -> np.ndarray:
        return _updates(server, "/p", "points")[-1]

    view = cloud.points[:]
    view += 1
    cloud.points = view
    assert (latest() == 1).all()
    cloud.points[:] = 7  # Not assigned; has no effect on clients.
    assert (latest() == 1).all()
    cloud.points = np.full((4, 3), 7.0)
    assert (latest() == 7).all()
    cloud.points[0] = 9
    cloud.points = cloud.points.copy()
    assert (latest()[0] == 9).all()
    # Reads reflect assignments made through any path.
    cloud.points = np.zeros((4, 3))
    assert (cloud.points == 0).all()


def test_point_cloud_points_accept_lists(server: viser.ViserServer) -> None:
    cloud = server.scene.add_point_cloud("/p", np.zeros((1, 3)), (1, 2, 3))
    cloud.points = [[1, 2, 3], [4, 5, 6]]  # type: ignore
    (update,) = _updates(server, "/p", "points")
    assert update.dtype == np.float16 and update.shape == (2, 3)


def test_concurrent_splat_attributes(server: viser.ViserServer) -> None:
    n = 5000
    splats = server.scene.add_gaussian_splats(
        "/s",
        centers=np.zeros((n, 3)),
        covariances=np.tile(np.eye(3), (n, 1, 1)),
        rgbs=np.zeros((n, 3)),
        opacities=np.ones((n, 1)),
    )
    for i in range(1, 60):
        barrier = threading.Barrier(2)

        def set_centers() -> None:
            barrier.wait()
            splats.centers = np.full((n, 3), i, dtype=np.float32)

        def set_rgbs() -> None:
            barrier.wait()
            splats.rgbs = np.full((n, 3), i, dtype=np.uint8)

        threads = [threading.Thread(target=f) for f in (set_centers, set_rgbs)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert (splats.centers == i).all() and (splats.rgbs == i).all()


def test_reads_do_not_revert_assignments(server: viser.ViserServer) -> None:
    cloud = server.scene.add_point_cloud(
        "/p", np.zeros((10, 3)), (1, 2, 3), precision="float32"
    )
    before = cloud._impl.props.points

    class AssignDuringCopy(np.ndarray):
        def copy(self, *args: Any, **kwargs: Any) -> np.ndarray:
            cloud.points = np.ones((10, 3))
            return np.array(self)

    stored = before.view(AssignDuringCopy)
    cloud._impl.props.points = stored  # type: ignore
    cloud.points  # A write lands in the middle of this read.
    assert (cloud._impl.props.points == 1).all()
    assert (cloud.points == 1).all()


def _array_update(i: int, num_bytes: int) -> vm.SceneNodeUpdateMessage:
    return vm.SceneNodeUpdateMessage(f"/{i}", {"x": np.zeros(num_bytes, np.uint8)})


def test_split_windows_reach_every_client() -> None:
    """Including clients that connect after a window was split for another one."""

    async def scenario() -> list[list[Any]]:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        for i in range(12):
            buffer.push(_array_update(i, 3 << 20))
        marker = vm.ReplayDoneMessage()
        sockets = [_FakeWebsocket() for _ in range(3)]
        async with contextlib.AsyncExitStack() as stack:
            for i, ws in enumerate(sockets):
                await stack.enter_async_context(_producers(buffer, [ws], marker, i))
                await _wait_for(ws, None)
        return [
            [m.get("name") for p in ws.payloads for m in _decode(p)] for ws in sockets
        ]

    received = run_isolated(lambda: asyncio.run(scenario()))
    assert received == [[f"/{i}" for i in range(12)] + [None]] * 3


def test_similar_windows_are_not_shared() -> None:
    """Windows that start with the same message may differ after it."""

    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        buffer.generator_cursors = {0: 0, 1: 0}
        a, b, c = [
            vm.SetPositionMessage(n, (0.0, 0.0, 0.0)) for n in ("/a", "/b", "/c")
        ]
        buffer.cache_encoding([a, b], [b"payload"])
        assert buffer.get_cached_encoding([a, b]) == [b"payload"]
        for other in ([a, c], [a], [a, b, c], [b, a]):
            assert buffer.get_cached_encoding(other) is None
        # Equal, but not the same.
        copy = vm.SetPositionMessage("/b", (0.0, 0.0, 0.0))
        assert buffer.get_cached_encoding([a, copy]) is None
        buffer.cache_encoding([a, b], [b"x" * (5 << 20)])
        assert buffer.get_cached_encoding([a, b]) is None

    run_isolated(lambda: asyncio.run(scenario()))


def test_atomic_blocks_are_delivered_whole() -> None:
    """Nothing is sent while a block is open, and then everything in it arrives
    in one payload -- including blocks that are larger than replay payloads, and
    when no other message follows to wake up the producer."""

    async def scenario() -> list[list[str]]:
        loop = asyncio.get_running_loop()
        buffer = AsyncMessageBuffer(loop, persistent_messages=True)
        ws = _FakeWebsocket()
        buffer.push(_array_update(-1, 1 << 20))
        # A second consumer, so that encodings are shared.
        async with _producers(buffer, [ws, _FakeWebsocket()], vm.ReplayDoneMessage()):
            await _wait_for(ws, None)
            num_before = len(ws.payloads)

            buffer.atomic_start()
            for i in range(10):
                buffer.push(_array_update(i, 3 << 20))
                await asyncio.sleep(0.02)
            assert len(ws.payloads) == num_before
            buffer.atomic_end()
            await _wait_for(ws, "/9")
        return [[m["name"] for m in _decode(p)] for p in ws.payloads[num_before:]]

    payloads = run_isolated(lambda: asyncio.run(scenario()))
    assert payloads == [[f"/{i}" for i in range(10)]]


def test_open_atomic_block_holds_back_awake_consumers() -> None:
    """Consumers that were woken up by an earlier message shouldn't pick up
    messages from a block that's still open."""

    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        ws = _FakeWebsocket()
        async with _producers(buffer, [ws]):
            await asyncio.sleep(0.05)
            buffer.push(vm.SetPositionMessage("/before", (0.0, 0.0, 0.0)))
            buffer.atomic_start()
            buffer.push(vm.SetPositionMessage("/a", (0.0, 0.0, 0.0)))
            await asyncio.sleep(0.1)
            buffer.push(vm.SetPositionMessage("/b", (0.0, 0.0, 0.0)))
            await asyncio.sleep(0.1)
            assert len(ws.payloads) == 0
            buffer.atomic_end()
            await _wait_for(ws, "/b")
        names = [[m["name"] for m in _decode(p)] for p in ws.payloads]
        assert names == [["/before", "/a", "/b"]]

    run_isolated(lambda: asyncio.run(scenario()))


def test_live_pushes_during_sparse_replay() -> None:
    """Large gaps in message ids, on both sides of the replay boundary."""

    async def scenario() -> list[Any]:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )

        def push(prefix: str, n: int) -> None:
            for i in range(n):
                buffer.push(vm.SetPositionMessage(f"/{prefix}{i}", (0.0, 0.0, 0.0)))
                buffer.message_counter += 5000

        push("a", 1500)
        marker = vm.ReplayDoneMessage()
        gen = buffer.window_generator(0, backlog_done_message=marker)
        push("b", 10)  # Live, but pushed before the first window.
        seen = list(await gen.__anext__())
        push("c", 1500)
        while getattr(seen[-1], "name", None) != "/c1499":
            seen.extend(await asyncio.wait_for(gen.__anext__(), timeout=5.0))
        await gen.aclose()
        return [getattr(m, "name", None) for m in seen]

    assert run_isolated(lambda: asyncio.run(scenario())) == (
        [f"/a{i}" for i in range(1500)]
        + [None]
        + [f"/b{i}" for i in range(10)]
        + [f"/c{i}" for i in range(1500)]
    )


def test_client_messages_are_not_starved_by_broadcasts(
    server: viser.ViserServer,
) -> None:
    """Per-client messages used to wait for the whole replay, or forever if large
    broadcasts kept coming."""
    from websockets.sync.client import connect

    for i in range(30):
        server.scene.add_mesh_simple(
            f"/m{i}", np.zeros((250_000, 3), np.float32), np.zeros((1, 3), np.uint32)
        )
    num_payloads = 0
    last_client_message = -1
    done = threading.Event()

    def on_connect(client: Any) -> None:
        def push() -> None:
            while not done.wait(0.02):
                client.queue_message(vm.SetPositionMessage("/mine", (0.0, 0.0, 0.0)))

        threading.Thread(target=push, daemon=True).start()

    server._websock_server.on_client_connect(on_connect)
    first_client_message = -1
    with connect(
        f"ws://localhost:{server.get_port()}",
        max_size=None,
        compression=None,
        subprotocols=[f"viser-v{viser.__version__}"],  # type: ignore
    ) as ws:
        while True:
            payload = ws.recv()
            assert isinstance(payload, bytes)
            messages = _decode(payload)
            num_payloads += 1
            if any(m.get("name") == "/mine" for m in messages):
                last_client_message = num_payloads
                if first_client_message < 0:
                    first_client_message = num_payloads
            if any(m["type"] == "ReplayDoneMessage" for m in messages):
                break
            done.wait(0.05)  # Slow reader.
    done.set()
    # Early, and not just once.
    assert 0 < first_client_message < num_payloads / 2
    assert last_client_message > num_payloads / 2


def test_incoming_messages_reach_client_handlers(server: viser.ViserServer) -> None:
    """Handlers may be registered on the server, on a connection, or both."""
    from websockets.sync.client import connect

    received: list[str] = []
    events = {"server": threading.Event(), "client": threading.Event()}

    def make_handler(name: str) -> Any:
        def handler(client_id: Any, message: Any) -> None:
            received.append(name)
            events[name].set()

        return handler

    server._websock_server.on_client_connect(
        lambda c: c.register_handler(vm.ShareUrlRequest, make_handler("client"))
    )
    server._websock_server.register_handler(vm.ShareUrlRequest, make_handler("server"))
    server.request_share_url = lambda *_: None  # type: ignore
    with connect(
        f"ws://localhost:{server.get_port()}",
        subprotocols=[f"viser-v{viser.__version__}"],  # type: ignore
    ) as ws:
        ws.recv()
        ws.send(msgspec.msgpack.encode({"type": "ShareUrlRequest"}))
        for event in events.values():
            assert event.wait(5.0)
    assert sorted(received) == ["client", "server"]


def test_encoding_cache_is_released() -> None:
    async def scenario() -> None:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        gens = [buffer.window_generator(i) for i in range(2)]
        buffer.push(_array_update(0, 10))
        window = list(await gens[0].__anext__())
        await gens[1].__anext__()
        buffer.cache_encoding(window, [b"payload"])
        assert buffer.get_cached_encoding(window) is not None
        for gen in gens:
            await gen.aclose()
        assert buffer._encoding_cache is None

    run_isolated(lambda: asyncio.run(scenario()))


# --- Concurrent assignments -------------------------------------------------


def _last_sent(buffer: AsyncMessageBuffer, kind: str) -> Any:
    out = None
    for m in list(buffer.message_from_id.values()):
        if kind == "position" and isinstance(m, vm.SetPositionMessage):
            out = m.position[0]
        elif kind == "visible" and isinstance(m, vm.SetSceneNodeVisibilityMessage):
            out = m.visible
        elif kind == "color" and isinstance(m, vm.SceneNodeUpdateMessage):
            out = m.updates["color"]
        elif kind == "value" and isinstance(m, vm.GuiUpdateMessage):
            out = m.updates["value"]
    return out


@pytest.mark.parametrize("kind", ["position", "visible", "color", "value"])
def test_concurrent_assignments_match_what_is_sent(
    server: viser.ViserServer, kind: str
) -> None:
    """The stored state used to be able to differ from the last update. After that,
    assigning the stored value was dropped as redundant."""
    buffer = server._websock_server._broadcast_buffer
    if kind == "value":
        handle: Any = server.gui.add_number("x", 0)
    else:
        handle = server.scene.add_box("/box")

    def to_value(i: int) -> Any:
        if kind == "position":
            return (float(i), 0.0, 0.0)
        if kind == "visible":
            return bool(i % 2)
        if kind == "color":
            return (i % 256, i // 256 % 256, 0)
        return i

    def work(offset: int) -> None:
        barrier.wait()
        for i in range(30):
            setattr(handle, kind, to_value(offset + i))

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-5)
    try:
        for _ in range(60):
            barrier = threading.Barrier(4)
            threads = [
                threading.Thread(target=work, args=(i * 37 + 1,)) for i in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            stored = getattr(handle, kind)
            if kind == "position":
                stored = stored[0]
            assert stored == _last_sent(buffer, kind)
    finally:
        sys.setswitchinterval(interval)


def test_concurrent_client_updates_match_what_is_sent(
    server: viser.ViserServer,
) -> None:
    handle = server.gui.add_number("x", 0)
    buffer = server._websock_server._broadcast_buffer
    message = vm.GuiUpdateMessage(handle._impl.uuid, {"value": 0})

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-5)
    try:
        for i in range(1000):
            message.updates = {"value": 2 * i + 1}
            thread = threading.Thread(target=setattr, args=(handle, "value", 2 * i + 2))
            thread.start()
            asyncio.run_coroutine_threadsafe(
                server.gui._handle_gui_updates(0, message),  # type: ignore
                server.get_event_loop(),
            ).result()
            thread.join()
            assert handle.value == _last_sent(buffer, "value")
    finally:
        sys.setswitchinterval(interval)


def test_updates_are_not_queued_after_removal(server: viser.ViserServer) -> None:
    def work() -> None:
        barrier.wait()
        with contextlib.suppress(RuntimeError):
            for j in range(6):
                handle.position = (j + 1.0, 0.0, 0.0)
                handle.axes_length = j + 1.0

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        for i in range(300):
            handle = server.scene.add_frame(f"/{i}")
            barrier = threading.Barrier(2)
            thread = threading.Thread(target=work)
            thread.start()
            barrier.wait()
            handle.remove()
            thread.join()
            assert not any(
                getattr(m, "name", None) == f"/{i}"
                and isinstance(m, (vm.SetPositionMessage, vm.SceneNodeUpdateMessage))
                for m in broadcast_messages(server)
            )
    finally:
        sys.setswitchinterval(interval)


def test_redundant_assignment_discards_inplace_edits(
    server: viser.ViserServer,
) -> None:
    cloud = server.scene.add_point_cloud(
        "/p", np.zeros((4, 3)), (1, 2, 3), precision="float32"
    )
    cloud.points[:] = 5
    cloud.points = np.zeros((4, 3), np.float32)
    assert not cloud.points.any()
    assert not _updates(server, "/p", "points")


def test_partial_splat_updates_include_inplace_edits(
    server: viser.ViserServer,
) -> None:
    splats = server.scene.add_gaussian_splats(
        "/splats",
        centers=np.zeros((4, 3)),
        covariances=np.tile(np.eye(3), (4, 1, 1)),
        rgbs=np.zeros((4, 3)),
        opacities=np.ones((4, 1)),
    )
    splats.centers[1] = 3.0
    splats.opacities = np.full((4, 1), 0.5)
    np.testing.assert_array_equal(splats.centers[1], 3.0)
    buffer = _updates(server, "/splats", "buffer")[-1]
    np.testing.assert_array_equal(buffer[1, :3].view(np.float32), 3.0)


def test_assignments_in_callbacks_do_not_deadlock(server: viser.ViserServer) -> None:
    """Locks are shared between handles, so callbacks can't run while one's held."""
    handles = [server.gui.add_number(str(i), 0) for i in range(200)]
    for i, handle in enumerate(handles):
        other = handles[-1 - i]

        @handle.on_update
        def _(_, other=other) -> None:
            if other.value < 5:
                other.value += 1

    def work(i: int) -> None:
        for j in range(len(handles)):
            handles[(j * 7 + i) % len(handles)].value = 1 + i

    threads = [threading.Thread(target=work, args=(i,), daemon=True) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20.0)
        assert not thread.is_alive()
