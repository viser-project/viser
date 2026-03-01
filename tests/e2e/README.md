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

## Troubleshooting

- **Client not built** -- blank pages or import errors mean you need to run `make build-client`.
- **Port conflicts** -- each test uses a random free port. Check for leftover viser processes if you see address-in-use errors.
- **WebSocket timeout** -- the `viser_page` fixture waits up to 15s for the connection. Ensure the server started and the client is built.
