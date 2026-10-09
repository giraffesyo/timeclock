package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/parallelworks/foundation/problem"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
	"github.com/giraffesyo/timeclock/internal/ical"
	"github.com/giraffesyo/timeclock/internal/messages"
)

// The days a feed lists, around today: what a subscriber looks back on, and
// ahead to.
const (
	feedPastDays   = 90
	feedFutureDays = 400
)

// feedRefresh is how often subscribers are asked to fetch the feed again.
const feedRefresh = time.Hour

// feedPath is where a feed with this secret is, under the base path.
const feedPath = Prefix + "/calendar/feeds/"

type calendarFeedBody struct {
	clock.CalendarFeedStatus
	Path string `json:"path,omitempty" doc:"The feed's address under the origin, set only when it was just made: it can't be read again."`
}

type icsResponse struct {
	ContentType  string `header:"Content-Type"`
	CacheControl string `header:"Cache-Control"`
	Body         []byte
}

func registerCalendarFeed(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/calendar/feed", "get-calendar-feed", "Whether the caller has a calendar feed", "Calendar"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body calendarFeedBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			status, err := d.clock(ctx).CalendarFeed(ctx, actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body calendarFeedBody }{calendarFeedBody{CalendarFeedStatus: status}}, nil
		})

	huma.Register(a, op(http.MethodPost, "/calendar/feed", "create-calendar-feed", "Make the caller a calendar feed of holidays and who is out, replacing any they had", "Calendar"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body calendarFeedBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			token, status, err := d.clock(ctx).NewCalendarFeed(ctx, actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body calendarFeedBody }{calendarFeedBody{
				CalendarFeedStatus: status,
				Path:               strings.TrimRight(d.BasePath, "/") + feedPath + token + ".ics",
			}}, nil
		})

	huma.Register(a, op(http.MethodDelete, "/calendar/feed", "stop-calendar-feed", "Turn the caller's calendar feed off", "Calendar"),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).StopCalendarFeed(ctx, actor)
		})

	// A calendar app fetches this signed out: the secret in the address is
	// who it is for, and which workspace.
	huma.Register(a, op(http.MethodGet, "/calendar/feeds/{file}", "calendar-feed", "A calendar feed, as iCalendar, of company holidays and who is out", "Calendar"),
		func(ctx context.Context, in *struct {
			File string `path:"file" doc:"The feed's secret, then .ics."`
		}) (*icsResponse, error) {
			token, ok := strings.CutSuffix(in.File, ".ics")
			if !ok || token == "" {
				return nil, problem.Status(http.StatusNotFound, "calendar feed not found")
			}
			owner, err := d.Clock.CalendarFeedOwner(ctx, token)
			if err != nil {
				return nil, err
			}
			// Whoever made it has to still be someone here.
			ctx = host.WithWorkspace(WithWorkspace(ctx, owner.Workspace.ID), owner.Workspace.Key)
			hp, err := d.Directory.Person(ctx, owner.PersonID)
			if errors.Is(err, host.ErrNotFound) {
				return nil, problem.Status(http.StatusNotFound, "calendar feed not found")
			}
			if err != nil {
				return nil, problem.Status(http.StatusServiceUnavailable, "the directory is unavailable").WithCause(err)
			}
			s := d.clock(ctx)
			actor, err := s.Sync(ctx, hp)
			if err != nil {
				return nil, err
			}
			if !actor.Active {
				return nil, problem.Status(http.StatusNotFound, "calendar feed not found")
			}
			cfg, err := s.Settings(ctx)
			if err != nil {
				return nil, err
			}
			today := s.TodayFor(cfg, actor.Person)
			from, to := today.AddDays(-feedPastDays), today.AddDays(feedFutureDays)
			holidays, err := s.Holidays(ctx)
			if err != nil {
				return nil, err
			}
			absences, err := s.Absences(ctx, from, to)
			if err != nil {
				return nil, err
			}
			workspace := owner.Workspace.Name
			if workspace == "" {
				workspace = messages.T("invite.defaultWorkspace", nil)
			}
			cal := ical.Calendar{
				Name:        messages.T("feed.name", messages.Args{"workspace": workspace}),
				Description: messages.T("feed.description", nil),
				Refresh:     feedRefresh,
				Events:      append(holidayEvents(holidays, from, to), absenceEvents(absences, actor.ID)...),
			}
			return &icsResponse{
				ContentType:  "text/calendar; charset=utf-8",
				CacheControl: "private, max-age=300",
				Body:         ical.Encode(cal, time.Now()),
			}, nil
		})
}

// holidayEvents is each holiday's runs of days in from..to.
func holidayEvents(holidays []clock.Holiday, from, to clock.Date) []ical.Event {
	var out []ical.Event
	for _, h := range holidays {
		var days []clock.HolidayDay
		for _, day := range h.Days {
			if !day.Day.Before(from) && !day.Day.After(to) {
				days = append(days, day)
			}
		}
		for _, run := range runs(days, func(a, b clock.HolidayDay) bool { return true }) {
			start, end := run[0].Day, run[len(run)-1].Day
			out = append(out, ical.Event{
				UID:     "holiday-" + h.ID.String() + "-" + start.String() + "@timeclock",
				Summary: h.Name,
				Start:   start.Time(), End: end.Time(),
			})
		}
	}
	return out
}

// absenceEvents is who is out, a run of days to an event. The subscriber's
// own say vacation or sick; anyone else's only that they are out, adding
// up their time off on a day.
func absenceEvents(absences []clock.Absence, self string) []ical.Event {
	type key struct{ person, kind string }
	type out struct {
		name string
		days map[clock.Date]float64
	}
	byKey := map[key]*out{}
	var keys []key
	for _, a := range absences {
		k := key{person: a.PersonID}
		if a.PersonID == self {
			k.kind = a.Kind
		}
		o, ok := byKey[k]
		if !ok {
			o = &out{name: a.PersonName, days: map[clock.Date]float64{}}
			byKey[k] = o
			keys = append(keys, k)
		}
		o.days[a.Day] = min(o.days[a.Day]+a.Hours, 24)
	}
	var events []ical.Event
	for _, k := range keys {
		o := byKey[k]
		days := make([]clock.HolidayDay, 0, len(o.days))
		for day, hours := range o.days {
			days = append(days, clock.HolidayDay{Day: day, Hours: hours})
		}
		sort.Slice(days, func(i, j int) bool { return days[i].Day.Before(days[j].Day) })
		var title string
		switch k.kind {
		case "vacation":
			title = messages.T("feed.vacation", nil)
		case "sick":
			title = messages.T("feed.sick", nil)
		default:
			title = messages.T("feed.out", messages.Args{"name": o.name})
		}
		for _, run := range runs(days, func(a, b clock.HolidayDay) bool { return a.Hours == b.Hours }) {
			start, end := run[0].Day, run[len(run)-1].Day
			summary := title
			if h := run[0].Hours; h < clock.HolidayHours {
				summary = messages.T("feed.partial", messages.Args{"title": title, "hours": strconv.FormatFloat(h, 'f', -1, 64)})
			}
			// Opaque, so the raw feed doesn't say what kind of time off it is.
			id := sha256.Sum256([]byte(k.person + "\x00" + k.kind + "\x00" + start.String()))
			events = append(events, ical.Event{
				UID:     "out-" + hex.EncodeToString(id[:12]) + "@timeclock",
				Summary: summary,
				Start:   start.Time(), End: end.Time(),
			})
		}
	}
	return events
}

// runs splits days, in order, into runs of consecutive days that belong
// together.
func runs(days []clock.HolidayDay, together func(a, b clock.HolidayDay) bool) [][]clock.HolidayDay {
	var out [][]clock.HolidayDay
	for i, day := range days {
		if i > 0 {
			prev := days[i-1]
			if prev.Day.AddDays(1) == day.Day && together(prev, day) {
				out[len(out)-1] = append(out[len(out)-1], day)
				continue
			}
		}
		out = append(out, []clock.HolidayDay{day})
	}
	return out
}
