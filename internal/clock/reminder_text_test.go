package clock

import "testing"

func TestTimesheetReminderNamesThePeriodAsTheAppDoes(t *testing.T) {
	for _, c := range []struct {
		start, end string
		want       string
	}{
		{"2026-09-28", "2026-10-11", "Submit your time for Sep 28 – Oct 11, 2026."},
		// Across a new year, the year still comes once, at the end, as on the web.
		{"2026-12-28", "2027-01-10", "Submit your time for Dec 28 – Jan 10, 2027."},
	} {
		start, _ := ParseDate(c.start)
		end, _ := ParseDate(c.end)
		n := Reminder{Kind: ReminderTimesheetDue, Period: Period{Start: start, End: end}}.notification()
		if n.Body != c.want {
			t.Errorf("%s–%s: got %q, want %q", c.start, c.end, n.Body, c.want)
		}
		if n.Title != "Your timesheet is due" || n.Path != "/timesheet?day="+c.start {
			t.Errorf("%s: title %q, path %q", c.start, n.Title, n.Path)
		}
	}
}

func TestClockReminderSaysHowLong(t *testing.T) {
	n := Reminder{Kind: ReminderClockRunning, Hours: 12.04}.notification()
	if want := "It has run for 12.0 hours. Clock out, or fix the entry if you forgot."; n.Body != want {
		t.Fatalf("got %q, want %q", n.Body, want)
	}
}
