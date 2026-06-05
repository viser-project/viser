.PHONY: help test test-e2e test-e2e-capture test-e2e-headed test-e2e-debug install-e2e build-client

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

test: ## Run all tests (unit + E2E)
	uv run pytest tests/

test-e2e: ## Run E2E tests only (parallel; video/trace capture off for speed)
	# `-n auto` = one worker per logical core, tuned for the capture-off default
	# (matches CI). On a very-high-core box where WebGL contexts contend, pass a
	# smaller `-n <N>` instead.
	uv run pytest tests/e2e/ -n auto

test-e2e-capture: ## Run E2E tests with video + trace retained on failure (for debugging)
	# Capture adds ~25-30% CPU per test, so use fewer workers than `-n auto` to
	# avoid tipping heavy WebGL tests into contention timeouts on many-core hosts.
	VISER_E2E_CAPTURE=1 uv run pytest tests/e2e/ -n 4

test-e2e-headed: ## Run E2E tests with a visible browser window
	uv run pytest tests/e2e/ -v --headed

test-e2e-debug: ## Run E2E tests visually with slow motion and video recording
	uv run pytest tests/e2e/ -v --headed --slowmo 1000 --video on

install-e2e: ## Install E2E dependencies
	uv sync --extra dev && uv run playwright install chromium

build-client: ## Build the viser client
	cd src/viser/client && npm install && npm run build
