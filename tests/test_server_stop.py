import socket
import subprocess
import sys
import time
from unittest.mock import patch

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_server_port_is_freed():
    server = viser.ViserServer()
    original_port = server.get_port()

    # Assert that the port is not free.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(("localhost", original_port))
    assert result == 0
    sock.close()
    server.stop()

    time.sleep(0.05)

    # Assert that the port is now free.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(("localhost", original_port))
    assert result != 0


_GIL_CONTENTION_EXIT_SCRIPT = """
import atexit, threading, time
import viser, viser._client_autobuild

viser._client_autobuild.ensure_client_is_built = lambda: None


# Registered BEFORE the server is constructed, so it runs AFTER viser's own
# atexit cleanup (atexit is LIFO): observes whether the loop thread actually
# exited within the cleanup's join, with no extra waiting of its own.
def check() -> None:
    thread = server._websock_server._server_thread
    print("SERVER_THREAD_ALIVE:", thread.is_alive(), flush=True)


atexit.register(check)

server = viser.ViserServer(port=0, verbose=False)


def burn():
    while True:
        sum(i * i for i in range(10000))


for _ in range(8):
    threading.Thread(target=burn, daemon=True).start()
time.sleep(0.3)
# Exit WITHOUT calling stop(): cleanup runs through atexit. The registered
# ViserServer.stop must wait for the loop thread to wind down even though the
# burner threads are contending the GIL.
"""


def test_atexit_stop_outwaits_gil_contention():
    """Regression test for https://github.com/viser-project/viser/issues/744.

    A process that exits without calling stop() relies on the atexit hook. If
    the atexit-side join gives up while the loop thread is still winding down
    (which CPU-loaded processes routinely hit with a short timeout), the
    daemonic thread is frozen mid-teardown at interpreter shutdown, and its
    frames pin server state and user callbacks -- binding frameworks like
    nanobind report those as leaked objects. The property that keeps the leak
    away is the loop thread being DEAD by the time viser's atexit cleanup
    returns.
    """
    result = subprocess.run(
        [sys.executable, "-c", _GIL_CONTENTION_EXIT_SCRIPT],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "SERVER_THREAD_ALIVE: False" in result.stdout, (
        "The background loop thread was still alive after viser's atexit "
        f"cleanup.\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )


_INIT_FAILURE_EXIT_SCRIPT = """
import viser, viser._client_autobuild, viser._viser

viser._client_autobuild.ensure_client_is_built = lambda: None


class Boom(Exception):
    pass


def _fail(*args, **kwargs):
    raise Boom()


# SceneApi is constructed AFTER ViserServer.__init__ registers stop() with
# atexit, so this failure leaves the registered stop() pointed at a
# partially-built server.
viser._viser.SceneApi = _fail

try:
    viser.ViserServer(port=0, verbose=False)
except Boom:
    print("INIT_FAILED_AS_EXPECTED", flush=True)
# Exit WITHOUT unregistering anything: the atexit-time stop() must run cleanly
# against the partially-built server.
"""


def test_atexit_stop_tolerates_init_failure():
    """The atexit-registered stop() must not raise when __init__ failed partway.

    Regression: stop() was registered with atexit before ``_share_tunnel`` was
    assigned. If __init__ failed in between, the atexit-time stop() missed the
    attribute and fell into DeprecatedAttributeShim.__getattr__, whose
    ``self.scene`` lookup (also unset) recursed until RecursionError -- an
    exception at interpreter exit re-raised after the exit handlers, failing
    the process.
    """
    result = subprocess.run(
        [sys.executable, "-c", _INIT_FAILURE_EXIT_SCRIPT],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert "INIT_FAILED_AS_EXPECTED" in result.stdout, (
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    assert "RecursionError" not in result.stderr, result.stderr
    assert result.returncode == 0, f"stdout: {result.stdout}\nstderr: {result.stderr}"
