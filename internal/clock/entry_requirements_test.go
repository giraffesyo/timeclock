package clock

import (
	"testing"

	"github.com/parallelworks/foundation/problem"
)

func TestClockRequirementsApplyWhenStopping(t *testing.T) {
	for _, rules := range []struct {
		name                 string
		project, description bool
	}{
		{"neither", false, false},
		{"project", true, false},
		{"description", false, true},
		{"both", true, true},
	} {
		t.Run(rules.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := t.Context()
			f.settings(func(s *Settings) { s.RequireProject, s.RequireDescription = rules.project, rules.description })
			running, err := f.ClockIn(ctx, f.ada, nil, " \t\n ")
			if err != nil {
				t.Fatal(err)
			}
			f.at("2026-10-02 17:05")
			if !rules.project && !rules.description {
				if _, err := f.ClockOut(ctx, f.ada); err != nil {
					t.Fatal(err)
				}
				return
			}
			code := problem.Code("project_required")
			if rules.description {
				code = "description_required"
			}
			_, err = f.ClockOut(ctx, f.ada)
			wantProblem(t, err, code)
			end := f.clock
			_, err = f.UpdateEntry(ctx, f.ada, running.ID, EntryInput{StartedAt: running.StartedAt, EndedAt: &end})
			if rules.project {
				wantProblem(t, err, "project_required")
			} else {
				wantProblem(t, err, "description_required")
			}
			got, err := f.Running(ctx, f.ada)
			if err != nil || got == nil || got.ID != running.ID || !got.StartedAt.Equal(running.StartedAt) {
				t.Fatalf("refused stop changed running entry: %+v, %v", got, err)
			}
			// Either field can be saved first while the other is still absent.
			if _, err = f.UpdateEntry(ctx, f.ada, running.ID, EntryInput{StartedAt: running.StartedAt, Note: "Planning"}); err != nil {
				t.Fatal(err)
			}
			p, err := f.SaveProject(ctx, f.admin, [16]byte{}, ProjectInput{Name: "Planning"})
			if err != nil {
				t.Fatal(err)
			}
			gotEntry, err := f.Switch(ctx, f.ada, &p.ID, "")
			if err != nil || (rules.project && (gotEntry.ID != running.ID || !gotEntry.StartedAt.Equal(running.StartedAt))) {
				t.Fatalf("assigning a project lost elapsed time: %+v, %v", gotEntry, err)
			}
			if _, err = f.UpdateEntry(ctx, f.ada, gotEntry.ID, EntryInput{StartedAt: gotEntry.StartedAt, ProjectID: &p.ID, Note: "Planning"}); err != nil {
				t.Fatal(err)
			}
			if _, err = f.ClockOut(ctx, f.ada); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSwitchDoesNotFinishIncompleteTime(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.settings(func(s *Settings) { s.RequireDescription = true })
	p, err := f.SaveProject(ctx, f.admin, [16]byte{}, ProjectInput{Name: "Planning"})
	if err != nil {
		t.Fatal(err)
	}
	running, err := f.ClockIn(ctx, f.ada, &p.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	f.at("2026-10-02 17:05")
	next, err := f.Switch(ctx, f.ada, &p.ID, "Planning")
	if err != nil || next.ID != running.ID {
		t.Fatalf("incomplete entry split: %+v, %v", next, err)
	}
	// Once complete, a switch can close this stretch and start an incomplete one.
	next, err = f.Switch(ctx, f.ada, nil, "")
	if err != nil || next.ID == running.ID {
		t.Fatalf("complete entry did not split: %+v, %v", next, err)
	}
	_, err = f.ClockOut(ctx, f.ada)
	wantProblem(t, err, "description_required")
}

func TestDescriptionRequirement(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.settings(func(s *Settings) { s.RequireProject = false })
	end := f.time("2026-10-02 10:00")
	in := EntryInput{StartedAt: f.time("2026-10-02 09:00"), EndedAt: &end}
	entry, err := f.CreateEntry(ctx, f.ada, in)
	if err != nil {
		t.Fatal(err)
	}
	// Existing clocks must also satisfy the rule before they can stop.
	if _, err := f.ClockIn(ctx, f.bob, nil, ""); err != nil {
		t.Fatal(err)
	}
	f.settings(func(s *Settings) { s.RequireDescription = true })
	cfg, err := f.Settings(ctx)
	if err != nil || !cfg.RequireDescription || cfg.RequireProject {
		t.Fatalf("settings = %+v, error = %v", cfg, err)
	}
	_, err = f.ClockOut(ctx, f.bob)
	wantProblem(t, err, "description_required")
	for _, blank := range []string{"", " \t\n "} {
		in.Note = blank
		_, err = f.CreateEntry(ctx, f.ada, in)
		wantProblem(t, err, "description_required")
		_, err = f.UpdateEntry(ctx, f.ada, entry.ID, in)
		wantProblem(t, err, "description_required")
	}
	in.Note = "  Design review  "
	if entry, err = f.UpdateEntry(ctx, f.ada, entry.ID, in); err != nil || entry.Note != "Design review" {
		t.Fatalf("updated entry = %+v, error = %v", entry, err)
	}
	if _, err = f.CreateEntry(ctx, f.ada, in); err != nil {
		t.Fatal(err)
	}
	running, err := f.ClockIn(ctx, f.ada, nil, "Build")
	if err != nil {
		t.Fatal(err)
	}
	// An incomplete replacement can run, but cannot stop even after a split.
	f.at("2026-10-02 17:05")
	next, err := f.Switch(ctx, f.ada, nil, " \t ")
	if err != nil || next.ID == running.ID || next.Note != "" {
		t.Fatalf("switched entry = %+v, error = %v", next, err)
	}
	_, err = f.ClockOut(ctx, f.ada)
	wantProblem(t, err, "description_required")
	if _, err = f.Switch(ctx, f.ada, nil, "Review"); err != nil {
		t.Fatal(err)
	}
	// The two requirements can be changed independently.
	f.settings(func(s *Settings) { s.RequireDescription = false; s.RequireProject = true })
	in.Note = ""
	_, err = f.CreateEntry(ctx, f.ada, in)
	wantProblem(t, err, "project_required")
	f.settings(func(s *Settings) { s.RequireProject = false })
	if _, err = f.CreateEntry(ctx, f.ada, in); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Switch(ctx, f.ada, nil, ""); err != nil {
		t.Fatal(err)
	}
}

func TestEntryRequirementsAreWorkspaceSettings(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.settings(func(s *Settings) { s.RequireProject = false; s.RequireDescription = true })
	ws, err := f.EnsureWorkspace(ctx, "other")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.In(ws.ID).Settings(ctx)
	if err != nil || !other.RequireProject || other.RequireDescription {
		t.Fatalf("other workspace settings = %+v, error = %v", other, err)
	}
	cfg, err := f.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cfg.RequireDescription = false
	_, err = f.UpdateSettings(ctx, f.ada, cfg)
	wantProblem(t, err, "forbidden")
	cfg, err = f.Settings(ctx)
	if err != nil || !cfg.RequireDescription {
		t.Fatalf("member changed settings = %+v, error = %v", cfg, err)
	}
}
