"""Run a test body on a worker thread, clear of the main thread's event loop.

The e2e suite's pytest-playwright fixtures drive the sync Playwright API on
the MAIN thread; once any e2e test has run, the main thread looks like it
hosts a running asyncio event loop for the rest of the process, and later
tests that call ``asyncio.run`` (or open ``sync_playwright()`` themselves)
fail with "cannot be called from a running event loop" / "Sync API inside
the asyncio loop". CI never sees this -- it shards e2e and unit suites into
separate processes -- but a combined ``pytest tests`` run does. A fresh
worker thread has clean thread-locals, so the same body runs fine there.
"""

from __future__ import annotations

import threading
from typing import Callable, TypeVar

T = TypeVar("T")


def run_isolated(fn: Callable[[], T]) -> T:
    """Call ``fn`` on a fresh thread; return its result or re-raise its error."""
    result: list[T] = []
    error: list[BaseException] = []

    def target() -> None:
        try:
            result.append(fn())
        except BaseException as e:  # re-raised on the caller's thread below.
            error.append(e)

    thread = threading.Thread(target=target)
    thread.start()
    thread.join()
    if error:
        raise error[0]
    return result[0]
