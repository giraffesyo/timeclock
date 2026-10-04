// Package api is Timeclock's HTTP API, defined with huma. Its OpenAPI
// document is served at /api/openapi.json.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/parallelworks/foundation/problem"
	"github.com/parallelworks/foundation/problem/humaproblem"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
)

// Prefix is the path prefix of every versioned operation.
const Prefix = "/api/v1"

// Info is what the web app needs to know about where it runs.
type Info struct {
	// HomeURL and HomeLabel link back to the host, when there is one.
	HomeURL   string `json:"homeUrl,omitempty"`
	HomeLabel string `json:"homeLabel,omitempty"`
	// SignInURL is where a signed-out browser goes to sign in; the web app
	// appends the URL-encoded path to come back to.
	SignInURL string `json:"signInUrl,omitempty"`
	// SignOutURL is the same-origin endpoint that ends the session; the web
	// app POSTs to it. Empty offers no sign-out.
	SignOutURL string `json:"signOutUrl,omitempty"`
	// ThemeStorageKey is the localStorage key holding the host's light,
	// dark or system choice, so Timeclock matches it.
	ThemeStorageKey string `json:"themeStorageKey,omitempty"`
	// Theme is the look to use: the workspace's where an admin set one, the
	// host's otherwise. A missing scheme is Timeclock's own.
	Theme host.Theme `json:"theme"`
	// WorkspaceTheme is what an admin set, for the settings page to edit.
	WorkspaceTheme host.Theme `json:"workspaceTheme"`
}

// Deps are what the operations need.
type Deps struct {
	Clock     *clock.Service
	Directory host.Directory
	Info      Info
	// HostTheme is the host application's look, which a workspace's own overrides.
	HostTheme host.Theme
}

type callerKey struct{}

// WithCaller returns ctx carrying the id of the host user making a request.
func WithCaller(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, callerKey{}, id)
}

// actor resolves the request's caller: who the host says they are now.
func (d Deps) actor(ctx context.Context) (clock.Actor, error) {
	id, _ := ctx.Value(callerKey{}).(string)
	if id == "" {
		return clock.Actor{}, problem.Status(http.StatusUnauthorized, "sign in to continue")
	}
	hp, err := d.Directory.Person(ctx, id)
	if errors.Is(err, host.ErrNotFound) {
		return clock.Actor{}, problem.Status(http.StatusUnauthorized, "sign in to continue")
	}
	if err != nil {
		return clock.Actor{}, problem.Status(http.StatusServiceUnavailable, "the directory is unavailable").WithCause(err)
	}
	return d.Clock.Sync(ctx, hp)
}

// info is Info with the look in force: each scheme the workspace's if an
// admin set it, and the host's if not.
func (d Deps) info(ctx context.Context) (Info, error) {
	out := d.Info
	workspace, err := d.Clock.Theme(ctx)
	if err != nil {
		return out, err
	}
	out.WorkspaceTheme = workspace
	out.Theme = d.HostTheme
	if workspace.Light != nil {
		out.Theme.Light = workspace.Light
	}
	if workspace.Dark != nil {
		out.Theme.Dark = workspace.Dark
	}
	return out, nil
}

// Config returns huma's configuration for the API.
func Config() huma.Config {
	cfg := huma.DefaultConfig("Timeclock API", "1")
	cfg.Info.Description = "Time tracking for payroll: clock in and out, time by project and customer, time off, timesheets, approvals and reports."
	cfg.DocsPath = ""
	cfg.OpenAPIPath = "/api/openapi"
	cfg.SchemasPath = "/api/schemas"
	cfg.Transformers = append(cfg.Transformers, humaproblem.Report(logServerErrors))
	return cfg
}

// New registers every operation on mux and returns the huma API.
func New(mux *http.ServeMux, deps Deps) huma.API {
	// Before any operation is registered: huma reads the error type from it.
	humaproblem.Install(humaproblem.Options{})
	a := humago.New(mux, Config())
	// Open to a signed-out browser, which asks it where to sign in.
	huma.Register(a, op(http.MethodGet, "/info", "get-info", "Where Timeclock runs and how to sign in", "Me"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body Info }, error) {
			info, err := deps.info(ctx)
			if err != nil {
				return nil, err
			}
			return &struct{ Body Info }{info}, nil
		})
	registerMe(a, deps)
	registerSettings(a, deps)
	registerPeople(a, deps)
	registerCatalog(a, deps)
	registerEntries(a, deps)
	registerTimeOff(a, deps)
	registerTimesheets(a, deps)
	registerReports(a, deps)
	return a
}

// logServerErrors logs the cause of every 5xx the API sends, which the
// client never sees.
func logServerErrors(ctx context.Context, p *problem.Problem) {
	if p.Status >= http.StatusInternalServerError {
		slog.ErrorContext(ctx, "timeclock: request failed", "status", p.Status, "detail", p.Detail, "error", p.Unwrap())
	}
}

// op is a huma operation with the API's conventions.
func op(method, path, id, summary string, tags ...string) huma.Operation {
	o := huma.Operation{Method: method, Path: Prefix + path, OperationID: id, Summary: summary, Tags: tags}
	if method == http.MethodDelete {
		o.DefaultStatus = http.StatusNoContent
	}
	return o
}

// day parses an optional YYYY-MM-DD query parameter, defaulting to today
// where the caller is.
func (d Deps) day(ctx context.Context, caller clock.Person, param, value string) (clock.Date, error) {
	if value == "" {
		cfg, err := d.Clock.Settings(ctx)
		if err != nil {
			return clock.Date{}, err
		}
		return d.Clock.TodayFor(cfg, caller), nil
	}
	parsed, err := clock.ParseDate(value)
	if err != nil {
		return parsed, problem.ValidationFailed(problem.InvalidFormat.AtParameter("query", param, "must be YYYY-MM-DD"))
	}
	return parsed, nil
}
