package clock

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// togglAway syncs one window's entries on the holiday, vacation and sick
// projects. They are never work: holiday entries are left out, and vacation
// and sick entries add up, per person, day and kind, to time off. It is
// one-way; time off is never written to Toggl.
type togglAway struct {
	t       *Toggl
	s       *Service
	c       togglConfig
	cfg     Settings
	zones   map[string]*time.Location
	touched map[awayKey]bool
	// known is each entry counted as time off, and its project and kind then.
	known map[int64]awayLink
}

type awayLink struct {
	project int64
	kind    string
}

type awayKey struct {
	person string
	day    Date
	kind   string
}

func newTogglAway(ctx context.Context, t *Toggl, s *Service, c togglConfig) (*togglAway, error) {
	cfg, err := settings(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	a := &togglAway{t: t, s: s, c: c, cfg: cfg, zones: map[string]*time.Location{}, touched: map[awayKey]bool{}, known: map[int64]awayLink{}}
	rows, err := s.pool.Query(ctx, `SELECT remote_id,project,kind FROM toggl_time_off WHERE workspace_id=$W`)
	if err != nil {
		return nil, err
	}
	var id int64
	var l awayLink
	_, err = pgx.ForEachRow(rows, []any{&id, &l.project, &l.kind}, func() error { a.known[id] = l; return nil })
	return a, err
}

// day is the day an entry starts on, in its person's time zone.
func (a *togglAway) day(ctx context.Context, personID string, start time.Time) (Date, error) {
	loc, ok := a.zones[personID]
	if !ok {
		p, err := person(ctx, a.s.pool, personID)
		if err != nil {
			return Date{}, err
		}
		loc = a.cfg.LocationOf(p)
		a.zones[personID] = loc
	}
	return DateOf(start, loc), nil
}

// claim reports whether an unlinked entry is away time, and records it if so.
// An entry that left the vacation or sick project is let go, to sync as work.
func (a *togglAway) claim(ctx context.Context, e toggl.Entry, personID string) (bool, error) {
	l, known := a.known[e.ID]
	if len(a.c.roles) == 0 && !known {
		return false, nil
	}
	day, err := a.day(ctx, personID, e.Start)
	if err != nil {
		return false, err
	}
	kind := a.c.role(e.ProjectID, day)
	// Time off stays time off while its entry stays on the same project, even
	// if that project's role changes later.
	if known && e.ProjectID != nil && *e.ProjectID == l.project {
		kind = l.kind
	}
	switch kind {
	case "holiday":
		// Company holidays pay this time.
		return true, a.drop(ctx, e.ID)
	case Vacation:
		return true, a.record(ctx, e, personID, Vacation, day)
	case Sick:
		return true, a.record(ctx, e, personID, Sick, day)
	}
	return false, a.drop(ctx, e.ID)
}

func (a *togglAway) record(ctx context.Context, e toggl.Entry, personID, kind string, day Date) error {
	if e.Duration <= 0 {
		// A running entry counts once it stops.
		return a.drop(ctx, e.ID)
	}
	if err := a.forget(ctx, e.ID); err != nil {
		return err
	}
	_, err := a.s.pool.Exec(ctx, `INSERT INTO toggl_time_off(workspace_id,remote_id,person_id,kind,day,started_at,seconds,note,project)
    VALUES($W,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,remote_id) DO UPDATE SET person_id=EXCLUDED.person_id,kind=EXCLUDED.kind,
    day=EXCLUDED.day,started_at=EXCLUDED.started_at,seconds=EXCLUDED.seconds,note=EXCLUDED.note,project=EXCLUDED.project`,
		e.ID, personID, kind, day.Time(), e.Start.UTC(), e.Duration, strings.TrimSpace(e.Description), *e.ProjectID)
	a.touched[awayKey{personID, day, kind}] = true
	a.known[e.ID] = awayLink{project: *e.ProjectID, kind: kind}
	return err
}

// forget marks the day an entry counted toward, if any, for settling again.
func (a *togglAway) forget(ctx context.Context, remoteID int64) error {
	if _, ok := a.known[remoteID]; !ok {
		return nil
	}
	var k awayKey
	var day time.Time
	err := a.s.pool.QueryRow(ctx, `SELECT person_id,day,kind FROM toggl_time_off WHERE workspace_id=$W AND remote_id=$1`, remoteID).Scan(&k.person, &day, &k.kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	k.day = DateFromTime(day)
	a.touched[k] = true
	return nil
}

// drop stops counting an entry toward time off.
func (a *togglAway) drop(ctx context.Context, remoteID int64) error {
	if _, ok := a.known[remoteID]; !ok {
		return nil
	}
	if err := a.forget(ctx, remoteID); err != nil {
		return err
	}
	delete(a.known, remoteID)
	_, err := a.s.pool.Exec(ctx, `DELETE FROM toggl_time_off WHERE workspace_id=$W AND remote_id=$1`, remoteID)
	return err
}

// missing rereads entries in the window that the report left out: they may
// have been deleted, moved or stopped being visible.
func (a *togglAway) missing(ctx context.Context, client *toggl.Client, seen map[int64]bool, people map[int64]string, from, to time.Time) error {
	rows, err := a.s.pool.Query(ctx, `SELECT remote_id FROM toggl_time_off WHERE workspace_id=$W AND started_at>=$1 AND started_at<$2`, from, to)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		e, err := client.Entry(ctx, id)
		if apiErr, ok := errors.AsType[*toggl.Error](err); ok && apiErr.Status == 404 {
			if err = a.drop(ctx, id); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		personID, ok := people[e.UserID]
		if e.DeletedAt != nil || e.WorkspaceID != a.c.remote || !ok {
			if err = a.drop(ctx, id); err != nil {
				return err
			}
			continue
		}
		if _, err = a.claim(ctx, e, personID); err != nil {
			return err
		}
	}
	return nil
}

// settle writes each touched day's total to time off, and retries days that
// couldn't be written before.
func (a *togglAway) settle(ctx context.Context) error {
	rows, err := a.s.pool.Query(ctx, `SELECT person_id,day,kind FROM toggl_time_off_days WHERE workspace_id=$W AND issue<>''`)
	if err != nil {
		return err
	}
	var k awayKey
	var day time.Time
	_, err = pgx.ForEachRow(rows, []any{&k.person, &day, &k.kind}, func() error {
		k.day = DateFromTime(day)
		a.touched[k] = true
		return nil
	})
	if err != nil {
		return err
	}
	for k := range a.touched {
		if err := a.settleDay(ctx, k); err != nil {
			return err
		}
	}
	return nil
}

func (a *togglAway) settleDay(ctx context.Context, k awayKey) error {
	return a.s.tx(ctx, k.person, func(q querier) error {
		var seconds int64
		var note string
		err := q.QueryRow(ctx, `SELECT COALESCE(sum(seconds),0),COALESCE(string_agg(DISTINCT NULLIF(note,''),'; '),'') FROM toggl_time_off
    WHERE workspace_id=$W AND person_id=$1 AND day=$2 AND kind=$3`, k.person, k.day.Time(), k.kind).Scan(&seconds, &note)
		if err != nil {
			return err
		}
		want := Hours(time.Duration(seconds) * time.Second)
		id := newID()
		var timeOffID *uuid.UUID
		var wrote float64
		var issue string
		err = q.QueryRow(ctx, `SELECT id,time_off_id,hours::float8,issue FROM toggl_time_off_days WHERE workspace_id=$W AND person_id=$1 AND day=$2 AND kind=$3`,
			k.person, k.day.Time(), k.kind).Scan(&id, &timeOffID, &wrote, &issue)
		known := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// Unchanged in Toggl: leave it, even if an approver rejected it or
		// someone removed it in Timeclock.
		if want == wrote {
			if !known || issue == "" {
				return nil
			}
			_, err = q.Exec(ctx, `UPDATE toggl_time_off_days SET issue='' WHERE workspace_id=$W AND id=$1`, id)
			return err
		}
		issue, timeOffID, err = a.write(ctx, q, k, want, note, timeOffID)
		if err != nil {
			return err
		}
		if issue == "" {
			wrote = want
		}
		if wrote == 0 && issue == "" {
			_, err = q.Exec(ctx, `DELETE FROM toggl_time_off_days WHERE workspace_id=$W AND id=$1`, id)
			return err
		}
		_, err = q.Exec(ctx, `INSERT INTO toggl_time_off_days(workspace_id,id,person_id,day,kind,time_off_id,hours,issue) VALUES($W,$1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,person_id,day,kind) DO UPDATE SET time_off_id=EXCLUDED.time_off_id,hours=EXCLUDED.hours,issue=EXCLUDED.issue`,
			id, k.person, k.day.Time(), k.kind, timeOffID, wrote, issue)
		return err
	})
}

// write makes the day's time off want hours, returning the issue that stops
// it, if any, and the time off it now owns.
func (a *togglAway) write(ctx context.Context, q querier, k awayKey, want float64, note string, timeOffID *uuid.UUID) (string, *uuid.UUID, error) {
	var locked bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM timesheets WHERE person_id=$1 AND workspace_id=$W
    AND status IN ('submitted','approved') AND $2 BETWEEN period_start AND period_end)`, k.person, k.day.Time()).Scan(&locked); err != nil {
		return "", timeOffID, err
	}
	if locked {
		return "locked", timeOffID, nil
	}
	if want > 24 {
		return "invalid_entry", timeOffID, nil
	}
	actor := Actor{Person: Person{ID: "integration:toggl"}, Admin: true}
	var owned bool
	if timeOffID != nil {
		if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM time_off WHERE workspace_id=$W AND id=$1)`, *timeOffID).Scan(&owned); err != nil {
			return "", timeOffID, err
		}
	}
	if want == 0 {
		if owned {
			if _, err := q.Exec(ctx, `DELETE FROM time_off WHERE workspace_id=$W AND id=$1`, *timeOffID); err != nil {
				return "", timeOffID, err
			}
		}
		return "", nil, audit(ctx, q, actor, "toggl.time_off", k.person, map[string]any{"day": k.day, "kind": k.kind, "hours": 0})
	}
	// Changed hours ask for a decision again, as a new request would.
	status, decidedBy := StatusApproved, actor.ID
	if a.cfg.ApproveTimeOff {
		status, decidedBy = StatusPending, ""
	}
	if owned {
		_, err := q.Exec(ctx, `UPDATE time_off SET hours=$2,note=$3,status=$4,decided_by=$5,decided_at=CASE WHEN $5='' THEN NULL ELSE now() END,decision_note=''
    WHERE workspace_id=$W AND id=$1`, *timeOffID, want, note, status, decidedBy)
		if err != nil {
			return "", timeOffID, err
		}
	} else {
		var taken bool
		if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM time_off WHERE workspace_id=$W AND person_id=$1 AND day=$2 AND kind=$3)`,
			k.person, k.day.Time(), k.kind).Scan(&taken); err != nil {
			return "", timeOffID, err
		}
		if taken {
			// Recorded in Timeclock too: someone decides which one counts.
			return "time_off_exists", nil, nil
		}
		id := newID()
		_, err := q.Exec(ctx, `INSERT INTO time_off(id,workspace_id,person_id,kind,day,hours,note,status,decided_by,decided_at)
    VALUES($1,$W,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='' THEN NULL ELSE now() END)`, id, k.person, k.kind, k.day.Time(), want, note, status, decidedBy)
		if err != nil {
			return "", timeOffID, err
		}
		timeOffID = &id
	}
	return "", timeOffID, audit(ctx, q, actor, "toggl.time_off", k.person, map[string]any{"day": k.day, "kind": k.kind, "hours": want, "status": status})
}
