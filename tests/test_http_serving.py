"""Smoke tests for the HTTP request handler in the websocket server.

Exercises the request path that serves the client bundle and performs path
traversal validation. Regression guard for cases where Python version
incompatibilities (e.g. methods that only exist on newer Pythons) would raise
inside ``process_request`` and surface as a 500 with the websockets library's
default failure message."""

import time
import urllib.error
import urllib.request
from unittest.mock import patch

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_http_root_and_traversal():
    server = viser.ViserServer()
    port = server.get_port()
    try:
        # Give the websockets server a moment to accept connections.
        time.sleep(0.1)

        # A normal asset fetch must reach the static file lookup without
        # raising. We don't require 200 here (the client bundle may not be
        # present in every test environment), but any exception in
        # process_request turns into a 500 from the websockets library.
        try:
            status = urllib.request.urlopen(
                f"http://localhost:{port}/", timeout=5
            ).status
        except urllib.error.HTTPError as e:
            status = e.code
        assert status != 500, "process_request raised for GET /"

        # Path traversal must be rejected as 404, not leak out of the client
        # root.
        try:
            status = urllib.request.urlopen(
                f"http://localhost:{port}/../../../etc/passwd", timeout=5
            ).status
        except urllib.error.HTTPError as e:
            status = e.code
        assert status == 404
    finally:
        server.stop()
