"""Root test configuration."""

from __future__ import annotations

# Skip the tests/e2e/ directory when Playwright is not installed, so that
# `pytest tests/` works even without E2E dependencies.
collect_ignore_glob: list[str] = []
try:
    import playwright  # noqa: F401
except ImportError:
    collect_ignore_glob.append("e2e/*")
