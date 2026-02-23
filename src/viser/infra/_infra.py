from __future__ import annotations

import abc
import asyncio
import atexit
import base64
import contextlib
import dataclasses
import gzip
import http
import logging
import mimetypes
import queue
import threading
import time
import webbrowser
from asyncio.events import AbstractEventLoop
from collections.abc import Coroutine
from pathlib import Path
from typing import Any, Callable, Generator, NewType, TypeVar

import msgspec.msgpack
import websockets.asyncio.server
import websockets.datastructures
import websockets.exceptions
import zstandard
from typing_extensions import Literal, assert_never, override
from websockets import Headers
from websockets.asyncio.server import ServerConnection
from websockets.http11 import Request, Response
from websockets.typing import Subprotocol

import viser  # Import for version checking

from ._async_message_buffer import AsyncMessageBuffer
from ._messages import Message


@dataclasses.dataclass
class _ClientHandleState:
    # Internal state for ClientConnection objects.
    # message_buffer: asyncio.Queue
    message_buffer: AsyncMessageBuffer
    event_loop: AbstractEventLoop


ClientId = NewType("ClientId", int)
TMessage = TypeVar("TMessage", bound=Message)


class StateSerializer:
    """Handle for serializing messages. In Viser, this is used to save the
    scene state so it can be shared/embedded in static webpages."""

    def __init__(
        self, handler: WebsockMessageHandler, filter: Callable[[Message], bool]
    ):
        self._handler = handler
        self._filter = filter
        self._time: float = 0.0
        self._messages: list[tuple[float, dict[str, Any]]] = []

    def _insert_message(self, message: Message) -> None:
        """Insert a message into the recorded file."""

        # Exclude messages that are filtered out. In Viser, this is typically
        # GUI messages.
        if not self._filter(message):
            return
        self._messages.append((self._time, message.as_serializable_dict()))

    def insert_sleep(self, duration: float) -> None:
        """Insert a sleep into the recorded file. This can be useful for
        dynamic 3D data."""
        assert self in self._handler._record_handles, "serialize() was already called!"
        self._time += duration

    def serialize(self) -> bytes:
        """Serialize saved messages. Should only be called once. Our convention
        is to write this binary format to a file with a ``.viser`` extension,
        for example via ``pathlib.Path("file.viser").write_bytes(...)``.

        Returns:
            The recording as bytes.
        """
        assert self in self._handler._record_handles, "serialize() was already called!"

        packed_bytes = msgspec.msgpack.encode(
            {
                "durationSeconds": self._time,
                "messages": self._messages,
                "viserVersion": viser.__version__,
            }
        )
        assert isinstance(packed_bytes, bytes)
        self._handler._record_handles.remove(self)
        # Use zstd for better compression ratio and speed.
        # Prepend 8-byte size header for decompressor.
        compressed = zstandard.ZstdCompressor(level=12).compress(packed_bytes)
        return len(packed_bytes).to_bytes(8, "little") + compressed

    def show(self, height: int = 400, dark_mode: bool = False) -> None:
        """Display the serialized scene in a Jupyter notebook or web browser.

        In Jupyter notebooks/labs, displays an inline IFrame. When running as a
        script, opens the visualization in the default web browser.

        See also :meth:`viser.ViserServer.show`.

        Args:
            height: Height of the embedded viewer in pixels.
            dark_mode: Use dark color scheme.
        """
        import html as html_module

        scene_bytes = self.serialize()
        scene_b64 = base64.b64encode(scene_bytes).decode("ascii")

        # Get client HTML and inject scene data as global variables.
        # The client reads from window.__VISER_EMBED_DATA__ (App.tsx).
        client_html_path = (
            Path(__file__).parent.parent / "client" / "build" / "index.html"
        )
        client_html = client_html_path.read_text()
        dark_mode_str = "true" if dark_mode else "false"
        inject_script = (
            f"<script>"
            f'window.__VISER_EMBED_DATA__="{scene_b64}";'
            f"window.__VISER_EMBED_CONFIG__={{darkMode:{dark_mode_str}}};"
            f"</script>"
        )
        modified_html = client_html.replace("</head>", f"{inject_script}</head>")

        # Display in IPython (Jupyter, Colab, myst-nb, etc.) using srcdoc.
        # This embeds the entire HTML inline, avoiding file serving issues.
        try:
            from IPython.core.getipython import get_ipython  # type: ignore

            ipython = get_ipython()
            if ipython is not None:
                from IPython.display import HTML, display  # type: ignore

                # Escape HTML for srcdoc attribute.
                escaped_html = html_module.escape(modified_html, quote=True)

                # Wrap in div to avoid IPython's "Consider using IFrame" warning.
                display(
                    HTML(
                        f'<div style="border:1px solid #ddd">'
                        f'<iframe srcdoc="{escaped_html}" '
                        f'width="100%" height="{height}" '
                        f'style="border:none;display:block"></iframe>'
                        f"</div>"
                    )
                )
                return
        except ImportError:
            pass

        # Fallback for scripts: write the modified HTML to a temp file.
        import tempfile

        with tempfile.NamedTemporaryFile(
            "w", suffix=".html", delete=False, encoding="utf-8"
        ) as f:
            f.write(modified_html)
            webbrowser.open("file://" + f.name)


class WebsockMessageHandler:
    """Mix-in for adding message handling to a class."""

    def __init__(self) -> None:
        self._incoming_handlers: dict[
            type[Message], list[Callable[[ClientId, Message], None | Coroutine]]
        ] = {}
        self._queued_messages: queue.Queue = queue.Queue()
        self._locked_thread_id = -1

        # List of active serializers recording messages.
        self._record_handles: list[StateSerializer] = []

    def get_message_serializer(
        self, filter: Callable[[Message], bool]
    ) -> StateSerializer:
        """Start recording messages that are sent. Sent messages will be
        serialized and can be used for playback."""
        serializer = StateSerializer(self, filter)
        self._record_handles.append(serializer)
        return serializer

    def register_handler(
        self,
        message_cls: type[TMessage],
        callback: Callable[[ClientId, TMessage], None | Coroutine],
    ) -> None:
        """Register a handler for a particular message type."""
        if message_cls not in self._incoming_handlers:
            self._incoming_handlers[message_cls] = []
        self._incoming_handlers[message_cls].append(callback)  # type: ignore

    def unregister_handler(
        self,
        message_cls: type[TMessage],
        callback: Callable[[ClientId, TMessage], None | Coroutine] | None = None,
    ):
        """Unregister a handler for a particular message type."""
        assert message_cls in self._incoming_handlers, (
            "Tried to unregister a handler that hasn't been registered."
        )
        if callback is None:
            self._incoming_handlers.pop(message_cls)
        else:
            self._incoming_handlers[message_cls].remove(callback)  # type: ignore

    async def _handle_incoming_message(
        self, client_id: ClientId, message: Message
    ) -> None:
        """Handle incoming messages."""
        if type(message) in self._incoming_handlers:
            for cb in self._incoming_handlers[type(message)]:
                if asyncio.iscoroutinefunction(cb):
                    await cb(client_id, message)
                else:
                    cb(client_id, message)

    @abc.abstractmethod
    def get_message_buffer(self) -> AsyncMessageBuffer: ...

    def queue_message(self, message: Message) -> None:
        """Wrapped method for sending messages."""
        for handle in self._record_handles:
            handle._insert_message(message)

        self.get_message_buffer().push(message)

    @contextlib.contextmanager
    def atomic(self) -> Generator[None, None, None]:
        """Returns a context where: all outgoing messages are grouped and applied by
        clients atomically.

        This should be treated as a soft constraint that's helpful for things
        like animations, or when we want position and orientation updates to
        happen synchronously.

        Returns:
            Context manager.
        """
        # If called multiple times in the same thread, we ignore inner calls.
        self.get_message_buffer().atomic_start()
        yield
        self.get_message_buffer().atomic_end()


class WebsockClientConnection(WebsockMessageHandler):
    """Handle for sending messages to and listening to messages from a single
    connected client."""

    def __init__(
        self,
        client_id: int,
        client_state: _ClientHandleState,
    ) -> None:
        self.client_id = client_id
        self._state = client_state
        super().__init__()

    @override
    def get_message_buffer(self) -> AsyncMessageBuffer:
        """Get client message buffer."""
        return self._state.message_buffer


class WebsockServer(WebsockMessageHandler):
    """Websocket server abstraction. Communicates asynchronously with client
    applications.

    By default, all messages are broadcasted to all connected clients.

    To send messages to an individual client, we can use `on_client_connect()` to
    retrieve client handles.

    Args:
        host: Host to bind server to.
        port: Port to bind server to.
        message_class: Base class for message types. Subclasses of the message type
            should have unique names. This argument is optional currently, but will be
            required in the future.
        http_server_root: Path to root for HTTP server.
        verbose: Toggle for print messages.
        client_api_version: Flag for backwards compatibility. 0 sends individual
            messages. 1 sends windowed messages.
    """

    def __init__(
        self,
        host: str,
        port: int,
        message_class: type[Message] = Message,
        http_server_root: Path | None = None,
        verbose: bool = True,
        client_api_version: Literal[0, 1] = 0,
    ):
        super().__init__()

        # Track connected clients.
        self._client_connect_cb: list[
            Callable[[WebsockClientConnection], None | Coroutine]
        ] = []
        self._client_disconnect_cb: list[
            Callable[[WebsockClientConnection], None | Coroutine]
        ] = []

        self._host = host
        self._port = port
        self._message_class = message_class
        self._http_server_root = http_server_root
        self._verbose = verbose
        self._client_api_version: Literal[0, 1] = client_api_version
        self._background_event_loop: asyncio.AbstractEventLoop | None = None

        self._stop_event: asyncio.Event | None = None

        self._client_state_from_id: dict[int, _ClientHandleState] = {}
        self._server_thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the server."""

        # Start server thread.
        ready_sem = threading.Semaphore(value=1)
        ready_sem.acquire()
        self._server_thread = threading.Thread(
            target=lambda: self._background_worker(ready_sem),
            daemon=True,
        )
        self._server_thread.start()

        # Wait for ready signal from the background thread.
        ready_sem.acquire()

        # Exit the server thread when the main process exits. This would happen
        # automatically, but is nice to do explicitly to avoid some nanobind
        # reference leak warnings:
        # https://github.com/viser-project/viser/issues/518
        atexit.register(self.stop)

        # Broadcast buffer should be populated by the background worker.
        assert isinstance(self._broadcast_buffer, AsyncMessageBuffer)

    def stop(self) -> None:
        """Stop the server."""
        assert self._background_event_loop is not None
        assert self._stop_event is not None
        assert self._server_thread is not None

        # Unregister the atexit handler to prevent double-stop.
        atexit.unregister(self.stop)

        # Signal the background thread to stop.
        self._background_event_loop.call_soon_threadsafe(self._stop_event.set)

        # Clean up the message buffers. This isn't really necessary, but helps
        # avoid "task destroyed" errors.
        self._broadcast_buffer.set_done()
        for client in self._client_state_from_id.values():
            client.message_buffer.set_done()

        # Wait for the server thread to finish.
        self._server_thread.join(timeout=0.1)

    def on_client_connect(
        self, cb: Callable[[WebsockClientConnection], None | Coroutine]
    ) -> None:
        """Attach a callback to run for newly connected clients."""
        self._client_connect_cb.append(cb)

    def on_client_disconnect(
        self, cb: Callable[[WebsockClientConnection], None | Coroutine]
    ) -> None:
        """Attach a callback to run when clients disconnect."""
        self._client_disconnect_cb.append(cb)

    @override
    def get_message_buffer(self) -> AsyncMessageBuffer:
        """Get the broadcast queue. Message will be sent to all clients."""
        return self._broadcast_buffer

    def flush(self) -> None:
        """Flush the outgoing message buffer for broadcasted messages. Any buffered
        messages will immediately be sent. (by default they are windowed)"""
        self._broadcast_buffer.flush()

    def flush_client(self, client_id: int) -> None:
        """Flush the outgoing message buffer for a particular client. Any buffered
        messages will immediately be sent. (by default they are windowed)"""
        # No-op if client is disconnected.
        client_state = self._client_state_from_id.get(client_id)
        if client_state is not None:
            client_state.message_buffer.flush()

    def _background_worker(self, ready_sem: threading.Semaphore) -> None:
        import rich

        host = self._host
        port = self._port
        message_class = self._message_class
        http_server_root = self._http_server_root

        # Need to make a new event loop for notebook compatbility.
        event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(event_loop)
        self._stop_event = asyncio.Event()
        self._background_event_loop = event_loop
        self._broadcast_buffer = AsyncMessageBuffer(
            event_loop, persistent_messages=True
        )

        count_lock = asyncio.Lock()
        connection_count = 0
        total_connections = 0

        async def ws_handler(
            connection: websockets.asyncio.server.ServerConnection,
        ) -> None:
            """Handler for websocket connections."""
            async with count_lock:
                nonlocal connection_count
                client_id = ClientId(connection_count)
                connection_count += 1

                nonlocal total_connections
                total_connections += 1

            # Version check to make sure Viser server/client match.
            if self._client_api_version == 1:
                import viser

                # Extract client version from the selected subprotocol.
                client_version_str = "unknown"
                if connection.subprotocol is not None:
                    if connection.subprotocol.startswith("viser-v"):
                        client_version_str = connection.subprotocol[7:].strip()

                if client_version_str != viser.__version__:
                    rich.print(
                        f"[bold red](viser)[/bold red] Version mismatch - connection rejected. "
                        f"Client: '{client_version_str}', Server: '{viser.__version__}'"
                    )
                    await connection.close(
                        1002,
                        f"Version mismatch. Client: {client_version_str}, Server: {viser.__version__}",
                    )
                    return  # Exit handler to prevent further processing.

            client_state = _ClientHandleState(
                AsyncMessageBuffer(event_loop, persistent_messages=False),
                event_loop,
            )
            client_connection = WebsockClientConnection(client_id, client_state)
            self._client_state_from_id[client_id] = client_state

            def handle_incoming(message: Message) -> None:
                event_loop.create_task(
                    self._handle_incoming_message(client_id, message)
                )
                event_loop.create_task(
                    client_connection._handle_incoming_message(client_id, message)
                )

            # New connection callbacks.
            for cb in self._client_connect_cb:
                if asyncio.iscoroutinefunction(cb):
                    await cb(client_connection)
                else:
                    cb(client_connection)

            if self._verbose:
                rich.print(
                    f"[bold](viser)[/bold] Connection opened ({client_id},"
                    f" {total_connections} total),"
                    f" {len(self._broadcast_buffer.message_from_id)} persistent"
                    " messages"
                )

            try:
                # For each client: infinite loop over producers (which send messages)
                # and consumers (which receive messages).
                await asyncio.gather(
                    _message_producer(
                        connection,
                        client_state.message_buffer,
                        client_id,
                        self._client_api_version,
                    ),
                    _message_producer(
                        connection,
                        self._broadcast_buffer,
                        client_id,
                        self._client_api_version,
                    ),
                    _message_consumer(connection, handle_incoming, message_class),
                )
            except (
                websockets.exceptions.ConnectionClosedOK,
                websockets.exceptions.ConnectionClosedError,
            ):
                # We use a sentinel value to signal that the client producer thread
                # should exit.
                #
                # This is partially cosmetic: it allows us to safely finish pending
                # queue get() tasks, which suppresses a "Task was destroyed but it is
                # pending" error.
                client_state.message_buffer.set_done()

                # Disconnection callbacks.
                for cb in self._client_disconnect_cb:
                    if asyncio.iscoroutinefunction(cb):
                        await cb(client_connection)
                    else:
                        cb(client_connection)

                # Cleanup.
                self._client_state_from_id.pop(client_id)
                total_connections -= 1
                if self._verbose:
                    rich.print(
                        f"[bold](viser)[/bold] Connection closed ({client_id},"
                        f" {total_connections} total)"
                    )

        # Host client on the same port as the websocket.
        file_cache: dict[Path, bytes] = {}
        file_cache_gzipped: dict[Path, bytes] = {}

        filter_added = False

        def viser_http_server(
            connection: ServerConnection,
            request: Request,
        ) -> Response | None:
            # <Hack>
            # Suppress errors for:
            # - https://github.com/python-websockets/websockets/issues/1513
            #    - (fixed in newer versions of websockets)
            # - https://github.com/python-websockets/websockets/issues/1606
            nonlocal filter_added
            if not filter_added:

                class NoHttpErrors(logging.Filter):
                    def filter(self, record):
                        return record.getMessage() not in (
                            "opening handshake failed",
                            "connection rejected (200 OK)",
                        )

                connection.logger.logger.addFilter(NoHttpErrors())  # type: ignore
                filter_added = True
            # </Hack>

            # Ignore websocket packets.
            if request.headers.get("Upgrade") == "websocket":
                return None

            # Strip out search params, get relative path.
            path = request.path
            path = path.partition("?")[0]
            relpath = str(Path(path).relative_to("/"))
            if relpath == ".":
                relpath = "index.html"
            assert http_server_root is not None

            source_path = http_server_root / relpath
            if not source_path.exists():
                return Response(http.HTTPStatus.NOT_FOUND, "NOT FOUND", Headers())

            use_gzip = "gzip" in request.headers.get("Accept-Encoding", "")

            # First, try some known MIME types. Using guess_type() can cause
            # problems for Javascript on some Windows machines.
            #
            # Some references:
            #     https://github.com/viser-project/viser/issues/256#issuecomment-2369684252
            #     https://bugs.python.org/issue43975
            #     https://github.com/golang/go/issues/32350#issuecomment-525111557
            #
            # We're assuming UTF-8, this is mostly reasonable but might want to revisit.
            mime_type = {
                ".css": "text/css; charset=utf-8",
                ".gif": "image/gif",
                ".htm": "text/html; charset=utf-8",
                ".html": "text/html; charset=utf-8",
                ".jpg": "image/jpeg",
                ".js": "application/javascript",
                ".wasm": "application/wasm",
                ".pdf": "application/pdf",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".xml": "text/xml; charset=utf-8",
            }.get(Path(path).suffix.lower(), None)
            if mime_type is None:
                mime_type = mimetypes.guess_type(relpath)[0]
            if mime_type is None:
                mime_type = "application/octet-stream"

            if source_path not in file_cache:
                file_cache[source_path] = source_path.read_bytes()
            if use_gzip:
                if source_path not in file_cache_gzipped:
                    file_cache_gzipped[source_path] = gzip.compress(
                        file_cache[source_path]
                    )
                response_payload = file_cache_gzipped[source_path]
            else:
                response_payload = file_cache[source_path]

            response_headers = {
                "Content-Type": mime_type,
                "Content-Length": str(len(response_payload)),
                "Content-Encoding": "gzip" if use_gzip else "identity",
            }

            # Try to read + send over file.
            return Response(
                http.HTTPStatus.OK,
                "OK",
                websockets.datastructures.Headers(**response_headers),
                response_payload,
            )
            # return (http.HTTPStatus.OK, response_headers, response_payload)

        async def start_server() -> None:
            port_attempt = port
            for _ in range(1000):
                try:
                    async with websockets.asyncio.server.serve(
                        ws_handler,
                        host,
                        port_attempt,
                        # Increase ws message size limit to 50MB to allow large messages.
                        # (e.g. via client.get_render()).
                        max_size=50 * 1024 * 1024,
                        # Compression can be too slow for our use cases.
                        compression=None,
                        process_request=(
                            viser_http_server if http_server_root is not None else None
                        ),
                        # Accept connections with version-based protocol and extract version in handler.
                        subprotocols=None,
                        select_subprotocol=lambda _, subprotocols: next(
                            (
                                Subprotocol(p)
                                for p in subprotocols
                                if p.startswith("viser-v")
                            ),
                            None,
                        ),
                    ) as serve_future:
                        assert serve_future.server is not None
                        self._port = port_attempt
                        ready_sem.release()
                        assert self._stop_event is not None
                        await self._stop_event.wait()
                        return
                except OSError:  # Port not available.
                    port_attempt += 1
                    continue

        event_loop.run_until_complete(start_server())
        rich.print("[bold](viser)[/bold] Server stopped")

        # Clean up the event loop to prevent reference leaks
        event_loop.stop()
        event_loop.close()


async def _message_producer(
    websocket: ServerConnection,
    buffer: AsyncMessageBuffer,
    client_id: int,
    client_api_version: Literal[0, 1],
) -> None:
    """Infinite loop to broadcast windows of messages from a buffer."""
    window_generator = buffer.window_generator(client_id)
    zstd = zstandard.ZstdCompressor(level=1)
    while not buffer.done:
        try:
            outgoing = await window_generator.__anext__()
        except StopAsyncIteration:
            break

        if client_api_version == 1:
            # Encode the message structure.
            inner = msgspec.msgpack.encode(
                {
                    "messages": tuple(
                        message.as_serializable_dict() for message in outgoing
                    ),
                    "timestampSec": time.perf_counter(),
                }
            )
            # Compress and prepend size header (8 bytes, little-endian uint64).
            compressed = zstd.compress(inner)
            serialized = len(inner).to_bytes(8, "little") + compressed
            await websocket.send(serialized)
        elif client_api_version == 0:
            for msg in outgoing:
                serialized = msgspec.msgpack.encode(msg.as_serializable_dict())
                assert isinstance(serialized, bytes)
                await websocket.send(serialized)
        else:
            assert_never(client_api_version)


async def _message_consumer(
    websocket: ServerConnection,
    handle_message: Callable[[Message], None],
    message_class: type[Message],
) -> None:
    """Infinite loop waiting for and then handling incoming messages."""
    while True:
        raw = await websocket.recv()
        assert isinstance(raw, bytes)
        message = message_class.deserialize(raw)
        handle_message(message)


def error_print_wrapper(inner: Callable[[], Any]) -> Callable[[], None]:
    """Wrap a Callable to print error messages when they happen.

    This can be helpful for jobs submitted to ThreadPoolExecutor instances, which, by
    default, will suppress error messages until returned futures are awaited.
    """

    def wrapped() -> None:
        try:
            inner()
        except Exception as e:
            import traceback as tb

            tb.print_exception(type(e), e, e.__traceback__, limit=100)

    return wrapped
