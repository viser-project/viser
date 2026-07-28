"""Regression tests for get_render() latency fixes and request races.

get_render() is a blocking round trip, so fixed per-call overhead directly
caps capture throughput. Three server-side problems are pinned here:

- The request message used to sit in the outgoing per-client buffer for up to
  one windowing delay (``window_duration_sec``) before hitting the wire;
  get_render() now flushes the buffer immediately after queueing.
- ``GetRenderRequestMessage`` had no ``redundancy_key`` override, so every
  request shared the class-name default key: a second concurrent
  get_render() on the same client evicted the first caller's still-unsent
  request from the buffer, hanging that caller until timeout.
- The response payload used to be decoded (plus imageio's slow first import)
  inside the response callback, which runs on the server's asyncio event
  loop -- blocking message handling for every client. Decoding now happens
  on the calling thread.
"""

from __future__ import annotations

import asyncio
import io
import threading
import time
from contextlib import contextmanager
from typing import Callable, Generator, cast

import numpy as np
import pytest

import viser
from viser import _messages
from viser._viser import ClientHandle
from viser.infra._async_message_buffer import AsyncMessageBuffer
from viser.infra._infra import (
    WebsockClientConnection,
    WebsockMessageHandler,
    _ClientHandleState,
)


@contextmanager
def _server() -> Generator[viser.ViserServer, None, None]:
    server = viser.ViserServer(port=0, verbose=False)
    try:
        yield server
    finally:
        server.stop()


def _camera_kwargs() -> dict:
    """Explicit camera args so fabricated clients never read camera state."""
    return dict(
        wxyz=(1.0, 0.0, 0.0, 0.0),
        position=(0.0, 0.0, 0.0),
        fov=1.0,
    )


def _jpeg_payload(height: int, width: int) -> bytes:
    import imageio.v3 as iio

    buf = io.BytesIO()
    iio.imwrite(buf, np.zeros((height, width, 3), dtype=np.uint8), extension=".jpeg")
    return buf.getvalue()


def _make_buffered_client(
    server: viser.ViserServer, client_id: int
) -> tuple[ClientHandle, AsyncMessageBuffer, WebsockClientConnection]:
    """A ClientHandle whose connection is backed by a REAL (non-persistent)
    AsyncMessageBuffer on the server's live event loop, as for a browser
    client -- so buffer-level behavior (coalescing, windowing, flushing) is
    actually exercised. The caller is responsible for popping the client from
    ``server._connected_clients`` / ``_client_state_from_id`` afterwards."""
    loop = server._websock_server._background_event_loop
    assert loop is not None

    # Construct the buffer ON the server's event loop: before Python 3.10,
    # asyncio.Event() binds its loop at construction time, so building the
    # buffer on the test thread attaches its events to the wrong loop and
    # the window generator explodes with "attached to a different loop".
    # (The real client path constructs buffers inside the ws handler, i.e.
    # on the loop, so it never hits this.)
    async def _make_buffer() -> AsyncMessageBuffer:
        return AsyncMessageBuffer(loop, persistent_messages=False)

    buffer = asyncio.run_coroutine_threadsafe(_make_buffer(), loop).result(timeout=5.0)
    client_state = _ClientHandleState(buffer, loop)
    conn = WebsockClientConnection(client_id, client_state)
    client = ClientHandle.__new__(ClientHandle)
    client.client_id = client_id
    client._websock_connection = conn
    client._viser_server = server
    server._connected_clients[client_id] = cast(viser.ClientHandle, client)
    # Registered so ClientHandle.flush() (-> flush_client) reaches this buffer.
    server._websock_server._client_state_from_id[client_id] = client_state
    return client, buffer, conn


def test_render_request_redundancy_key_is_per_request() -> None:
    """Two render requests must occupy independent buffer slots. Under the
    class-name default key, push() evicted the earlier request."""

    def request(uuid: str) -> _messages.GetRenderRequestMessage:
        return _messages.GetRenderRequestMessage(
            "image/jpeg",
            height=8,
            width=8,
            quality=80,
            position=(0.0, 0.0, 0.0),
            wxyz=(1.0, 0.0, 0.0, 0.0),
            fov=1.0,
            render_uuid=uuid,
        )

    assert request("aa").redundancy_key() != request("bb").redundancy_key()

    async def scenario() -> int:
        buffer = AsyncMessageBuffer(
            asyncio.get_running_loop(), persistent_messages=False
        )
        buffer.push(request("aa"))
        buffer.push(request("bb"))
        return sum(
            isinstance(m, _messages.GetRenderRequestMessage)
            for m in buffer.message_from_id.values()
        )

    from .thread_isolation import run_isolated

    assert run_isolated(lambda: asyncio.run(scenario())) == 2


def test_concurrent_get_render_requests_both_survive_and_resolve() -> None:
    """Two concurrent get_render() calls on the SAME client: both requests
    must reach the outgoing buffer (pre-fix, the second evicted the first),
    and crossed responses must resolve each caller to its own frame."""
    with _server() as server:
        client, buffer, conn = _make_buffered_client(server, client_id=810_001)
        results: dict[int, object] = {}
        results_lock = threading.Lock()

        def call(height: int) -> None:
            try:
                out = client.get_render(
                    height=height,
                    width=height,
                    **_camera_kwargs(),
                    transport_format="jpeg",
                    timeout=6.0,
                )
                with results_lock:
                    results[height] = out
            except BaseException as e:  # noqa: BLE001
                with results_lock:
                    results[height] = e

        threads = [
            threading.Thread(target=call, args=(8,)),
            threading.Thread(target=call, args=(16,)),
        ]
        try:
            for t in threads:
                t.start()

            # Both requests must be present in the buffer simultaneously.
            deadline = time.monotonic() + 5.0
            requests: list[_messages.GetRenderRequestMessage] = []
            while time.monotonic() < deadline:
                with buffer.buffer_lock:
                    requests = [
                        m
                        for m in buffer.message_from_id.values()
                        if isinstance(m, _messages.GetRenderRequestMessage)
                    ]
                if len(requests) == 2:
                    break
                time.sleep(0.002)
            assert len(requests) == 2, (
                f"expected both in-flight render requests in the buffer, found "
                f"{len(requests)} (concurrent requests coalesced?)"
            )

            uuid_by_height = {r.height: r.render_uuid for r in requests}
            # Dispatch crossed responses (largest first) to a handler snapshot,
            # as the server's dispatch loop would: each caller must take only
            # the frame matching its own request uuid.
            handlers = list(conn._incoming_handlers[_messages.GetRenderResponseMessage])
            assert len(handlers) == 2
            for height in (16, 8):
                message = _messages.GetRenderResponseMessage(
                    _jpeg_payload(height, height), uuid_by_height[height]
                )
                for cb in handlers:
                    cb(client.client_id, message)

            for t in threads:
                t.join(timeout=8.0)
            assert all(not t.is_alive() for t in threads), "get_render hung"
            for height in (8, 16):
                out = results[height]
                assert isinstance(out, np.ndarray), f"caller raised: {out!r}"
                assert out.shape == (height, height, 3)
        finally:
            server._connected_clients.pop(client.client_id, None)
            server._websock_server._client_state_from_id.pop(client.client_id, None)


def test_get_render_request_skips_windowing_delay() -> None:
    """The render request must be flushed onto the wire immediately, not sit
    out the buffer's windowing delay. The buffer's window delay is set
    absurdly high (10s); with the producer parked in that delay, the request
    window must still arrive promptly because get_render() flushes."""
    with _server() as server:
        loop = server._websock_server._background_event_loop
        assert loop is not None
        client, buffer, conn = _make_buffered_client(server, client_id=810_002)
        buffer.window_duration_sec = 10.0
        dummy_seen = threading.Event()

        async def collect_until_request() -> tuple[float, list]:
            gen = buffer.window_generator(client.client_id)
            try:
                while True:
                    window = await gen.__anext__()
                    if any(
                        isinstance(m, _messages.GetRenderRequestMessage) for m in window
                    ):
                        return time.monotonic(), list(window)
                    dummy_seen.set()
            finally:
                await gen.aclose()

        box: dict[str, BaseException] = {}

        def call() -> None:
            try:
                client.get_render(height=8, width=8, **_camera_kwargs(), timeout=8.0)
            except BaseException as e:  # noqa: BLE001
                box["err"] = e

        thread = threading.Thread(target=call)
        # Queue a dummy BEFORE the producer starts (so its very first window
        # yields it immediately), then drain it: the producer is then parked
        # in its (10-second) post-window delay when the request is pushed --
        # the exact state the flush must break out of.
        conn.queue_message(_messages.GuiCloseModalMessage(uuid="dummy"))
        future = asyncio.run_coroutine_threadsafe(collect_until_request(), loop)
        try:
            assert dummy_seen.wait(timeout=5.0)
            time.sleep(0.3)  # Let the producer re-enter its post-yield delay.

            start = time.monotonic()
            thread.start()
            # Pre-fix (no flush), the window surfaces only after the full 10s
            # delay and this times out.
            arrival, window = future.result(timeout=5.0)
            assert arrival - start < 5.0
            request = next(
                m for m in window if isinstance(m, _messages.GetRenderRequestMessage)
            )
            # Unblock the caller: empty payload is the failure sentinel.
            for cb in list(
                conn._incoming_handlers.get(_messages.GetRenderResponseMessage, [])
            ):
                cb(
                    client.client_id,
                    _messages.GetRenderResponseMessage(b"", request.render_uuid),
                )
        finally:
            future.cancel()
            thread.join(timeout=10.0)
            server._connected_clients.pop(client.client_id, None)
            server._websock_server._client_state_from_id.pop(client.client_id, None)
        assert not thread.is_alive()
        assert isinstance(box.get("err"), RuntimeError)  # empty-payload sentinel


def test_render_decode_runs_on_caller_thread_not_dispatch_thread() -> None:
    """The payload must be decoded on the get_render() caller's thread. It
    used to be decoded inside the response callback, which the server runs on
    its asyncio event loop -- stalling message handling for every client for
    the duration of a large PNG/JPEG decode."""
    import imageio.v3 as iio

    payload = _jpeg_payload(8, 8)
    decode_threads: list[threading.Thread] = []
    real_imread = iio.imread

    def spy_imread(*args: object, **kwargs: object) -> np.ndarray:
        decode_threads.append(threading.current_thread())
        return real_imread(*args, **kwargs)  # type: ignore[arg-type]

    class _Conn(WebsockMessageHandler):
        def __init__(self) -> None:
            super().__init__()
            self.sent: list[object] = []

        def get_message_buffer(self):  # pragma: no cover - unused
            raise NotImplementedError()

        def queue_message(self, message) -> None:
            self.sent.append(message)

    with _server() as server:
        conn = _Conn()
        client = ClientHandle.__new__(ClientHandle)
        client.client_id = 810_003
        client._websock_connection = conn  # type: ignore[assignment]
        client._viser_server = server
        server._connected_clients[client.client_id] = cast(viser.ClientHandle, client)

        result: dict[str, object] = {}

        def call() -> None:
            result["thread"] = threading.current_thread()
            try:
                result["out"] = client.get_render(
                    height=8,
                    width=8,
                    **_camera_kwargs(),
                    transport_format="jpeg",
                    timeout=5.0,
                )
            except BaseException as e:  # noqa: BLE001
                result["err"] = e

        thread = threading.Thread(target=call)
        try:
            with pytest.MonkeyPatch.context() as mp:
                mp.setattr("imageio.v3.imread", spy_imread)
                thread.start()
                # Wait for the request, then deliver the response from THIS
                # (dispatch-stand-in) thread.
                deadline = time.monotonic() + 5.0
                cb = None
                uuid = None
                while time.monotonic() < deadline:
                    handlers = conn._incoming_handlers.get(
                        _messages.GetRenderResponseMessage, []
                    )
                    requests = [
                        m
                        for m in conn.sent
                        if isinstance(m, _messages.GetRenderRequestMessage)
                    ]
                    if handlers and requests:
                        cb, uuid = handlers[0], requests[0].render_uuid
                        break
                    time.sleep(0.002)
                assert cb is not None and uuid is not None, "request never sent"
                cb(client.client_id, _messages.GetRenderResponseMessage(payload, uuid))
                thread.join(timeout=8.0)
        finally:
            server._connected_clients.pop(client.client_id, None)

        assert not thread.is_alive()
        assert "err" not in result, f"caller raised: {result.get('err')!r}"
        assert cast(np.ndarray, result["out"]).shape == (8, 8, 3)
        # Decoded exactly once, on the caller's thread -- never on the thread
        # that delivered the response (the event loop, in production).
        assert decode_threads == [result["thread"]], (
            f"decode ran on {decode_threads}, expected only the get_render "
            f"caller thread {result['thread']}"
        )
        assert threading.current_thread() not in decode_threads


class _RecordingConn(WebsockMessageHandler):
    """A connection with a real handler registry that records queued messages
    instead of buffering them."""

    def __init__(self) -> None:
        super().__init__()
        self.sent: list[object] = []

    def get_message_buffer(self):  # pragma: no cover - unused
        raise NotImplementedError()

    def queue_message(self, message) -> None:
        self.sent.append(message)


def _wait_for_request(
    conn: _RecordingConn, timeout: float = 5.0
) -> tuple[Callable, str]:
    """Wait until get_render() registered its handler and queued its request;
    return (response callback, request uuid)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        handlers = conn._incoming_handlers.get(_messages.GetRenderResponseMessage, [])
        requests = [
            m for m in conn.sent if isinstance(m, _messages.GetRenderRequestMessage)
        ]
        if handlers and requests:
            return handlers[0], requests[0].render_uuid
        time.sleep(0.002)
    raise AssertionError("get_render never registered/queued its request")


def test_get_render_default_transport_is_jpeg() -> None:
    """The transport lineup is deliberately just jpeg (default) and png.
    Content-adaptive lossless transports (deflate-compressed raw pixels,
    with or without a JPEG fallback) were built, measured, and removed:
    every fixed lossless choice had a content class where it lost badly
    (high-entropy frames deflate at ~2x for 100-270ms, or ship as multi-MB
    payloads), and the per-frame adaptive variant's win over plain JPEG --
    after the capture-path optimizations that benefit every format -- was
    too small to justify two extra formats, a payload-flag protocol, and
    sampling thresholds. See the branch history for the measurements."""
    import inspect

    from viser._viser import CameraHandle

    for fn in (ClientHandle.get_render, CameraHandle.get_render):
        default = inspect.signature(fn).parameters["transport_format"].default
        assert default == "jpeg", f"{fn.__qualname__} default is {default!r}"


def test_get_render_jpeg_quality_reaches_the_wire() -> None:
    """The request's quality field carries the fixed JPEG quality (80); the
    client passes it to toBlob, where omitting it silently encoded at
    Chrome's 0.92 default -- measured strictly slower to encode AND decode,
    and ~50% larger."""
    with _server() as server:
        conn = _RecordingConn()
        client = ClientHandle.__new__(ClientHandle)
        client.client_id = 810_007
        client._websock_connection = conn  # type: ignore[assignment]
        client._viser_server = server
        server._connected_clients[client.client_id] = cast(viser.ClientHandle, client)
        try:

            def call() -> None:
                try:
                    client.get_render(
                        height=8,
                        width=8,
                        **_camera_kwargs(),
                        transport_format="jpeg",
                        timeout=2.0,
                    )
                except BaseException:  # noqa: BLE001
                    pass

            thread = threading.Thread(target=call)
            thread.start()
            cb, uuid = _wait_for_request(conn)
            request = next(
                m for m in conn.sent if isinstance(m, _messages.GetRenderRequestMessage)
            )
            assert request.quality == 80
            cb(
                client.client_id,
                _messages.GetRenderResponseMessage(_jpeg_payload(8, 8), uuid),
            )
            thread.join(timeout=5.0)
            assert not thread.is_alive()
        finally:
            server._connected_clients.pop(client.client_id, None)


def test_get_render_flushes_broadcast_buffer_first() -> None:
    """Scene updates made before get_render() ride the BROADCAST buffer while
    the render request rides the per-client buffer. get_render() must flush
    the broadcast buffer BEFORE queueing its own request, so a still-windowed
    scene update is (best-effort) on the wire ahead of the request instead of
    being overtaken and captured stale. The ordering is pinned in-band: the
    flush call is recorded into the same log as the queued request."""
    with _server() as server:
        broadcast = server._websock_server._broadcast_buffer
        conn = _RecordingConn()
        client = ClientHandle.__new__(ClientHandle)
        client.client_id = 810_005
        client._websock_connection = conn  # type: ignore[assignment]
        client._viser_server = server
        server._connected_clients[client.client_id] = cast(viser.ClientHandle, client)
        orig_flush = server.flush

        def recording_flush() -> None:
            conn.sent.append("broadcast-flush")
            orig_flush()

        server.flush = recording_flush  # type: ignore[method-assign]
        try:
            # A scene update sits in the (windowed) broadcast buffer.
            server.scene.add_frame("/pending")
            assert not broadcast.flush_event.is_set()

            def call() -> None:
                try:
                    client.get_render(
                        height=8, width=8, **_camera_kwargs(), timeout=0.5
                    )
                except BaseException:  # noqa: BLE001
                    pass

            thread = threading.Thread(target=call)
            thread.start()
            _wait_for_request(conn)
            # ORDERING: the broadcast flush must be recorded before the
            # request in the same in-band log. (A flush anywhere later in
            # the call would not protect a still-windowed scene update.)
            flush_index = conn.sent.index("broadcast-flush")
            request_index = next(
                i
                for i, m in enumerate(conn.sent)
                if isinstance(m, _messages.GetRenderRequestMessage)
            )
            assert flush_index < request_index, (
                "get_render() must flush the broadcast buffer BEFORE queueing "
                f"its request (flush at {flush_index}, request at {request_index})"
            )
            # And the signal actually reaches the broadcast buffer.
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and not broadcast.flush_event.is_set():
                time.sleep(0.002)
            assert broadcast.flush_event.is_set()
            thread.join(timeout=5.0)
            assert not thread.is_alive()
        finally:
            server.flush = orig_flush  # type: ignore[method-assign]
            server._connected_clients.pop(client.client_id, None)
