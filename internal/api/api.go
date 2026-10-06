// Package api is Timeclock's HTTP API, defined with huma. Its OpenAPI
// document is served at /api/openapi.json.
package api

import (
	"context"
	"errors"
	"github.com/google/uuid"
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
	// AccountsURL is where a standalone server manages its own accounts:
	// the workspaces to switch between, invitations and passwords. Empty
	// when a host application has its own users.
	AccountsURL string `json:"accountsUrl,omitempty"`
	// APIKeysURL is where a person creates an API key for the CLI, when the
	// host signs it in with one instead of through the browser.
	APIKeysURL string `json:"apiKeysUrl,omitempty" format:"uri"`
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
	Toggl     *clock.Toggl
	Clock     *clock.Service
	Directory host.Directory
	Info      Info
	// HostTheme is the host application's look, which a workspace's own overrides.
	HostTheme host.Theme
}

type callerKey struct{}

type workspaceKey struct{}

// WithWorkspace returns ctx carrying the workspace a request is in.
func WithWorkspace(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, workspaceKey{}, id)
}

// clock is the service for the request's workspace. Without one its queries
// are refused, so nothing is read or written across workspaces by default.
func (d Deps) clock(ctx context.Context) *clock.Service {
	id, _ := ctx.Value(workspaceKey{}).(uuid.UUID)
	return d.Clock.In(id)
}

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
	return d.clock(ctx).Sync(ctx, hp)
}

// info is Info with the look in force: each scheme the workspace's if an
// admin set it, and the host's if not.
func (d Deps) info(ctx context.Context) (Info, error) {
	out := d.Info
	workspace, err := d.clock(ctx).Theme(ctx)
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
	registerIntegrations(a, deps)
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
		cfg, err := d.clock(ctx).Settings(ctx)
		if err != nil {
			return clock.Date{}, err
		}
		return d.clock(ctx).TodayFor(cfg, caller), nil
	}
	parsed, err := clock.ParseDate(value)
	if err != nil {
		return parsed, problem.ValidationFailed(problem.InvalidFormat.AtParameter("query", param, "must be YYYY-MM-DD"))
	}
	return parsed, nil
}
