"""Tests for behavior that the server's fast paths need to preserve, plus bugs
found while benchmarking it. Timing lives in ``benchmarks/``; the few
complexity checks here count operations instead of seconds."""

from __future__ import annotations

import asyncio
import dataclasses
import struct
import threading
from typing import Any, Dict, Optional, Tuple, Union

import msgspec
import numpy as np
import numpy.typing as npt
import pytest
import zstandard
from typing_extensions import get_type_hints

import viser
from viser import _messages as vm
from viser._assignable_props_api import array_snapshot, arrays_equal
from viser.infra import _infra
from viser.infra._async_message_buffer import AsyncMessageBuffer
from viser.infra._messages import (
    _make_converter,
    _prepare_for_serialization,
    get_type_hints_cached,
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
        assert get_type_hints_cached(cls) == get_type_hints(cls)
        for hint in get_type_hints_cached(cls).values():
            assert callable(_make_converter(hint))


# --- Message delivery -------------------------------------------------------


def _drain(buffer: AsyncMessageBuffer, marker: Any, visited: list[int]) -> Any:
    class CountingDict(dict):
        def get(self, key, default=None):
            visited.append(key)
            return super().get(key, default)

    buffer.message_from_id = CountingDict(buffer.message_from_id)

    async def inner():
        out: list[Any] = []
        gen = buffer.window_generator(0, backlog_done_message=marker)
        while marker not in out:
            out.extend(await asyncio.wait_for(gen.__anext__(), timeout=5.0))
        await gen.aclose()
        return out

    return inner()


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

        visited: list[int] = []
        out = await _drain(buffer, vm.ReplayDoneMessage(), visited)
        assert [getattr(m, "name", None) for m in out] == ["/a", "/b", "/c", None]
        assert len(visited) < 100

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


def _run_producers(
    push: Any, num_clients: int, marker: Any
) -> tuple[list[_FakeWebsocket], list[list[dict]]]:
    async def scenario():
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=True
        )
        push(buffer)
        sockets = [_FakeWebsocket() for _ in range(num_clients)]
        tasks = [
            asyncio.create_task(
                _infra._message_producer(ws, buffer, i, marker)  # type: ignore
            )
            for i, ws in enumerate(sockets)
        ]
        await asyncio.sleep(0.2)
        buffer.push(vm.SetPositionMessage("/live", (1.0, 2.0, 3.0)))
        buffer.push(vm.SetPositionMessage("/live2", (1.0, 2.0, 3.0)))
        await asyncio.sleep(0.2)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
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
    assert ws.largest_fragment <= 2 * _infra._FRAGMENT_BYTES


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
        buffer.generator_cursors[0] = buffer.message_counter
        handle.remove()
        if not client_is_behind:
            buffer.generator_cursors[0] = buffer.message_counter
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
