package clock

import (
	"testing"
	"time"
)

func span(t *testing.T, loc *time.Location, start, end string) Span {
	t.Helper()
	const layout = "2006-01-02 15:04"
	s, err := time.ParseInLocation(layout, start, loc)
	if err != nil {
		t.Fatal(err)
	}
	e, err := time.ParseInLocation(layout, end, loc)
	if err != nil {
		t.Fatal(err)
	}
	return Span{Start: s, End: e}
}

func chicago(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

var mondayWeek40 = OvertimeRule{WeekStart: time.Monday, Weekly: 40 * time.Hour}

func TestHoursSplitAtLocalMidnight(t *testing.T) {
	loc := chicago(t)
	got := HoursByDay([]Span{span(t, loc, "2026-10-01 22:00", "2026-10-02 03:30")}, loc, mondayWeek40)
	if h := got[date(t, "2026-10-01")].Regular; h != 2*time.Hour {
		t.Errorf("Oct 1 = %v, want 2h", h)
	}
	if h := got[date(t, "2026-10-02")].Regular; h != 3*time.Hour+30*time.Minute {
		t.Errorf("Oct 2 = %v, want 3h30m", h)
	}
}

// The day clocks fall back has 25 hours; a span across it counts them all.
func TestHoursAcrossDaylightSaving(t *testing.T) {
	loc := chicago(t)
	got := HoursByDay([]Span{span(t, loc, "2026-10-31 20:00", "2026-11-01 20:00")}, loc, OvertimeRule{})
	if h := got[date(t, "2026-11-01")].Regular; h != 21*time.Hour {
		t.Errorf("Nov 1 = %v, want 21h (a 25-hour day)", h)
	}
	if h := got[date(t, "2026-10-31")].Regular; h != 4*time.Hour {
		t.Errorf("Oct 31 = %v, want 4h", h)
	}
}

func TestWeeklyOvertime(t *testing.T) {
	loc := chicago(t)
	// Mon–Fri 9h each: 45h, so the last 5 are overtime, all on Friday.
	var spans []Span
	for _, day := range []string{"2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"} {
		spans = append(spans, span(t, loc, day+" 08:00", day+" 17:00"))
	}
	got := HoursByDay(spans, loc, mondayWeek40)
	for _, day := range []string{"2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"} {
		if h := got[date(t, day)]; h.Regular != 9*time.Hour || h.Overtime != 0 {
			t.Errorf("%s = %+v, want 9h regular", day, h)
		}
	}
	if h := got[date(t, "2026-10-02")]; h.Regular != 4*time.Hour || h.Overtime != 5*time.Hour {
		t.Errorf("Friday = %+v, want 4h regular + 5h overtime", h)
	}
}

// Each workweek has its own threshold: 50h then 30h is 10h of overtime, not 0.
func TestOvertimeIsPerWorkweek(t *testing.T) {
	loc := chicago(t)
	var spans []Span
	for _, day := range []string{"2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"} {
		spans = append(spans, span(t, loc, day+" 08:00", day+" 18:00"))
	}
	for _, day := range []string{"2026-10-05", "2026-10-06", "2026-10-07"} {
		spans = append(spans, span(t, loc, day+" 08:00", day+" 18:00"))
	}
	var regular, overtime time.Duration
	for _, h := range HoursByDay(spans, loc, mondayWeek40) {
		regular += h.Regular
		overtime += h.Overtime
	}
	if regular != 70*time.Hour || overtime != 10*time.Hour {
		t.Errorf("regular %v overtime %v, want 70h and 10h", regular, overtime)
	}
}

func TestNoOvertimeWhenOff(t *testing.T) {
	loc := chicago(t)
	got := HoursByDay([]Span{span(t, loc, "2026-09-28 00:00", "2026-09-30 12:00")}, loc, OvertimeRule{WeekStart: time.Monday})
	var overtime time.Duration
	for _, h := range got {
		overtime += h.Overtime
	}
	if overtime != 0 {
		t.Errorf("overtime %v with the rule off", overtime)
	}
}

func TestHoursRounding(t *testing.T) {
	if got := Hours(7*time.Hour + 20*time.Minute); got != 7.33 {
		t.Errorf("7h20m = %v, want 7.33", got)
	}
	if got := Hours(90 * time.Second); got != 0.03 {
		t.Errorf("90s = %v, want 0.03", got)
	}
}
