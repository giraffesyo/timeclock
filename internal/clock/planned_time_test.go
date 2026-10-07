package clock

import (
	"testing"
	"time"
)

func TestPlannedTimeIsRefusedUnlessAllowed(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.settings(func(s *Settings) { s.RequireProject = false })
	end := f.time("2026-10-02 19:00")
	_, err := f.CreateEntry(ctx, f.ada, EntryInput{StartedAt: f.time("2026-10-02 18:00"), EndedAt: &end})
	wantProblem(t, err, "in_the_future")

	f.settings(func(s *Settings) { s.AllowPlannedTime, s.RequireProject = true, false })
	if _, err := f.CreateEntry(ctx, f.ada, EntryInput{StartedAt: f.time("2026-10-02 18:00"), EndedAt: &end}); err != nil {
		t.Fatalf("planned time refused: %v", err)
	}
	// Up to a year ahead, not further: a mistyped year is caught.
	far := f.time("2027-10-05 10:00")
	_, err = f.CreateEntry(ctx, f.ada, EntryInput{StartedAt: f.time("2027-10-05 09:00"), EndedAt: &far})
	wantProblem(t, err, "in_the_future")
	// A running clock still starts now or earlier.
	running, err := f.ClockIn(ctx, f.ada, nil, "Now")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.UpdateEntry(ctx, f.ada, running.ID, EntryInput{StartedAt: f.time("2026-10-02 18:30"), Note: "Now"})
	wantProblem(t, err, "in_the_future")
}

func TestPlannedTimeCountsAsItPasses(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.settings(func(s *Settings) { s.AllowPlannedTime, s.RequireProject = true, false })
	// It is Friday 17:00.
	f.work(f.ada, "2026-10-02 09:00", "2026-10-02 12:00") // done: 3 h
	f.work(f.ada, "2026-10-02 16:00", "2026-10-02 18:00") // under way: 1 h so far
	f.work(f.ada, "2026-10-02 19:00", "2026-10-02 21:00") // planned: nothing yet
	day := DateOf(f.clock, f.loc)

	hours := func() (regular, chart, report float64) {
		t.Helper()
		sum, err := f.Summary(ctx, f.ada, f.ada.ID, day)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := f.HoursByDayAndProject(ctx, f.ada, day, day, true)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			chart += r.Hours
		}
		projects, err := f.ProjectReport(ctx, f.admin, day, day)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range projects {
			if p.PersonID == f.ada.ID {
				report += p.Hours
			}
		}
		return sum.Regular, chart, report
	}
	if regular, chart, report := hours(); regular != 4 || chart != 4 || report != 4 {
		t.Fatalf("at 17:00: regular %v, chart %v, report %v; want 4 each", regular, chart, report)
	}

	// The period can't be submitted while time is still ahead.
	_, err := f.Submit(ctx, f.ada, f.ada.ID, day)
	wantProblem(t, err, "planned_time_in_period")

	// Once it has all passed, it all counts, and the period can be submitted.
	f.at("2026-10-02 21:30")
	if regular, chart, report := hours(); regular != 7 || chart != 7 || report != 7 {
		t.Fatalf("at 21:30: regular %v, chart %v, report %v; want 7 each", regular, chart, report)
	}
	if _, err := f.Submit(ctx, f.ada, f.ada.ID, day); err != nil {
		t.Fatalf("submit after planned time passed: %v", err)
	}
}

func TestPlannedTimeIsNotALongEntryUntilItIs(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.settings(func(s *Settings) {
		s.AllowPlannedTime, s.RequireProject = true, false
		s.LongEntryHours = 4
	})
	// A planned six-hour entry starting in an hour isn't long yet: none of it has passed.
	f.work(f.ada, "2026-10-02 18:00", "2026-10-03 00:00")
	day := DateOf(f.clock, f.loc)
	long := func() int {
		t.Helper()
		ex, err := f.Exceptions(ctx, f.admin, day)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, e := range ex {
			if e.Kind == ExceptionLongEntry && e.PersonID == f.ada.ID {
				n++
			}
		}
		return n
	}
	if n := long(); n != 0 {
		t.Fatalf("planned entry flagged long before it started: %d", n)
	}
	f.clock = f.time("2026-10-02 23:00").Add(time.Minute)
	if n := long(); n != 1 {
		t.Fatalf("five hours in, want it flagged long, got %d", n)
	}
}
