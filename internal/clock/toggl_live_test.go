package clock

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/google/uuid"
)

// TestLiveTogglRoundTrip creates one disposable entry in an explicitly selected
// test workspace. It uses an isolated local database schema, edits only that
// entry, and deletes it on cleanup. Ordinary test runs never contact Toggl.
func TestLiveTogglRoundTrip(t *testing.T) {
	if os.Getenv("TIMECLOCK_TOGGL_TEST_WRITES") != "1" {
		t.Skip("set TIMECLOCK_TOGGL_TEST_WRITES=1 to allow disposable remote entries")
	}
	workspaceID, err := strconv.ParseInt(os.Getenv("TIMECLOCK_TOGGL_TEST_WORKSPACE_ID"), 10, 64)
	if err != nil || workspaceID <= 0 {
		t.Fatal("set TIMECLOCK_TOGGL_TEST_WORKSPACE_ID to the test workspace ID")
	}
	raw, err := os.ReadFile(os.Getenv("TIMECLOCK_TOGGL_TEST_TOKEN_FILE"))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		t.Fatal("set TIMECLOCK_TOGGL_TEST_TOKEN_FILE to a readable token file")
	}
	token := strings.TrimSpace(string(raw))
	f := newFixture(t)
	f.clock = time.Now().UTC()
	f.settings(func(s *Settings) { s.RequireProject = false; s.RequireDescription = false })
	b, err := NewToggl(f.Service, "isolated live test encryption key "+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	preview, err := b.Preview(t.Context(), f.Service, f.admin, token, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	// This test deliberately requires a single-user sandbox. Team permissions
	// and per-person ownership need a separate multi-user test workspace.
	if len(preview.Users) != 1 || preview.Users[0].Inactive {
		t.Fatal("the live round-trip test requires a single active user in the test workspace")
	}
	userID := preview.Users[0].ID
	start := f.clock.Add(-2 * time.Hour).Truncate(time.Second)
	end := start.Add(15 * time.Minute)
	if err = b.Configure(t.Context(), f.Service, f.admin, TogglSetup{
		Token: token, WorkspaceID: workspaceID, From: start.Format(time.DateOnly),
		People: []TogglMapping{{PersonID: f.ada.ID, UserID: userID}},
	}); err != nil {
		t.Fatal(err)
	}
	client := &toggl.Client{Token: token}
	note := "Timeclock disposable integration test " + uuid.NewString()
	write := toggl.Write{WorkspaceID: workspaceID, UserID: userID, Start: start, Stop: &end, Duration: 900, Description: note}
	remote, err := client.Save(t.Context(), write, 0)
	if err != nil {
		t.Fatalf("create disposable entry: %v", err)
	}
	if remote.ID <= 0 {
		t.Fatal("Toggl did not return a disposable entry ID")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := client.Delete(ctx, workspaceID, remote.ID); err != nil {
			t.Errorf("cleanup failed for disposable Toggl entry %d: %v", remote.ID, err)
		}
	})
	if remote.WorkspaceID != workspaceID || remote.UserID != userID {
		t.Fatal("disposable entry ownership differs from the selected workspace and user")
	}
	requireSync(t, f, b)
	var entryID uuid.UUID
	if err = f.pool.QueryRow(t.Context(), `SELECT entry_id FROM toggl_entries WHERE workspace_id=$W AND remote_id=$1`, remote.ID).Scan(&entryID); err != nil {
		t.Fatalf("imported entry mapping: %v", err)
	}
	local, owner, err := togglLocal(t.Context(), f.pool, entryID)
	if err != nil || local.Deleted || owner != f.ada.ID || local.Note != note {
		t.Fatal("remote entry did not import with the expected owner and description")
	}
	write.Description = note + " edited in Timeclock"
	if _, err = f.UpdateEntry(t.Context(), f.ada, entryID, EntryInput{StartedAt: start, EndedAt: &end, Note: write.Description}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	updated, err := client.Entry(t.Context(), remote.ID)
	if err != nil || updated.Description != write.Description {
		t.Fatalf("Timeclock edit did not reach Toggl: %v", err)
	}
	write.Description = note + " edited in Toggl"
	if _, err = client.Save(t.Context(), write, remote.ID); err != nil {
		t.Fatalf("edit disposable entry in Toggl: %v", err)
	}
	requireSync(t, f, b)
	local, _, err = togglLocal(t.Context(), f.pool, entryID)
	if err != nil || local.Deleted || local.Note != write.Description {
		t.Fatal("Toggl edit did not reach Timeclock")
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 0 {
		t.Fatal("round trip left unresolved sync issues")
	}
	if err = b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err = f.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM toggl_workspaces WHERE workspace_id=$W)+
		(SELECT count(*) FROM toggl_people WHERE workspace_id=$W)+
		(SELECT count(*) FROM toggl_projects WHERE workspace_id=$W)+
		(SELECT count(*) FROM toggl_entries WHERE workspace_id=$W)`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatal("disconnect left credentials or mappings behind")
	}
	local, _, err = togglLocal(t.Context(), f.pool, entryID)
	if err != nil || local.Deleted || local.Note != write.Description {
		t.Fatal("disconnect did not preserve imported time")
	}
	t.Log("Live import, edits in both directions, and disconnect cleanup passed")
}
