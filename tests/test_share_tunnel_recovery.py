"""Regression tests for share-tunnel failure recovery.

A tunnel that fails to connect (share backend unreachable) sets its status to
"failed" without ever signaling disconnect, so nothing clears the server's
tunnel slot. ``request_share_url`` must treat such a dead tunnel as absent --
close it, clear the slot, and create a fresh one -- instead of returning None
forever.
"""

from __future__ import annotations

import asyncio
import threading
import time
from unittest.mock import patch

import viser
import viser._client_autobuild
import viser._tunnel
import viser._viser


class _FakeTunnel:
    """Stand-in for ViserTunnel: no network, no subprocess. Each instance pops
    its behavior ("fail" or "connect") from the shared queue."""

    behaviors: list[str] = []
    instances: list["_FakeTunnel"] = []

    def __init__(self, share_domain: str, local_port: int) -> None:
        del share_domain, local_port
        self.behavior = _FakeTunnel.behaviors.pop(0)
        self.closed = False
        self._status = "ready"
        self._url: str | None = None
        _FakeTunnel.instances.append(self)

    def on_disconnect(self, callback) -> None:
        self._disconnect_cb = callback

    def on_connect(self, callback) -> None:
        # The real tunnel resolves asynchronously; resolving synchronously here
        # keeps the test deterministic. request_share_url's wait loop handles
        # both orders.
        if self.behavior == "fail":
            self._status = "failed"
        else:
            self._status = "connected"
            self._url = "https://fake.share.url"
            callback(8)

    def get_status(self) -> str:
        return self._status

    def get_url(self) -> str | None:
        return self._url

    def close(self) -> None:
        self.closed = True
        self._status = "closed"


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_request_share_url_recovers_after_failure() -> None:
    _FakeTunnel.behaviors = ["fail", "connect"]
    _FakeTunnel.instances = []

    server = viser.ViserServer(port=0, verbose=False)
    try:
        with patch.object(viser._viser, "ViserTunnel", _FakeTunnel):
            # First request fails (documented: returns None, doesn't hang).
            assert server.request_share_url(verbose=False) is None

            # The failed tunnel must not poison the slot: the next request
            # closes it and connects fresh.
            assert server.request_share_url(verbose=False) == "https://fake.share.url"
            assert len(_FakeTunnel.instances) == 2
            assert _FakeTunnel.instances[0].closed
            assert server._share_tunnel is _FakeTunnel.instances[1]
    finally:
        server.stop()


def _fake_failing_connect_job(
    connect_event,
    disconnect_event,
    close_event,
    share_domain,
    local_port,
    shared_state,
    event_loop_target,
) -> None:
    """Mimic _connect_job's failure path: publish the loop, exit with status
    "failed" and the loop closed -- WITHOUT ever setting connect_event."""
    del connect_event, disconnect_event, close_event, share_domain, local_port
    loop = asyncio.new_event_loop()
    if event_loop_target is not None:
        event_loop_target._event_loop = loop
    shared_state["status"] = "failed"
    loop.close()


def test_close_of_failed_tunnel_releases_watcher_thread() -> None:
    """close() must release the on_connect watcher (wait_job) of a tunnel
    that never connected. Pre-fix, wait_job blocked on _connect_event forever;
    in multiprocess mode that pinned the mp.Manager proxies, leaking the
    SyncManager child process on every failed-tunnel replacement (one per
    request_share_url retry while the share backend is unreachable)."""
    callback_ran = threading.Event()
    # Single-line double context manager (not the parenthesized 3.10+ form):
    # this suite runs on 3.8+.
    with patch.object(
        viser._tunnel, "_is_multiprocess_ok", lambda: False
    ), patch.object(viser._tunnel, "_connect_job", _fake_failing_connect_job):
        tunnel = viser._tunnel.ViserTunnel("fake.example", 0)
        threads_before = set(threading.enumerate())
        tunnel.on_connect(lambda _max: callback_ran.set())
        spawned = [t for t in threading.enumerate() if t not in threads_before]
        assert spawned, "on_connect should spawn the watcher + job threads"

        deadline = time.monotonic() + 5
        while tunnel.get_status() != "failed" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert tunnel.get_status() == "failed"

        tunnel.close()

        for thread in spawned:
            thread.join(timeout=5)
        assert not any(t.is_alive() for t in spawned), (
            "close() left the never-connected tunnel's watcher thread parked "
            "on _connect_event -- in multiprocess mode this pins the manager "
            "and leaks its child process on every failed-tunnel replacement"
        )
        # Releasing the watcher must not fire the connect callback.
        assert not callback_ran.is_set()
