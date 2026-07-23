"""Broadcast-GC cursor + task cleanup on client disconnect.

Lives under tests/e2e/ (not tests/) because it drives a real browser:
the ``build`` CI job runs ``pytest --ignore=tests/e2e`` without installing
chromium, so a browser test in tests/ fails there. This runs in the e2e
job, which installs chromium.
"""

from __future__ import annotations

import asyncio

from ..thread_isolation import run_isolated


async def _noop_count() -> int:
    return len(asyncio.all_tasks())


def test_disconnect_releases_gc_cursor_promptly() -> None:
    """A disconnected client's broadcast GC cursor must be released at
    teardown, not when the next broadcast happens to wake a zombie producer:
    gather() does not cancel siblings, so on a QUIET server the parked
    producer's finally never ran and the stale cursor pinned the GC deletion
    floor forever."""
    # On a worker thread: this test opens sync_playwright() itself, which the
    # main thread can't once the e2e fixtures have run (see thread_isolation).
    run_isolated(_disconnect_scenario)


def _disconnect_scenario() -> None:
    import time
    from unittest.mock import patch

    from playwright.sync_api import sync_playwright

    import viser
    import viser._client_autobuild

    with patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None):
        server = viser.ViserServer(verbose=False)
    try:
        broadcast = server._websock_server._broadcast_buffer
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(f"http://localhost:{server.get_port()}")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not broadcast.generator_cursors:
                time.sleep(0.05)
            assert broadcast.generator_cursors, "client cursor never registered"
            browser.close()
        # NO further broadcasts: the cursor must still be released promptly.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and broadcast.generator_cursors:
            time.sleep(0.05)
        assert not broadcast.generator_cursors, (
            f"stale GC cursors after disconnect: {broadcast.generator_cursors}"
        )

        # And the connection's tasks are fully reaped: repeated quiet
        # connect/disconnect cycles must not grow the event loop's task set
        # (one flush-event waiter leaked per cycle before teardown awaited
        # the generator's close).
        loop = server._websock_server._background_event_loop
        assert loop is not None

        def _tasks_now() -> int:
            return asyncio.run_coroutine_threadsafe(_noop_count(), loop).result(
                timeout=5.0
            )

        baseline_tasks = _tasks_now()
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for _ in range(3):
                page = browser.new_page()
                page.goto(f"http://localhost:{server.get_port()}")
                page.wait_for_timeout(300)
                page.close()
            browser.close()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and broadcast.generator_cursors:
            time.sleep(0.05)
        counts = [_tasks_now() for _ in (time.sleep(0.2), time.sleep(0.2), None)]
        # Relative bound: compare against the steady-state before the cycles
        # (absolute thresholds flake across environments). One leaked flush
        # waiter per cycle would show as growth >= 3.
        assert min(counts) <= baseline_tasks + 1, (
            f"event-loop task set grew across quiet disconnects: "
            f"{counts} vs baseline {baseline_tasks}"
        )
    finally:
        server.stop()
