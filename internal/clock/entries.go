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

// zoneExpr is the time zone an entry's days are cut in: its person's own,
// or the organization's ($1).
const zoneExpr = `coalesce(nullif((SELECT timezone FROM people WHERE id = e.person_id AND workspace_id = e.workspace_id), ''), $1)`

// A day is locked for a person while a timesheet covering it is submitted
// or approved.
const lockedExpr = `EXISTS (SELECT 1 FROM timesheets t WHERE t.workspace_id = e.workspace_id AND t.person_id = e.person_id
	AND t.status IN ('submitted', 'approved')
	AND (e.started_at AT TIME ZONE ` + zoneExpr + `)::date <= t.period_end
	AND (coalesce(e.ended_at, now()) AT TIME ZONE ` + zoneExpr + `)::date >= t.period_start)`

const entrySelect = `SELECT e.id, e.person_id, e.project_id, e.started_at, e.ended_at, e.note, e.source, ` + lockedExpr + `
	FROM time_entries e`

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	err := row.Scan(&e.ID, &e.PersonID, &e.ProjectID, &e.StartedAt, &e.EndedAt, &e.Note, &e.Source, &e.Locked)
	return e, err
}

// Entries lists a person's time that touches the days from..to, oldest first.
func (s *Service) Entries(ctx context.Context, actor Actor, personID string, from, to Date) ([]Entry, error) {
	p, err := s.viewable(ctx, s.pool, actor, personID)
	if err != nil {
		return nil, err
	}
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	loc := cfg.LocationOf(p)
	rows, err := s.pool.Query(ctx, entrySelect+`
		WHERE e.workspace_id = $W AND e.person_id = $2 AND e.started_at < $4 AND coalesce(e.ended_at, now()) >= $3
		ORDER BY e.started_at`, cfg.Timezone, p.ID, from.In(loc), to.AddDays(1).In(loc))
	if err != nil {
		return nil, fmt.Errorf("list entries: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Entry, error) { return scanEntry(row) })
	if err != nil {
		return nil, fmt.Errorf("list entries: %w", err)
	}
	return out, nil
}

// Running returns the person's running clock, or nil.
func (s *Service) Running(ctx context.Context, actor Actor) (*Entry, error) {
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	e, err := scanEntry(s.pool.QueryRow(ctx, entrySelect+` WHERE e.workspace_id = $W AND e.person_id = $2 AND e.ended_at IS NULL`, cfg.Timezone, actor.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil //nolint:nilnil // no running clock is an answer, not an error
	}
	if err != nil {
		return nil, fmt.Errorf("read running clock: %w", err)
	}
	return &e, nil
}

// writable returns the person whose time actor is changing: their own, or a
// report's for a manager, or anyone's for an admin.
func (s *Service) writable(ctx context.Context, q querier, actor Actor, personID string) (Person, error) {
	p, err := s.viewable(ctx, q, actor, personID)
	if err != nil {
		return p, err
	}
	if !p.Active && !actor.Admin {
		return p, forbidden("this person no longer tracks time")
	}
	return p, nil
}

// plannedHorizon is how far ahead planned time may be recorded: enough to
// plan, not so much that a mistyped year goes unnoticed.
const plannedHorizon = 366 * 24 * time.Hour

// checkSpan refuses time that is locked or lies in the future. end is nil
// for a running clock. Time may overlap other time: hours count it once.
// Where the organization allows planned time, finished entries may lie
// ahead; they count only as they pass.
func (s *Service) checkSpan(ctx context.Context, q querier, cfg Settings, personID string, start time.Time, end *time.Time) error {
	now := s.now()
	ahead := now.Add(time.Minute)
	if end != nil && cfg.AllowPlannedTime {
		ahead = now.Add(plannedHorizon)
	}
	if start.After(ahead) || (end != nil && end.After(ahead)) {
		return ErrFuture.New("")
	}
	if end != nil && !end.After(start) {
		return invalidField("endedAt", "must be after startedAt")
	}
	var tz string
	if err := q.QueryRow(ctx, `SELECT timezone FROM people WHERE id = $1 AND workspace_id = $W`, personID).Scan(&tz); err != nil {
		return fmt.Errorf("read time zone: %w", err)
	}
	loc := cfg.LocationOf(Person{Timezone: tz})
	last := now
	if end != nil {
		last = *end
	}
	var locked bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM timesheets WHERE person_id = $1 AND workspace_id = $W
		AND status IN ('submitted', 'approved') AND period_start <= $3 AND period_end >= $2)`,
		personID, DateOf(start, loc).Time(), DateOf(last, loc).Time()).Scan(&locked); err != nil {
		return fmt.Errorf("check lock: %w", err)
	}
	if locked {
		return ErrLocked.New("")
	}
	return nil
}

func checkProject(ctx context.Context, q querier, cfg Settings, projectID *uuid.UUID) error {
	if projectID == nil {
		if cfg.RequireProject {
			return ErrProjectRequired.New("")
		}
		return nil
	}
	return usableProject(ctx, q, *projectID)
}

func checkDescription(cfg Settings, note string) error {
	if cfg.RequireDescription && strings.TrimSpace(note) == "" {
		return ErrDescriptionRequired.New("")
	}
	return nil
}

// ClockIn starts the actor's clock. Required fields can be filled in while it runs.
func (s *Service) ClockIn(ctx context.Context, actor Actor, projectID *uuid.UUID, note string) (Entry, error) {
	var out Entry
	err := s.tx(ctx, actor.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		var running bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM time_entries WHERE person_id = $1 AND workspace_id = $W AND ended_at IS NULL)`, actor.ID).Scan(&running); err != nil {
			return fmt.Errorf("check running clock: %w", err)
		}
		if running {
			return ErrClockRunning.New("")
		}
		if err := checkProject(ctx, tx, Settings{}, projectID); err != nil {
			return err
		}
		start := s.now().Truncate(time.Second)
		if err := s.checkSpan(ctx, tx, cfg, actor.ID, start, nil); err != nil {
			return err
		}
		id := newID()
		if _, err := tx.Exec(ctx, `INSERT INTO time_entries (id, workspace_id, person_id, project_id, started_at, note, source, created_by)
			VALUES ($1, $W, $2, $3, $4, $5, 'clock', $2)`, id, actor.ID, projectID, start, strings.TrimSpace(note)); err != nil {
			return fmt.Errorf("clock in: %w", err)
		}
		out, err = scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id))
		return err
	})
	return out, err
}

// retagWithin is how young a running clock is retagged rather than split: a
// switch that soon after clocking in is a correction, not a change of work.
const retagWithin = time.Minute

// Switch moves the actor's running clock to other work without stopping it:
// the time so far stays on what it was recorded against, and the clock goes
// on, from this instant, against the given project and note.
func (s *Service) Switch(ctx context.Context, actor Actor, projectID *uuid.UUID, note string) (Entry, error) {
	var out Entry
	err := s.tx(ctx, actor.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		var id uuid.UUID
		var start time.Time
		var previousProject *uuid.UUID
		var previousNote string
		err = tx.QueryRow(ctx, `SELECT id, started_at, project_id, note FROM time_entries WHERE person_id = $1 AND workspace_id = $W AND ended_at IS NULL`, actor.ID).Scan(&id, &start, &previousProject, &previousNote)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrClockNotRunning.New("")
		}
		if err != nil {
			return fmt.Errorf("read running clock: %w", err)
		}
		if err := checkProject(ctx, tx, Settings{}, projectID); err != nil {
			return err
		}
		note = strings.TrimSpace(note)
		now := s.now().Truncate(time.Second)
		// Filling in unfinished work keeps all the time already tracked.
		// Only a complete stretch may be closed by switching to new work.
		if now.Sub(start) < retagWithin || (cfg.RequireProject && previousProject == nil) || checkDescription(cfg, previousNote) != nil {
			if _, err := tx.Exec(ctx, `UPDATE time_entries SET project_id = $2, note = $3, updated_at = now() WHERE id = $1 AND workspace_id = $W`, id, projectID, note); err != nil {
				return fmt.Errorf("retag running clock: %w", err)
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE time_entries SET ended_at = $2, updated_at = now() WHERE id = $1 AND workspace_id = $W`, id, now); err != nil {
				return fmt.Errorf("stop running clock: %w", err)
			}
			if err := s.checkSpan(ctx, tx, cfg, actor.ID, now, nil); err != nil {
				return err
			}
			id = newID()
			if _, err := tx.Exec(ctx, `INSERT INTO time_entries (id, workspace_id, person_id, project_id, started_at, note, source, created_by)
				VALUES ($1, $W, $2, $3, $4, $5, 'clock', $2)`, id, actor.ID, projectID, now, note); err != nil {
				return fmt.Errorf("start clock: %w", err)
			}
		}
		out, err = scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id))
		return err
	})
	return out, err
}

// ClockOut stops the actor's clock.
func (s *Service) ClockOut(ctx context.Context, actor Actor) (Entry, error) {
	var out Entry
	err := s.tx(ctx, actor.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		var id uuid.UUID
		var start time.Time
		var previousProject *uuid.UUID
		var previousNote string
		err = tx.QueryRow(ctx, `SELECT id, started_at, project_id, note FROM time_entries WHERE person_id = $1 AND workspace_id = $W AND ended_at IS NULL`, actor.ID).Scan(&id, &start, &previousProject, &previousNote)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrClockNotRunning.New("")
		}
		if err != nil {
			return fmt.Errorf("read running clock: %w", err)
		}
		if err := checkDescription(cfg, previousNote); err != nil {
			return err
		}
		if cfg.RequireProject && previousProject == nil {
			return ErrProjectRequired.New("")
		}
		// A clock stopped the second it started still records a second.
		end := s.now().Truncate(time.Second)
		if !end.After(start) {
			end = start.Add(time.Second)
		}
		if _, err := tx.Exec(ctx, `UPDATE time_entries SET ended_at = $2, updated_at = now() WHERE id = $1 AND workspace_id = $W`, id, end); err != nil {
			return fmt.Errorf("clock out: %w", err)
		}
		out, err = scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id))
		return err
	})
	return out, err
}

// EntryInput is a time entry as written by hand.
type EntryInput struct {
	PersonID  string     `json:"personId,omitempty" doc:"Whose time it is. Defaults to the caller; a manager or admin can record time for someone else."`
	ProjectID *uuid.UUID `json:"projectId,omitempty"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty" doc:"Absent leaves a running clock running."`
	Note      string     `json:"note,omitempty" maxLength:"2000"`
}

// CreateEntry records a finished stretch of work by hand.
func (s *Service) CreateEntry(ctx context.Context, actor Actor, in EntryInput) (Entry, error) {
	if in.EndedAt == nil {
		return Entry{}, requiredField("endedAt")
	}
	p, err := s.writable(ctx, s.pool, actor, in.PersonID)
	if err != nil {
		return Entry{}, err
	}
	var out Entry
	err = s.tx(ctx, p.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		if err := checkProject(ctx, tx, cfg, in.ProjectID); err != nil {
			return err
		}
		if err := checkDescription(cfg, in.Note); err != nil {
			return err
		}
		if err := s.checkSpan(ctx, tx, cfg, p.ID, in.StartedAt, in.EndedAt); err != nil {
			return err
		}
		id := newID()
		if _, err := tx.Exec(ctx, `INSERT INTO time_entries (id, workspace_id, person_id, project_id, started_at, ended_at, note, source, created_by)
			VALUES ($1, $W, $2, $3, $4, $5, $6, 'manual', $7)`,
			id, p.ID, in.ProjectID, in.StartedAt, in.EndedAt, strings.TrimSpace(in.Note), actor.ID); err != nil {
			return fmt.Errorf("create entry: %w", err)
		}
		if out, err = scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id)); err != nil {
			return err
		}
		return audit(ctx, tx, actor, "entry.create", p.ID, out)
	})
	return out, err
}

// entryForWrite reads an entry and the person whose it is, refusing an
// actor who may not change that person's time.
func (s *Service) entryForWrite(ctx context.Context, actor Actor, id uuid.UUID) (Person, error) {
	var personID string
	err := s.pool.QueryRow(ctx, `SELECT person_id FROM time_entries WHERE id = $1 AND workspace_id = $W`, id).Scan(&personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Person{}, notFound("entry")
	}
	if err != nil {
		return Person{}, fmt.Errorf("read entry: %w", err)
	}
	p, err := s.writable(ctx, s.pool, actor, personID)
	if err != nil {
		// Not theirs to see: the same answer as an entry that doesn't exist.
		return p, notFound("entry")
	}
	return p, nil
}

// UpdateEntry changes an entry. Giving a running clock an end stops it.
func (s *Service) UpdateEntry(ctx context.Context, actor Actor, id uuid.UUID, in EntryInput) (Entry, error) {
	p, err := s.entryForWrite(ctx, actor, id)
	if err != nil {
		return Entry{}, err
	}
	var out Entry
	err = s.tx(ctx, p.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		before, err := scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("entry")
		}
		if err != nil {
			return fmt.Errorf("read entry: %w", err)
		}
		if before.Locked {
			return ErrLocked.New("")
		}
		if in.EndedAt == nil && before.EndedAt != nil {
			return requiredField("endedAt") // a finished entry can't be set running again
		}
		// Running entries can be filled in a field at a time. Closing one
		// (including through this endpoint) enforces both requirements.
		requirements := cfg
		if in.EndedAt == nil {
			requirements.RequireProject = false
			requirements.RequireDescription = false
		}
		// A project that was fine when the entry was made is fine to keep.
		if in.ProjectID == nil || before.ProjectID == nil || *in.ProjectID != *before.ProjectID {
			if err := checkProject(ctx, tx, requirements, in.ProjectID); err != nil {
				return err
			}
		}
		if err := checkDescription(requirements, in.Note); err != nil {
			return err
		}
		if err := s.checkSpan(ctx, tx, cfg, p.ID, in.StartedAt, in.EndedAt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE time_entries SET project_id = $2, started_at = $3, ended_at = $4, note = $5,
			updated_at = now() WHERE id = $1 AND workspace_id = $W`, id, in.ProjectID, in.StartedAt, in.EndedAt, strings.TrimSpace(in.Note)); err != nil {
			return fmt.Errorf("update entry: %w", err)
		}
		if out, err = scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id)); err != nil {
			return err
		}
		return audit(ctx, tx, actor, "entry.update", p.ID, map[string]any{"before": before, "after": out})
	})
	return out, err
}

// DeleteEntry removes an entry.
func (s *Service) DeleteEntry(ctx context.Context, actor Actor, id uuid.UUID) error {
	p, err := s.entryForWrite(ctx, actor, id)
	if err != nil {
		return err
	}
	return s.tx(ctx, p.ID, func(tx querier) error {
		cfg, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		before, err := scanEntry(tx.QueryRow(ctx, entrySelect+` WHERE e.id = $2 AND e.workspace_id = $W`, cfg.Timezone, id))
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("entry")
		}
		if err != nil {
			return fmt.Errorf("read entry: %w", err)
		}
		if before.Locked {
			return ErrLocked.New("")
		}
		if _, err := tx.Exec(ctx, `DELETE FROM time_entries WHERE id = $1 AND workspace_id = $W`, id); err != nil {
			return fmt.Errorf("delete entry: %w", err)
		}
		return audit(ctx, tx, actor, "entry.delete", p.ID, before)
	})
}
