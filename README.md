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
})
if err != nil {
	return err
}
defer tc.Close()
go tc.Run(ctx)                  // reminders, until ctx ends
mux.Handle("/timeclock/", tc)   // requests arrive with the base path still on them
```

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

```sh
TIMECLOCK_DATABASE_URL=postgres://... \
TIMECLOCK_PUBLIC_URL=https://time.example.com \
TIMECLOCK_OIDC_ISSUER=https://accounts.google.com \
TIMECLOCK_OIDC_CLIENT_ID=... TIMECLOCK_OIDC_CLIENT_SECRET=... \
TIMECLOCK_SESSION_SECRET=<32+ random characters> \
TIMECLOCK_ALLOWED_DOMAIN=example.com \
TIMECLOCK_ADMIN_EMAILS=payroll@example.com \
timeclock-server
```

The OIDC provider's redirect URL is `<public URL>/auth/callback`. See `cmd/timeclock-server/main.go` for every variable. The `Dockerfile` builds the image.

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
| `internal/clock/` | The payroll rules and their storage |
| `internal/api/` | The HTTP API (huma); `timeclock-server openapi` prints its document |
| `internal/standalone/` | Accounts, OIDC sign-in and sessions for running alone |
| `migrations/` | goose migrations, `NNNNN_name.sql` |
| `web/` | The Vite app, embedded in the binary |
| `web/packages/timeclock/` | `@giraffesyo/timeclock`, the clock for a host application; the app is built on its source |
| `web/e2e/` | End-to-end tests (Playwright): each test is its own people, against a schema made for the run |

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
