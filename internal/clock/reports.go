package clock

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Exceptions lists what payroll should look at in the pay period containing
// day, for the people whose time actor may see.
func (s *Service) Exceptions(ctx context.Context, actor Actor, day Date) ([]Exception, error) {
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	team, err := s.Team(ctx, actor, day)
	if err != nil {
		return nil, err
	}
	today := s.Today(cfg)
	limit := time.Duration(cfg.LongEntryHours * float64(time.Hour))
	loc := cfg.Location()

	out := []Exception{}
	for _, sum := range team {
		p := sum.Person
		add := func(e Exception) {
			e.PersonID, e.PersonName = p.ID, p.Name
			out = append(out, e)
		}

		long, err := s.longEntries(ctx, p.ID, sum.Period, loc, limit)
		if err != nil {
			return nil, err
		}
		for _, e := range long {
			add(e)
		}

		ended := sum.Period.End.Before(today)
		switch {
		case sum.Timesheet == nil && ended && sum.Regular+sum.Overtime+sum.Vacation+sum.Sick+sum.PendingTimeOff == 0 && !sum.Running:
			add(Exception{Kind: ExceptionNoTime})
		case sum.Timesheet == nil && ended:
			add(Exception{Kind: ExceptionNotSubmitted})
		case sum.Timesheet != nil && sum.Timesheet.Status == StatusRejected:
			add(Exception{Kind: ExceptionRejected})
		case sum.Timesheet != nil && sum.Timesheet.Status == StatusSubmitted && ended:
			add(Exception{Kind: ExceptionAwaitingApproval})
		}
		if sum.PendingTimeOff > 0 {
			add(Exception{Kind: ExceptionTimeOffPending, Hours: sum.PendingTimeOff})
		}
		if sum.Overtime > 0 {
			add(Exception{Kind: ExceptionOvertime, Hours: sum.Overtime})
		}
	}
	return out, nil
}

// longEntries finds a person's entries in a period that ran past the limit:
// finished ones, and a clock still running.
func (s *Service) longEntries(ctx context.Context, personID string, period Period, loc *time.Location, limit time.Duration) ([]Exception, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, started_at, ended_at FROM time_entries
		WHERE person_id = $1 AND started_at >= $2 AND started_at < $3
		AND coalesce(ended_at, $4) - started_at > $5 ORDER BY started_at`,
		personID, period.Start.In(loc), period.End.AddDays(1).In(loc), s.now(), limit)
	if err != nil {
		return nil, fmt.Errorf("find long entries: %w", err)
	}
	var out []Exception
	var id uuid.UUID
	var start time.Time
	var end *time.Time
	if _, err := pgx.ForEachRow(rows, []any{&id, &start, &end}, func() error {
		day := DateOf(start, loc)
		e := Exception{Kind: ExceptionLongEntry, Day: &day, EntryID: &id}
		if end == nil {
			e.Kind = ExceptionClockRunning
			e.Hours = Hours(s.now().Sub(start))
		} else {
			e.Hours = Hours(end.Sub(start))
		}
		out = append(out, e)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("find long entries: %w", err)
	}
	return out, nil
}

// Payroll returns everyone's pay period containing day, for the export.
func (s *Service) Payroll(ctx context.Context, actor Actor, day Date) ([]PeriodSummary, error) {
	if !actor.Admin {
		return nil, forbidden("only an admin runs payroll reports")
	}
	return s.Team(ctx, actor, day)
}

// ProjectReport adds up finished time on the days from..to by project and
// person, for the people whose time actor may see. Time is cut at the first
// and last midnight, so an entry across one counts only its part inside.
func (s *Service) ProjectReport(ctx context.Context, actor Actor, from, to Date) ([]ProjectHours, error) {
	if to.Before(from) {
		return nil, invalidField("to", "must not be before from")
	}
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	loc := cfg.Location()
	rows, err := s.pool.Query(ctx, `
		SELECT coalesce(c.name, ''), coalesce(p.id::text, ''), coalesce(p.name, ''), coalesce(p.code, ''), coalesce(p.billable, false),
			pe.id, pe.name,
			extract(epoch FROM sum(least(e.ended_at, $2) - greatest(e.started_at, $1)))::float8
		FROM time_entries e
		JOIN people pe ON pe.id = e.person_id
		LEFT JOIN projects p ON p.id = e.project_id
		LEFT JOIN customers c ON c.id = p.customer_id
		WHERE e.ended_at IS NOT NULL AND e.started_at < $2 AND e.ended_at > $1
		AND ($3 OR pe.id = $4 OR (CASE WHEN pe.manager_id <> '' THEN pe.manager_id ELSE pe.host_manager_id END) = $4)
		GROUP BY c.name, p.id, p.name, p.code, p.billable, pe.id, pe.name
		ORDER BY lower(coalesce(c.name, '')), lower(coalesce(p.name, '')), lower(pe.name)`,
		from.In(loc), to.AddDays(1).In(loc), actor.Admin, actor.ID)
	if err != nil {
		return nil, fmt.Errorf("project report: %w", err)
	}
	out := []ProjectHours{}
	var h ProjectHours
	var seconds float64
	if _, err := pgx.ForEachRow(rows, []any{&h.CustomerName, &h.ProjectID, &h.ProjectName, &h.ProjectCode, &h.Billable, &h.PersonID, &h.PersonName, &seconds}, func() error {
		h.Hours = Hours(time.Duration(seconds * float64(time.Second)))
		out = append(out, h)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("project report: %w", err)
	}
	return out, nil
}

// AuditEntry is one change to payroll data.
type AuditEntry struct {
	At       time.Time      `json:"at"`
	Actor    string         `json:"actor"`
	Action   string         `json:"action"`
	PersonID string         `json:"personId,omitempty"`
	Detail   map[string]any `json:"detail"`
}

// Audit lists the most recent changes to a person's time, or to anything
// when personID is empty, newest first.
func (s *Service) Audit(ctx context.Context, actor Actor, personID string, limit int) ([]AuditEntry, error) {
	if !actor.Admin {
		return nil, forbidden("only an admin reads the audit log")
	}
	rows, err := s.pool.Query(ctx, `SELECT at, actor, action, person_id, detail FROM audit_log
		WHERE $1 = '' OR person_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, personID, limit)
	if err != nil {
		return nil, fmt.Errorf("read audit log: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (AuditEntry, error) {
		var a AuditEntry
		var detail any
		err := row.Scan(&a.At, &a.Actor, &a.Action, &a.PersonID, &detail)
		// Detail is an object for one record and a list for several.
		if m, ok := detail.(map[string]any); ok {
			a.Detail = m
		} else {
			a.Detail = map[string]any{"items": detail}
		}
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("read audit log: %w", err)
	}
	return out, nil
}
