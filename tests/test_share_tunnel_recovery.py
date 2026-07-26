"""Regression tests for share-tunnel failure recovery.

A tunnel that fails to connect (share backend unreachable) sets its status to
"failed" without ever signaling disconnect, so nothing clears the server's
tunnel slot. ``request_share_url`` must treat such a dead tunnel as absent --
close it, clear the slot, and create a fresh one -- instead of returning None
forever.
"""

from __future__ import annotations

from unittest.mock import patch

import viser
import viser._client_autobuild
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
