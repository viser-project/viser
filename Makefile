.PHONY: help test-e2e test-e2e-headed test-e2e-debug update-baselines test-unit test-all install-e2e build-client

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

test-e2e: ## Run all E2E tests
	uv run pytest tests/e2e/ -v

test-e2e-headed: ## Run E2E tests with a visible browser window
	uv run pytest tests/e2e/ -v --headed

test-e2e-debug: ## Run E2E tests with headed browser, slow motion, and video
	uv run pytest tests/e2e/ -v --headed --slowmo 500 --video on

update-baselines: ## Generate/update reference screenshots
	uv run pytest tests/e2e/ -v --update-baselines

test-unit: ## Run unit tests (excludes E2E)
	uv run pytest tests/ --ignore=tests/e2e

test-all: ## Run both unit and E2E tests
	uv run pytest tests/
	uv run pytest tests/e2e/ -v

install-e2e: ## Install E2E dependencies
	uv sync --extra dev && uv run playwright install chromium

build-client: ## Build the viser client
	cd src/viser/client && npm install && npm run build
