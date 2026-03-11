.PHONY: help test test-e2e test-e2e-headed test-e2e-debug install-e2e build-client

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

test: ## Run all tests (unit + E2E)
	uv run pytest tests/

test-e2e: ## Run E2E tests only
	uv run pytest tests/e2e/ -v

test-e2e-headed: ## Run E2E tests with a visible browser window
	uv run pytest tests/e2e/ -v --headed

test-e2e-debug: ## Run E2E tests visually with slow motion and video recording
	uv run pytest tests/e2e/ -v --headed --slowmo 1000 --video on

install-e2e: ## Install E2E dependencies
	uv sync --extra dev && uv run playwright install chromium

build-client: ## Build the viser client
	cd src/viser/client && npm install && npm run build
