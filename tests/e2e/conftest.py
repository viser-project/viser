"""Pytest fixtures for viser Playwright E2E tests."""

from __future__ import annotations

from pathlib import Path
from typing import Generator

import pytest
from playwright.sync_api import Page

import viser
import viser._client_autobuild

from .utils import find_free_port, wait_for_connection, wait_for_server_ready

TEST_RESULTS_DIR = Path(__file__).resolve().parent.parent.parent / "test-results"


def pytest_addoption(parser: pytest.Parser) -> None:
    """Register the --update-baselines CLI flag."""
    parser.addoption(
        "--update-baselines",
        action="store_true",
        default=False,
        help="Save screenshots as new reference baselines instead of comparing.",
    )


def pytest_configure(config: pytest.Config) -> None:
    """Enable video/tracing retention on failure (unless overridden via CLI)."""
    option = config.option
    if hasattr(option, "video") and option.video == "off":
        option.video = "retain-on-failure"
    if hasattr(option, "tracing") and option.tracing == "off":
        option.tracing = "retain-on-failure"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(
    item: pytest.Item, call: pytest.CallInfo[None]
) -> Generator[None, None, None]:
    """Capture a screenshot and page HTML whenever a test fails."""
    outcome = yield
    report = outcome.get_result()

    if report.when != "call" or not report.failed:
        return

    page = item.funcargs.get("viser_page") or item.funcargs.get("page")
    if page is None:
        return
    try:
        if page.is_closed():
            return
    except Exception:
        return

    safe_name = item.nodeid.replace("/", "_").replace("::", "__").replace(" ", "_")
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


@pytest.fixture()
def update_baselines(request: pytest.FixtureRequest) -> bool:
    """Whether to save screenshots as new baselines."""
    return bool(request.config.getoption("--update-baselines"))


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
def viser_page(page: Page, viser_server: viser.ViserServer) -> Page:
    """Navigate to the viser server and wait for WebSocket connection."""
    wait_for_connection(page, viser_server.get_port())
    return page


@pytest.fixture()
def reference_images_dir() -> Path:
    """Path to the .reference_images/ directory at the repo root."""
    return Path(__file__).resolve().parent.parent.parent / ".reference_images"
