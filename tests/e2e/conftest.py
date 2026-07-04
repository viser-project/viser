"""Pytest fixtures for viser Playwright E2E tests."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Generator

import pytest
from playwright.sync_api import Page

import viser
import viser._client_autobuild

from .utils import find_free_port, wait_for_connection, wait_for_server_ready

TEST_RESULTS_DIR = Path(__file__).resolve().parent.parent.parent / "test-results"

# Smaller-than-default viewport: software WebGL (SwiftShader, used on GPU-less CI
# runners) rasterizes the 3D scene in software, so per-frame cost scales with the
# pixel count. Shrinking the canvas from Playwright's 1280x720 default cuts that
# work substantially on CI. Kept large enough for layout-sensitive tests (text
# wrapping, panel docking). device_scale_factor is pinned to 1 (already the
# Linux default, explicit for determinism across hosts).
_E2E_VIEWPORT = {"width": 960, "height": 600}


@pytest.fixture()
def browser_context_args(browser_context_args: dict) -> dict:
    """Shrink the viewport to reduce software-WebGL raster cost on CI.

    reduced_motion: the dock's minimize/expand transitions honor
    prefers-reduced-motion (they become instant), so tests keep short fixed
    waits instead of animation-length sleeps. The playground module context
    (dock_helpers) sets the same flag."""
    return {
        **browser_context_args,
        "viewport": _E2E_VIEWPORT,
        "device_scale_factor": 1,
        "reduced_motion": "reduce",
    }


def pytest_configure(config: pytest.Config) -> None:
    """Configure Playwright video/trace capture.

    Recording video and (especially) Playwright traces for a WebGL-heavy app is
    expensive -- continuous canvas-frame capture and per-action DOM snapshots
    add ~25-30% CPU to every test, and this suite is CPU-bound, so it directly
    inflates wall-clock time. We therefore leave capture OFF by default; test
    failures still produce a screenshot + page HTML via
    ``pytest_runtest_makereport`` below, which is enough for most triage.

    Set ``VISER_E2E_CAPTURE=1`` (or pass ``--video``/``--tracing`` explicitly on
    the CLI) to re-enable ``retain-on-failure`` capture when debugging a flaky
    or hard-to-reproduce failure.
    """
    import os

    if not os.environ.get("VISER_E2E_CAPTURE"):
        return
    option = config.option
    if hasattr(option, "video") and option.video == "off":
        option.video = "retain-on-failure"
    if hasattr(option, "tracing") and option.tracing == "off":
        option.tracing = "retain-on-failure"


def _save_failure_artifacts(page: Page | None, nodeid: str) -> None:
    """Write a screenshot + page HTML for a failed test, if a live page exists.

    Used for both call-phase failures (via the report hook) and setup-phase
    connection failures (via the ``viser_page`` fixture) -- the latter because
    ``item.funcargs`` is not populated when a fixture raises during setup, so
    the report hook alone cannot reach the page in that case."""
    try:
        if page is None or page.is_closed():
            return
    except Exception:
        return

    safe_name = nodeid.replace("/", "_").replace("::", "__").replace(" ", "_")
    artifact_dir = TEST_RESULTS_DIR / safe_name
    artifact_dir.mkdir(parents=True, exist_ok=True)

    try:
        page.screenshot(path=str(artifact_dir / "failure.png"))
    except Exception:
        pass
    try:
        (artifact_dir / "failure.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(
    item: pytest.Item, call: pytest.CallInfo[None]
) -> Generator[None, None, None]:
    """Capture a screenshot and page HTML on a call-phase test failure.

    Setup-phase failures (e.g. ``wait_for_connection``'s readiness timeout) are
    handled separately in the ``viser_page`` fixture, because ``item.funcargs``
    is not populated when a fixture raises during setup."""
    outcome = yield
    report = outcome.get_result()  # type: ignore[union-attr]

    if report.when != "call" or not report.failed:
        return

    funcargs = item.funcargs  # type: ignore[attr-defined]
    page = funcargs.get("viser_page") or funcargs.get("page")
    _save_failure_artifacts(page, item.nodeid)


@pytest.fixture(scope="session", autouse=True)
def _skip_client_autobuild() -> None:
    """Skip the client autobuild check -- the client must already be built."""
    viser._client_autobuild.ensure_client_is_built = lambda: None


@pytest.fixture()
def viser_server() -> Generator[viser.ViserServer, None, None]:
    """Start a ViserServer on a random port; stop it on teardown."""
    max_retries = 3
    server: viser.ViserServer | None = None
    for attempt in range(max_retries):
        port = find_free_port()
        try:
            server = viser.ViserServer(port=port, verbose=False)
            break
        except OSError:
            if attempt == max_retries - 1:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())
    yield server
    server.stop()


@pytest.fixture()
def viser_page(
    page: Page, viser_server: viser.ViserServer, request: pytest.FixtureRequest
) -> Page:
    """Navigate to the viser server and wait for WebSocket connection.

    If the connection/readiness wait fails (a setup-phase failure), capture a
    screenshot + HTML before re-raising -- with capture off by default this is
    otherwise an artifact-less timeout."""
    try:
        wait_for_connection(page, viser_server.get_port())
    except Exception:
        _save_failure_artifacts(page, request.node.nodeid + "__setup")
        raise
    return page


# ---------------------------------------------------------------------------
# Dock playground harness, shared by every test_dock_* module. One Vite dev
# server (HMR off, serving the client SOURCE at /dock_test.html) per session/
# xdist worker, instead of one per module: dock tests don't touch the prebuilt
# client bundle, and a shared server cuts repeated ~5s startups.
# ---------------------------------------------------------------------------
DOCK_CLIENT_DIR = Path(__file__).resolve().parents[2] / "src" / "viser" / "client"

# Wrap the client's vite config with HMR disabled: the playground tests drive
# deterministic DOM interactions, and an HMR websocket reconnect mid-test can
# reload the page under the pointer. Also disable file watching entirely (the
# tests never edit source mid-run) -- vite otherwise recursively watches the
# whole client dir, including the huge `.nodeenv`/`node_modules` trees, which can
# exhaust the OS inotify watcher limit and crash the dev server on startup
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


def _wait_for_http(port: int, path: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://localhost:{port}{path}"
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError) as err:
            last_err = err
            time.sleep(0.1)
    raise RuntimeError(f"Vite dev server not ready at {url}: {last_err}")


@pytest.fixture(scope="session")
def vite_server() -> Generator[int, None, None]:
    """Port of a Vite dev server serving the dock playground (dock_test.html)."""
    if shutil.which("npx") is None:
        pytest.skip("npx not on PATH; client toolchain not installed")
    if not (DOCK_CLIENT_DIR / "node_modules").exists():
        pytest.skip("client node_modules missing; run `npm install` in the client dir")

    cfg_fd, cfg_name = tempfile.mkstemp(
        prefix="vite.e2e.hmroff.", suffix=".mts", dir=str(DOCK_CLIENT_DIR)
    )
    cfg_path = Path(cfg_name)
    with os.fdopen(cfg_fd, "w") as f:
        f.write(_DOCK_HMR_OFF_CONFIG)

    port = find_free_port()
    proc = subprocess.Popen(
        ["npx", "vite", "--config", str(cfg_path), "--port", str(port), "--strictPort"],
        cwd=str(DOCK_CLIENT_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_for_http(port, "/dock_test.html")
        yield port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        cfg_path.unlink(missing_ok=True)


@pytest.fixture(scope="module")
def dock_context(browser):
    """Shared per-module browser context for the dock playground tests.

    One context per module keeps the HTTP cache warm, so Vite's unbundled
    module graph is fetched once instead of per test (a new context starts
    with a cold cache). Pages are still created per test for isolation;
    viewports are set per page via set_viewport_size.

    reduced_motion: the dock honors prefers-reduced-motion (animations become
    instant), which lets tests use short fixed waits instead of padding every
    interaction with animation-length sleeps -- and exercises the
    reduced-motion code path in the bargain."""
    ctx = browser.new_context(reduced_motion="reduce")
    yield ctx
    ctx.close()
