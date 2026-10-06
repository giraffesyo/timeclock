package clock

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
)

func TestTogglHistoryRespectsReportDateFloor(t *testing.T) {
	for _, tc := range []struct {
		name, from, cursor string
	}{
		{name: "all history"},
		{name: "explicit old start", from: "1970-01-01"},
		{name: "earliest report day", from: "2006-01-01"},
		{name: "existing historical cursor", cursor: "1980-01-01"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, b, fake := togglFixture(t)
			seedToggl(f, fake)
			earliest := fake.entries[101]
			earliest.ID = 102
			earliest.Start = time.Date(2006, 1, 1, 0, 0, 0, 0, time.UTC)
			end := earliest.Start.Add(time.Hour)
			earliest.Stop = &end
			fake.entries[102] = earliest
			if err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{Token: "fake", WorkspaceID: 42, From: tc.from, People: []TogglMapping{{PersonID: f.ada.ID, UserID: 1}}}); err != nil {
				t.Fatal(err)
			}
			if tc.cursor != "" {
				if _, err := f.pool.Exec(t.Context(), `UPDATE toggl_workspaces SET history_cursor=$1 WHERE workspace_id=$W`, tc.cursor); err != nil {
					t.Fatal(err)
				}
			}
			// Six batches cover the supported history through the fixture's
			// October 2026 clock without spending batches on unsupported years.
			for range 6 {
				requireSync(t, f, b)
			}
			status, err := b.Status(t.Context(), f.Service, f.admin)
			if err != nil || !status.HistoryComplete {
				t.Fatalf("history did not finish: %+v %v", status, err)
			}
			var imported int
			if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM time_entries WHERE workspace_id=$W AND source='toggl'`).Scan(&imported); err != nil || imported != 2 {
				t.Fatalf("earliest-day and recent entries must import exactly once: %d %v", imported, err)
			}
		})
	}
}

func TestTogglAllHistoryAndOfflineReconnect(t *testing.T) {
	f, b, fake := togglFixture(t)
	seedToggl(f, fake)
	historical := fake.entries[101]
	historical.ID = 102
	historical.Start = f.time("2014-02-04 09:00")
	end := historical.Start.Add(time.Hour)
	historical.Stop = &end
	historical.Description = "Historical work"
	fake.entries[102] = historical
	setup := func() {
		t.Helper()
		if err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{Token: "fake", WorkspaceID: 42, People: []TogglMapping{{PersonID: f.ada.ID, UserID: 1}}}); err != nil {
			t.Fatal(err)
		}
	}
	sweep := func() {
		t.Helper()
		for range 20 {
			requireSync(t, f, b)
			status, err := b.Status(t.Context(), f.Service, f.admin)
			if err != nil {
				t.Fatal(err)
			}
			if status.HistoryComplete {
				return
			}
		}
		t.Fatal("history never finished")
	}
	list := func() []Entry {
		t.Helper()
		entries, err := f.Entries(t.Context(), f.admin, f.ada.ID, day(t, "2014-01-01"), day(t, "2026-10-02"))
		if err != nil {
			t.Fatal(err)
		}
		return entries
	}
	setup()
	sweep()
	entries := list()
	if len(entries) != 2 || entries[0].Note != "Historical work" {
		t.Fatal("all-history import omitted old time")
	}
	original := entries[0]
	if err := b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	if _, err := f.UpdateEntry(t.Context(), f.ada, original.ID, EntryInput{StartedAt: original.StartedAt, EndedAt: original.EndedAt, ProjectID: original.ProjectID, Note: "Offline local"}); err != nil {
		t.Fatal(err)
	}
	historical.Description = "Offline remote"
	fake.entries[102] = historical
	setup()
	sweep()
	entries = list()
	if len(entries) != 2 || entries[0].ID != original.ID || fake.posts != 0 {
		t.Fatal("reconnect duplicated historical time")
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 1 || status.Issues[0].Kind != "conflict" {
		t.Fatalf("offline edits did not become a conflict: %v %+v", err, status.Issues)
	}
	issue := status.Issues[0]
	if err = b.Resolve(t.Context(), f.Service, f.admin, issue.EntryID, TogglResolution{Choice: "remote", Version: issue.Version}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if list()[0].Note != "Offline remote" {
		t.Fatal("historical conflict resolution was not applied")
	}
}

func TestTogglHistoricalPagesResumeAfterRateLimit(t *testing.T) {
	f, b, fake := togglFixture(t)
	seedToggl(f, fake)
	e := fake.entries[101]
	e.Start = f.time("2014-02-04 09:00")
	end := e.Start.Add(time.Hour)
	e.Stop = &end
	fail := true
	firstPages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reports/api/v3/workspace/42/search/time_entries" {
			fake.ServeHTTP(w, r)
			return
		}
		var body struct {
			From string `json:"start_date"`
			To   string `json:"end_date"`
			Row  int    `json:"first_row_number"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.From > "2014-02-04" || body.To < "2014-02-04" {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		if body.Row == 0 {
			firstPages++
			w.Header().Set("X-Next-Row-Number", "1")
		} else if fail {
			w.Header().Set("Retry-After", "3600")
			w.WriteHeader(429)
			return
		}
		id := 101 + body.Row
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"user_id": e.UserID, "project_id": e.ProjectID, "description": fmt.Sprintf("Historical page %d", body.Row), "time_entries": []any{map[string]any{"id": id, "start": e.Start, "stop": e.Stop, "seconds": e.Duration}}}})
	}))
	defer server.Close()
	b.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	if err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{Token: "fake", WorkspaceID: 42, From: "2013-01-01", People: []TogglMapping{{PersonID: f.ada.ID, UserID: 1}}}); err != nil {
		t.Fatal(err)
	}
	if err := syncToggl(t, f, b); err == nil {
		t.Fatal("rate limit was ignored")
	}
	c, err := b.config(t.Context(), f.Service)
	if err != nil || c.history == nil || !c.history.After(c.from) {
		t.Fatal("completed history window was not checkpointed")
	}
	var imported int
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM time_entries WHERE workspace_id=$W`).Scan(&imported); err != nil || imported != 0 {
		t.Fatal("partial report was reconciled")
	}
	fail = false
	requireSync(t, f, b)
	if firstPages != 1 {
		t.Fatalf("restarted page one after rate limit: %d", firstPages)
	}
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM time_entries WHERE workspace_id=$W`).Scan(&imported); err != nil || imported != 2 {
		t.Fatalf("incomplete historical import: %d %v", imported, err)
	}
	if err = b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	var pages int
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM toggl_report_pages WHERE workspace_id=$W`).Scan(&pages); err != nil || pages != 0 {
		t.Fatal("disconnect left staged reports behind")
	}
}

func TestTogglReconnectReviewsOfflineRemoteDeletion(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	requireSync(t, f, b)
	entry := togglEntries(t, f)[0]
	if err := b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	delete(fake.entries, 101)
	if _, err := f.UpdateEntry(t.Context(), f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: entry.EndedAt, ProjectID: entry.ProjectID, Note: "Offline edit"}); err != nil {
		t.Fatal(err)
	}
	setupToggl(t, f, b)
	requireSync(t, f, b)
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 1 || status.Issues[0].Kind != "missing_remote" {
		t.Fatalf("offline deletion was not reviewed: %v %+v", err, status.Issues)
	}
	issue := status.Issues[0]
	if err = b.Resolve(t.Context(), f.Service, f.admin, issue.EntryID, TogglResolution{Choice: "local", Version: issue.Version}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if fake.posts != 1 {
		t.Fatal("keeping local time did not create its replacement")
	}
	if err = b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	setupToggl(t, f, b)
	requireSync(t, f, b)
	status, err = b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 0 || len(togglEntries(t, f)) != 1 || fake.posts != 1 {
		t.Fatalf("reconnect used the obsolete remote ID: %v %+v", err, status.Issues)
	}
}

func TestTogglReconnectPreservesDistinctRenamedProjects(t *testing.T) {
	f, b, _ := togglFixture(t)
	setupToggl(t, f, b)
	projects := []toggl.Project{{ID: 11, Name: "Repeated name", Active: true}, {ID: 12, Name: "Repeated name", Active: false}}
	if err := b.catalog(t.Context(), f.Service, 42, projects, nil); err != nil {
		t.Fatal(err)
	}
	original, err := togglProjects(t.Context(), f.pool)
	if err != nil || len(original) != 2 || original[11] == original[12] {
		t.Fatal("duplicate project names lost their separate identities")
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE projects SET name='Renamed locally' WHERE workspace_id=$W AND id=$1`, original[11]); err != nil {
		t.Fatal(err)
	}
	if err = b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	setupToggl(t, f, b)
	if err = b.catalog(t.Context(), f.Service, 42, []toggl.Project{projects[1], projects[0]}, nil); err != nil {
		t.Fatal(err)
	}
	restored, err := togglProjects(t.Context(), f.pool)
	if err != nil || restored[11] != original[11] || restored[12] != original[12] {
		t.Fatal("reconnect duplicated or reassigned renamed projects")
	}
}

func TestTogglReconciliationDiscardsStagedSnapshotBeforeWrites(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	requireSync(t, f, b)
	entry := togglEntries(t, f)[0]
	if _, err := f.UpdateEntry(t.Context(), f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: entry.EndedAt, ProjectID: entry.ProjectID, Note: "Local change"}); err != nil {
		t.Fatal(err)
	}
	// Fail the outbound write after the report has already been staged.
	fail := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail && r.Method == "PUT" {
			w.WriteHeader(503)
			return
		}
		fake.ServeHTTP(w, r)
	}))
	defer server.Close()
	b.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	if err := syncToggl(t, f, b); err == nil {
		t.Fatal("expected outbound write failure")
	}
	var pages int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM toggl_report_pages WHERE workspace_id=$W`).Scan(&pages); err != nil || pages != 0 {
		t.Fatal("a retry would reuse the old report snapshot")
	}
	remote := fake.entries[101]
	remote.Description = "New remote change after the failed attempt"
	fake.entries[101] = remote
	fail = false
	requireSync(t, f, b)
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || len(status.Issues) != 1 || status.Issues[0].Kind != "conflict" {
		t.Fatalf("retry did not fetch the fresh remote version: %v %+v", err, status.Issues)
	}
}

func TestTogglStagedReportResumesAcrossMidnight(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	fail := true
	firstPages := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reports/api/v3/workspace/42/search/time_entries" {
			fake.ServeHTTP(w, r)
			return
		}
		var body struct {
			To  string `json:"end_date"`
			Row int    `json:"first_row_number"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Row == 0 {
			firstPages[body.To]++
			w.Header().Set("X-Next-Row-Number", "1")
		} else if fail {
			w.WriteHeader(429)
			return
		}
		e := fake.entries[101]
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"user_id": e.UserID, "project_id": e.ProjectID, "description": fmt.Sprintf("Page %d", body.Row), "time_entries": []any{map[string]any{"id": 101 + body.Row, "start": e.Start, "stop": e.Stop, "seconds": e.Duration}}}})
	}))
	defer server.Close()
	b.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	if err := syncToggl(t, f, b); err == nil {
		t.Fatal("expected a rate limit")
	}
	f.clock = f.clock.Add(24 * time.Hour)
	fail = false
	requireSync(t, f, b)
	if firstPages["2026-10-03"] != 1 || firstPages["2026-10-04"] != 1 {
		t.Fatalf("midnight replayed or abandoned a staged report: %v", firstPages)
	}
	var pages int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM toggl_report_pages WHERE workspace_id=$W`).Scan(&pages); err != nil || pages != 0 {
		t.Fatal("old report pages were abandoned after midnight")
	}
}

// One entry Timeclock can't place must not stop the history import: before,
// an entry on a deleted Toggl project failed every sync at the same window.
func TestTogglHistoryContinuesPastUnavailableProjects(t *testing.T) {
	f, b, fake := togglFixture(t)
	seedToggl(f, fake)
	project, deleted := int64(11), int64(99)
	entry := func(id int64, user int64, p *int64, start string) {
		at := f.time(start)
		end := at.Add(time.Hour)
		fake.entries[id] = toggl.Entry{ID: id, WorkspaceID: 42, UserID: user, ProjectID: p, Start: at, Stop: &end, Duration: 3600, Description: fmt.Sprint("entry ", id)}
	}
	entry(103, 1, &deleted, "2024-02-01 09:00")
	entry(104, 1, &project, "2024-03-01 09:00")
	entry(105, 0, &project, "2024-04-01 09:00") // a report row with no user
	if err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{Token: "fake", WorkspaceID: 42, People: []TogglMapping{{PersonID: f.ada.ID, UserID: 1}}}); err != nil {
		t.Fatal(err)
	}
	for range 6 {
		requireSync(t, f, b)
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || !status.HistoryComplete {
		t.Fatalf("history did not finish: %+v %v", status, err)
	}
	var imported int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM time_entries WHERE workspace_id=$W AND source='toggl'`).Scan(&imported); err != nil || imported != 2 {
		t.Fatalf("the recent entry and the one after the unavailable project must import: %d %v", imported, err)
	}
	if len(status.Issues) != 1 || status.Issues[0].Kind != "project_unavailable" || *status.Issues[0].RemoteID != 103 {
		t.Fatalf("the entry on the deleted project waits for an admin: %+v", status.Issues)
	}

	// Once the project is back in Toggl's catalog, the next sweep imports it.
	fake.projects = append(fake.projects, toggl.Project{ID: deleted, WorkspaceID: 42, Name: "Restored", Active: false})
	for range 6 {
		requireSync(t, f, b)
	}
	if status, err = b.Status(t.Context(), f.Service, f.admin); err != nil || len(status.Issues) != 0 {
		t.Fatalf("the restored project clears the issue: %+v %v", status.Issues, err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM time_entries WHERE workspace_id=$W AND source='toggl'`).Scan(&imported); err != nil || imported != 3 {
		t.Fatalf("the entry imports with its project: %d %v", imported, err)
	}
}

func TestTogglSyncErrorSaysWhy(t *testing.T) {
	if got := togglMessage(errors.New("Toggl did not preserve the entry")); got != "Sync could not finish: Toggl did not preserve the entry" {
		t.Fatal(got)
	}
}
