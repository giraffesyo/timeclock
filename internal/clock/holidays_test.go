package clock

import (
	"testing"

	"github.com/google/uuid"

	"github.com/giraffesyo/timeclock/host"
)

// holidayOn is the holiday hours on a day of a person's pay period.
func holidayOn(t *testing.T, sum PeriodSummary, d string) DaySummary {
	t.Helper()
	for _, x := range sum.Days {
		if x.Day.String() == d {
			return x
		}
	}
	t.Fatalf("%s is not in %s..%s", d, sum.Period.Start, sum.Period.End)
	return DaySummary{}
}

func TestHolidaysArePaidNotWorked(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()

	// Monday Sep 28 is a holiday. Ada works 10h Tuesday to Friday, and 2h on
	// the holiday itself: 42h worked in the week.
	if _, err := f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Founders Day", Days: []HolidayDayInput{{Day: day(t, "2026-09-28")}}}); err != nil {
		t.Fatal(err)
	}
	f.work(f.ada, "2026-09-28 09:00", "2026-09-28 11:00")
	for _, d := range []string{"2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"} {
		f.work(f.ada, d+" 07:00", d+" 17:00")
	}
	f.at("2026-10-02 18:00")
	sum, err := f.Summary(ctx, f.ada, "", day(t, "2026-09-28"))
	if err != nil {
		t.Fatal(err)
	}
	// The holiday's 8h are paid on top and never push work into overtime;
	// the 2h worked on it count as work like any other.
	if sum.Holiday != 8 || sum.Regular != 40 || sum.Overtime != 2 {
		t.Fatalf("week = %v holiday, %v regular, %v overtime; want 8, 40, 2", sum.Holiday, sum.Regular, sum.Overtime)
	}
	if mon := holidayOn(t, sum, "2026-09-28"); mon.Holiday != 8 || mon.HolidayName != "Founders Day" || mon.Regular != 2 {
		t.Fatalf("Monday = %+v", mon)
	}

	// A holiday can cover several days, each paying its own hours.
	winter, err := f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Winter break", Days: []HolidayDayInput{
		{Day: day(t, "2026-10-08"), Hours: 4}, {Day: day(t, "2026-10-09")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(winter.Days) != 2 || winter.Days[0].Hours != 4 || winter.Days[1].Hours != HolidayHours {
		t.Fatalf("winter break = %+v", winter)
	}
	sum, err = f.Summary(ctx, f.ada, "", day(t, "2026-09-28"))
	if err != nil || sum.Holiday != 20 || holidayOn(t, sum, "2026-10-08").Holiday != 4 {
		t.Fatalf("period holiday = %v (%v), want 20 with 4 on Oct 8", sum.Holiday, err)
	}

	list, err := f.Holidays(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "Founders Day" || list[1].Name != "Winter break" {
		t.Fatalf("holidays = %+v, %v", list, err)
	}
	audit, err := f.Audit(ctx, f.admin, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	created := 0
	for _, a := range audit {
		if a.Action == "holiday.create" {
			created++
		}
	}
	if created != 2 {
		t.Errorf("audit has %d holiday.create, want 2", created)
	}
}

func TestHolidayPayIsASetting(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()
	no, yes := false, true
	if _, err := f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Founders Day", Days: []HolidayDayInput{{Day: day(t, "2026-09-28")}}}); err != nil {
		t.Fatal(err)
	}
	holiday := func(who string) float64 {
		t.Helper()
		sum, err := f.Summary(ctx, f.admin, who, day(t, "2026-09-28"))
		if err != nil {
			t.Fatal(err)
		}
		return sum.Holiday
	}

	// On by default for everyone.
	if holiday("ada") != 8 || holiday("bob") != 8 {
		t.Fatal("holiday pay is on by default")
	}
	// Bob's own choice beats the workspace's.
	bob, err := f.UpdatePerson(ctx, f.admin, "bob", PersonUpdate{Active: true, ManagerID: "boss", HolidayPay: &no})
	if err != nil || bob.HolidayPay || bob.HolidayPayOverride == nil || *bob.HolidayPayOverride {
		t.Fatalf("bob = %+v, %v", bob, err)
	}
	if holiday("bob") != 0 || holiday("ada") != 8 {
		t.Fatal("bob's choice not to be paid applies to him alone")
	}
	// Turned off for the workspace, only those who chose it are paid.
	f.settings(func(s *Settings) { s.HolidayPay = false })
	if _, err := f.UpdatePerson(ctx, f.admin, "ada", PersonUpdate{Active: true, ManagerID: "boss", HolidayPay: &yes}); err != nil {
		t.Fatal(err)
	}
	if holiday("ada") != 8 || holiday("boss") != 0 {
		t.Fatal("with the workspace off, ada's own choice still pays her")
	}
	// Inactive people aren't paid, whatever they chose.
	if _, err := f.UpdatePerson(ctx, f.admin, "ada", PersonUpdate{Active: false, ManagerID: "boss", HolidayPay: &yes}); err != nil {
		t.Fatal(err)
	}
	if holiday("ada") != 0 {
		t.Fatal("an inactive person isn't paid for holidays")
	}
	// The day is still named for everyone.
	sum, err := f.Summary(ctx, f.admin, "boss", day(t, "2026-09-28"))
	if err != nil || holidayOn(t, sum, "2026-09-28").HolidayName != "Founders Day" {
		t.Fatalf("the holiday is named even when unpaid: %v", err)
	}
}

func TestHolidayRules(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false })
	ctx := t.Context()
	one := func(d string, hours float64) []HolidayDayInput {
		return []HolidayDayInput{{Day: day(t, d), Hours: hours}}
	}

	_, err := f.SaveHoliday(ctx, f.ada, uuid.Nil, HolidayInput{Name: "Mine", Days: one("2026-10-05", 0)})
	wantProblem(t, err, "forbidden")
	_, err = f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Twice", Days: append(one("2026-10-05", 0), one("2026-10-05", 4)...)})
	wantProblem(t, err, "validation")
	_, err = f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Long", Days: one("2026-10-05", 25)})
	wantProblem(t, err, "validation")

	founders, err := f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Founders Day", Days: one("2026-10-05", 0)})
	if err != nil {
		t.Fatal(err)
	}
	// A day is one holiday, so it is never paid twice.
	_, err = f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Again", Days: one("2026-10-05", 0)})
	wantProblem(t, err, ErrHolidayTaken.Code)

	// Once ada's timesheet is submitted, her pay for its days is settled.
	f.work(f.ada, "2026-10-01 09:00", "2026-10-01 17:00")
	if _, err := f.Submit(ctx, f.ada, "", day(t, "2026-10-01")); err != nil {
		t.Fatal(err)
	}
	_, err = f.SaveHoliday(ctx, f.admin, founders.ID, HolidayInput{Name: "Founders Day", Days: one("2026-10-05", 4)})
	wantProblem(t, err, ErrLocked.Code)
	_, err = f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "New", Days: one("2026-10-06", 0)})
	wantProblem(t, err, ErrLocked.Code)
	err = f.DeleteHoliday(ctx, f.admin, founders.ID)
	wantProblem(t, err, ErrLocked.Code)
	// Renaming changes no one's pay, and days outside the period are free.
	renamed, err := f.SaveHoliday(ctx, f.admin, founders.ID, HolidayInput{Name: "Founders' Day", Days: append(one("2026-10-05", 0), one("2026-10-20", 0)...)})
	if err != nil || renamed.Name != "Founders' Day" || len(renamed.Days) != 2 {
		t.Fatalf("renamed = %+v, %v", renamed, err)
	}
	// A settled timesheet of someone the holiday doesn't pay doesn't hold it.
	no := false
	if _, err := f.UpdatePerson(ctx, f.admin, "ada", PersonUpdate{Active: true, ManagerID: "boss", HolidayPay: &no}); err != nil {
		t.Fatal(err)
	}
	if err := f.DeleteHoliday(ctx, f.admin, founders.ID); err != nil {
		t.Fatal(err)
	}
	if list, err := f.Holidays(ctx); err != nil || len(list) != 0 {
		t.Fatalf("holidays after delete = %+v, %v", list, err)
	}
}

func TestHolidaysAreTheWorkspaces(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	if _, err := f.SaveHoliday(ctx, f.admin, uuid.Nil, HolidayInput{Name: "Founders Day", Days: []HolidayDayInput{{Day: day(t, "2026-09-28")}}}); err != nil {
		t.Fatal(err)
	}
	other, err := f.EnsureWorkspace(ctx, "other")
	if err != nil {
		t.Fatal(err)
	}
	g := f.In(other.ID)
	admin2, err := g.Sync(ctx, host.Person{ID: "admin", Name: "Other Admin", Email: "o@example.com", Admin: true})
	if err != nil {
		t.Fatal(err)
	}
	if list, err := g.Holidays(ctx); err != nil || len(list) != 0 {
		t.Fatalf("the other workspace's holidays = %+v, %v", list, err)
	}
	sum, err := g.Summary(ctx, admin2, "", day(t, "2026-09-28"))
	if err != nil || sum.Holiday != 0 {
		t.Fatalf("another workspace's holiday pays here: %v %v", sum.Holiday, err)
	}
	// The same day can be a holiday in each workspace, and one's ids mean
	// nothing in the other.
	mine, err := g.SaveHoliday(ctx, admin2, uuid.Nil, HolidayInput{Name: "Theirs", Days: []HolidayDayInput{{Day: day(t, "2026-09-28")}}})
	if err != nil {
		t.Fatal(err)
	}
	err = f.DeleteHoliday(ctx, f.admin, mine.ID)
	wantProblem(t, err, "not_found")
}
