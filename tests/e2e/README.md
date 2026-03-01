# End-to-End Tests

Viser's E2E test suite uses [Playwright](https://playwright.dev/python/) to drive a real Chromium browser against a live `ViserServer`.

## Quick Start

```bash
# Install dependencies
pip install -e ".[e2e]"
playwright install chromium

# Build the client (required -- tests skip auto-build)
cd src/viser/client && npm install && npm run build && cd -

# Run tests
make test-e2e
```

## Test Categories

- **Functional tests** -- assert DOM state and server/client round-trips (GUI controls, scene objects, interactions).
- **Visual regression tests** -- capture screenshots and compare pixel-by-pixel against reference baselines.

## Visual Regression

Reference images live on the orphan branch `ci/reference_images` and are checked out into `.reference_images/` by CI.

Each visual test captures a screenshot at 1280x720 and computes a normalized pixel diff against the reference. If the diff exceeds 2%, the test fails.

**Update baselines locally:**

```bash
make update-baselines
```

**Update baselines via CI:** trigger the `update-baselines` workflow from GitHub Actions.

## Key Files

| File | Purpose |
|---|---|
| `conftest.py` | Pytest fixtures (`viser_server`, `viser_page`, failure diagnostics) |
| `utils.py` | Shared helpers (pixel diff, scene-graph JS snippets, GUI locators) |
| `scenes.py` | Shared scene builders used by both tests and reference generation |
| `generate_references.py` | Standalone script for generating reference screenshots |
| `generate_readme.py` | Generates a README for the `ci/reference_images` branch |

## Makefile Targets

Run `make help` to see all available targets.

## Troubleshooting

- **Client not built** -- blank pages or import errors mean you need to run `npm install && npm run build` in `src/viser/client/`.
- **Port conflicts** -- each test uses a random free port. Check for leftover viser processes if you see address-in-use errors.
- **Visual regression failures** -- small rendering differences across platforms are expected. The 2% threshold accounts for antialiasing. Update baselines after intentional UI changes.
- **WebSocket timeout** -- the `viser_page` fixture waits up to 15s for the connection. Ensure the server started and the client is built.
