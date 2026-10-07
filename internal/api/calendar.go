package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/parallelworks/foundation/problem"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
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
	// Meeting names the event wherever it comes round: its series, or a
	// one-off's title. Empty for an untitled one-off, which isn't remembered.
	Meeting string `json:"meeting,omitempty" doc:"Names the event wherever it comes round, for remembering its project."`
	// Remembered is a meeting the caller has copied before: copies go to
	// ProjectID at once.
	Remembered bool       `json:"remembered" doc:"The caller chose a project for this meeting before: copies go straight to it."`
	ProjectID  *uuid.UUID `json:"projectId,omitempty" doc:"The remembered project; absent with remembered is no project."`
}

// meetingOf names an event wherever it comes round.
func meetingOf(e gcal.Event) string {
	if e.SeriesID != "" {
		return "series:" + e.SeriesID
	}
	if title := strings.ToLower(strings.Join(strings.Fields(e.Title), " ")); title != "" {
		return "title:" + title
	}
	return ""
}

type calendarBody struct {
	Connected   bool            `json:"connected" doc:"Whether the caller has a calendar to read; false lists no events."`
	Connectable bool            `json:"connectable" doc:"Whether the caller can connect their own calendar: the host doesn't read it for them, and Timeclock has a Google client."`
	Calendar    string          `json:"calendar,omitempty" doc:"The calendar's name, normally its owner's email address."`
	Events      []CalendarEvent `json:"events"`
}

type googleStatusBody struct {
	clock.GoogleCalendarStatus
	Managed     bool `json:"managed" doc:"The host application reads the caller's calendar for them, so there is nothing to connect."`
	Connectable bool `json:"connectable" doc:"Whether the caller can connect, or disconnect, their own calendar."`
}

// The most days one request reads, a little over a month.
const calendarDays = 42

// calendarSettings is where a person manages their calendar, under the base path.
const calendarSettings = "/settings?tab=calendar"

type redirect struct {
	Status   int
	Location string `header:"Location"`
}

func registerCalendar(a huma.API, d Deps) {
	// source is the caller's credentials: the host's for them, or else their
	// own connection. managed says which.
	source := func(ctx context.Context, actor clock.Actor) (ts oauth2.TokenSource, ok, managed bool, err error) {
		if d.Calendar != nil {
			// The person as the host knows them, which is whose calendar it is.
			id, _ := ctx.Value(callerKey{}).(string)
			hp, err := d.Directory.Person(ctx, id)
			if err != nil {
				return nil, false, false, problem.Status(http.StatusServiceUnavailable, "the directory is unavailable").WithCause(err)
			}
			ts, ok, err = d.Calendar(ctx, hp)
			if err != nil {
				return nil, false, false, problem.Status(http.StatusServiceUnavailable, "Google Calendar is unavailable").WithCause(err)
			}
			if ok {
				return ts, true, true, nil
			}
		}
		if d.Google == nil {
			return nil, false, false, nil
		}
		ts, ok, err = d.Google.TokenSource(ctx, d.clock(ctx), actor)
		return ts, ok, false, err
	}

	huma.Register(a, op(http.MethodGet, "/calendar/events", "list-calendar-events", "The caller's Google Calendar events on a range of days", "Calendar"),
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
			ts, ok, managed, err := source(ctx, actor)
			if err != nil {
				return nil, err
			}
			out.Body.Connectable = d.Google != nil && !managed
			if !ok {
				return out, nil
			}
			cfg, err := d.clock(ctx).Settings(ctx)
			if err != nil {
				return nil, err
			}
			loc := cfg.LocationOf(actor.Person)
			read := func(ts oauth2.TokenSource) (gcal.Calendar, error) {
				return (&gcal.Client{HTTP: oauth2.NewClient(ctx, ts)}).Events(ctx, from.In(loc), to.AddDays(1).In(loc))
			}
			cal, err := read(ts)
			if err != nil && !managed && gcal.Denied(err) {
				// Google refused an access token it gave, as it does once the
				// person revokes Timeclock's access: try a fresh one, which tells.
				d.Google.Drop(d.clock(ctx), actor)
				if ts, ok, terr := d.Google.TokenSource(ctx, d.clock(ctx), actor); terr == nil && ok {
					cal, err = read(ts)
				}
			}
			if err != nil && !managed && clock.Revoked(err) {
				// They took Timeclock's access back at Google: they can connect again.
				return out, d.Google.Forget(ctx, d.clock(ctx), actor)
			}
			if err != nil {
				msg := "Google Calendar is unavailable"
				if gcal.Denied(err) || errors.Is(err, context.DeadlineExceeded) {
					msg = err.Error()
				}
				return nil, problem.Status(http.StatusBadGateway, msg).WithCause(err)
			}
			out.Body.Connected = true
			out.Body.Calendar = cal.Name
			var meetings []string
			for _, e := range cal.Events {
				if m := meetingOf(e); m != "" {
					meetings = append(meetings, m)
				}
			}
			chosen, err := d.clock(ctx).Meetings(ctx, actor, meetings)
			if err != nil {
				return nil, err
			}
			for _, e := range cal.Events {
				m := meetingOf(e)
				c, remembered := chosen[m]
				out.Body.Events = append(out.Body.Events, CalendarEvent{
					ID: e.ID, Title: e.Title, Link: e.Link, StartedAt: e.Start.UTC(), EndedAt: e.End.UTC(),
					Meeting: m, Remembered: remembered, ProjectID: c.ProjectID,
				})
			}
			return out, nil
		})

	huma.Register(a, op(http.MethodPut, "/calendar/meetings", "remember-calendar-meeting", "Remember the project the caller copies a calendar meeting to", "Calendar"),
		func(ctx context.Context, in *struct {
			Body struct {
				Meeting   string     `json:"meeting" minLength:"1" maxLength:"1024" doc:"The event's meeting, as listed."`
				ProjectID *uuid.UUID `json:"projectId,omitempty" doc:"Absent is no project."`
			}
		}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).RememberMeeting(ctx, actor, in.Body.Meeting, in.Body.ProjectID)
		})

	huma.Register(a, op(http.MethodGet, "/calendar/google", "get-google-calendar", "Whether the caller's Google Calendar is connected", "Calendar"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body googleStatusBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			_, ok, managed, err := source(ctx, actor)
			if err != nil {
				return nil, err
			}
			out := &struct{ Body googleStatusBody }{Body: googleStatusBody{Managed: managed, Connectable: d.Google != nil && !managed}}
			out.Body.Connected = ok
			if out.Body.Connectable {
				if out.Body.GoogleCalendarStatus, err = d.Google.Status(ctx, d.clock(ctx), actor); err != nil {
					return nil, err
				}
			}
			return out, nil
		})

	// Connecting is a visit to Google and back, so these two are pages the
	// browser goes to, not calls the web app makes.
	connect := op(http.MethodGet, "/calendar/google/connect", "connect-google-calendar", "Go to Google to connect the caller's calendar", "Calendar")
	connect.DefaultStatus = http.StatusFound
	huma.Register(a, connect,
		func(ctx context.Context, in *struct {
			Return string `query:"return" doc:"The path in the web app to come back to, such as /settings?tab=calendar."`
		}) (*redirect, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			if d.Google == nil {
				return nil, problem.Status(http.StatusNotFound, "connecting a Google Calendar isn't set up here")
			}
			target, err := d.Google.AuthURL(d.clock(ctx), actor, appPath(in.Return))
			if err != nil {
				return nil, err
			}
			return &redirect{Status: http.StatusFound, Location: target}, nil
		})

	callback := op(http.MethodGet, "/calendar/google/callback", "google-calendar-callback", "Where Google returns the caller after they connect their calendar", "Calendar")
	callback.DefaultStatus = http.StatusFound
	huma.Register(a, callback,
		func(ctx context.Context, in *struct {
			Code  string `query:"code"`
			State string `query:"state"`
			Error string `query:"error" doc:"Set by Google when the caller didn't allow access."`
		}) (*redirect, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			if d.Google == nil {
				return nil, problem.Status(http.StatusNotFound, "connecting a Google Calendar isn't set up here")
			}
			back := func(path string) *redirect {
				return &redirect{Status: http.StatusFound, Location: strings.TrimRight(d.BasePath, "/") + path}
			}
			s := d.clock(ctx)
			returnPath, err := d.Google.Return(s, actor, in.State)
			if err != nil {
				return nil, err
			}
			if in.Error != "" {
				// They didn't allow it: back to their settings, to say so.
				return back(calendarSettings + "&calendar=denied"), nil
			}
			if err := d.Google.Complete(ctx, s, actor, in.Code, in.State); err != nil {
				slog.ErrorContext(ctx, "timeclock: connect a Google Calendar", "error", err)
				return back(calendarSettings + "&calendar=failed"), nil
			}
			return back(returnPath), nil
		})

	huma.Register(a, op(http.MethodDelete, "/calendar/google", "disconnect-google-calendar", "Disconnect the caller's own Google Calendar, and revoke Timeclock's access", "Calendar"),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			if d.Google == nil {
				return nil, nil
			}
			return nil, d.Google.Disconnect(ctx, d.clock(ctx), actor)
		})
}

// appPath is a path in the web app to return to, or the week when it isn't
// one: never another site.
func appPath(p string) string {
	u, err := url.Parse(p)
	if err != nil || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.Contains(p, `\`) || u.Host != "" || u.Scheme != "" {
		return "/"
	}
	return p
}
