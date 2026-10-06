.PHONY: install build build-web build-server build-host build-e2e cli cli-dist check lint lint-go vuln test test-db e2e api release

GOLANGCI := go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0
GOVULNCHECK := go run golang.org/x/vuln/cmd/govulncheck@v1.8.0

# The database dev.json describes: `go -C tools tool dev` (or `dev stack`) runs it.
TEST_DB_URL := postgres://timeclock:timeclock@localhost:54331/timeclock_test?sslmode=disable

install:
	go mod download
	@cd web && pnpm install --frozen-lockfile

# The server with the web app embedded, as the image builds it.
build: build-server build-host cli

build-web:
	@cd web && pnpm build

build-server: build-web
	go build -o timeclock-server ./cmd/timeclock-server

build-host: build-web
	go build -o example-host ./examples/host

# Build the test server directly, without first linking a production server
# that would immediately be overwritten. The host keeps its production tags.
build-e2e: build-web build-host cli
	go build -tags=e2e -o timeclock-server ./cmd/timeclock-server

# The CLI needs neither PostgreSQL nor the web build.
CLI_VERSION ?= dev
cli:
	go build -trimpath -ldflags '-X main.version=$(CLI_VERSION)' -o timeclock ./cmd/timeclock

cli-dist:
	bash scripts/build-cli.sh '$(CLI_VERSION)'

check: lint test

lint: lint-go
	@cd web && pnpm lint && pnpm typecheck

lint-go:
	go vet ./...
	$(GOLANGCI) run ./...

# Known vulnerabilities in the code the module actually calls.
vuln:
	$(GOVULNCHECK) ./...

test:
	go test ./...

# The Go tests with the database tests on: each makes and drops its own schema.
test-db:
	TIMECLOCK_TEST_DATABASE_URL='$(TEST_DB_URL)' go test ./...

# The end-to-end tests: the built server, with the app embedded, driven by
# real browsers against the development database (a schema of its own per run).
e2e: build-e2e
	@cd web && pnpm exec playwright test $(ARGS)

# Regenerate the web app's API types from the server's OpenAPI document.
api:
	@cd web && pnpm gen:api

# Tag a version that carries the web build: a commit on top of HEAD that adds
# web/dist, reachable only from the tag, so canary never holds build output.
# Then push it: git push origin $(VERSION)
release:
	@test -n "$(VERSION)" || (echo "usage: make release VERSION=v0.1.0" && exit 1)
	@test -z "$$(git status --porcelain)" || (echo "commit or stash your changes first" && exit 1)
	@cd web && pnpm install --frozen-lockfile && pnpm build
	@test -f web/dist/index.html
	git checkout --detach
	git add -f web/dist
	git commit -q -m "release $(VERSION)"
	git tag $(VERSION)
	git checkout -
	@echo "tagged $(VERSION); push it with: git push origin $(VERSION)"
