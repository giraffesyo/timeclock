package clock

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/hopper"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/messages"
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
		JOIN people p ON p.id = e.person_id AND p.workspace_id = e.workspace_id
		WHERE e.workspace_id = $W AND e.ended_at IS NULL AND p.active AND $1 - e.started_at > $2`,
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

	// The pay period that ended most recently, for people who submit
	// timesheets, with time or time off in it and no timesheet.
	last := PeriodBefore(cfg.PayCycle, cfg.CycleAnchor, cfg.PeriodOf(s.Today(cfg)))
	loc := cfg.Location()
	rows, err = s.pool.Query(ctx, `SELECT p.id FROM people p
		WHERE p.workspace_id = $W AND p.active
		AND coalesce(p.submits_timesheets, (SELECT submit_timesheets FROM settings WHERE workspace_id = $W))
		AND NOT EXISTS (SELECT 1 FROM timesheets t WHERE t.workspace_id = $W AND t.person_id = p.id AND t.period_start = $1 AND t.status <> 'rejected')
		AND (EXISTS (SELECT 1 FROM time_entries e WHERE e.workspace_id = $W AND e.person_id = p.id AND e.started_at >= $3 AND e.started_at < $4)
			OR EXISTS (SELECT 1 FROM time_off o WHERE o.workspace_id = $W AND o.person_id = p.id AND o.day BETWEEN $1 AND $2))`,
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
		tag, err := s.pool.Exec(ctx, `INSERT INTO reminders (workspace_id, person_id, kind, key) VALUES ($W, $1, $2, $3) ON CONFLICT DO NOTHING`,
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
	workspaces, err := r.svc.Workspaces(ctx)
	if err != nil {
		return err
	}
	var due []Reminder
	for _, w := range workspaces {
		list, err := r.svc.In(w.ID).DueReminders(ctx)
		if err != nil {
			return err
		}
		due = append(due, list...)
	}
	for _, d := range due {
		n := host.Notification{Kind: d.Kind, Path: "/"}
		switch d.Kind {
		case ReminderClockRunning:
			n.Title = messages.T("reminder.clockRunning.title", nil)
			n.Body = messages.T("reminder.clockRunning.body", messages.Args{"hours": strconv.FormatFloat(d.Hours, 'f', 1, 64)})
		default:
			n.Title = messages.T("reminder.timesheetDue.title", nil)
			n.Body = messages.T("reminder.timesheetDue.body", messages.Args{"start": d.Period.Start.String(), "end": d.Period.End.String()})
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
