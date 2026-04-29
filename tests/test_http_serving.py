"""Smoke tests for the HTTP request handler in the websocket server.

Exercises the request path that serves the client bundle and performs path
traversal validation. Regression guard for cases where Python version
incompatibilities (e.g. methods that only exist on newer Pythons) would raise
inside ``process_request`` and surface as a 500 with the websockets library's
default failure message."""

import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Tuple
from unittest.mock import patch

import viser
import viser._client_autobuild
from viser import infra


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


def _fetch(url: str) -> Tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def test_http_serves_files_through_symlink(tmp_path: Path):
    # Regression test for Bazel/uv runfile layouts where the served root and
    # the files inside it pass through different symlinks. With the old
    # Path.resolve() based check, the resolved file path lands outside the
    # resolved root and every static asset returns 404.
    served_root = tmp_path / "served"
    served_root.mkdir()
    real_target_dir = tmp_path / "elsewhere"
    real_target_dir.mkdir()

    real_index = real_target_dir / "index.html"
    real_index.write_bytes(b"<html>hello from symlinked file</html>")
    (served_root / "index.html").symlink_to(real_index)

    real_asset = real_target_dir / "asset.js"
    real_asset.write_bytes(b"console.log('via symlink');")
    (served_root / "asset.js").symlink_to(real_asset)

    server = infra.WebsockServer(
        host="127.0.0.1",
        port=18900,
        http_server_root=served_root,
        verbose=False,
    )
    server.start()
    try:
        time.sleep(0.1)
        port = server._port

        status, body = _fetch(f"http://127.0.0.1:{port}/")
        assert status == 200
        assert b"hello from symlinked file" in body

        status, body = _fetch(f"http://127.0.0.1:{port}/asset.js")
        assert status == 200
        assert b"console.log('via symlink');" in body

        # Traversal still rejected even though we no longer use resolve().
        status, _ = _fetch(f"http://127.0.0.1:{port}/../../etc/passwd")
        assert status == 404

        # Missing file still 404s.
        status, _ = _fetch(f"http://127.0.0.1:{port}/does-not-exist.js")
        assert status == 404
    finally:
        server.stop()
