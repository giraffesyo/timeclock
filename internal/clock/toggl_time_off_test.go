package clock

import (
	"testing"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
)

const (
	togglHoliday  = int64(21)
	togglVacation = int64(22)
	togglSick     = int64(23)
)

// togglAwayFixture connects Ada with the three away projects, chosen on
// Friday 2026-10-02.
func togglAwayFixture(t *testing.T) (*fixture, *Toggl, *fakeToggl) {
	t.Helper()
	f, b, fake := togglFixture(t)
	fake.projects = []toggl.Project{
		{ID: togglHoliday, WorkspaceID: 42, Name: "Company holiday", Active: true},
		{ID: togglVacation, WorkspaceID: 42, Name: "Vacation", Active: true},
		{ID: togglSick, WorkspaceID: 42, Name: "Sick", Active: true},
	}
	seedToggl(f, fake)
	err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{Token: "fake", WorkspaceID: 42, From: "2026-10-01",
		People: []TogglMapping{{PersonID: f.ada.ID, UserID: 1}},
		TogglRoles: TogglRoles{HolidayProject: togglHoliday, VacationProject: togglVacation, SickProject: togglSick}})
	if err != nil {
		t.Fatal(err)
	}
	return f, b, fake
}

func awayEntry(f *fixture, fake *fakeToggl, id, project int64, start, end string) {
	at, stop := f.time(start), f.time(end)
	fake.entries[id] = toggl.Entry{ID: id, WorkspaceID: 42, UserID: 1, ProjectID: &project, Start: at, Stop: &stop,
		Duration: int64(stop.Sub(at) / time.Second), Description: "Away"}
}

// adaTimeOff is Ada's time off by day and kind.
func adaTimeOff(t *testing.T, f *fixture) map[string]TimeOff {
	t.Helper()
	list, err := f.TimeOff(t.Context(), f.admin, f.ada.ID, day(t, "2026-09-01"), day(t, "2026-10-31"))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]TimeOff{}
	for _, o := range list {
		out[o.Day.String()+" "+o.Kind] = o
	}
	return out
}

func TestTogglAwayProjectsBecomeTimeOff(t *testing.T) {
	f, b, fake := togglAwayFixture(t)
	awayEntry(f, fake, 201, togglVacation, "2026-10-02 08:00", "2026-10-02 12:00")
	awayEntry(f, fake, 202, togglVacation, "2026-10-02 13:00", "2026-10-02 17:00")
	awayEntry(f, fake, 203, togglSick, "2026-10-05 09:00", "2026-10-05 11:00")
	awayEntry(f, fake, 204, togglHoliday, "2026-10-05 00:00", "2026-10-05 08:00")
	// Chosen on October 2: earlier entries on the vacation project stay work.
	awayEntry(f, fake, 205, togglVacation, "2026-10-01 13:00", "2026-10-01 14:00")
	f.at("2026-10-05 17:00")
	requireSync(t, f, b)

	off := adaTimeOff(t, f)
	if v := off["2026-10-02 vacation"]; v.Hours != 8 || v.Status != StatusPending || v.Note != "Away" {
		t.Fatalf("a day's vacation entries add up to one pending request: %+v", off)
	}
	if s := off["2026-10-05 sick"]; s.Hours != 2 || s.Status != StatusPending {
		t.Fatalf("sick entries become sick time: %+v", off)
	}
	if len(off) != 2 {
		t.Fatalf("holiday entries are left out: %+v", off)
	}
	var work int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM time_entries WHERE workspace_id=$W AND source='toggl'`).Scan(&work); err != nil || work != 2 {
		t.Fatalf("only the recent work and the entry from before the role are work: %d %v", work, err)
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 0 || status.VacationProject != togglVacation || status.VacationFrom != "2026-10-02" {
		t.Fatalf("no issues, and the roles show with their day: %+v %v", status, err)
	}
	if fake.posts+fake.puts+fake.deletes != 0 {
		t.Fatalf("time off is never written to Toggl: %d posts %d puts %d deletes", fake.posts, fake.puts, fake.deletes)
	}

	// An edit in Toggl updates the day; a deletion removes it.
	awayEntry(f, fake, 202, togglVacation, "2026-10-02 13:00", "2026-10-02 15:00")
	delete(fake.entries, 203)
	requireSync(t, f, b)
	off = adaTimeOff(t, f)
	if off["2026-10-02 vacation"].Hours != 6 {
		t.Fatalf("an edit in Toggl changes the hours: %+v", off)
	}
	if _, ok := off["2026-10-05 sick"]; ok {
		t.Fatalf("a deletion in Toggl removes the time off: %+v", off)
	}

	// A rejection stands while nothing changes in Toggl.
	if _, err = f.DecideTimeOff(t.Context(), f.boss, off["2026-10-02 vacation"].ID, false, "Not then"); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if v := adaTimeOff(t, f)["2026-10-02 vacation"]; v.Status != StatusRejected {
		t.Fatalf("an unchanged entry doesn't undo the rejection: %+v", v)
	}
	// Different hours are a new request.
	awayEntry(f, fake, 202, togglVacation, "2026-10-02 13:00", "2026-10-02 16:00")
	requireSync(t, f, b)
	if v := adaTimeOff(t, f)["2026-10-02 vacation"]; v.Status != StatusPending || v.Hours != 7 || v.DecidedBy != "" {
		t.Fatalf("changed hours ask again: %+v", v)
	}
}

func TestTogglAwayApprovalLocksAndConflicts(t *testing.T) {
	f, b, fake := togglAwayFixture(t)
	f.settings(func(s *Settings) { s.ApproveTimeOff = false })
	awayEntry(f, fake, 201, togglSick, "2026-10-02 08:00", "2026-10-02 12:00")
	requireSync(t, f, b)
	if s := adaTimeOff(t, f)["2026-10-02 sick"]; s.Status != StatusApproved || s.DecidedBy != "integration:toggl" {
		t.Fatalf("without approval, time off is approved by the integration: %+v", s)
	}

	// A submitted timesheet holds its days: the change waits as an issue.
	sheet, err := f.Submit(t.Context(), f.ada, f.ada.ID, day(t, "2026-10-02"))
	if err != nil {
		t.Fatal(err)
	}
	awayEntry(f, fake, 201, togglSick, "2026-10-02 08:00", "2026-10-02 10:00")
	requireSync(t, f, b)
	if s := adaTimeOff(t, f)["2026-10-02 sick"]; s.Hours != 4 {
		t.Fatalf("a locked day keeps its time off: %+v", s)
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 1 || status.Issues[0].Kind != "locked" || status.Issues[0].TimeOff == nil ||
		status.Issues[0].TimeOff.Hours != 2 || status.Issues[0].TimeOff.Kind != Sick {
		t.Fatalf("the locked day needs attention: %+v %v", status.Issues, err)
	}
	// Returned for changes, the next sync writes it and clears the issue.
	if _, err = f.Decide(t.Context(), f.boss, sheet.Timesheet.ID, false, "Fix it"); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if s := adaTimeOff(t, f)["2026-10-02 sick"]; s.Hours != 2 {
		t.Fatalf("an unlocked day takes the change: %+v", s)
	}
	if status, err = b.Status(t.Context(), f.Service, f.admin); err != nil || len(status.Issues) != 0 {
		t.Fatalf("the issue clears: %+v %v", status.Issues, err)
	}

	// Time off already recorded in Timeclock is never overwritten.
	f.at("2026-10-05 17:00")
	if _, err = f.RequestTimeOff(t.Context(), f.ada, TimeOffInput{Kind: Vacation, From: day(t, "2026-10-05"), To: day(t, "2026-10-05"), Hours: 8}); err != nil {
		t.Fatal(err)
	}
	awayEntry(f, fake, 202, togglVacation, "2026-10-05 08:00", "2026-10-05 12:00")
	requireSync(t, f, b)
	if v := adaTimeOff(t, f)["2026-10-05 vacation"]; v.Hours != 8 {
		t.Fatalf("Timeclock's own time off stays: %+v", v)
	}
	status, err = b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 1 || status.Issues[0].Kind != "time_off_exists" {
		t.Fatalf("the clash needs attention: %+v %v", status.Issues, err)
	}
}

func TestTogglAwayRolesKeepHistoryAndOwnDays(t *testing.T) {
	f, b, fake := togglAwayFixture(t)
	for range 6 {
		requireSync(t, f, b)
	}
	f.at("2026-10-06 09:00")
	// Saving the connection again keeps the history and each role's day; a
	// new role starts today.
	err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{WorkspaceID: 42, From: "2026-10-01",
		People:     []TogglMapping{{PersonID: f.ada.ID, UserID: 1}},
		TogglRoles: TogglRoles{HolidayProject: togglSick, VacationProject: togglVacation}})
	if err != nil {
		t.Fatal(err)
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || !status.HistoryComplete || status.VacationFrom != "2026-10-02" || status.HolidayFrom != "2026-10-06" ||
		status.HolidayProject != togglSick || status.SickProject != 0 || status.SickFrom != "" {
		t.Fatalf("roles keep or restart their day without resetting history: %+v %v", status, err)
	}
	// One project can't fill two roles.
	err = b.Configure(t.Context(), f.Service, f.admin, TogglSetup{WorkspaceID: 42, From: "2026-10-01",
		People:     []TogglMapping{{PersonID: f.ada.ID, UserID: 1}},
		TogglRoles: TogglRoles{HolidayProject: togglVacation, VacationProject: togglVacation}})
	if err == nil {
		t.Fatal("a project filled two roles")
	}
	_ = fake
}
