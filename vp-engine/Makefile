.PHONY: generate build test lint run docker clean help

BINARY     := vp-engine
BUILD_DIR  := ./bin
DOCKER_TAG ?= ghcr.io/vicionpower/vp-engine:dev
GOOS       ?= linux
GOARCH     ?= arm64
VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT     ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

generate: ## buf generate + sqlc generate (requires buf, sqlc installed)
	cd proto && buf generate
	cd sqlc && sqlc generate

build: ## CGO disabled, static build. Default target: linux/arm64 for EC2 t4g
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build \
		-trimpath \
		-ldflags="-s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)" \
		-o $(BUILD_DIR)/$(BINARY) \
		./cmd/vp-engine

test: ## Run tests with race detector
	go test -race -count=1 -timeout=5m ./...

test-integration: ## Run integration tests (requires Docker)
	go test -race -count=1 -timeout=15m -tags=integration ./tests/integration/...

lint: ## golangci-lint
	golangci-lint run --timeout=5m

run: build ## Build + run with .env loaded
	@test -f .env || (echo "Missing .env. Copy .env.example."; exit 1)
	set -a && source .env && set +a && $(BUILD_DIR)/$(BINARY)

docker: ## Build scratch image
	docker build -f deployments/Dockerfile --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) -t $(DOCKER_TAG) .
	@docker images $(DOCKER_TAG)

clean:
	rm -rf $(BUILD_DIR) sqlc/generated/*

tidy:
	go mod tidy
