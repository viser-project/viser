# End-to-End Tests

Viser's E2E test suite uses [Playwright](https://playwright.dev/python/) to drive a real Chromium browser against a live `ViserServer`.

## Quick Start

```bash
# Install dependencies
make install-e2e

# Build the client (required -- tests skip auto-build)
make build-client

# Run tests
make test-e2e
```

## Key Files

| File | Purpose |
|---|---|
| `conftest.py` | Pytest fixtures (`viser_server`, `viser_page`, failure diagnostics) |
| `utils.py` | Shared helpers (scene-graph JS snippets, GUI locators) |

## Makefile Targets

Run `make help` to see all available targets.

## Speed & failure artifacts

Tests run with Playwright **video and trace capture disabled by default**.
Recording a trace forces a DOM snapshot on every mutation and (with video) a
continuous canvas capture; for this WebGL-heavy app that adds ~25-30% CPU per
test, and the suite is CPU-bound, so it roughly doubles wall-clock time.

Failures still produce a screenshot (`failure.png`) and the page HTML
(`failure.html`) under `test-results/` via a pytest hook, which is enough for
most triage. To capture full video + traces on failure when debugging a
hard-to-reproduce issue:

```bash
VISER_E2E_CAPTURE=1 uv run pytest tests/e2e/ -n auto   # or: make test-e2e-capture
```

Most tests synchronize on real conditions (`expect(...)`, `wait_for_function`,
scene-graph predicates) rather than fixed `wait_for_timeout` sleeps, so they
return as soon as the app is ready instead of always waiting a worst-case delay.

## Troubleshooting

- **Client not built** -- blank pages or import errors mean you need to run `make build-client`.
- **Port conflicts** -- each test uses a random free port. Check for leftover viser processes if you see address-in-use errors.
- **WebSocket timeout** -- the `viser_page` fixture waits up to 15s for the connection. Ensure the server started and the client is built.
