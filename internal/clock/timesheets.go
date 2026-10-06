package clock

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const timesheetColumns = `id, person_id, period_start, period_end, status, submitted_at, decided_by, decided_at, decision_note`

func scanTimesheet(row pgx.Row) (Timesheet, error) {
	var t Timesheet
	var start, end time.Time
	err := row.Scan(&t.ID, &t.PersonID, &start, &end, &t.Status, &t.SubmittedAt, &t.DecidedBy, &t.DecidedAt, &t.DecisionNote)
	t.Period = Period{Start: DateFromTime(start), End: DateFromTime(end)}
	return t, err
}

// Today is the current day in the organization's time zone.
func (s *Service) Today(cfg Settings) Date { return DateOf(s.now(), cfg.Location()) }

// TodayFor is the current day where a person is.
func (s *Service) TodayFor(cfg Settings, p Person) Date { return DateOf(s.now(), cfg.LocationOf(p)) }

// periodFor is the pay period a day falls in for a person: the period of a
// timesheet they already submitted covering it, which keeps its bounds even
// if the pay cycle changed since, and otherwise the settings' period.
func periodFor(ctx context.Context, q querier, cfg Settings, personID string, d Date) (Period, error) {
	var start, end time.Time
	err := q.QueryRow(ctx, `SELECT period_start, period_end FROM timesheets
		WHERE workspace_id = $W AND person_id = $1 AND $2 BETWEEN period_start AND period_end ORDER BY submitted_at DESC LIMIT 1`,
		personID, d.Time()).Scan(&start, &end)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg.PeriodOf(d), nil
	}
	if err != nil {
		return Period{}, fmt.Errorf("read timesheet period: %w", err)
	}
	return Period{Start: DateFromTime(start), End: DateFromTime(end)}, nil
}

// summarize adds up a person's pay period.
func summarize(ctx context.Context, q querier, cfg Settings, p Person, period Period) (PeriodSummary, error) {
	loc := cfg.LocationOf(p)
	rule := cfg.Overtime(p.OvertimeExempt)
	out := PeriodSummary{Person: p, Period: period}

	// Overtime depends on the whole workweek, so read back to the start of
	// the week the period begins in.
	from := WeekStart(period.Start, rule.WeekStart).In(loc)
	until := period.End.AddDays(1).In(loc)
	rows, err := q.Query(ctx, `SELECT started_at, ended_at FROM time_entries
		WHERE workspace_id = $W AND person_id = $1 AND started_at < $3 AND coalesce(ended_at, 'infinity'::timestamptz) > $2`, p.ID, from, until)
	if err != nil {
		return out, fmt.Errorf("read entries: %w", err)
	}
	var spans []Span
	var start time.Time
	var end *time.Time
	if _, err := pgx.ForEachRow(rows, []any{&start, &end}, func() error {
		if end == nil {
			out.Running = true
			return nil
		}
		spans = append(spans, Span{Start: start, End: *end})
		return nil
	}); err != nil {
		return out, fmt.Errorf("read entries: %w", err)
	}
	byDay := HoursByDay(spans, loc, rule)

	off, err := timeOff(ctx, q, p.ID, period.Start, period.End)
	if err != nil {
		return out, err
	}
	vacation, sick := map[Date]float64{}, map[Date]float64{}
	for _, t := range off {
		switch {
		case t.Status == StatusPending:
			out.PendingTimeOff += t.Hours
		case t.Status != StatusApproved:
		case t.Kind == Vacation:
			vacation[t.Day] += t.Hours
		default:
			sick[t.Day] += t.Hours
		}
	}

	var regular, overtime time.Duration
	for _, d := range period.Days() {
		h := byDay[d]
		regular += h.Regular
		overtime += h.Overtime
		out.Days = append(out.Days, DaySummary{
			Day: d, Regular: Hours(h.Regular), Overtime: Hours(h.Overtime), Vacation: vacation[d], Sick: sick[d],
		})
		out.Vacation += vacation[d]
		out.Sick += sick[d]
	}
	// Totals are rounded once, from the exact durations, so they don't drift
	// from the sum of rounded days.
	out.Regular, out.Overtime = Hours(regular), Hours(overtime)

	ts, err := scanTimesheet(q.QueryRow(ctx, `SELECT `+timesheetColumns+` FROM timesheets WHERE workspace_id = $W AND person_id = $1 AND period_start = $2`,
		p.ID, period.Start.Time()))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return out, fmt.Errorf("read timesheet: %w", err)
	default:
		names, err := personNames(ctx, q, []string{ts.DecidedBy})
		if err != nil {
			return out, err
		}
		ts.DecidedByName = names[ts.DecidedBy]
		out.Timesheet = &ts
	}
	return out, nil
}

// Summary returns a person's pay period containing day.
func (s *Service) Summary(ctx context.Context, actor Actor, personID string, day Date) (PeriodSummary, error) {
	p, err := s.viewable(ctx, s.pool, actor, personID)
	if err != nil {
		return PeriodSummary{}, err
	}
	cfg, err := s.Settings(ctx)
	if err != nil {
		return PeriodSummary{}, err
	}
	period, err := periodFor(ctx, s.pool, cfg, p.ID, day)
	if err != nil {
		return PeriodSummary{}, err
	}
	return summarize(ctx, s.pool, cfg, p, period)
}

// Team returns the pay period containing day for everyone whose time actor
// may see and who still tracks time.
func (s *Service) Team(ctx context.Context, actor Actor, day Date) ([]PeriodSummary, error) {
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	people, err := s.People(ctx, actor)
	if err != nil {
		return nil, err
	}
	var out []PeriodSummary
	for _, p := range people {
		if !p.Active {
			continue
		}
		period, err := periodFor(ctx, s.pool, cfg, p.ID, day)
		if err != nil {
			return nil, err
		}
		sum, err := summarize(ctx, s.pool, cfg, p, period)
		if err != nil {
			return nil, err
		}
		out = append(out, sum)
	}
	return out, nil
}

// Submit states that a person's pay period containing day is complete, which
// locks its time. It waits for a decision when the organization approves
// timesheets, and is approved at once when it doesn't.
func (s *Service) Submit(ctx context.Context, actor Actor, personID string, day Date) (PeriodSummary, error) {
	p, err := s.writable(ctx, s.pool, actor, personID)
	if err != nil {
		return PeriodSummary{}, err
	}
	var out PeriodSummary
	err = s.tx(ctx, p.ID, func(tx querier) error {
		// Read now, not from the caller's session: an admin may just have changed it.
		current, err := person(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		if !current.SubmitsTimesheets {
			return ErrDoesNotSubmit.New("")
		}
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		period, err := periodFor(ctx, tx, cfg, p.ID, day)
		if err != nil {
			return err
		}
		if period.Start.After(s.TodayFor(cfg, p)) {
			return invalidField("day", "the pay period hasn't started")
		}
		var running bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM time_entries WHERE workspace_id = $W AND person_id = $1 AND ended_at IS NULL AND started_at < $2)`,
			p.ID, period.End.AddDays(1).In(cfg.LocationOf(p))).Scan(&running); err != nil {
			return fmt.Errorf("check running clock: %w", err)
		}
		if running {
			return ErrPeriodOpen.New("")
		}
		status, decidedAt := StatusSubmitted, (*time.Time)(nil)
		if !cfg.ApproveTimesheets {
			now := s.now()
			status, decidedAt = StatusApproved, &now
		}
		ts, err := scanTimesheet(tx.QueryRow(ctx, `INSERT INTO timesheets (id, workspace_id, person_id, period_start, period_end, status, decided_at)
			VALUES ($1, $W, $2, $3, $4, $5, $6)
			ON CONFLICT (workspace_id, person_id, period_start) DO UPDATE SET status = EXCLUDED.status, submitted_at = now(),
				decided_by = '', decided_at = EXCLUDED.decided_at, decision_note = ''
			WHERE timesheets.status = 'rejected'
			RETURNING `+timesheetColumns, newID(), p.ID, period.Start.Time(), period.End.Time(), status, decidedAt))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAlreadySubmitted.New("")
		}
		if err != nil {
			return fmt.Errorf("submit timesheet: %w", err)
		}
		if err := audit(ctx, tx, actor, "timesheet.submit", p.ID, ts); err != nil {
			return err
		}
		out, err = summarize(ctx, tx, cfg, p, period)
		return err
	})
	return out, err
}

func timesheetByID(ctx context.Context, q querier, id uuid.UUID) (Timesheet, error) {
	t, err := scanTimesheet(q.QueryRow(ctx, `SELECT `+timesheetColumns+` FROM timesheets WHERE id = $1 AND workspace_id = $W`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, notFound("timesheet")
	}
	if err != nil {
		return t, fmt.Errorf("read timesheet: %w", err)
	}
	return t, nil
}

// Decide approves a submitted timesheet, or sends it back to its person
// with a note, which unlocks its time.
func (s *Service) Decide(ctx context.Context, actor Actor, id uuid.UUID, approve bool, note string) (Timesheet, error) {
	t, err := timesheetByID(ctx, s.pool, id)
	if err != nil {
		return t, err
	}
	if _, err := s.decidable(ctx, s.pool, actor, t.PersonID); err != nil {
		return t, err
	}
	status := StatusRejected
	if approve {
		status = StatusApproved
	}
	err = s.tx(ctx, t.PersonID, func(tx querier) error {
		t, err = scanTimesheet(tx.QueryRow(ctx, `UPDATE timesheets SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
			WHERE id = $1 AND workspace_id = $W AND status = 'submitted' RETURNING `+timesheetColumns, id, status, actor.ID, strings.TrimSpace(note)))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotSubmitted.New("")
		}
		if err != nil {
			return fmt.Errorf("decide timesheet: %w", err)
		}
		return audit(ctx, tx, actor, "timesheet."+status, t.PersonID, t)
	})
	return t, err
}

// Reopen unlocks a timesheet so its time can be corrected: its person can
// take back one that is still waiting, and a manager or admin can send back
// one that was approved.
func (s *Service) Reopen(ctx context.Context, actor Actor, id uuid.UUID, note string) (Timesheet, error) {
	t, err := timesheetByID(ctx, s.pool, id)
	if err != nil {
		return t, err
	}
	p, err := s.viewable(ctx, s.pool, actor, t.PersonID)
	if err != nil {
		return t, notFound("timesheet")
	}
	// Taking back your own waiting timesheet needs no one's say. Anything
	// else is a decision about someone's time.
	own := p.ID == actor.ID && t.Status == StatusSubmitted
	if !own {
		if _, err := s.decidable(ctx, s.pool, actor, t.PersonID); err != nil {
			return t, err
		}
	}
	err = s.tx(ctx, t.PersonID, func(tx querier) error {
		t, err = scanTimesheet(tx.QueryRow(ctx, `UPDATE timesheets SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
			WHERE id = $1 AND workspace_id = $W AND status IN ('submitted', 'approved') RETURNING `+timesheetColumns, id, actor.ID, strings.TrimSpace(note)))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotSubmitted.New("")
		}
		if err != nil {
			return fmt.Errorf("reopen timesheet: %w", err)
		}
		return audit(ctx, tx, actor, "timesheet.reopen", t.PersonID, t)
	})
	return t, err
}
