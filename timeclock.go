// Package timeclock tracks time for payroll: clocking in and out, time by
// project and customer, vacation and sick time per pay cycle, timesheets,
// approvals, exceptions and reports a payroll system can import.
//
// It runs inside a host application, which mounts [Timeclock] under a path,
// tells it who is calling and answers its questions about people through a
// [host.Directory]:
//
//	tc, err := timeclock.New(ctx, timeclock.Options{
//		DatabaseURL: dsn,
//		BasePath:    "/timeclock",
//		Caller:      func(r *http.Request) (string, bool) { return userIDFromSession(r) },
//		Directory:   directory,
//	})
//	go tc.Run(ctx)
//	mux.Handle("/timeclock/", tc)
//
// cmd/timeclock-server runs it on its own, with its own sign-in.
package timeclock

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/foundation/problem"
	"github.com/parallelworks/foundation/server"
	"github.com/parallelworks/hopper"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/api"
	"github.com/giraffesyo/timeclock/internal/clock"
	"github.com/giraffesyo/timeclock/migrations"
	"github.com/giraffesyo/timeclock/web"
)

// Options configures a Timeclock.
type Options struct {
	// DatabaseURL is the PostgreSQL database holding Timeclock's schema,
	// normally the host's own.
	DatabaseURL string
	// Schema is Timeclock's schema in that database. Defaults to "timeclock".
	Schema string
	// SkipMigrations leaves migrating to the host. By default New applies
	// Timeclock's migrations under an advisory lock, so replicas can start
	// together.
	SkipMigrations bool
	// BasePath is where the host mounts Timeclock, such as "/timeclock".
	// Requests reach Timeclock with it still on the path. Empty serves at
	// the root.
	BasePath string
	// Caller returns the host user making a request, from the host's
	// session or API key.
	Caller func(r *http.Request) (userID string, ok bool)
	// Directory answers questions about the host's people.
	Directory host.Directory
	// Notifier delivers reminders (a clock left running, a timesheet that is
	// due) through the host's notifications. Without one, none are sent.
	Notifier host.Notifier
	// HomeURL and HomeLabel link from Timeclock back to the host, such as
	// "/" and the host's name.
	HomeURL   string
	HomeLabel string
	// SignInURL is where the host signs a person in, ending with the query
	// parameter that takes the path to return to, such as "/login?next=".
	// Timeclock's web app sends a signed-out browser there.
	SignInURL string
	// SignOutURL is the host's same-origin endpoint that ends its session.
	// Timeclock's web app POSTs to it and then loads HomeURL. Without it,
	// Timeclock offers no sign-out.
	SignOutURL string
	// ThemeStorageKey is the localStorage key where the host keeps the
	// person's light, dark or system choice, so Timeclock matches it.
	// Without it, Timeclock follows the system.
	ThemeStorageKey string
	// Workspace names the workspace a request is in, for a host with more
	// than one organization: each key is its own people, time and settings,
	// made the first time it is seen. Without it, everyone is in one.
	Workspace func(r *http.Request) (key string, ok bool)
	// Theme is the host's look, so Timeclock mounted in it matches: for
	// light and for dark, an accent and a background. A workspace admin can
	// still set the workspace's own in Timeclock's settings.
	Theme host.Theme
	// Routes registers extra handlers beside Timeclock's own, such as a
	// standalone server's sign-in.
	Routes func(mux *http.ServeMux)
	// DevServer is the Vite dev server, such as "http://localhost:5174",
	// proxied while the module embeds no web build.
	DevServer string
	// HSTS sends Strict-Transport-Security. A host that sets its own
	// security headers leaves it off.
	HSTS bool
	// Logger defaults to slog.Default().
	Logger *slog.Logger
}

// Timeclock is an http.Handler for everything under its base path, and
// background work started by Run.
type Timeclock struct {
	pool    *pgxpool.Pool
	jobs    *hopper.Client[pgx.Tx]
	logger  *slog.Logger
	handler http.Handler
}

// New connects to the database, applies migrations and builds the handler.
func New(ctx context.Context, opts Options) (*Timeclock, error) {
	if opts.Caller == nil || opts.Directory == nil {
		return nil, errors.New("timeclock: Options.Caller and Options.Directory are required")
	}
	base := "/" + strings.Trim(opts.BasePath, "/")
	for _, u := range []string{opts.SignInURL, opts.SignOutURL, opts.HomeURL} {
		if u != "" && (!strings.HasPrefix(u, "/") || strings.HasPrefix(u, "//")) {
			return nil, fmt.Errorf("timeclock: %q must be a path on the host", u)
		}
	}
	if opts.Schema == "" {
		opts.Schema = "timeclock"
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	pool, err := pgdb.Open(ctx, opts.DatabaseURL, opts.Schema)
	if err != nil {
		return nil, fmt.Errorf("timeclock: %w", err)
	}
	if !opts.SkipMigrations {
		if err := pgdb.Migrate(ctx, pool, pgdb.Migrations{FS: migrations.FS, Logger: logger}); err != nil {
			pool.Close()
			return nil, fmt.Errorf("timeclock: %w", err)
		}
	}
	svc := clock.New(pool)

	// Reminders are the only background work, and only a host with a
	// Notifier can deliver them.
	var jobs *hopper.Client[pgx.Tx]
	if opts.Notifier != nil {
		workers := hopper.NewWorkers()
		reminders := clock.NewReminders(opts.Notifier, logger)
		periodic := reminders.Register(workers)
		reminders.Bind(svc)
		jobs, err = hopper.NewClient(pgdb.HopperDriver(pool), &hopper.Config{
			Queues:   map[string]hopper.QueueConfig{hopper.QueueDefault: {MaxWorkers: 2}},
			Workers:  workers,
			Periodic: []hopper.PeriodicJob{periodic},
			Logger:   logger,
		})
		if err != nil {
			pool.Close()
			return nil, fmt.Errorf("timeclock: %w", err)
		}
	}

	deps := api.Deps{Clock: svc, Directory: opts.Directory, Info: api.Info{
		HomeURL: opts.HomeURL, HomeLabel: opts.HomeLabel, SignInURL: opts.SignInURL, SignOutURL: opts.SignOutURL,
		ThemeStorageKey: opts.ThemeStorageKey,
	}, HostTheme: opts.Theme}
	h := server.New(server.Options{
		Logger: logger,
		Routes: func(mux *http.ServeMux) {
			api.New(mux, deps)
			if opts.Routes != nil {
				opts.Routes(mux)
			}
		},
		Problems:  []*problem.Registry{clock.Problems},
		Ready:     map[string]server.Pinger{"database": pool},
		Web:       web.FS(),
		DevServer: opts.DevServer,
		BasePath:  base,
		HSTS:      opts.HSTS,
		Wrap:      authenticate(opts.Caller, (&workspaces{svc: svc, key: opts.Workspace}).of),
	})
	if base != "/" {
		h = http.StripPrefix(base, h)
	}
	return &Timeclock{pool: pool, jobs: jobs, logger: logger, handler: h}, nil
}

// ServeHTTP serves Timeclock's API and web app.
func (t *Timeclock) ServeHTTP(w http.ResponseWriter, r *http.Request) { t.handler.ServeHTTP(w, r) }

// Run does Timeclock's background work until ctx ends: reminding people,
// through the host's Notifier, about a clock left running or a timesheet
// that is due. Without a Notifier it returns when ctx ends.
func (t *Timeclock) Run(ctx context.Context) {
	if t.jobs == nil {
		<-ctx.Done()
		return
	}
	if err := t.jobs.Run(ctx); err != nil && ctx.Err() == nil {
		t.logger.ErrorContext(ctx, "timeclock: background jobs stopped", "error", err)
	}
}

// Close releases the database pool.
func (t *Timeclock) Close() { t.pool.Close() }

// authenticate attaches the host's caller, and the workspace they are in, to
// each request.
func authenticate(callerOf func(*http.Request) (string, bool), workspaceOf func(*http.Request) (uuid.UUID, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ws, err := workspaceOf(r)
			if err != nil {
				problem.Write(w, problem.Status(http.StatusServiceUnavailable, "the workspace is unavailable").WithCause(err))
				return
			}
			ctx := api.WithWorkspace(r.Context(), ws)
			if id, ok := callerOf(r); ok {
				ctx = api.WithCaller(ctx, id)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// workspaces resolves a request's workspace: the one the host names, or the
// default. Keys are remembered, so a request costs no query for it.
type workspaces struct {
	svc  *clock.Service
	key  func(*http.Request) (string, bool)
	seen sync.Map // key → uuid.UUID
}

func (w *workspaces) of(r *http.Request) (uuid.UUID, error) {
	key := clock.DefaultWorkspace
	if w.key != nil {
		if k, ok := w.key(r); ok && k != "" {
			key = k
		}
	}
	if id, ok := w.seen.Load(key); ok {
		return id.(uuid.UUID), nil
	}
	ws, err := w.svc.EnsureWorkspace(r.Context(), key)
	if err != nil {
		return uuid.Nil, err
	}
	w.seen.Store(key, ws.ID)
	return ws.ID, nil
}

// OpenAPI returns the API's OpenAPI document without connecting to
// anything. The web app's client types are generated from it.
func OpenAPI() *huma.OpenAPI {
	return api.New(http.NewServeMux(), api.Deps{}).OpenAPI()
}
