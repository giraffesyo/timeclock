package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/parallelworks/foundation/problem"

	"github.com/giraffesyo/timeclock/internal/clock"
)

// --- Me ---

type meBody struct {
	Person    clock.Person   `json:"person"`
	AvatarURL string         `json:"avatarUrl,omitempty" doc:"The caller's profile image from the host directory; absent uses initials."`
	Admin     bool           `json:"admin" doc:"Runs payroll: sees everyone, approves anything, changes settings, exports reports."`
	Manager   bool           `json:"manager" doc:"Has people whose time they approve."`
	Settings  clock.Settings `json:"settings"`
	Today     clock.Date     `json:"today" format:"date" doc:"Today in the organization's time zone."`
	Period    clock.Period   `json:"period" doc:"The current pay period."`
	Running   *clock.Entry   `json:"running,omitempty" doc:"The caller's running clock."`
	Info      Info           `json:"info"`
}

func registerMe(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/me", "get-me", "Who is calling, and how payroll runs", "Me"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body meBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			cfg, err := d.clock(ctx).Settings(ctx)
			if err != nil {
				return nil, err
			}
			people, err := d.clock(ctx).People(ctx, actor)
			if err != nil {
				return nil, err
			}
			running, err := d.clock(ctx).Running(ctx, actor)
			if err != nil {
				return nil, err
			}
			info, err := d.info(ctx)
			if err != nil {
				return nil, err
			}
			today := d.clock(ctx).TodayFor(cfg, actor.Person)
			out := meBody{
				Person: actor.Person, AvatarURL: actor.AvatarURL, Admin: actor.Admin, Settings: cfg, Today: today,
				Period: cfg.PeriodOf(today), Running: running, Info: info,
			}
			for _, p := range people {
				if p.ManagerID == actor.ID && p.ID != actor.ID {
					out.Manager = true
					break
				}
			}
			return &struct{ Body meBody }{out}, nil
		})
}

// --- Settings ---

func registerSettings(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodPut, "/theme", "set-theme", "Set the workspace's look; an empty theme goes back to the host's or Timeclock's own", "Settings"),
		func(ctx context.Context, in *struct{ Body clock.Theme }) (*struct{ Body Info }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			if _, err := d.clock(ctx).SetTheme(ctx, actor, in.Body); err != nil {
				return nil, err
			}
			info, err := d.info(ctx)
			if err != nil {
				return nil, err
			}
			return &struct{ Body Info }{info}, nil
		})

	huma.Register(a, op(http.MethodPut, "/settings", "update-settings", "Change how payroll runs", "Settings"),
		func(ctx context.Context, in *struct{ Body clock.Settings }) (*struct{ Body clock.Settings }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).UpdateSettings(ctx, actor, in.Body)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.Settings }{out}, nil
		})
}

// --- Holidays ---

func registerHolidays(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/holidays", "list-holidays", "The company's holidays, by their first day", "Settings"),
		func(ctx context.Context, _ *struct{}) (*struct {
			Body struct {
				Holidays []clock.Holiday `json:"holidays"`
			}
		}, error) {
			if _, err := d.actor(ctx); err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).Holidays(ctx)
			if err != nil {
				return nil, err
			}
			out := &struct {
				Body struct {
					Holidays []clock.Holiday `json:"holidays"`
				}
			}{}
			out.Body.Holidays = orEmpty(list)
			return out, nil
		})

	saveHoliday := func(ctx context.Context, id uuid.UUID, in clock.HolidayInput) (*struct{ Body clock.Holiday }, error) {
		actor, err := d.actor(ctx)
		if err != nil {
			return nil, err
		}
		out, err := d.clock(ctx).SaveHoliday(ctx, actor, id, in)
		if err != nil {
			return nil, err
		}
		return &struct{ Body clock.Holiday }{out}, nil
	}
	huma.Register(a, op(http.MethodPost, "/holidays", "create-holiday", "Add a company holiday", "Settings"),
		func(ctx context.Context, in *struct{ Body clock.HolidayInput }) (*struct{ Body clock.Holiday }, error) {
			return saveHoliday(ctx, uuid.Nil, in.Body)
		})
	huma.Register(a, op(http.MethodPut, "/holidays/{id}", "update-holiday", "Rename a company holiday or change its days", "Settings"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body clock.HolidayInput
		}) (*struct{ Body clock.Holiday }, error) {
			return saveHoliday(ctx, in.ID, in.Body)
		})
	huma.Register(a, op(http.MethodDelete, "/holidays/{id}", "delete-holiday", "Remove a company holiday", "Settings"),
		func(ctx context.Context, in *struct {
			ID uuid.UUID `path:"id"`
		}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).DeleteHoliday(ctx, actor, in.ID)
		})
}

// --- People ---

type peopleBody struct {
	People []clock.Person `json:"people"`
}

func registerPeople(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/people", "list-people", "The people whose time the caller may see", "People"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body peopleBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			people, err := d.clock(ctx).People(ctx, actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body peopleBody }{peopleBody{People: orEmpty(people)}}, nil
		})

	huma.Register(a, op(http.MethodPost, "/people/sync", "sync-people", "Bring in everyone from the directory", "People"),
		func(ctx context.Context, _ *struct{}) (*struct{ Body peopleBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			if !actor.Admin {
				return nil, problem.Status(http.StatusForbidden, "only an admin syncs people").AsDenial()
			}
			all, err := d.Directory.People(ctx)
			if err != nil {
				return nil, problem.Status(http.StatusServiceUnavailable, "the directory is unavailable").WithCause(err)
			}
			if err := d.clock(ctx).SyncAll(ctx, all); err != nil {
				return nil, err
			}
			people, err := d.clock(ctx).People(ctx, actor)
			if err != nil {
				return nil, err
			}
			return &struct{ Body peopleBody }{peopleBody{People: orEmpty(people)}}, nil
		})

	huma.Register(a, op(http.MethodPut, "/me/timezone", "set-own-timezone", "Set the time zone the caller's days are cut in", "Me"),
		func(ctx context.Context, in *struct {
			Body struct {
				Timezone string `json:"timezone" doc:"An IANA time zone. Empty uses the organization's." example:"America/Los_Angeles"`
			}
		}) (*struct{ Body clock.Person }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).SetOwnTimezone(ctx, actor, in.Body.Timezone)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.Person }{out}, nil
		})

	huma.Register(a, op(http.MethodPut, "/people/{id}", "update-person", "Set a person's manager and payroll details", "People"),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body clock.PersonUpdate
		}) (*struct{ Body clock.Person }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).UpdatePerson(ctx, actor, in.ID, in.Body)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.Person }{out}, nil
		})

	huma.Register(a, op(http.MethodPut, "/people/{id}/admin", "set-person-admin", "Make someone an admin in Timeclock, or take it back", "People"),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Admin bool `json:"admin" doc:"Grant admin here. Someone the host makes an admin stays one either way."`
			}
		}) (*struct{ Body clock.Person }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).SetAdmin(ctx, actor, in.ID, in.Body.Admin)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.Person }{out}, nil
		})
}

// --- Customers and projects ---

type customerInput struct {
	Name     string `json:"name" minLength:"1" maxLength:"120"`
	Archived bool   `json:"archived,omitempty"`
}

type archivedQuery struct {
	Archived bool `query:"archived" doc:"Include archived ones."`
}

func registerCatalog(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/customers", "list-customers", "Customers", "Projects"),
		func(ctx context.Context, in *archivedQuery) (*struct {
			Body struct {
				Customers []clock.Customer `json:"customers"`
			}
		}, error) {
			if _, err := d.actor(ctx); err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).Customers(ctx, in.Archived)
			if err != nil {
				return nil, err
			}
			out := &struct {
				Body struct {
					Customers []clock.Customer `json:"customers"`
				}
			}{}
			out.Body.Customers = orEmpty(list)
			return out, nil
		})

	saveCustomer := func(ctx context.Context, id uuid.UUID, in customerInput) (*struct{ Body clock.Customer }, error) {
		actor, err := d.actor(ctx)
		if err != nil {
			return nil, err
		}
		out, err := d.clock(ctx).SaveCustomer(ctx, actor, id, in.Name, in.Archived)
		if err != nil {
			return nil, err
		}
		return &struct{ Body clock.Customer }{out}, nil
	}
	huma.Register(a, op(http.MethodPost, "/customers", "create-customer", "Add a customer", "Projects"),
		func(ctx context.Context, in *struct{ Body customerInput }) (*struct{ Body clock.Customer }, error) {
			return saveCustomer(ctx, uuid.Nil, in.Body)
		})
	huma.Register(a, op(http.MethodPut, "/customers/{id}", "update-customer", "Rename or archive a customer", "Projects"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body customerInput
		}) (*struct{ Body clock.Customer }, error) {
			return saveCustomer(ctx, in.ID, in.Body)
		})
	huma.Register(a, op(http.MethodDelete, "/customers/{id}", "delete-customer", "Delete a customer with no projects", "Projects"),
		func(ctx context.Context, in *struct {
			ID uuid.UUID `path:"id"`
		}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).DeleteCustomer(ctx, actor, in.ID)
		})

	huma.Register(a, op(http.MethodGet, "/projects", "list-projects", "Projects, by customer", "Projects"),
		func(ctx context.Context, in *archivedQuery) (*struct {
			Body struct {
				Projects []clock.Project `json:"projects"`
			}
		}, error) {
			if _, err := d.actor(ctx); err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).Projects(ctx, in.Archived)
			if err != nil {
				return nil, err
			}
			out := &struct {
				Body struct {
					Projects []clock.Project `json:"projects"`
				}
			}{}
			out.Body.Projects = orEmpty(list)
			return out, nil
		})

	saveProject := func(ctx context.Context, id uuid.UUID, in clock.ProjectInput) (*struct{ Body clock.Project }, error) {
		actor, err := d.actor(ctx)
		if err != nil {
			return nil, err
		}
		out, err := d.clock(ctx).SaveProject(ctx, actor, id, in)
		if err != nil {
			return nil, err
		}
		return &struct{ Body clock.Project }{out}, nil
	}
	huma.Register(a, op(http.MethodPost, "/projects", "create-project", "Add a project", "Projects"),
		func(ctx context.Context, in *struct{ Body clock.ProjectInput }) (*struct{ Body clock.Project }, error) {
			return saveProject(ctx, uuid.Nil, in.Body)
		})
	huma.Register(a, op(http.MethodPut, "/projects/{id}", "update-project", "Change or archive a project", "Projects"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body clock.ProjectInput
		}) (*struct{ Body clock.Project }, error) {
			return saveProject(ctx, in.ID, in.Body)
		})
	huma.Register(a, op(http.MethodDelete, "/projects/{id}", "delete-project", "Delete a project with no time on it", "Projects"),
		func(ctx context.Context, in *struct {
			ID uuid.UUID `path:"id"`
		}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).DeleteProject(ctx, actor, in.ID)
		})
}

// --- Entries and the clock ---

type rangeQuery struct {
	Person string `query:"person" doc:"Whose. Defaults to the caller."`
	From   string `query:"from" format:"date" required:"true"`
	To     string `query:"to" format:"date" required:"true"`
}

func (q rangeQuery) dates() (from, to clock.Date, err error) {
	if from, err = clock.ParseDate(q.From); err != nil {
		return from, to, problem.ValidationFailed(problem.InvalidFormat.AtParameter("query", "from", "must be YYYY-MM-DD"))
	}
	if to, err = clock.ParseDate(q.To); err != nil {
		return from, to, problem.ValidationFailed(problem.InvalidFormat.AtParameter("query", "to", "must be YYYY-MM-DD"))
	}
	return from, to, nil
}

type entryBody struct{ Body clock.Entry }

type recentWorkBody struct {
	Body struct {
		Recent []clock.RecentWork `json:"recent" doc:"Each note with the project it was on, once."`
	}
}

func registerEntries(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodPost, "/clock/in", "clock-in", "Start the caller's clock", "Clock"),
		func(ctx context.Context, in *struct {
			Body struct {
				ProjectID *uuid.UUID `json:"projectId,omitempty"`
				Note      string     `json:"note,omitempty" maxLength:"2000"`
			}
		}) (*entryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).ClockIn(ctx, actor, in.Body.ProjectID, in.Body.Note)
			if err != nil {
				return nil, err
			}
			return &entryBody{out}, nil
		})

	huma.Register(a, op(http.MethodPost, "/clock/switch", "clock-switch", "Move the caller's running clock to other work", "Clock"),
		func(ctx context.Context, in *struct {
			Body struct {
				ProjectID *uuid.UUID `json:"projectId,omitempty"`
				Note      string     `json:"note,omitempty" maxLength:"2000"`
			}
		}) (*entryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).Switch(ctx, actor, in.Body.ProjectID, in.Body.Note)
			if err != nil {
				return nil, err
			}
			return &entryBody{out}, nil
		})

	huma.Register(a, op(http.MethodPost, "/clock/out", "clock-out", "Stop the caller's clock", "Clock"),
		func(ctx context.Context, _ *struct{}) (*entryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).ClockOut(ctx, actor)
			if err != nil {
				return nil, err
			}
			return &entryBody{out}, nil
		})

	huma.Register(a, op(http.MethodGet, "/entries", "list-entries", "A person's time on a range of days", "Entries"),
		func(ctx context.Context, in *rangeQuery) (*struct {
			Body struct {
				Entries []clock.Entry `json:"entries"`
			}
		}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			from, to, err := in.dates()
			if err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).Entries(ctx, actor, in.Person, from, to)
			if err != nil {
				return nil, err
			}
			out := &struct {
				Body struct {
					Entries []clock.Entry `json:"entries"`
				}
			}{}
			out.Body.Entries = orEmpty(list)
			return out, nil
		})

	huma.Register(a, op(http.MethodGet, "/entries/recent", "list-recent-work", "What the caller has tracked before, most recent first", "Entries"),
		func(ctx context.Context, _ *struct{}) (*recentWorkBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).RecentWork(ctx, actor, 200)
			if err != nil {
				return nil, err
			}
			out := &recentWorkBody{}
			out.Body.Recent = orEmpty(list)
			return out, nil
		})

	huma.Register(a, op(http.MethodPost, "/entries", "create-entry", "Record finished time by hand", "Entries"),
		func(ctx context.Context, in *struct{ Body clock.EntryInput }) (*entryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).CreateEntry(ctx, actor, in.Body)
			if err != nil {
				return nil, err
			}
			return &entryBody{out}, nil
		})

	huma.Register(a, op(http.MethodPut, "/entries/{id}", "update-entry", "Change an entry", "Entries"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body clock.EntryInput
		}) (*entryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).UpdateEntry(ctx, actor, in.ID, in.Body)
			if err != nil {
				return nil, err
			}
			return &entryBody{out}, nil
		})

	huma.Register(a, op(http.MethodDelete, "/entries/{id}", "delete-entry", "Delete an entry", "Entries"),
		func(ctx context.Context, in *struct {
			ID uuid.UUID `path:"id"`
		}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).DeleteEntry(ctx, actor, in.ID)
		})
}

// --- Time off ---

type timeOffListBody struct {
	Body struct {
		TimeOff []clock.TimeOff `json:"timeOff"`
	}
}

type decision struct {
	Approve bool   `json:"approve" doc:"False sends it back."`
	Note    string `json:"note,omitempty" maxLength:"2000"`
}

func registerTimeOff(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/time-off", "list-time-off", "A person's time off on a range of days", "Time off"),
		func(ctx context.Context, in *rangeQuery) (*timeOffListBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			from, to, err := in.dates()
			if err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).TimeOff(ctx, actor, in.Person, from, to)
			if err != nil {
				return nil, err
			}
			out := &timeOffListBody{}
			out.Body.TimeOff = orEmpty(list)
			return out, nil
		})

	huma.Register(a, op(http.MethodGet, "/time-off/pending", "list-pending-time-off", "Time off waiting for the caller's decision", "Time off"),
		func(ctx context.Context, _ *struct{}) (*timeOffListBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).PendingTimeOff(ctx, actor)
			if err != nil {
				return nil, err
			}
			out := &timeOffListBody{}
			out.Body.TimeOff = orEmpty(list)
			return out, nil
		})

	huma.Register(a, op(http.MethodPost, "/time-off", "request-time-off", "Record vacation or sick time on a run of days", "Time off"),
		func(ctx context.Context, in *struct{ Body clock.TimeOffInput }) (*timeOffListBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			list, err := d.clock(ctx).RequestTimeOff(ctx, actor, in.Body)
			if err != nil {
				return nil, err
			}
			out := &timeOffListBody{}
			out.Body.TimeOff = list
			return out, nil
		})

	huma.Register(a, op(http.MethodDelete, "/time-off/{id}", "cancel-time-off", "Remove a day of time off", "Time off"),
		func(ctx context.Context, in *struct {
			ID uuid.UUID `path:"id"`
		}) (*struct{}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			return nil, d.clock(ctx).CancelTimeOff(ctx, actor, in.ID)
		})

	huma.Register(a, op(http.MethodPost, "/time-off/{id}/decision", "decide-time-off", "Approve or reject time off", "Time off"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body decision
		}) (*struct{ Body clock.TimeOff }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).DecideTimeOff(ctx, actor, in.ID, in.Body.Approve, in.Body.Note)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.TimeOff }{out}, nil
		})
}

// --- Timesheets ---

type dayQuery struct {
	Person string `query:"person" doc:"Whose. Defaults to the caller."`
	Day    string `query:"day" format:"date" doc:"Any day in the pay period. Defaults to today."`
}

type summaryBody struct{ Body clock.PeriodSummary }

type teamBody struct {
	Body struct {
		Period  clock.Period          `json:"period"`
		Members []clock.PeriodSummary `json:"members"`
	}
}

func registerTimesheets(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/timesheet", "get-timesheet", "A person's pay period: hours by day and its timesheet", "Timesheets"),
		func(ctx context.Context, in *dayQuery) (*summaryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			day, err := d.day(ctx, actor.Person, "day", in.Day)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).Summary(ctx, actor, in.Person, day)
			if err != nil {
				return nil, err
			}
			return &summaryBody{out}, nil
		})

	huma.Register(a, op(http.MethodPost, "/timesheet/submit", "submit-timesheet", "State that a pay period's time is complete", "Timesheets"),
		func(ctx context.Context, in *struct {
			Body struct {
				PersonID string     `json:"personId,omitempty" doc:"Whose. Defaults to the caller."`
				Day      clock.Date `json:"day" format:"date" doc:"Any day in the pay period."`
			}
		}) (*summaryBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).Submit(ctx, actor, in.Body.PersonID, in.Body.Day)
			if err != nil {
				return nil, err
			}
			return &summaryBody{out}, nil
		})

	huma.Register(a, op(http.MethodPost, "/timesheets/{id}/decision", "decide-timesheet", "Approve a timesheet or send it back", "Timesheets"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body decision
		}) (*struct{ Body clock.Timesheet }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).Decide(ctx, actor, in.ID, in.Body.Approve, in.Body.Note)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.Timesheet }{out}, nil
		})

	huma.Register(a, op(http.MethodPost, "/timesheets/{id}/reopen", "reopen-timesheet", "Unlock a timesheet so its time can be corrected", "Timesheets"),
		func(ctx context.Context, in *struct {
			ID   uuid.UUID `path:"id"`
			Body struct {
				Note string `json:"note,omitempty" maxLength:"2000"`
			}
		}) (*struct{ Body clock.Timesheet }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			out, err := d.clock(ctx).Reopen(ctx, actor, in.ID, in.Body.Note)
			if err != nil {
				return nil, err
			}
			return &struct{ Body clock.Timesheet }{out}, nil
		})

	huma.Register(a, op(http.MethodGet, "/team", "get-team", "The pay period of everyone whose time the caller may see", "Timesheets"),
		func(ctx context.Context, in *struct {
			Day string `query:"day" format:"date" doc:"Any day in the pay period. Defaults to today."`
		}) (*teamBody, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			day, err := d.day(ctx, actor.Person, "day", in.Day)
			if err != nil {
				return nil, err
			}
			cfg, err := d.clock(ctx).Settings(ctx)
			if err != nil {
				return nil, err
			}
			members, err := d.clock(ctx).Team(ctx, actor, day)
			if err != nil {
				return nil, err
			}
			out := &teamBody{}
			out.Body.Period, out.Body.Members = cfg.PeriodOf(day), orEmpty(members)
			return out, nil
		})
}

// orEmpty makes a nil list an empty one, so JSON has [] and not null.
func orEmpty[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}
