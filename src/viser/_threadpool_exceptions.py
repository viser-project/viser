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
