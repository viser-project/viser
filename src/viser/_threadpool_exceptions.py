from __future__ import annotations

import sys
import traceback
from concurrent.futures import Future
from typing import Any


def print_threadpool_errors(future: Future[Any]) -> None:
    """Print errors from a Future in a ThreadPool, should be used with
    `add_done_callback`."""
    if future.cancelled():
        print("Task was cancelled", file=sys.stderr)
        return

    exc = future.exception()
    if exc is not None:
        print("Task failed with exception:", file=sys.stderr)
        traceback.print_exception(type(exc), exc, exc.__traceback__)


def print_awaited_callback_error(exc: BaseException) -> None:
    """Print an exception raised by an awaited user callback. The async
    analog of ``print_threadpool_errors``: a throwing callback must not
    abort the caller's remaining work (sibling callbacks, teardown steps),
    so callers catch, report through here, and continue."""
    print("Callback failed with exception:", file=sys.stderr)
    traceback.print_exception(type(exc), exc, exc.__traceback__)
