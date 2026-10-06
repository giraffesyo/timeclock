.PHONY: dev server web install build cli cli-dist check lint lint-go vuln test test-db e2e api release

GOLANGCI := go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0
GOVULNCHECK := go run golang.org/x/vuln/cmd/govulncheck@v1.8.0

TEST_DB_PORT ?= 54331
TEST_DB_URL := postgres://postgres:postgres@localhost:$(TEST_DB_PORT)/timeclock_test?sslmode=disable

# Run the standalone server and the Vite dev server together, signed in as
# DEV_USER. Open http://localhost:8090: the Go server proxies the app from
# Vite (hot reload included) until web/dist holds a build.
DEV_USER ?= dev@example.com
dev: db
	@echo "Starting Timeclock on http://localhost:8090 ..."
	@$(MAKE) -j2 server web

server:
	TIMECLOCK_DATABASE_URL='$(TEST_DB_URL)' TIMECLOCK_DEV_USER=$(DEV_USER) TIMECLOCK_ADMIN_EMAILS=$(DEV_USER) \
		TIMECLOCK_VITE_URL=http://localhost:5174 PORT=8090 go run ./cmd/timeclock-server

web:
	@cd web && pnpm dev

install:
	go mod download
	@cd web && pnpm install --frozen-lockfile

# The server with the web app embedded, as the image builds it.
build:
	@cd web && pnpm build
	go build -o timeclock-server ./cmd/timeclock-server
	go build -o example-host ./examples/host
	$(MAKE) cli

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

# A throwaway postgres:18 for development and the database tests.
db:
	@docker start timeclock-test-db >/dev/null 2>&1 || \
		docker run -d --name timeclock-test-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=timeclock_test \
			-p $(TEST_DB_PORT):5432 postgres:18-alpine >/dev/null
	@until docker exec timeclock-test-db pg_isready -U postgres -d timeclock_test >/dev/null 2>&1; do sleep 0.5; done

# The Go tests with the database tests on: each makes and drops its own schema.
test-db: db
	TIMECLOCK_TEST_DATABASE_URL='$(TEST_DB_URL)' go test ./...

# The end-to-end tests: the built server, with the app embedded, driven by
# real browsers against the development database (a schema of its own per run).
e2e: db build
	go build -tags=e2e -o timeclock-server ./cmd/timeclock-server
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
