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

const timeOffColumns = `id, person_id, kind, day, hours::float8, note, status, decided_by, decided_at, decision_note`

// timeOffLocked is whether a time_off row (aliased o) is in a submitted or
// approved timesheet.
const timeOffLocked = `EXISTS (SELECT 1 FROM timesheets t WHERE t.workspace_id = o.workspace_id AND t.person_id = o.person_id
	AND t.status IN ('submitted', 'approved') AND o.day BETWEEN t.period_start AND t.period_end)`

func scanTimeOff(row pgx.Row) (TimeOff, error) {
	var t TimeOff
	var day time.Time
	err := row.Scan(&t.ID, &t.PersonID, &t.Kind, &day, &t.Hours, &t.Note, &t.Status, &t.DecidedBy, &t.DecidedAt, &t.DecisionNote)
	t.Day = DateFromTime(day)
	return t, err
}

// scanTimeOffListed reads a row of timeOffColumns followed by timeOffLocked.
func scanTimeOffListed(row pgx.CollectableRow) (TimeOff, error) {
	var t TimeOff
	var day time.Time
	err := row.Scan(&t.ID, &t.PersonID, &t.Kind, &day, &t.Hours, &t.Note, &t.Status, &t.DecidedBy, &t.DecidedAt, &t.DecisionNote, &t.Locked)
	t.Day = DateFromTime(day)
	return t, err
}

// nameDeciders fills in who decided each one, by name.
func nameDeciders(ctx context.Context, q querier, list []TimeOff) error {
	var ids []string
	for _, t := range list {
		if t.DecidedBy != "" {
			ids = append(ids, t.DecidedBy)
		}
	}
	names, err := personNames(ctx, q, ids)
	if err != nil {
		return err
	}
	for i := range list {
		list[i].DecidedByName = names[list[i].DecidedBy]
	}
	return nil
}

// TimeOff lists a person's time off on the days from..to.
func (s *Service) TimeOff(ctx context.Context, actor Actor, personID string, from, to Date) ([]TimeOff, error) {
	p, err := s.viewable(ctx, s.pool, actor, personID)
	if err != nil {
		return nil, err
	}
	return timeOff(ctx, s.pool, p.ID, from, to)
}

func timeOff(ctx context.Context, q querier, personID string, from, to Date) ([]TimeOff, error) {
	rows, err := q.Query(ctx, `SELECT `+prefixed("o", timeOffColumns)+`, `+timeOffLocked+` FROM time_off o
		WHERE o.workspace_id = $W AND o.person_id = $1 AND o.day BETWEEN $2 AND $3 ORDER BY o.day, o.kind`, personID, from.Time(), to.Time())
	if err != nil {
		return nil, fmt.Errorf("list time off: %w", err)
	}
	out, err := pgx.CollectRows(rows, scanTimeOffListed)
	if err != nil {
		return nil, fmt.Errorf("list time off: %w", err)
	}
	return out, nameDeciders(ctx, q, out)
}

// PendingTimeOff lists the time off waiting for actor's decision: their
// reports', or everyone's for an admin.
func (s *Service) PendingTimeOff(ctx context.Context, actor Actor) ([]TimeOff, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+prefixed("o", timeOffColumns)+`, `+timeOffLocked+` FROM time_off o JOIN people p ON p.id = o.person_id AND p.workspace_id = o.workspace_id
		WHERE o.workspace_id = $W AND o.status = 'pending'
		AND ($1 OR ((CASE WHEN p.manager_id <> '' THEN p.manager_id ELSE p.host_manager_id END) = $2 AND p.id <> $2))
		ORDER BY o.day, o.person_id`, actor.Admin, actor.ID)
	if err != nil {
		return nil, fmt.Errorf("list pending time off: %w", err)
	}
	out, err := pgx.CollectRows(rows, scanTimeOffListed)
	if err != nil {
		return nil, fmt.Errorf("list pending time off: %w", err)
	}
	return out, nil
}

// prefixed qualifies a column list with a table alias.
func prefixed(alias, columns string) string {
	parts := strings.Split(columns, ", ")
	for i, c := range parts {
		parts[i] = alias + "." + c
	}
	return strings.Join(parts, ", ")
}

// TimeOffInput is a request for time off on a run of days.
type TimeOffInput struct {
	PersonID string  `json:"personId,omitempty" doc:"Whose time off. Defaults to the caller; a manager or admin can record it for someone else."`
	Kind     string  `json:"kind" enum:"vacation,sick"`
	From     Date    `json:"from" format:"date"`
	To       Date    `json:"to" format:"date" doc:"The last day off; the same as from for one day."`
	Hours    float64 `json:"hours" exclusiveMinimum:"0" maximum:"24" doc:"Hours off on each day."`
	Weekends bool    `json:"weekends,omitempty" doc:"Include Saturdays and Sundays in the run."`
	Note     string  `json:"note,omitempty" maxLength:"2000"`
}

// maxTimeOffDays bounds one request, so a mistyped year can't write
// thousands of rows.
const maxTimeOffDays = 92

// RequestTimeOff records time off on each day of a run. It waits for a
// decision when the organization approves time off, and is approved at once
// when it doesn't.
func (s *Service) RequestTimeOff(ctx context.Context, actor Actor, in TimeOffInput) ([]TimeOff, error) {
	p, err := s.writable(ctx, s.pool, actor, in.PersonID)
	if err != nil {
		return nil, err
	}
	if in.To.Before(in.From) {
		return nil, invalidField("to", "must not be before from")
	}
	if in.To.DaysSince(in.From) >= maxTimeOffDays {
		return nil, invalidField("to", fmt.Sprintf("at most %d days in one request", maxTimeOffDays))
	}
	var out []TimeOff
	err = s.tx(ctx, p.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		status := StatusApproved
		if cfg.ApproveTimeOff {
			status = StatusPending
		}
		for d := in.From; !d.After(in.To); d = d.AddDays(1) {
			if wd := d.Weekday(); !in.Weekends && (wd == time.Saturday || wd == time.Sunday) {
				continue
			}
			if err := dayLocked(ctx, tx, p.ID, d); err != nil {
				return err
			}
			t, err := scanTimeOff(tx.QueryRow(ctx, `INSERT INTO time_off (id, workspace_id, person_id, kind, day, hours, note, status)
				VALUES ($1, $W, $2, $3, $4, $5, $6, $7) RETURNING `+timeOffColumns,
				newID(), p.ID, in.Kind, d.Time(), in.Hours, strings.TrimSpace(in.Note), status))
			if isUniqueViolation(err) {
				return ErrOverlap.Newf("%s time off is already recorded on %s", in.Kind, d)
			}
			if err != nil {
				return fmt.Errorf("record time off: %w", err)
			}
			out = append(out, t)
		}
		if len(out) == 0 {
			return invalidField("from", "the run has no weekdays")
		}
		return audit(ctx, tx, actor, "time_off.request", p.ID, out)
	})
	return out, err
}

func dayLocked(ctx context.Context, q querier, personID string, d Date) error {
	var locked bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM timesheets WHERE person_id = $1 AND workspace_id = $W
		AND status IN ('submitted', 'approved') AND $2 BETWEEN period_start AND period_end)`, personID, d.Time()).Scan(&locked); err != nil {
		return fmt.Errorf("check lock: %w", err)
	}
	if locked {
		return ErrLocked.New("")
	}
	return nil
}

func timeOffByID(ctx context.Context, q querier, id uuid.UUID) (TimeOff, error) {
	t, err := scanTimeOff(q.QueryRow(ctx, `SELECT `+timeOffColumns+` FROM time_off WHERE id = $1 AND workspace_id = $W`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, notFound("time off")
	}
	if err != nil {
		return t, fmt.Errorf("read time off: %w", err)
	}
	return t, nil
}

// CancelTimeOff removes time off on a day whose timesheet isn't submitted.
func (s *Service) CancelTimeOff(ctx context.Context, actor Actor, id uuid.UUID) error {
	t, err := timeOffByID(ctx, s.pool, id)
	if err != nil {
		return err
	}
	if _, err := s.writable(ctx, s.pool, actor, t.PersonID); err != nil {
		return notFound("time off")
	}
	return s.tx(ctx, t.PersonID, func(tx querier) error {
		if err := dayLocked(ctx, tx, t.PersonID, t.Day); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM time_off WHERE id = $1 AND workspace_id = $W`, id); err != nil {
			return fmt.Errorf("cancel time off: %w", err)
		}
		return audit(ctx, tx, actor, "time_off.cancel", t.PersonID, t)
	})
}

// DecideTimeOff approves or rejects pending time off.
func (s *Service) DecideTimeOff(ctx context.Context, actor Actor, id uuid.UUID, approve bool, note string) (TimeOff, error) {
	t, err := timeOffByID(ctx, s.pool, id)
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
		t, err = scanTimeOff(tx.QueryRow(ctx, `UPDATE time_off SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
			WHERE id = $1 AND workspace_id = $W AND status = 'pending' RETURNING `+timeOffColumns, id, status, actor.ID, strings.TrimSpace(note)))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotSubmitted.New("")
		}
		if err != nil {
			return fmt.Errorf("decide time off: %w", err)
		}
		return audit(ctx, tx, actor, "time_off."+status, t.PersonID, t)
	})
	return t, err
}
