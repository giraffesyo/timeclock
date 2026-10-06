# Timeclock

Time tracking for payroll: clock in and out, time by customer and project, vacation and sick time per pay cycle, timesheets, approvals, exceptions, and reports a payroll system can import.

It is one Go module with its web app embedded. It runs two ways:

- **Inside a host application**, mounted under a path. The host says who is calling and answers questions about its people; Timeclock keeps the time.
- **On its own**, as `timeclock-server`, with its own sign-in.

## What it does

- **The clock.** One running clock per person: say what you are working on, pick its project, and start. Choosing another project while it runs moves the clock to it without stopping: the time so far stays where it was. Time can also be added and corrected by hand.
- **Projects.** Every entry can be tagged with a project: a customer's, or internal work with no customer. An organization can require one.
- **The week.** A calendar of the workweek, a day to a column: drag to add time, drag a block or its edge to change it. Entries may overlap, as a meeting inside a longer stretch does; worked hours count the overlap once, so they are never more than the time that passed.
- **Overview.** Hours per day by project, each project's share of the week, and who is on the clock now.
- **Pay periods.** Weekly, biweekly, twice a month or monthly, set by an admin.
- **Time zones.** The organization has one, and a person can have their own: their times show in it, and their days and workweeks start at its midnight. Pay periods are the same calendar dates for everyone.
- **Overtime.** Time beyond a weekly threshold is overtime, counted per workweek on the day it was worked, so a week that straddles two pay periods puts its overtime in the right one. People can be marked exempt.
- **Time off.** Vacation and sick hours are recorded per day and reported per pay period. Balances stay in the payroll system.
- **Timesheets.** Each period a person submits their timesheet, which locks that period's time. A manager or admin can send it back.
- **Approvals.** Timesheets and time off can each need approval, from the person's manager or an admin, or not. Nobody approves their own.
- **Exceptions.** What payroll should look at before paying: a clock left running, a very long entry, a timesheet not submitted or not approved, pending time off, overtime, a period with nothing recorded.
- **Reports.** Hours per person per pay period, exported as a CSV for Gusto's hours import, and hours by customer, project and person.
- **Audit log.** Every change to payroll data, with who made it.
- **Workspaces.** A workspace is one organization's Timeclock: its people, time, settings and look. Every table carries its workspace and every query names it, so one deployment can hold many. A host with several organizations says which one a request is in; without that there is one.
- **Themes.** A look is a few values: for light and for dark, an accent, a background and a contrast, and optionally the same for the sidebar; every other color follows from them. A workspace admin sets the workspace's in Settings, with the page wearing the draft as it changes; a host application can hand Timeclock its own; and each person chooses light, dark or the system's.
- **Reminders.** With a host notifier, people are told once about a clock left running and a timesheet that is due.

## Embedding

```go
tc, err := timeclock.New(ctx, timeclock.Options{
	DatabaseURL: dsn,          // the host's own PostgreSQL database
	BasePath:    "/timeclock", // where the host mounts it
	Caller: func(r *http.Request) (string, bool) {
		return userIDFromSession(r) // the host's signed-in user
	},
	Directory:       directory,     // a host.Directory over the host's people
	Notifier:        notifier,      // optional: a host.Notifier for reminders
	HomeURL:         "/",           // optional: a link back to the host
	HomeLabel:       "Portal",
	SignInURL:       "/login?next=",
	SignOutURL:      "/api/auth/logout",
	ThemeStorageKey: "portal-theme", // optional: follow the host's light/dark choice
	Theme:           theme,          // optional: a host.Theme, so Timeclock matches the host's colors
	Workspace:       workspaceOf,    // optional: func(*http.Request) (key string, ok bool), for a host with several organizations
	APIKeysURL:      "https://portal.example.com/settings/api-keys", // optional: where the CLI sends people for an API key Caller accepts
})
if err != nil {
	return err
}
defer tc.Close()
go tc.Run(ctx)                  // reminders and integrations, until ctx ends
mux.Handle("/timeclock/", tc)   // requests arrive with the base path still on them
```

[`examples/host`](examples/host) is a complete host in one file: its own people, several organizations, and its own colors.

`host.Directory` is two methods: `Person(ctx, id)` and `People(ctx)`. A `host.Person` has an id, a name, an email, whether they are an admin (run payroll), and optionally their manager's id; an admin can set managers in Timeclock too, which takes precedence.

Set `host.Person.AvatarURL` to the user's profile image to show it beside their name. The caller's current image comes from the directory on each session fetch; absent or unavailable images fall back to initials. Use a same-origin image path, or list the images' origin in `Options.ImageSources` (for example `https://*.googleusercontent.com` for Google Workspace photos) so Timeclock's content security policy allows it.

Timeclock keeps its tables, and [hopper](https://github.com/parallelworks/hopper)'s job tables, in its own schema (`timeclock` by default) and migrates it at startup under an advisory lock, so replicas can start together and it can share the host's database. `Options.SkipMigrations` leaves migrating to the host.

It is built on [foundation](https://github.com/parallelworks/foundation): errors are RFC 9457 problems with stable codes (`/problems/timeclock/<code>`), the handler sets security headers and a strict CSP, and refuses cross-site writes.

### The clock in the host's own pages

[`@giraffesyo/timeclock`](web/packages/timeclock) is the clock bar as an npm package, for the host's own header: a ready-made `ClockBar`, a headless `useClock()` hook, and a store with no React. Timeclock's own bar is that package.

```tsx
import { ClockBar } from '@giraffesyo/timeclock/react';
import '@giraffesyo/timeclock/styles.css';

<ClockBar basePath="/timeclock" />;
```

## Standalone

`timeclock-server` is Timeclock with its own accounts. Nobody is signed in until they accept an invitation and set a password.

```sh
TIMECLOCK_DATABASE_URL=postgres://... \
TIMECLOCK_PUBLIC_URL=https://time.example.com \
TIMECLOCK_ADMIN_EMAILS=payroll@example.com \
TIMECLOCK_SECRET_KEY=<32+ random characters, kept out of the database's backups> \
TIMECLOCK_SMTP_HOST=smtp.example.com TIMECLOCK_SMTP_FROM='Timeclock <time@example.com>' \
TIMECLOCK_SMTP_USERNAME=... TIMECLOCK_SMTP_PASSWORD=... \
timeclock-server
```

- **Getting in.** Each address in `TIMECLOCK_ADMIN_EMAILS` is invited when the server first starts. After that, a workspace's admins invite people from Settings → People, and whoever runs the server can too: `timeclock-server invite KEY EMAIL [--admin]`. There is no open sign-up.
- **Workspaces.** `timeclock-server workspace KEY "Name" --admin EMAIL` makes another organization on the same server and invites its first admin. Someone in more than one switches between them from the top of the sidebar.
- **Passwords.** At least 10 characters, with no rules about what they contain; ones known from a data breach are refused (the check sends five characters of a hash, never the password; `TIMECLOCK_BREACH_CHECK=off` turns it off). They are stored as Argon2id hashes. Repeated wrong guesses pause sign-in for the account and for the address they come from; behind a reverse proxy, set `TIMECLOCK_TRUST_PROXY=1` so that address is the client's (from `X-Forwarded-For`) and not the proxy's.
- **Sessions.** A random token in an `HttpOnly`, `SameSite=Lax` cookie, kept only as a hash. Signing out, resetting or changing a password ends sessions at the server.
- **A second step.** Anyone can add an authenticator app to their account (with recovery codes for when the phone is gone); sign-in then asks for its code after the password, and a reset link doesn't get around it. A passkey signs in on its own, with a fingerprint, face or device PIN. Both are set up under Account.
- **Email.** Invitations and password resets go by SMTP. Without a mail server, they are written to the log, and an invitation's link is shown to the admin who made it.
- **Single sign-on.** A workspace's admins can give it its own OpenID Connect provider in Settings → Sign-in, require it, and let anyone it signs in join; Settings shows a sign-in link that goes straight to the provider. What a workspace's provider says counts in that workspace only: a session that came in through it sees that workspace and can't change how the account signs in. `TIMECLOCK_OIDC_ISSUER`, `_CLIENT_ID` and `_CLIENT_SECRET` add a provider for the whole server instead. Either way the redirect URL is `<public URL>/auth/callback`.
- **The secret key.** `TIMECLOCK_SECRET_KEY` seals authenticator secrets, providers' client secrets, and integration tokens in the database (AES-256-GCM). Losing it means setting those up again; it isn't needed to read time or sign in with a password.

See `cmd/timeclock-server/main.go` for every variable. The `Dockerfile` builds the image.

## Command-line client

Download `timeclock` from the [GitHub release assets](https://github.com/giraffesyo/timeclock/releases). Each release includes macOS, Linux, and Windows binaries for `amd64` (Intel/AMD) and `arm64` (Apple Silicon/ARM). Unix archives are `.tar.gz`; Windows archives are `.zip`. Download `SHA256SUMS` alongside the archive and verify its SHA-256 digest before extracting it. On macOS/Linux, compare `shasum -a 256 <archive>` to its line in the manifest; on Windows use `Get-FileHash <archive> -Algorithm SHA256`. Put the extracted `timeclock` (or `timeclock.exe`) on your `PATH`.

With Go installed, `go install github.com/giraffesyo/timeclock/cmd/timeclock@latest` also works. From this checkout, `make cli` builds only the client, without PostgreSQL or a web build.

```sh
timeclock auth login time.example.com
timeclock status
timeclock projects
timeclock clock in --project PROJECT_UUID --note 'Implement the export'
timeclock clock switch --project ANOTHER_UUID --note 'Review payroll'
timeclock clock out
timeclock entries list --from 2026-10-01 --to 2026-10-05
timeclock timesheet show
timeclock timesheet submit --day 2026-10-05
timeclock reports payroll --day 2026-10-05 --csv > payroll.csv
timeclock status --json
timeclock auth logout
```

`auth login` opens your system browser and uses OAuth authorization code flow with S256 PKCE and a temporary loopback callback. Sign in normally with your password, passkey, authenticator or workspace SSO, then approve the CLI for the workspace shown. The CLI never asks for your password or browser cookie. `--no-browser` prints the URL for you to open manually on the same machine.

For SSH or another machine without a browser, use device authorization:

```sh
timeclock auth login time.example.com --device --no-browser
```

Open the displayed URL on another device, enter the code from your terminal, check the account and workspace, and approve. Authorize only requests you started yourself. To use another workspace, switch to it in the browser and sign the CLI in again. Each authorization stays bound to its approved workspace even if the browser later switches.

Tokens live in the OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. On a headless system without one, explicitly add `--credential-store=file`; tokens are then stored in a private file beside the configuration (mode `0600` on Unix). There is no automatic plaintext fallback. The non-secret configuration lives in the platform's user configuration directory under `timeclock/config.json`; override it with `--config` or `TIMECLOCK_CONFIG` for separate profiles. The server is the Timeclock URL including any mount path; a bare host means HTTPS. A successful login saves the server and credential-store choice, so later commands (and a later `auth login` with no argument) reuse it. `TIMECLOCK_URL` overrides the saved server, and saved credentials are never sent to a different server.

Access tokens last ten minutes. Refresh tokens rotate automatically, with a thirty-day authorization lifetime; reusing a spent refresh token revokes the whole authorization. `auth logout` revokes the authorization at the server and removes the local credentials. Removing workspace membership, disabling the account, or changing/resetting its password also removes access. Browser logout is independent. CLI tokens cannot manage sign-in methods or approve another CLI.

Browser and device authorization are provided by the **standalone server**. When Timeclock is embedded in a host, the host supplies authentication with its own API keys. `auth login` asks you to paste one (without echoing it), checks it, and saves it in the credential store like OAuth tokens. If the host sets `Options.APIKeysURL` (and lets signed-out requests reach `/api/v1/info`), it opens that page first so you can create the key:

```sh
timeclock auth login portal.example.com/timeclock
```

For scripts, `--with-token` reads the key from standard input without prompting: `timeclock auth login portal.example.com/timeclock --with-token < key.txt`. An API key isn't refreshed or revoked by the CLI; `auth logout` removes it locally, and you revoke it in the host. `TIMECLOCK_TOKEN` still works too, and overrides stored credentials. Production servers should use HTTPS; remote plain HTTP requires an explicit `--allow-http`.

Use `--help` on any command. Date ranges include both `--from` and `--to`; manual entry timestamps require RFC3339 with an offset. `entries update` replaces the supplied entry's fields, so include its description and project to retain them. `--json` preserves the complete API response, CSV writes cleanly to stdout, and failures go to stderr with a nonzero exit status. Payroll CSV includes settled time by default; `--all` explicitly includes unsettled time. Shell completions are available through `timeclock completion bash|zsh|fish|powershell`.

For operations without a dedicated command, `api` calls a path relative to `/api/v1`:

```sh
timeclock api '/time-off?from=2026-10-01&to=2026-10-31'
timeclock api /projects --method POST --input project.json
# --input - reads JSON from stdin.
```

## Toggl Track trial sync

An admin opens **Integrations → Toggl Track**, enters a Toggl workspace admin's API token, selects the workspace, and confirms the suggested email matches between Toggl users and Timeclock people. Employees do not connect their accounts. The Toggl account must have permission to read and edit the matched people's time; plan restrictions and API quotas still apply.

All history is selected by default, including completed entries on archived projects. Historical time with missing required fields or payroll locks is surfaced under **Needs attention**. You can instead choose a starting date (midnight UTC, 1970 or later). Hopper picks up the connection within a minute. Recent time syncs while older time imports in bounded batches; progress and report-page cursors survive restarts and API limits. Large histories can take multiple runs. After the first historical scan, jobs run about every ten minutes and continue sweeping older dates for changes. History is limited to the matched people and data the Toggl account can access. Run `tc.Run(ctx)` when embedding, and set `Options.IntegrationSecretKey` to at least 32 characters. Standalone uses `TIMECLOCK_SECRET_KEY`. Tokens are encrypted with AES-GCM and are never returned by the API or included in audit records.

- Completed time entries sync in both directions, including descriptions, dates and project assignments. Running timers transfer after stopping. Customers and projects are imported from Toggl and paired with existing names within the same customer; use these projects when tracking in either app. Catalog renames, new Timeclock projects, tags, tasks, billable flags/rates, time off and payroll approvals are outside this bridge's scope.
- Only explicitly matched, active Timeclock people sync. Existing matches cannot be reassigned while connected. An admin can add people through **Manage connection**.
- Submitted and approved timesheets remain locked. Conflicting edits appear under **Needs attention**, with both versions and an explicit choice. Toggl does not provide conditional updates for these writes: the bridge re-reads before pushing, but a simultaneous edit after that read remains a limitation of polling.
- Local deletions propagate to Toggl. Missing or inaccessible Toggl entries require an admin decision before deleting local time. A report omission alone never deletes anything.
- Partial reports and API limits stop that attempt. Backoff is saved in the database, including `Retry-After`; **Sync now** cannot bypass it. Sync resumes from durable entry mappings. If an external create may have succeeded before a network or database failure, the bridge asks the admin to link the created entry or confirm that it is absent before retrying.
- **Disconnect** waits for the active workspace sync, then deletes credentials, person/project/entry mappings, staged report pages and sync state. Imported time, customers, projects and the audit history stay in Timeclock; no data is deleted in Toggl. Reconnecting requires a token and person matching again. The retained audit history restores entry identity and the last shared version for the same Toggl workspace and people, avoiding duplicates and detecting offline conflicts or deletions. Previously imported users must be matched to their original Timeclock people.

The integration uses Toggl's [Track API](https://engineering.toggl.com/docs/track/api/time_entries/), [detailed Reports API](https://engineering.toggl.com/docs/track/reports/detailed_reports/), and [workspace membership API](https://engineering.toggl.com/docs/track/api/workspaces/). Google Calendar and Gusto have reserved rows on the Integrations page but are not connected services yet.

The regular browser suite uses a local fake Toggl service, synthetic tokens, the real API/database, and the Hopper worker. `make e2e ARGS="e2e/integrations.spec.ts --project=chromium"` covers history pagination, edits, disconnect, reconnect and conflict resolution without any Toggl account. The `e2e` build tag redirects Toggl requests to localhost and refuses real Toggl traffic; production builds have no override.

Live integration tests are opt-in. Set `TIMECLOCK_TOGGL_TEST_TOKEN_FILE` to a local file containing a **Toggl Track** API token and `TIMECLOCK_TOGGL_TEST_WORKSPACE_ID` to the sandbox workspace ID. Run `go test ./internal/toggl -run '^TestLiveWorkspaceContract$' -count=1 -v` for read-only checks. With the test database configured, `TIMECLOCK_TOGGL_TEST_WRITES=1 go test ./internal/clock -run '^TestLiveTogglRoundTrip$' -count=1 -v` creates one disposable entry, verifies edits in both directions and disconnect cleanup, then deletes that remote entry. The write test requires a single-user sandbox and uses an isolated local schema; it does not verify editing another team member's time. Toggl 2.0 tokens use a separate API and are not supported by this Track integration.

## Development

Needs Go 1.27 and Node 26 with pnpm 11. Foundation's `dev` tool (`dev.json`) runs everything in one terminal, without Docker: Postgres 18 on :54331, the server on http://localhost:8090 (rebuilt and restarted when Go or SQL changes), and Vite. Its data stays in `.devstack/` between runs. `dev.env` holds the server's development settings, signed in as `dev@example.com`, an admin; the real environment wins, so `TIMECLOCK_DEV_USER=you@example.com go -C tools tool dev` signs in as someone else.

```sh
make install
go -C tools tool dev         # Postgres, server and Vite; `dev stack` runs only Postgres, `dev reset` deletes its data
make test-db    # Go tests, with the database tests on
make check      # every linter and test
make vuln       # known vulnerabilities in the Go code
make e2e        # the end-to-end tests: the built server, driven by real browsers
make api        # after changing an API operation: regenerate the web app's types
make cli        # build the Go command-line client
make cli-dist CLI_VERSION=dev # cross-compile and package all six CLI targets
```

In development the Go server proxies the web app from Vite, so open the Go server's address. Vite's own address (`:5174`) passes the API on to the Go server and works too, but only the Go server applies the CSP.

`make build` builds the production server, example host, and CLI. `make build-e2e` builds the same frontend and host with the test-tagged server directly; `make e2e` uses it. Both share one frontend build, including with parallel Make. CI overlaps that build with browser installation and runs every browser project. Go jobs use separate caches for cross-compilation, lint/race tests, API generation, and E2E builds; Docker uses a shared BuildKit layer cache. Cache hits never skip the database or browser tests. CI runs Postgres from the same dev stack, so it tests what development uses.

| Where | What |
| --- | --- |
| `timeclock.go` | `New`, `Options`: the handler a host mounts |
| `host/` | `Directory` and `Notifier`: what a host implements |
| `internal/clock/` | The payroll rules and their storage. Every statement names its workspace as `$W`; one that doesn't is refused (`workspace.go`) |
| `internal/api/` | The HTTP API (huma); `timeclock-server openapi` prints its document |
| `internal/standalone/` | A standalone server's accounts: passwords, sessions, invitations, workspaces to switch between, email, and OIDC |
| `internal/cli/`, `cmd/timeclock/` | The Cobra CLI, OAuth client, credential storage, and HTTP commands |
| `migrations/` | goose migrations, `NNNNN_name.sql` |
| `web/` | The Vite app, embedded in the binary |
| `web/packages/timeclock/` | `@giraffesyo/timeclock`, the clock for a host application; the app is built on its source |
| `examples/host/` | A small application with Timeclock mounted in it |
| `web/e2e/` | End-to-end tests (Playwright): each test is its own people, against a schema made for the run. They drive four servers: one signed in as whoever a test says, one with its own accounts, one set up like a real deployment (mail by SMTP, identity providers, a breach list, a proxy; the pretend ones are `services.mjs`), and `examples/host` |

## The payroll export

`GET /api/v1/reports/payroll.csv?day=<any day in the period>` has one row per person whose time is settled (their timesheet is approved, or submitted when timesheets need no approval), with the columns `last_name, first_name, gusto_employee_id, regular_hours, overtime_hours, double_overtime_hours, pto_hours, sick_hours`. `?all=true` includes everyone. Check the columns against the template Gusto gives your company before the first import; the column names are in `internal/api/reports.go`.

## Releasing

Commits on `canary` follow Conventional Commits, and [release-please](https://github.com/googleapis/release-please) keeps a release PR open from them. Merging that PR:

- publishes a `timeclock-vX.Y.Z` GitHub release with the notes;
- attaches `timeclock_X.Y.Z_OS_ARCH` CLI archives and `SHA256SUMS` to that release, built from its exact tag;
- tags the Go module `vX.Y.Z` on a commit that adds the built `web/dist`, so a tagged version carries the app while `canary` stays free of build output. A host depends on that tag, never on `canary`, which embeds no app;
- publishes `@giraffesyo/timeclock` at the same version to npm, signed in through npm's trusted publishing.

`make release VERSION=vX.Y.Z` tags the module by hand, as a fallback.

`make cli-dist CLI_VERSION=vX.Y.Z` builds the same CLI archives locally under `dist/cli` (Go, Bash, `tar`, `zip`, and `shasum` required). CI cross-compiles all targets, checks the checksums, and smoke-tests the Linux binary. The browser suite runs the real CLI against the standalone server and PostgreSQL: PKCE, device approval, MFA, required SSO, denial, workspace isolation, clock and entry operations, timesheets, exports, refresh, and logout. Run it with `make e2e ARGS='e2e/cli.spec.ts e2e/signin.spec.ts --project=accounts --project=signin'`. Go database tests additionally cover token replay, concurrent refresh, expiry, account revocation, and membership/SSO-policy changes.

## License

[Apache License 2.0](LICENSE).
