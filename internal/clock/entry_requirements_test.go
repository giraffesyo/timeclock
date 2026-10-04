package clock

import "testing"

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
	// Existing clocks can still be stopped after the rule is enabled.
	if _, err := f.ClockIn(ctx, f.bob, nil, ""); err != nil {
		t.Fatal(err)
	}
	f.settings(func(s *Settings) { s.RequireDescription = true })
	cfg, err := f.Settings(ctx)
	if err != nil || !cfg.RequireDescription || cfg.RequireProject {
		t.Fatalf("settings = %+v, error = %v", cfg, err)
	}
	if _, err := f.ClockOut(ctx, f.bob); err != nil {
		t.Fatal(err)
	}
	for _, blank := range []string{"", " \t\n "} {
		in.Note = blank
		_, err = f.CreateEntry(ctx, f.ada, in)
		wantProblem(t, err, "description_required")
		_, err = f.UpdateEntry(ctx, f.ada, entry.ID, in)
		wantProblem(t, err, "description_required")
		_, err = f.ClockIn(ctx, f.ada, nil, blank)
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
	// Validate both the immediate retag and later split, without stopping the original clock.
	for _, when := range []string{"2026-10-02 17:00", "2026-10-02 17:05"} {
		f.at(when)
		_, err = f.Switch(ctx, f.ada, nil, " \t ")
		wantProblem(t, err, "description_required")
		got, err := f.Running(ctx, f.ada)
		if err != nil || got == nil || got.ID != running.ID || got.Note != "Build" {
			t.Fatalf("running = %+v, error = %v", got, err)
		}
	}
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
