package clock

import (
	"testing"

	"github.com/google/uuid"
)

func typeNamed(t *testing.T, f *fixture, name string) TimeOffType {
	t.Helper()
	types, err := f.TimeOffTypes(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, typ := range types {
		if typ.Name == name {
			return typ
		}
	}
	t.Fatalf("no time off type %q in %+v", name, types)
	return TimeOffType{}
}

func TestTimeOffTypes(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()

	// A workspace starts with Vacation (PTO) and Sick.
	types, err := f.TimeOffTypes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(types) != 2 || types[0].Name != "Vacation" || types[0].PaysAs != Vacation || types[1].Name != "Sick" || types[1].PaysAs != Sick {
		t.Fatalf("starting types = %+v", types)
	}

	_, err = f.SaveTimeOffType(ctx, f.boss, uuid.Nil, TimeOffTypeInput{Name: "Health day", PaysAs: Sick})
	wantProblem(t, err, "forbidden")
	health, err := f.SaveTimeOffType(ctx, f.admin, uuid.Nil, TimeOffTypeInput{Name: " Health day ", PaysAs: Sick})
	if err != nil {
		t.Fatal(err)
	}
	if health.Name != "Health day" || health.PaysAs != Sick || health.Used || health.Archived {
		t.Fatalf("added %+v", health)
	}
	_, err = f.SaveTimeOffType(ctx, f.admin, uuid.Nil, TimeOffTypeInput{Name: "health DAY", PaysAs: Vacation})
	wantProblem(t, err, "name_taken")

	// Time off is recorded as its type, and paid as the type says.
	off, err := f.RequestTimeOff(ctx, f.ada, TimeOffInput{TypeID: health.ID, From: day(t, "2026-10-05"), To: day(t, "2026-10-05"), Hours: 8})
	if err != nil {
		t.Fatal(err)
	}
	if off[0].TypeID != health.ID || off[0].TypeName != "Health day" || off[0].Kind != Sick {
		t.Fatalf("recorded %+v", off[0])
	}
	// Another type paid the same way can share the day; the same type can't.
	if _, err := f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Sick, From: day(t, "2026-10-05"), To: day(t, "2026-10-05"), Hours: 1}); err != nil {
		t.Fatalf("sick beside a health day: %v", err)
	}
	_, err = f.RequestTimeOff(ctx, f.ada, TimeOffInput{TypeID: health.ID, From: day(t, "2026-10-05"), To: day(t, "2026-10-05"), Hours: 1})
	wantProblem(t, err, "entry_overlaps")

	// Once used, a type is renamed freely but keeps how it's paid.
	_, err = f.SaveTimeOffType(ctx, f.admin, health.ID, TimeOffTypeInput{Name: "Health day", PaysAs: Vacation})
	wantProblem(t, err, "time_off_type_used")
	renamed, err := f.SaveTimeOffType(ctx, f.admin, health.ID, TimeOffTypeInput{Name: "Wellness day", PaysAs: Sick})
	if err != nil || renamed.Name != "Wellness day" || !renamed.Used {
		t.Fatalf("renamed = %+v, %v", renamed, err)
	}
	list, err := f.TimeOff(ctx, f.ada, "", day(t, "2026-10-05"), day(t, "2026-10-05"))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, o := range list {
		names[o.TypeName] = true
	}
	if !names["Wellness day"] || !names["Sick"] {
		t.Fatalf("listed under %v, want the new name", names)
	}

	// Archived, it isn't offered for new time off, but what was keeps its name.
	if _, err := f.SaveTimeOffType(ctx, f.admin, health.ID, TimeOffTypeInput{Name: "Wellness day", PaysAs: Sick, Archived: true}); err != nil {
		t.Fatal(err)
	}
	_, err = f.RequestTimeOff(ctx, f.ada, TimeOffInput{TypeID: health.ID, From: day(t, "2026-10-06"), To: day(t, "2026-10-06"), Hours: 8})
	wantProblem(t, err, "validation")

	// Asked for by how it's paid, time off is the first type offered paid that way.
	sick := typeNamed(t, f, "Sick")
	if _, err := f.SaveTimeOffType(ctx, f.admin, sick.ID, TimeOffTypeInput{Name: "Sick", PaysAs: Sick, Archived: true}); err != nil {
		t.Fatal(err)
	}
	later, err := f.SaveTimeOffType(ctx, f.admin, uuid.Nil, TimeOffTypeInput{Name: "Unwell", PaysAs: Sick})
	if err != nil {
		t.Fatal(err)
	}
	off, err = f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Sick, From: day(t, "2026-10-07"), To: day(t, "2026-10-07"), Hours: 8})
	if err != nil || off[0].TypeID != later.ID {
		t.Fatalf("sick by kind = %+v, %v; want %s", off, err, later.Name)
	}

	// Something is always offered.
	vacation := typeNamed(t, f, "Vacation")
	if _, err := f.SaveTimeOffType(ctx, f.admin, vacation.ID, TimeOffTypeInput{Name: "Vacation", PaysAs: Vacation, Archived: true}); err != nil {
		t.Fatal(err)
	}
	_, err = f.SaveTimeOffType(ctx, f.admin, later.ID, TimeOffTypeInput{Name: "Unwell", PaysAs: Sick, Archived: true})
	wantProblem(t, err, "validation")
}

// Where no approval is needed, time off counts at once and names no one as
// approving it; a manager may still approve it, which names them, but not
// reject it.
func TestOptionalTimeOffApproval(t *testing.T) {
	f := newFixture(t)
	f.settings(func(s *Settings) { s.ApproveTimeOff = false })
	ctx := t.Context()

	off, err := f.RequestTimeOff(ctx, f.ada, TimeOffInput{Kind: Vacation, From: day(t, "2026-10-05"), To: day(t, "2026-10-06"), Hours: 8})
	if err != nil {
		t.Fatal(err)
	}
	if off[0].Status != StatusApproved || off[0].DecidedBy != "" || off[0].DecidedAt != nil {
		t.Fatalf("recorded %+v, want approved by no one", off[0])
	}
	if pending, _ := f.PendingTimeOff(ctx, f.boss); len(pending) != 0 {
		t.Errorf("boss has %d waiting, want none", len(pending))
	}
	unapproved, err := f.UnapprovedTimeOff(ctx, f.boss)
	if err != nil || len(unapproved) != 2 || unapproved[0].TypeName != "Vacation" {
		t.Fatalf("boss may approve %+v (%v), want ada's 2 days", unapproved, err)
	}
	if mine, _ := f.UnapprovedTimeOff(ctx, f.ada); len(mine) != 0 {
		t.Errorf("ada may approve %d of her own, want none", len(mine))
	}

	_, err = f.DecideTimeOff(ctx, f.boss, off[0].ID, false, "no")
	wantProblem(t, err, "not_awaiting_decision")
	_, err = f.DecideTimeOff(ctx, f.ada, off[0].ID, true, "")
	wantProblem(t, err, "own_approval")
	approved, err := f.DecideTimeOff(ctx, f.boss, off[0].ID, true, "enjoy")
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != StatusApproved || approved.DecidedBy != f.boss.ID || approved.DecidedByName != "Bo Boss" || approved.DecisionNote != "enjoy" {
		t.Fatalf("approved %+v", approved)
	}
	_, err = f.DecideTimeOff(ctx, f.boss, off[0].ID, true, "")
	wantProblem(t, err, "not_awaiting_decision")
	if left, _ := f.UnapprovedTimeOff(ctx, f.boss); len(left) != 1 || left[0].ID != off[1].ID {
		t.Errorf("left to approve %+v, want the second day", left)
	}

	// Approving changes nothing payroll pays.
	sum, err := f.Summary(ctx, f.ada, "", day(t, "2026-10-05"))
	if err != nil || sum.Vacation != 16 || sum.PendingTimeOff != 0 {
		t.Errorf("summary vacation %v pending %v (%v), want 16 and 0", sum.Vacation, sum.PendingTimeOff, err)
	}

	// Long past, it's no longer offered for approving.
	f.at("2026-11-20 09:00")
	if left, _ := f.UnapprovedTimeOff(ctx, f.boss); len(left) != 0 {
		t.Errorf("a month on, %d still offered for approving", len(left))
	}
}
