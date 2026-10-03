package clock

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// Activity lists, for everyone whose time actor may see and who still tracks
// time, what they are on now and their hours today and this workweek. People
// with a running clock come first.
func (s *Service) Activity(ctx context.Context, actor Actor) ([]Activity, error) {
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	people, err := s.People(ctx, actor)
	if err != nil {
		return nil, err
	}
	now := s.now()
	// Each person's day and week start at their own midnight, so read back
	// far enough to cover the earliest of them.
	since := WeekStart(s.Today(cfg), time.Weekday(cfg.WeekStart)).AddDays(-2).Time()

	rows, err := s.pool.Query(ctx, entrySelect+`
		WHERE e.started_at < $3 AND coalesce(e.ended_at, $3) > $2
		AND ($4 OR e.person_id = $5 OR e.person_id IN (SELECT id FROM people
			WHERE (CASE WHEN manager_id <> '' THEN manager_id ELSE host_manager_id END) = $5))
		ORDER BY e.started_at`, cfg.Timezone, since, now, actor.Admin, actor.ID)
	if err != nil {
		return nil, fmt.Errorf("read activity: %w", err)
	}
	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Entry, error) { return scanEntry(row) })
	if err != nil {
		return nil, fmt.Errorf("read activity: %w", err)
	}
	spans := map[string][]Span{}
	running := map[string]*Entry{}
	for _, e := range entries {
		end := now
		if e.EndedAt != nil {
			end = *e.EndedAt
		} else {
			running[e.PersonID] = &e
		}
		if end.After(e.StartedAt) {
			spans[e.PersonID] = append(spans[e.PersonID], Span{Start: e.StartedAt, End: end})
		}
	}

	out := []Activity{}
	for _, p := range people {
		if !p.Active {
			continue
		}
		loc := cfg.LocationOf(p)
		today := DateOf(now, loc)
		week := WeekStart(today, time.Weekday(cfg.WeekStart))
		a := Activity{Person: p, Running: running[p.ID]}
		var total time.Duration
		for day, h := range HoursByDay(spans[p.ID], loc, OvertimeRule{}) {
			if day.Before(week) {
				continue
			}
			total += h.Total()
			if day == today {
				a.Today = Hours(h.Total())
			}
		}
		a.Week = Hours(total)
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Running != nil && out[j].Running == nil })
	return out, nil
}

// HoursByDayAndProject adds up time on the days from..to by day and project:
// the caller's own when mine is set, and otherwise that of everyone whose
// time they may see. A running clock counts up to now. Time is cut at each
// midnight where the person is. Unlike worked hours, overlapping entries each count in full, so
// every project shows all the time recorded on it.
func (s *Service) HoursByDayAndProject(ctx context.Context, actor Actor, from, to Date, mine bool) ([]DayProjectHours, error) {
	if to.Before(from) {
		return nil, invalidField("to", "must not be before from")
	}
	cfg, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	now := s.now()
	// Wide enough for every time zone; each person's own midnights cut it below.
	rows, err := s.pool.Query(ctx, `SELECT coalesce(e.project_id::text, ''), pe.timezone, e.started_at, coalesce(e.ended_at, $3)
		FROM time_entries e JOIN people pe ON pe.id = e.person_id
		WHERE e.started_at < $2 AND coalesce(e.ended_at, $3) > $1
		AND (pe.id = $5 OR (NOT $6 AND ($4 OR (CASE WHEN pe.manager_id <> '' THEN pe.manager_id ELSE pe.host_manager_id END) = $5)))`,
		from.AddDays(-1).Time(), to.AddDays(2).Time(), now, actor.Admin, actor.ID, mine)
	if err != nil {
		return nil, fmt.Errorf("hours by day: %w", err)
	}
	type key struct {
		day     Date
		project string
	}
	sums := map[key]time.Duration{}
	var project, tz string
	var a, b time.Time
	if _, err := pgx.ForEachRow(rows, []any{&project, &tz, &a, &b}, func() error {
		loc := cfg.LocationOf(Person{Timezone: tz})
		start, end := from.In(loc), to.AddDays(1).In(loc)
		if a.Before(start) {
			a = start
		}
		if b.After(end) {
			b = end
		}
		for _, seg := range split(Span{Start: a, End: b}, loc) {
			sums[key{seg.day, project}] += seg.end.Sub(seg.start)
		}
		return nil
	}); err != nil {
		return nil, fmt.Errorf("hours by day: %w", err)
	}
	out := make([]DayProjectHours, 0, len(sums))
	for k, d := range sums {
		out = append(out, DayProjectHours{Day: k.day, ProjectID: k.project, Hours: Hours(d)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Day != out[j].Day {
			return out[i].Day.Before(out[j].Day)
		}
		return out[i].ProjectID < out[j].ProjectID
	})
	return out, nil
}
