package clock

import (
	"testing"
	"time"
)

func date(t *testing.T, s string) Date {
	t.Helper()
	d, err := ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPeriodContaining(t *testing.T) {
	anchor := date(t, "2026-01-05") // a Monday
	for _, tc := range []struct {
		cycle      PayCycle
		day        string
		start, end string
	}{
		{Biweekly, "2026-01-05", "2026-01-05", "2026-01-18"},
		{Biweekly, "2026-01-18", "2026-01-05", "2026-01-18"},
		{Biweekly, "2026-01-19", "2026-01-19", "2026-02-01"},
		{Biweekly, "2026-10-02", "2026-09-28", "2026-10-11"},
		// Before the anchor, periods still line up with it.
		{Biweekly, "2026-01-04", "2025-12-22", "2026-01-04"},
		{Biweekly, "2025-12-21", "2025-12-08", "2025-12-21"},
		{Weekly, "2026-01-07", "2026-01-05", "2026-01-11"},
		{Weekly, "2026-01-04", "2025-12-29", "2026-01-04"},
		{Semimonthly, "2026-02-15", "2026-02-01", "2026-02-15"},
		{Semimonthly, "2026-02-16", "2026-02-16", "2026-02-28"},
		{Semimonthly, "2028-02-29", "2028-02-16", "2028-02-29"},
		{Monthly, "2026-12-31", "2026-12-01", "2026-12-31"},
	} {
		p := PeriodContaining(tc.cycle, anchor, date(t, tc.day))
		if p.Start.String() != tc.start || p.End.String() != tc.end {
			t.Errorf("%s containing %s = %s–%s, want %s–%s", tc.cycle, tc.day, p.Start, p.End, tc.start, tc.end)
		}
		if !p.Contains(date(t, tc.day)) {
			t.Errorf("%s period %s–%s doesn't contain %s", tc.cycle, p.Start, p.End, tc.day)
		}
	}
}

// Periods tile the calendar: each one starts the day after the one before.
func TestPeriodsTile(t *testing.T) {
	anchor := date(t, "2026-01-05")
	for _, cycle := range []PayCycle{Weekly, Biweekly, Semimonthly, Monthly} {
		p := PeriodContaining(cycle, anchor, date(t, "2025-11-20"))
		for range 40 {
			next := PeriodAfter(cycle, anchor, p)
			if next.Start != p.End.AddDays(1) {
				t.Fatalf("%s: %s–%s is followed by %s–%s", cycle, p.Start, p.End, next.Start, next.End)
			}
			if back := PeriodBefore(cycle, anchor, next); back != p {
				t.Fatalf("%s: before %s is %s, want %s", cycle, next.Start, back.Start, p.Start)
			}
			p = next
		}
	}
}

func TestWeekStart(t *testing.T) {
	if got := WeekStart(date(t, "2026-10-02"), time.Monday); got.String() != "2026-09-28" {
		t.Errorf("Monday week of Fri 2026-10-02 starts %s", got)
	}
	if got := WeekStart(date(t, "2026-10-04"), time.Sunday); got.String() != "2026-10-04" {
		t.Errorf("Sunday week of Sun 2026-10-04 starts %s", got)
	}
	if got := WeekStart(date(t, "2026-10-04"), time.Monday); got.String() != "2026-09-28" {
		t.Errorf("Monday week of Sun 2026-10-04 starts %s", got)
	}
}
