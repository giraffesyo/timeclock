package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/giraffesyo/timeclock/internal/clock"
	"github.com/google/uuid"
	"github.com/parallelworks/foundation/problem"
)

func registerIntegrations(a huma.API, d Deps) {
	admin := func(ctx context.Context) (clock.Actor, error) {
		actor, err := d.actor(ctx)
		if err != nil {
			return actor, err
		}
		if !actor.Admin {
			return actor, problem.Status(http.StatusForbidden, "only an admin manages integrations").AsDenial()
		}
		return actor, nil
	}
	huma.Register(a, op(http.MethodGet, "/integrations/toggl", "get-toggl", "Toggl connection and sync issues", "Integrations"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body clock.TogglStatus }, error) {
			actor, err := admin(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.Toggl.Status(ctx, d.clock(ctx), actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.TogglStatus }{out}, nil
		})
	huma.Register(a, op(http.MethodPost, "/integrations/toggl/preview", "preview-toggl", "Find Toggl workspaces and suggest person matches without saving credentials", "Integrations"),
		func(ctx context.Context, in *struct {
			Body struct {
				Token       string `json:"token" maxLength:"256"`
				WorkspaceID int64  `json:"workspaceId" minimum:"0"`
			}
		}) (*struct{ Body clock.TogglPreview }, error) {
			actor, err := admin(ctx)
			if err != nil {
				return nil, err
			}
			people, err := d.Directory.People(ctx)
			if err != nil {
				return nil, problem.Status(http.StatusServiceUnavailable, "the directory is unavailable").WithCause(err)
			}
			if err = d.clock(ctx).SyncAll(ctx, people); err != nil {
				return nil, err
			}
			out, err := d.Toggl.Preview(ctx, d.clock(ctx), actor, in.Body.Token, in.Body.WorkspaceID)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.TogglPreview }{out}, nil
		})
	huma.Register(a, op(http.MethodPut, "/integrations/toggl", "configure-toggl", "Connect Toggl and confirm person matches", "Integrations"),
		func(ctx context.Context, in *struct{ Body clock.TogglSetup }) (*struct{ Body clock.TogglStatus }, error) {
			actor, err := admin(ctx)
			if err != nil {
				return nil, err
			}
			if err = d.Toggl.Configure(ctx, d.clock(ctx), actor, in.Body); err != nil {
				return nil, err
			}
			out, err := d.Toggl.Status(ctx, d.clock(ctx), actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.TogglStatus }{out}, nil
		})
	huma.Register(a, op(http.MethodPost, "/integrations/toggl/sync", "sync-toggl", "Request a background sync, respecting API backoff", "Integrations"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body clock.TogglStatus }, error) {
			actor, err := admin(ctx)
			if err != nil {
				return nil, err
			}
			if err = d.Toggl.RequestSync(ctx, d.clock(ctx), actor); err != nil {
				return nil, err
			}
			out, err := d.Toggl.Status(ctx, d.clock(ctx), actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.TogglStatus }{out}, nil
		})
	huma.Register(a, op(http.MethodDelete, "/integrations/toggl", "disconnect-toggl", "Remove Toggl credentials and mappings while keeping recorded time", "Integrations"),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			actor, err := admin(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.Toggl.Disconnect(ctx, d.clock(ctx), actor)
		})
	huma.Register(a, op(http.MethodPost, "/integrations/toggl/entries/{id}/resolve", "resolve-toggl-entry", "Resolve a sync conflict or recover an uncertain creation", "Integrations"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body clock.TogglResolution
		}) (*struct{}, error) {
			actor, err := admin(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.Toggl.Resolve(ctx, d.clock(ctx), actor, in.ID, in.Body)
		})
}
