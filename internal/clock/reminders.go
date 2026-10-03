package clock

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/hopper"

	"github.com/giraffesyo/timeclock/host"
)

// The kinds of reminder.
const (
	ReminderClockRunning = "clock_running"
	ReminderTimesheetDue = "timesheet_due"
)

// Reminder is a nudge for one person about their own time.
type Reminder struct {
	PersonID string
	Kind     string
	// Key identifies what it is about, so it is sent once: the entry of a
	// running clock, or the first day of a pay period.
	Key string
	// Hours is how long the clock has run, for a running clock.
	Hours float64
	// Period is the pay period whose timesheet is due.
	Period Period
}

// DueReminders finds what people should be nudged about now and haven't
// been: a clock running past the long-entry limit, and a timesheet for the
// last pay period that was never submitted. Each is recorded as sent, so a
// later call doesn't return it again.
func (s *Service) DueReminders(ctx context.Context) ([]Reminder, error) {
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	now := s.now()
	var due []Reminder

	rows, err := s.pool.Query(ctx, `SELECT e.person_id, e.id::text, e.started_at FROM time_entries e
		JOIN people p ON p.id = e.person_id
		WHERE e.ended_at IS NULL AND p.active AND $1 - e.started_at > $2`,
		now, time.Duration(cfg.LongEntryHours*float64(time.Hour)))
	if err != nil {
		return nil, fmt.Errorf("find running clocks: %w", err)
	}
	var r Reminder
	var started time.Time
	if _, err := pgx.ForEachRow(rows, []any{&r.PersonID, &r.Key, &started}, func() error {
		r.Kind, r.Hours = ReminderClockRunning, Hours(now.Sub(started))
		due = append(due, r)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("find running clocks: %w", err)
	}

	// The pay period that ended most recently, for people with time or time
	// off in it and no timesheet.
	last := PeriodBefore(cfg.PayCycle, cfg.CycleAnchor, cfg.PeriodOf(s.Today(cfg)))
	loc := cfg.Location()
	rows, err = s.pool.Query(ctx, `SELECT p.id FROM people p
		WHERE p.active
		AND NOT EXISTS (SELECT 1 FROM timesheets t WHERE t.person_id = p.id AND t.period_start = $1 AND t.status <> 'rejected')
		AND (EXISTS (SELECT 1 FROM time_entries e WHERE e.person_id = p.id AND e.started_at >= $3 AND e.started_at < $4)
			OR EXISTS (SELECT 1 FROM time_off o WHERE o.person_id = p.id AND o.day BETWEEN $1 AND $2))`,
		last.Start.Time(), last.End.Time(), last.Start.In(loc), last.End.AddDays(1).In(loc))
	if err != nil {
		return nil, fmt.Errorf("find due timesheets: %w", err)
	}
	var personID string
	if _, err := pgx.ForEachRow(rows, []any{&personID}, func() error {
		due = append(due, Reminder{PersonID: personID, Kind: ReminderTimesheetDue, Key: last.Start.String(), Period: last})
		return nil
	}); err != nil {
		return nil, fmt.Errorf("find due timesheets: %w", err)
	}

	// Keep only the ones not sent before, recording them as sent.
	var out []Reminder
	for _, r := range due {
		tag, err := s.pool.Exec(ctx, `INSERT INTO reminders (person_id, kind, key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			r.PersonID, r.Kind, r.Key)
		if err != nil {
			return nil, fmt.Errorf("record reminder: %w", err)
		}
		if tag.RowsAffected() == 1 {
			out = append(out, r)
		}
	}
	return out, nil
}

type remindJob struct{}

func (remindJob) Kind() string { return "timeclock.remind" }

// Reminders is the periodic job that nudges people through the host's
// notifications.
type Reminders struct {
	svc      *Service
	notifier host.Notifier
	logger   *slog.Logger
}

// NewReminders returns the job. It does nothing until Bind.
func NewReminders(notifier host.Notifier, logger *slog.Logger) *Reminders {
	return &Reminders{notifier: notifier, logger: logger}
}

// Register adds the job's worker and returns its schedule for
// [hopper.Config.Periodic].
func (r *Reminders) Register(workers *hopper.Workers) hopper.PeriodicJob {
	hopper.AddWorkFunc(workers, r.run)
	return hopper.Every(15*time.Minute, remindJob{}, &hopper.PeriodicOpts{RunOnStart: true})
}

// Bind sets the service, which is built after the client.
func (r *Reminders) Bind(svc *Service) { r.svc = svc }

func (r *Reminders) run(ctx context.Context, _ *hopper.Job[remindJob]) error {
	due, err := r.svc.DueReminders(ctx)
	if err != nil {
		return err
	}
	for _, d := range due {
		n := host.Notification{Kind: d.Kind, Path: "/"}
		switch d.Kind {
		case ReminderClockRunning:
			n.Title = "Your clock is still running"
			n.Body = fmt.Sprintf("It has run for %.1f hours. Clock out, or fix the entry if you forgot.", d.Hours)
		default:
			n.Title = "Your timesheet is due"
			n.Body = fmt.Sprintf("Submit your time for %s to %s.", d.Period.Start, d.Period.End)
			n.Path = "/timesheet?day=" + d.Period.Start.String()
		}
		// Already recorded as sent: a failed delivery is logged, not retried
		// into a second notification.
		if err := r.notifier.Notify(ctx, d.PersonID, n); err != nil {
			r.logger.ErrorContext(ctx, "timeclock: reminder not delivered", "person", d.PersonID, "kind", d.Kind, "error", err)
		}
	}
	return nil
}
