package clock

import (
	"errors"
	"testing"
	"time"

	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/foundation/pgdb/pgdbtest"
	"github.com/parallelworks/foundation/problem"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/migrations"
)

// TestDatabaseURL names the database the tests make their own schemas in,
// such as the one `make test-db` starts.
const TestDatabaseURL = "TIMECLOCK_TEST_DATABASE_URL"

type fixture struct {
	*Service
	t     *testing.T
	loc   *time.Location
	clock time.Time
	admin Actor
	boss  Actor
	ada   Actor
	bob   Actor
}

// newFixture is a migrated schema with an admin, a manager (boss) and two
// people who report to boss. The clock reads Friday 2026-10-02 17:00 in
// Chicago, in the biweekly period 2026-09-28..2026-10-11.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := pgdbtest.Migrated(t, TestDatabaseURL, pgdb.Migrations{FS: migrations.FS})
	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{Service: New(pool), t: t, loc: loc}
	f.at("2026-10-02 17:00")
	f.now = func() time.Time { return f.clock }
	sync := func(p host.Person) Actor {
		a, err := f.Sync(t.Context(), p)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	f.admin = sync(host.Person{ID: "admin", Name: "Pat Admin", Email: "pat@example.com", Admin: true})
	f.boss = sync(host.Person{ID: "boss", Name: "Bo Boss", Email: "bo@example.com"})
	f.ada = sync(host.Person{ID: "ada", Name: "Ada Lovelace", Email: "ada@example.com", ManagerID: "boss"})
	f.bob = sync(host.Person{ID: "bob", Name: "Bob Hope", Email: "bob@example.com", ManagerID: "boss"})
	return f
}

func (f *fixture) at(local string) time.Time {
	f.t.Helper()
	ts, err := time.ParseInLocation("2006-01-02 15:04", local, f.loc)
	if err != nil {
		f.t.Fatal(err)
	}
	f.clock = ts
	return ts
}

func (f *fixture) time(local string) time.Time {
	f.t.Helper()
	ts, err := time.ParseInLocation("2006-01-02 15:04", local, f.loc)
	if err != nil {
		f.t.Fatal(err)
	}
	return ts
}

// settings changes the organization's settings.
func (f *fixture) settings(change func(*Settings)) {
	f.t.Helper()
	cfg, err := f.Settings(f.t.Context())
	if err != nil {
		f.t.Fatal(err)
	}
	change(&cfg)
	if _, err := f.UpdateSettings(f.t.Context(), f.admin, cfg); err != nil {
		f.t.Fatal(err)
	}
}

// work records a finished entry for a person, without a project.
func (f *fixture) work(who Actor, start, end string) Entry {
	f.t.Helper()
	e := f.time(end)
	entry, err := f.CreateEntry(f.t.Context(), who, EntryInput{StartedAt: f.time(start), EndedAt: &e})
	if err != nil {
		f.t.Fatalf("record %s–%s: %v", start, end, err)
	}
	return entry
}

// wantProblem fails unless err is a problem with the given code.
func wantProblem(t *testing.T, err error, code problem.Code) {
	t.Helper()
	p, ok := errors.AsType[*problem.Problem](err)
	if !ok {
		t.Fatalf("error = %v, want problem %s", err, code)
	}
	if p.Key() != code {
		t.Fatalf("problem = %s (%s), want %s", p.Key(), p.Detail, code)
	}
}

func day(t *testing.T, s string) Date {
	t.Helper()
	d, err := ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestClockInAndOut(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()

	if _, err := f.ClockOut(ctx, f.ada); err == nil {
		t.Fatal("clocking out with no clock running succeeded")
	} else {
		wantProblem(t, err, "clock_not_running")
	}

	f.at("2026-10-02 09:00")
	in, err := f.ClockIn(ctx, f.ada, nil, " standup ")
	if err != nil {
		t.Fatal(err)
	}
	if in.EndedAt != nil || in.Note != "standup" || in.Source != "clock" {
		t.Errorf("clocked in = %+v", in)
	}
	_, err = f.ClockIn(ctx, f.ada, nil, "")
	wantProblem(t, err, "clock_running")

	// Bob's clock is his own.
	if _, err := f.ClockIn(ctx, f.bob, nil, ""); err != nil {
		t.Fatalf("bob clocking in while ada is: %v", err)
	}

	f.at("2026-10-02 12:30")
	out, err := f.ClockOut(ctx, f.ada)
	if err != nil {
		t.Fatal(err)
	}
	if out.ID != in.ID || out.EndedAt == nil || out.EndedAt.Sub(out.StartedAt) != 3*time.Hour+30*time.Minute {
		t.Errorf("clocked out = %+v", out)
	}
	running, err := f.Running(ctx, f.ada)
	if err != nil || running != nil {
		t.Errorf("running after clock out = %v, %v", running, err)
	}
}

func TestProjectRules(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()

	_, err := f.ClockIn(ctx, f.ada, nil, "")
	wantProblem(t, err, "project_required")

	if _, err := f.SaveCustomer(ctx, f.ada, [16]byte{}, "Acme", false); !problem.Denied(err) {
		t.Fatalf("a non-admin creating a customer: %v", err)
	}
	acme, err := f.SaveCustomer(ctx, f.admin, [16]byte{}, "Acme", false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.SaveCustomer(ctx, f.admin, [16]byte{}, "Acme", false)
	wantProblem(t, err, "name_taken")

	proj, err := f.SaveProject(ctx, f.admin, [16]byte{}, ProjectInput{CustomerID: acme.ID, Name: "Portal", Code: "C-1", Billable: true})
	if err != nil {
		t.Fatal(err)
	}
	if proj.CustomerName != "Acme" {
		t.Errorf("project = %+v", proj)
	}
	if _, err := f.ClockIn(ctx, f.ada, &proj.ID, ""); err != nil {
		t.Fatal(err)
	}
	f.at("2026-10-02 18:00")
	if _, err := f.ClockOut(ctx, f.ada); err != nil {
		t.Fatal(err)
	}

	// Time is recorded on it, so it can be archived but not deleted.
	wantProblem(t, f.DeleteProject(ctx, f.admin, proj.ID), "in_use")
	wantProblem(t, f.DeleteCustomer(ctx, f.admin, acme.ID), "in_use")
	if _, err := f.SaveCustomer(ctx, f.admin, acme.ID, "Acme", true); err != nil {
		t.Fatal(err)
	}
	// Archiving the customer archives its projects for new time.
	f.at("2026-10-02 19:00")
	_, err = f.ClockIn(ctx, f.ada, &proj.ID, "")
	wantProblem(t, err, "project_archived")
	active, err := f.Projects(ctx, false)
	if err != nil || len(active) != 0 {
		t.Errorf("active projects = %v, %v", active, err)
	}
}

func TestEntriesCannotOverlapOrBeInTheFuture(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()

	first := f.work(f.ada, "2026-10-01 09:00", "2026-10-01 12:00")
	for _, tc := range [][2]string{
		{"2026-10-01 11:00", "2026-10-01 13:00"}, // tail
		{"2026-10-01 08:00", "2026-10-01 09:01"}, // head
		{"2026-10-01 10:00", "2026-10-01 10:30"}, // inside
		{"2026-10-01 08:00", "2026-10-01 13:00"}, // around
	} {
		end := f.time(tc[1])
		_, err := f.CreateEntry(ctx, f.ada, EntryInput{StartedAt: f.time(tc[0]), EndedAt: &end})
		wantProblem(t, err, "entry_overlaps")
	}
	// Back to back is fine, and so is someone else's same time.
	f.work(f.ada, "2026-10-01 12:00", "2026-10-01 13:00")
	f.work(f.bob, "2026-10-01 09:00", "2026-10-01 12:00")

	end := f.time("2026-10-03 10:00")
	_, err := f.CreateEntry(ctx, f.ada, EntryInput{StartedAt: f.time("2026-10-03 09:00"), EndedAt: &end})
	wantProblem(t, err, "in_the_future")

	// Moving an entry onto itself isn't an overlap.
	newEnd := f.time("2026-10-01 11:30")
	if _, err := f.UpdateEntry(ctx, f.ada, first.ID, EntryInput{StartedAt: first.StartedAt, EndedAt: &newEnd}); err != nil {
		t.Fatalf("shortening an entry: %v", err)
	}
}

func TestWhoSeesWhoseTime(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()
	entry := f.work(f.ada, "2026-10-01 09:00", "2026-10-01 12:00")
	from, to := day(t, "2026-09-28"), day(t, "2026-10-11")

	for who, want := range map[*Actor]bool{&f.ada: true, &f.boss: true, &f.admin: true, &f.bob: false} {
		got, err := f.Entries(ctx, *who, "ada", from, to)
		if want && (err != nil || len(got) != 1) {
			t.Errorf("%s reading ada's time: %v, %v", who.ID, got, err)
		}
		if !want {
			// A peer gets the same answer as for someone who doesn't exist.
			p, ok := errors.AsType[*problem.Problem](err)
			if !ok || p.Status != 404 {
				t.Errorf("%s reading ada's time: %v, want 404", who.ID, err)
			}
		}
	}
	if err := f.DeleteEntry(ctx, f.bob, entry.ID); err == nil {
		t.Fatal("bob deleted ada's entry")
	}
	people, err := f.People(ctx, f.boss)
	if err != nil || len(people) != 3 { // boss, ada, bob
		t.Errorf("boss sees %d people (%v), want 3", len(people), err)
	}
	if people, _ := f.People(ctx, f.ada); len(people) != 1 {
		t.Errorf("ada sees %d people, want herself", len(people))
	}
	if people, _ := f.People(ctx, f.admin); len(people) != 4 {
		t.Errorf("admin sees %d people, want 4", len(people))
	}
}

func TestSubmittingLocksThePeriodAndApprovalIsTheManagers(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()
	entry := f.work(f.ada, "2026-10-01 09:00", "2026-10-01 17:00")
	today := day(t, "2026-10-02")

	sum, err := f.Submit(ctx, f.ada, "", today)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Timesheet == nil || sum.Timesheet.Status != StatusSubmitted || sum.Regular != 8 ||
		sum.Period.Start.String() != "2026-09-28" || sum.Period.End.String() != "2026-10-11" {
		t.Fatalf("submitted = %+v, timesheet %+v", sum, sum.Timesheet)
	}
	_, err = f.Submit(ctx, f.ada, "", today)
	wantProblem(t, err, "already_submitted")

	// Locked: no edits, deletes, new time or time off in the period, by anyone.
	end := f.time("2026-10-01 16:00")
	_, err = f.UpdateEntry(ctx, f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: &end})
	wantProblem(t, err, "period_locked")
	wantProblem(t, f.DeleteEntry(ctx, f.admin, entry.ID), "period_locked")
	end = f.time("2026-10-02 12:00")
	_, err = f.CreateEntry(ctx, f.ada, EntryInput{StartedAt: f.time("2026-10-02 09:00"), EndedAt: &end})
	wantProblem(t, err, "period_locked")
	_, err = f.ClockIn(ctx, f.ada, nil, "")
	wantProblem(t, err, "period_locked")
	_, err = f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Vacation, From: day(t, "2026-10-05"), To: day(t, "2026-10-05"), Hours: 8})
	wantProblem(t, err, "period_locked")

	// Not ada, and not a peer: her manager or an admin approves.
	_, err = f.Decide(ctx, f.ada, sum.Timesheet.ID, true, "")
	wantProblem(t, err, "own_approval")
	if _, err := f.Decide(ctx, f.bob, sum.Timesheet.ID, true, ""); err == nil {
		t.Fatal("a peer approved ada's timesheet")
	}
	approved, err := f.Decide(ctx, f.boss, sum.Timesheet.ID, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != StatusApproved || approved.DecidedBy != "boss" {
		t.Errorf("approved = %+v", approved)
	}
	_, err = f.Decide(ctx, f.admin, sum.Timesheet.ID, false, "")
	wantProblem(t, err, "not_awaiting_decision")

	// Approved time stays locked until someone with a say sends it back.
	if _, err := f.Reopen(ctx, f.ada, sum.Timesheet.ID, ""); err == nil {
		t.Fatal("ada reopened her own approved timesheet")
	}
	if _, err := f.Reopen(ctx, f.admin, sum.Timesheet.ID, "wrong day"); err != nil {
		t.Fatal(err)
	}
	end = f.time("2026-10-01 16:00")
	if _, err := f.UpdateEntry(ctx, f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: &end}); err != nil {
		t.Fatalf("editing after the timesheet was sent back: %v", err)
	}
	again, err := f.Submit(ctx, f.ada, "", today)
	if err != nil {
		t.Fatal(err)
	}
	if again.Timesheet.Status != StatusSubmitted || again.Regular != 7 || again.Timesheet.DecisionNote != "" {
		t.Errorf("resubmitted = %+v, timesheet %+v", again, again.Timesheet)
	}
	// Still waiting, so ada can take it back herself.
	if _, err := f.Reopen(ctx, f.ada, again.Timesheet.ID, ""); err != nil {
		t.Fatalf("ada taking back her waiting timesheet: %v", err)
	}
}

func TestSubmitNeedsTheClockStopped(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()
	f.at("2026-10-02 09:00")
	if _, err := f.ClockIn(ctx, f.ada, nil, ""); err != nil {
		t.Fatal(err)
	}
	f.at("2026-10-02 17:00")
	_, err := f.Submit(ctx, f.ada, "", day(t, "2026-10-02"))
	wantProblem(t, err, "clock_still_running")

	// A period that hasn't started can't be submitted.
	if _, err := f.Submit(ctx, f.bob, "", day(t, "2026-10-12")); err == nil {
		t.Fatal("submitted a future period")
	}
}

func TestApprovalsCanBeTurnedOff(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) {
		s.RequireProject, s.ApproveTimesheets, s.ApproveTimeOff = false, false, false
	})
	ctx := t.Context()
	f.work(f.ada, "2026-10-01 09:00", "2026-10-01 17:00")

	off, err := f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Sick, From: day(t, "2026-09-30"), To: day(t, "2026-09-30"), Hours: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(off) != 1 || off[0].Status != StatusApproved {
		t.Errorf("time off with approvals off = %+v", off)
	}
	sum, err := f.Submit(ctx, f.ada, "", day(t, "2026-10-02"))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Timesheet.Status != StatusApproved || sum.Sick != 4 || sum.Regular != 8 {
		t.Errorf("submitted with approvals off = %+v, timesheet %+v", sum, sum.Timesheet)
	}
}

func TestTimeOff(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()

	// Mon Oct 5 – Mon Oct 12 skips the weekend: 6 days.
	off, err := f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Vacation, From: day(t, "2026-10-05"), To: day(t, "2026-10-12"), Hours: 8, Note: "trip"})
	if err != nil {
		t.Fatal(err)
	}
	if len(off) != 6 || off[0].Status != StatusPending {
		t.Fatalf("requested %d days (%+v), want 6 pending", len(off), off)
	}
	_, err = f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Vacation, From: day(t, "2026-10-06"), To: day(t, "2026-10-06"), Hours: 4})
	wantProblem(t, err, "entry_overlaps")

	// Pending hours aren't paid yet; they show as pending.
	sum, err := f.Summary(ctx, f.ada, "", day(t, "2026-10-05"))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Vacation != 0 || sum.PendingTimeOff != 40 { // Oct 5–9 are in the period ending Oct 11
		t.Errorf("before approval: vacation %v pending %v, want 0 and 40", sum.Vacation, sum.PendingTimeOff)
	}

	pending, err := f.PendingTimeOff(ctx, f.boss)
	if err != nil || len(pending) != 6 {
		t.Fatalf("boss has %d to decide (%v), want 6", len(pending), err)
	}
	if mine, _ := f.PendingTimeOff(ctx, f.ada); len(mine) != 0 {
		t.Errorf("ada has %d to decide, want none", len(mine))
	}
	_, err = f.DecideTimeOff(ctx, f.ada, off[0].ID, true, "")
	wantProblem(t, err, "own_approval")
	if _, err := f.DecideTimeOff(ctx, f.boss, off[0].ID, true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DecideTimeOff(ctx, f.boss, off[1].ID, false, "need you that day"); err != nil {
		t.Fatal(err)
	}
	sum, err = f.Summary(ctx, f.ada, "", day(t, "2026-10-05"))
	if err != nil {
		t.Fatal(err)
	}
	if sum.Vacation != 8 || sum.PendingTimeOff != 24 {
		t.Errorf("after decisions: vacation %v pending %v, want 8 and 24", sum.Vacation, sum.PendingTimeOff)
	}
	if err := f.CancelTimeOff(ctx, f.ada, off[2].ID); err != nil {
		t.Fatal(err)
	}
	if err := f.CancelTimeOff(ctx, f.bob, off[3].ID); err == nil {
		t.Fatal("bob cancelled ada's time off")
	}
}

// A workweek that straddles two pay periods puts its overtime in the period
// the extra hours were worked in.
func TestOvertimeAcrossAPeriodBoundary(t *testing.T) {
	f := newFixture(t)
	// Semimonthly: Mon Sep 28 – Wed Sep 30 is one period, Thu Oct 1 on the next.
	f.settings(func(s *Settings) { s.RequireProject, s.PayCycle = false, Semimonthly })
	for _, d := range []string{"2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"} {
		f.work(f.ada, d+" 07:00", d+" 16:00") // 9h a day, 45h in the week
	}
	september, err := f.Summary(t.Context(), f.ada, "", day(t, "2026-09-30"))
	if err != nil {
		t.Fatal(err)
	}
	if september.Period.Start.String() != "2026-09-16" || september.Regular != 27 || september.Overtime != 0 {
		t.Errorf("September = %s: %v regular, %v overtime; want 27 and 0", september.Period.Start, september.Regular, september.Overtime)
	}
	october, err := f.Summary(t.Context(), f.ada, "", day(t, "2026-10-01"))
	if err != nil {
		t.Fatal(err)
	}
	if october.Regular != 13 || october.Overtime != 5 {
		t.Errorf("October = %v regular, %v overtime; want 13 and 5", october.Regular, october.Overtime)
	}

	// An exempt person earns none.
	if _, err := f.UpdatePerson(t.Context(), f.admin, "ada", PersonUpdate{OvertimeExempt: true, Active: true}); err != nil {
		t.Fatal(err)
	}
	october, err = f.Summary(t.Context(), f.admin, "ada", day(t, "2026-10-01"))
	if err != nil || october.Regular != 18 || october.Overtime != 0 {
		t.Errorf("exempt October = %v regular, %v overtime (%v); want 18 and 0", october.Regular, october.Overtime, err)
	}
}

func TestExceptions(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()

	// Last period (Sep 14–27): ada worked a 13h day and never submitted; bob
	// submitted and waits; boss recorded nothing.
	f.work(f.ada, "2026-09-21 06:00", "2026-09-21 19:00")
	f.work(f.bob, "2026-09-21 09:00", "2026-09-21 17:00")
	if _, err := f.Submit(ctx, f.bob, "", day(t, "2026-09-21")); err != nil {
		t.Fatal(err)
	}
	got, err := f.Exceptions(ctx, f.admin, day(t, "2026-09-21"))
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, e := range got {
		kinds[e.PersonID+"/"+e.Kind] = e.PersonName
	}
	for _, want := range []string{"ada/long_entry", "ada/not_submitted", "bob/awaiting_approval", "boss/no_time", "admin/no_time"} {
		if _, ok := kinds[want]; !ok {
			t.Errorf("missing exception %s in %v", want, kinds)
		}
	}
	if len(got) != 5 {
		t.Errorf("%d exceptions, want 5: %v", len(got), kinds)
	}

	// This period: a clock left running since yesterday morning.
	f.at("2026-10-01 08:00")
	if _, err := f.ClockIn(ctx, f.ada, nil, ""); err != nil {
		t.Fatal(err)
	}
	f.at("2026-10-02 17:00")
	got, err = f.Exceptions(ctx, f.boss, day(t, "2026-10-02"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Kind != ExceptionClockRunning || got[0].PersonID != "ada" || got[0].Hours != 33 {
		t.Errorf("current period exceptions = %+v, want ada's running clock at 33h", got)
	}

	// An inactive person is left out.
	if _, err := f.UpdatePerson(ctx, f.admin, "boss", PersonUpdate{Active: false}); err != nil {
		t.Fatal(err)
	}
	got, _ = f.Exceptions(ctx, f.admin, day(t, "2026-09-21"))
	for _, e := range got {
		if e.PersonID == "boss" {
			t.Errorf("inactive boss still has exception %s", e.Kind)
		}
	}
}

func TestProjectReport(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	acme, err := f.SaveCustomer(ctx, f.admin, [16]byte{}, "Acme", false)
	if err != nil {
		t.Fatal(err)
	}
	portal, err := f.SaveProject(ctx, f.admin, [16]byte{}, ProjectInput{CustomerID: acme.ID, Name: "Portal", Code: "C-1", Billable: true})
	if err != nil {
		t.Fatal(err)
	}
	record := func(who Actor, start, end string) {
		e := f.time(end)
		if _, err := f.CreateEntry(ctx, who, EntryInput{ProjectID: &portal.ID, StartedAt: f.time(start), EndedAt: &e}); err != nil {
			t.Fatal(err)
		}
	}
	record(f.ada, "2026-09-30 22:00", "2026-10-01 02:00") // 2h on each side of midnight
	record(f.ada, "2026-10-01 09:00", "2026-10-01 12:00")
	record(f.bob, "2026-10-01 09:00", "2026-10-01 10:30")

	rows, err := f.ProjectReport(ctx, f.admin, day(t, "2026-10-01"), day(t, "2026-10-01"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].PersonID != "ada" || rows[0].Hours != 5 || rows[1].Hours != 1.5 ||
		rows[0].CustomerName != "Acme" || rows[0].ProjectCode != "C-1" || !rows[0].Billable {
		t.Errorf("Oct 1 report = %+v, want ada 5h (only her time on the 1st) and bob 1.5h", rows)
	}
	// Bob sees only his own.
	rows, err = f.ProjectReport(ctx, f.bob, day(t, "2026-09-28"), day(t, "2026-10-11"))
	if err != nil || len(rows) != 1 || rows[0].PersonID != "bob" {
		t.Errorf("bob's report = %+v, %v", rows, err)
	}
}

func TestManagersAndTheAuditLog(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()

	_, err := f.UpdatePerson(ctx, f.admin, "boss", PersonUpdate{ManagerID: "ada", Active: true})
	wantProblem(t, err, "manager_loop")
	_, err = f.UpdatePerson(ctx, f.admin, "ada", PersonUpdate{ManagerID: "ada", Active: true})
	wantProblem(t, err, "manager_loop")
	if _, err := f.UpdatePerson(ctx, f.boss, "ada", PersonUpdate{Active: true}); !problem.Denied(err) {
		t.Fatalf("a non-admin changing a person: %v", err)
	}
	// An admin's choice of manager beats the host directory's.
	moved, err := f.UpdatePerson(ctx, f.admin, "ada", PersonUpdate{ManagerID: "admin", Active: true, PayrollID: "E-7"})
	if err != nil || moved.ManagerID != "admin" || moved.PayrollID != "E-7" {
		t.Fatalf("moved ada = %+v, %v", moved, err)
	}
	again, err := f.Sync(ctx, host.Person{ID: "ada", Name: "Ada King", Email: "ada@example.com", ManagerID: "boss"})
	if err != nil || again.ManagerID != "admin" || again.Name != "Ada King" {
		t.Errorf("after the host's next answer: %+v, %v", again, err)
	}

	// A manager recording time for a report is on the record, under their name.
	f.work(f.admin, "2026-10-01 09:00", "2026-10-01 10:00")
	end := f.time("2026-10-01 12:00")
	if _, err := f.CreateEntry(ctx, f.admin, EntryInput{PersonID: "ada", StartedAt: f.time("2026-10-01 11:00"), EndedAt: &end}); err != nil {
		t.Fatal(err)
	}
	log, err := f.Audit(ctx, f.admin, "ada", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 2 || log[0].Action != "entry.create" || log[0].Actor != "admin" || log[1].Action != "person.update" {
		t.Errorf("ada's audit log = %+v", log)
	}
	if _, err := f.Audit(ctx, f.boss, "ada", 10); !problem.Denied(err) {
		t.Errorf("a non-admin reading the audit log: %v", err)
	}
}

func TestRemindersGoOutOnce(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()

	// Ada worked last period (Sep 14–27) and never submitted; Bob did submit.
	f.work(f.ada, "2026-09-21 09:00", "2026-09-21 17:00")
	f.work(f.bob, "2026-09-21 09:00", "2026-09-21 17:00")
	if _, err := f.Submit(ctx, f.bob, "", day(t, "2026-09-21")); err != nil {
		t.Fatal(err)
	}
	// Bob left a clock running since yesterday morning.
	f.at("2026-10-01 08:00")
	if _, err := f.ClockIn(ctx, f.bob, nil, ""); err != nil {
		t.Fatal(err)
	}
	f.at("2026-10-02 17:00")

	due, err := f.DueReminders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Reminder{}
	for _, r := range due {
		got[r.PersonID+"/"+r.Kind] = r
	}
	if len(due) != 2 || got["bob/clock_running"].Hours != 33 || got["ada/timesheet_due"].Period.Start.String() != "2026-09-14" {
		t.Fatalf("due = %+v, want bob's running clock (33h) and ada's timesheet for Sep 14", due)
	}
	// Recorded as sent, so the next run is quiet.
	if again, err := f.DueReminders(ctx); err != nil || len(again) != 0 {
		t.Errorf("second run = %+v, %v; want nothing", again, err)
	}
}
