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
})
if err != nil {
	return err
}
defer tc.Close()
go tc.Run(ctx)                  // reminders, until ctx ends
mux.Handle("/timeclock/", tc)   // requests arrive with the base path still on them
```

[`examples/host`](examples/host) is a complete host in one file: its own people, several organizations, and its own colors.

`host.Directory` is two methods: `Person(ctx, id)` and `People(ctx)`. A `host.Person` has an id, a name, an email, whether they are an admin (run payroll), and optionally their manager's id; an admin can set managers in Timeclock too, which takes precedence.

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
- **The secret key.** `TIMECLOCK_SECRET_KEY` seals authenticator secrets and providers' client secrets in the database (AES-256-GCM). Losing it means setting those up again; it isn't needed to read time or sign in with a password.

See `cmd/timeclock-server/main.go` for every variable. The `Dockerfile` builds the image.

## Development

Needs Go 1.27, Node 26 with pnpm 11, and Docker.

```sh
make install
make dev        # http://localhost:8090, signed in as DEV_USER (an admin)
make test-db    # Go tests, with the database tests on
make check      # every linter and test
make vuln       # known vulnerabilities in the Go code
make e2e        # the end-to-end tests: the built server, driven by real browsers
make api        # after changing an API operation: regenerate the web app's types
```

In development the Go server proxies the web app from Vite, so open the Go server's address. Vite's own address (`:5174`) passes the API on to the Go server and works too, but only the Go server applies the CSP.

| Where | What |
| --- | --- |
| `timeclock.go` | `New`, `Options`: the handler a host mounts |
| `host/` | `Directory` and `Notifier`: what a host implements |
| `internal/clock/` | The payroll rules and their storage. Every statement names its workspace as `$W`; one that doesn't is refused (`workspace.go`) |
| `internal/api/` | The HTTP API (huma); `timeclock-server openapi` prints its document |
| `internal/standalone/` | A standalone server's accounts: passwords, sessions, invitations, workspaces to switch between, email, and OIDC |
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
- tags the Go module `vX.Y.Z` on a commit that adds the built `web/dist`, so a tagged version carries the app while `canary` stays free of build output. A host depends on that tag, never on `canary`, which embeds no app;
- publishes `@giraffesyo/timeclock` at the same version to npm, signed in through npm's trusted publishing.

`make release VERSION=vX.Y.Z` tags the module by hand, as a fallback.

## License

[Apache License 2.0](LICENSE).
