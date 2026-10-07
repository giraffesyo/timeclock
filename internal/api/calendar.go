package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/parallelworks/foundation/problem"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/gcal"
)

// GoogleCalendar returns credentials to read a person's Google Calendar, or
// ok false when they have none.
type GoogleCalendar func(ctx context.Context, p host.Person) (ts oauth2.TokenSource, ok bool, err error)

// CalendarEvent is an event on the caller's calendar, which the week offers
// as time to add.
type CalendarEvent struct {
	ID        string    `json:"id"`
	Title     string    `json:"title" doc:"Empty for an event without one."`
	Link      string    `json:"link,omitempty" format:"uri" doc:"Opens the event in Google Calendar."`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt"`
}

type calendarBody struct {
	Connected bool            `json:"connected" doc:"Whether the caller has a calendar to read; false lists no events."`
	Calendar  string          `json:"calendar,omitempty" doc:"The calendar's name, normally its owner's email address."`
	Events    []CalendarEvent `json:"events"`
}

// The most days one request reads, a little over a month.
const calendarDays = 42

func registerCalendar(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/calendar/events", "list-calendar-events", "The caller's Google Calendar events on a range of days", "Entries"),
		func(ctx context.Context, in *struct {
			From string `query:"from" format:"date" required:"true"`
			To   string `query:"to" format:"date" required:"true"`
		}) (*struct{ Body calendarBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			from, to, err := rangeQuery{From: in.From, To: in.To}.dates()
			if err != nil {
				return nil, err
			}
			if to.Before(from) || from.AddDays(calendarDays).Before(to) {
				return nil, problem.ValidationFailed(problem.Invalid.AtParameter("query", "to", "must be on or after from, and at most 42 days later"))
			}
			out := &struct{ Body calendarBody }{Body: calendarBody{Events: []CalendarEvent{}}}
			if d.Calendar == nil {
				return out, nil
			}
			// The person as the host knows them, which is whose calendar it is.
			id, _ := ctx.Value(callerKey{}).(string)
			hp, err := d.Directory.Person(ctx, id)
			if err != nil {
				return nil, problem.Status(http.StatusServiceUnavailable, "the directory is unavailable").WithCause(err)
			}
			ts, ok, err := d.Calendar(ctx, hp)
			if err != nil {
				return nil, problem.Status(http.StatusServiceUnavailable, "Google Calendar is unavailable").WithCause(err)
			}
			if !ok {
				return out, nil
			}
			cfg, err := d.clock(ctx).Settings(ctx)
			if err != nil {
				return nil, err
			}
			loc := cfg.LocationOf(actor.Person)
			client := &gcal.Client{HTTP: oauth2.NewClient(ctx, ts)}
			cal, err := client.Events(ctx, from.In(loc), to.AddDays(1).In(loc))
			if err != nil {
				msg := "Google Calendar is unavailable"
				if gcal.Denied(err) || errors.Is(err, context.DeadlineExceeded) {
					msg = err.Error()
				}
				return nil, problem.Status(http.StatusBadGateway, msg).WithCause(err)
			}
			out.Body.Connected = true
			out.Body.Calendar = cal.Name
			for _, e := range cal.Events {
				out.Body.Events = append(out.Body.Events, CalendarEvent{
					ID: e.ID, Title: e.Title, Link: e.Link, StartedAt: e.Start.UTC(), EndedAt: e.End.UTC(),
				})
			}
			return out, nil
		})
}
