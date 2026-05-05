from __future__ import annotations

import asyncio
import multiprocessing as mp
import ssl
import threading
from functools import lru_cache
from multiprocessing.managers import DictProxy
from pathlib import Path
from typing import Callable, Literal

import rich


@lru_cache
def _is_multiprocess_ok() -> bool:
    import __main__

    if hasattr(__main__, "__file__"):
        src = Path(__main__.__file__).read_text()
        return "\nif __name__" in src and "__main__" in src
    else:
        return True


class ViserTunnel:
    """Tunneling utility for internal use.

    This is chaotic academic software, and we'd appreciate if you refrained
    from red-teaming it. :)
    """

    def __init__(self, share_domain: str, local_port: int) -> None:
        self._share_domain = share_domain
        self._local_port = local_port

        # Heuristic for `if __name__ == "__main__"` check.
        self._multiprocess_ok = _is_multiprocess_ok()
        if not self._multiprocess_ok:
            import rich

            rich.print(
                "[bold](viser)[/bold] No `if __name__ == '__main__'` check found; creating share URL tunnel in a thread"
            )

        self._process: mp.Process | None = None
        self._thread: threading.Thread | None = None
        self._event_loop: asyncio.AbstractEventLoop | None = None

        self._shared_state: DictProxy | dict
        if self._multiprocess_ok:
            manager = mp.Manager()
            self._connect_event = manager.Event()
            self._disconnect_event = manager.Event()
            self._close_event = None  # Only used for threads. For processes, we just kill the tunnel process.
            self._shared_state = manager.dict()
        else:
            self._connect_event = threading.Event()
            self._disconnect_event = threading.Event()
            self._close_event = asyncio.Event()
            self._shared_state = {}

        self._shared_state["status"] = "ready"
        self._shared_state["url"] = None

    def on_disconnect(self, callback: Callable[[], None]) -> None:
        def call_on_disconnect() -> None:
            try:
                self._disconnect_event.wait()
            except EOFError:
                return
            callback()

        threading.Thread(target=call_on_disconnect, daemon=True).start()

    def on_connect(self, callback: Callable[[int], None]) -> None:
        """Establish the tunnel connection.

        Returns URL if tunnel succeeds, otherwise None."""
        assert self._process is None

        self._shared_state["status"] = "connecting"

        def wait_job() -> None:
            try:
                self._connect_event.wait()
            except EOFError:
                return
            callback(self._shared_state["max_conn_count"])

        threading.Thread(target=wait_job, daemon=True).start()

        # Note that this will generally require an __name__ == "__main__" check
        # on the origin script.
        if self._multiprocess_ok:
            self._process = mp.Process(
                target=_connect_job,
                daemon=True,
                args=(
                    self._connect_event,
                    self._disconnect_event,
                    self._close_event,
                    self._share_domain,
                    self._local_port,
                    self._shared_state,
                    None,
                ),
            )
            self._process.start()
        else:
            self._thread = threading.Thread(
                target=_connect_job,
                daemon=True,
                args=(
                    self._connect_event,
                    self._disconnect_event,
                    self._close_event,
                    self._share_domain,
                    self._local_port,
                    self._shared_state,
                    self,
                ),
            )
            self._thread.start()

    def get_url(self) -> str | None:
        """Get tunnel URL. None if not connected (or connection failed)."""
        return self._shared_state["url"]

    def get_status(
        self,
    ) -> Literal["ready", "connecting", "failed", "connected", "closed"]:
        return self._shared_state["status"]

    def close(self) -> None:
        """Close the tunnel."""
        if self._process is not None:
            self._process.kill()
            self._process.join()
            self._disconnect_event.set()
        if self._thread is not None:
            assert self._event_loop is not None

            @self._event_loop.call_soon_threadsafe
            def _() -> None:
                assert self._close_event is not None
                self._close_event.set()

            self._thread.join()
            self._disconnect_event.set()


def _connect_job(
    connect_event: threading.Event,
    disconnect_event: threading.Event,
    close_event: asyncio.Event | None,  # Only for threads.
    share_domain: str,
    local_port: int,
    shared_state: DictProxy | dict,
    event_loop_target: ViserTunnel | None,  # Only for threads.
) -> None:
    event_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(event_loop)
    if event_loop_target is not None:
        event_loop_target._event_loop = event_loop
    if close_event is None:
        close_event = asyncio.Event()

    try:
        event_loop.run_until_complete(
            _make_tunnel(
                connect_event,
                disconnect_event,
                close_event,
                share_domain,
                local_port,
                shared_state,
            )
        )
        event_loop.close()
    except KeyboardInterrupt:
        event_loop.call_soon_threadsafe(close_event.set)
        tasks = asyncio.all_tasks(event_loop)
        event_loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
        event_loop.close()


async def _make_tunnel(
    connect_event: threading.Event,
    disconnect_event: threading.Event,
    close_event: asyncio.Event | None,
    share_domain: str,
    local_port: int,
    shared_state: DictProxy | dict,
) -> None:
    import requests
    import requests.exceptions

    try:
        response = requests.request(
            "GET",
            url=f"https://{share_domain}/?request_forward",
            headers={"Content-Type": "application/json"},
        )
        if response.status_code != 200:
            shared_state["status"] = "failed"
            return
    except requests.exceptions.ConnectionError:
        shared_state["status"] = "failed"
        return
    except Exception as e:
        shared_state["status"] = "failed"
        raise e

    res = response.json()

    # Require TLS for secure tunnel connections.
    tls_port = res.get("tls_port")
    if tls_port is None:
        shared_state["status"] = "failed"
        rich.print(
            "[bold](viser)[/bold] Share server does not support encrypted connections. "
            "Please update the server or use an older viser version."
        )
        return

    shared_state["url"] = res["url"]
    shared_state["max_conn_count"] = res["max_conn_count"]
    shared_state["status"] = "connected"
    connect_event.set()

    await asyncio.gather(
        *[
            asyncio.create_task(
                _simple_proxy(
                    "127.0.0.1",
                    local_port,
                    share_domain,
                    tls_port,
                    close_event if close_event is not None else asyncio.Event(),
                )
            )
            for _ in range(res["max_conn_count"])
        ]
    )

    shared_state["url"] = None
    shared_state["status"] = "closed"
    disconnect_event.set()


async def _simple_proxy(
    local_host: str,
    local_port: int,
    remote_host: str,
    remote_port: int,
    close_event: asyncio.Event,
) -> None:
    """Establish an encrypted TLS connection to the tunnel server."""
    ssl_context = ssl.create_default_context()

    async def close_writer(writer: asyncio.StreamWriter) -> None:
        """Utility for closing a writer and waiting until done, while suppressing errors
        from broken connections."""
        try:
            if not writer.is_closing():
                writer.close()
            await writer.wait_closed()
        except ConnectionError:
            pass

    async def relay(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        """Simple data passthrough from one stream to another."""
        try:
            while True:
                data = await r.read(4096)
                if len(data) == 0:
                    # Done!
                    break
                w.write(data)
                await w.drain()
        except Exception:
            pass
        finally:
            await close_writer(w)

    while True:
        local_w = None
        remote_w = None
        try:
            local_r, local_w = await asyncio.open_connection(local_host, local_port)
            remote_r, remote_w = await asyncio.open_connection(
                remote_host, remote_port, ssl=ssl_context
            )
            await asyncio.wait(
                [
                    asyncio.gather(
                        asyncio.create_task(relay(local_r, remote_w)),
                        asyncio.create_task(relay(remote_r, local_w)),
                    ),
                    asyncio.create_task(close_event.wait()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
        except Exception:
            pass
        finally:
            # Be extra sure that connections are closed.
            if local_w is not None:
                await close_writer(local_w)
            if remote_w is not None:
                await close_writer(remote_w)

        if close_event.is_set():
            break

        # Throttle connection attempts.
        await asyncio.sleep(0.1)
