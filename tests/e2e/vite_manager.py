"""Restartable Vite dev-server manager for the dock playground e2e suite.

Why this exists: the playground tests share one long-lived Vite dev server per
xdist worker (see ``vite_server`` in conftest). Twice on CI (2026-07-27 run
30298026392 attempt 1, 2026-07-29 run 30418320431 -- both py3.9 shard 2) that
server entered a permanently wedged state mid-run: ``page.goto`` kept
succeeding (the HTML was served) but the module graph never finished loading,
so the dock never mounted and every subsequent playground page-open on that
worker timed out for the remaining ~30 minutes -- 17 straight failures. Both
incidents left orphaned esbuild child processes behind, pointing at Vite's
dependency optimizer hanging. Waiting longer cannot rescue that state (the
60s ``OPEN_READY_TIMEOUT_MS`` already rides out transient runner stalls), so
the recovery is a server restart: ``open_playground`` calls
:func:`restart_for_port` after two consecutive page-boot failures and retries
once against the fresh server.

The manager also fixes two quality-of-life issues with the old inline fixture:

* The server is spawned in its own process group and torn down with
  ``killpg``, so esbuild children die with it instead of leaking as orphans
  (``proc.terminate()`` only killed the ``npx`` wrapper).
* stdout/stderr go to a log file instead of ``DEVNULL``; on restart the tail
  is printed so a wedge is diagnosable from the test output.
"""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, Optional

DOCK_CLIENT_DIR = Path(__file__).resolve().parents[2] / "src" / "viser" / "client"

# Wrap the client's vite config with HMR disabled: the playground tests drive
# deterministic DOM interactions, and an HMR websocket reconnect mid-test can
# reload the page under the pointer. Also disable file watching entirely (the
# tests never edit source mid-run) -- vite otherwise recursively watches the
# whole client dir, including the huge `.nodeenv`/`node_modules` trees, which
# can exhaust the OS inotify watcher limit and crash the dev server on startup
# (ENOSPC). usePolling:false + ignored globs keeps the server lightweight.
_DOCK_HMR_OFF_CONFIG = """\
import base from "./vite.config.mts";
export default async (env) => {
  const resolved = typeof base === "function" ? await base(env) : base;
  return {
    ...resolved,
    server: {
      ...(resolved.server || {}),
      hmr: false,
      watch: { ignored: ["**/.nodeenv/**", "**/node_modules/**"] },
    },
  };
};
"""

# Managers by port, so dock_helpers (which only receives the port from the
# fixture) can find the right server to restart.
_managers: Dict[int, "ViteServerManager"] = {}


def _group_alive(pgid: int) -> bool:
    """Whether any process in the group still exists (signal 0 probe)."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False


def _wait_for_http(port: int, path: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://localhost:{port}{path}"
    last_err: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError) as err:
            last_err = err
            time.sleep(0.1)
    raise RuntimeError(f"Vite dev server not ready at {url}: {last_err}")


class ViteServerManager:
    """Owns one Vite dev server process (plus its config + log files)."""

    def __init__(self, port: int) -> None:
        self.port = port
        self._proc: Optional[subprocess.Popen] = None
        cfg_fd, cfg_name = tempfile.mkstemp(
            prefix="vite.e2e.hmroff.", suffix=".mts", dir=str(DOCK_CLIENT_DIR)
        )
        with os.fdopen(cfg_fd, "w") as f:
            f.write(_DOCK_HMR_OFF_CONFIG)
        self._cfg_path = Path(cfg_name)
        log_fd, log_name = tempfile.mkstemp(prefix="vite.e2e.", suffix=".log")
        os.close(log_fd)
        self.log_path = Path(log_name)

    def start(self) -> None:
        assert self._proc is None, "server already running"
        # Append so restarts keep the pre-wedge history in one file.
        log_file = open(self.log_path, "ab")
        try:
            # start_new_session: put npx AND its node/esbuild descendants in a
            # fresh process group so stop() can kill the whole tree.
            self._proc = subprocess.Popen(
                [
                    "npx",
                    "vite",
                    "--config",
                    str(self._cfg_path),
                    "--port",
                    str(self.port),
                    "--strictPort",
                ],
                cwd=str(DOCK_CLIENT_DIR),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log_file.close()
        _wait_for_http(self.port, "/dock_test.html")
        _managers[self.port] = self

    def stop(self) -> None:
        proc = self._proc
        if proc is None:
            return
        self._proc = None
        # Process groups are POSIX-only; on Windows (no os.getpgid/killpg,
        # start_new_session silently ignored) fall back to the direct-child
        # terminate below, matching the pre-manager fixture's behavior for
        # devs running the e2e suite locally. CI runs Linux.
        try:
            pgid = os.getpgid(proc.pid) if hasattr(os, "getpgid") else None
        except ProcessLookupError:
            pgid = None
        if pgid is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
            return
        # Signal the WHOLE group and wait for the whole group: `npx` exits on
        # SIGTERM quickly, but the vite node process (and its esbuild child)
        # can outlive it -- waiting only on the direct child is exactly what
        # used to leak orphaned esbuild processes on CI.
        self._signal_group_and_wait(pgid, proc, signal.SIGTERM, timeout=10.0)
        if _group_alive(pgid):
            self._signal_group_and_wait(pgid, proc, signal.SIGKILL, timeout=10.0)

    @staticmethod
    def _signal_group_and_wait(
        pgid: int, proc: subprocess.Popen, sig: signal.Signals, timeout: float
    ) -> None:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                proc.wait(timeout=0.1)  # reap the direct child when it exits
            except (subprocess.TimeoutExpired, ProcessLookupError):
                pass
            if not _group_alive(pgid):
                return
            time.sleep(0.1)

    def restart(self) -> None:
        self.stop()
        # strictPort + SO_REUSEADDR in node's listener make an immediate
        # rebind on the same port safe; the port must stay stable because
        # every test in the worker already holds it via the session fixture.
        self.start()

    def close(self) -> None:
        """Final teardown: stop the server and remove temp files."""
        self.stop()
        _managers.pop(self.port, None)
        self._cfg_path.unlink(missing_ok=True)
        self.log_path.unlink(missing_ok=True)

    def log_tail(self, max_bytes: int = 4000) -> str:
        try:
            data = self.log_path.read_bytes()
        except OSError:
            return "<no vite log>"
        return data[-max_bytes:].decode("utf-8", errors="replace")


def restart_for_port(port: int) -> bool:
    """Restart the managed Vite server on ``port``, if there is one.

    Returns True if a managed server was found and restarted. Prints the
    server's recent output first -- if the dev server wedged (the reason
    we restart), that log is the only diagnostic trail.
    """
    manager = _managers.get(port)
    if manager is None:
        return False
    print(
        f"[dock e2e] page boot failed twice; restarting the Vite dev server "
        f"on port {port}. Recent server output:\n{manager.log_tail()}",
        flush=True,
    )
    manager.restart()
    return True
