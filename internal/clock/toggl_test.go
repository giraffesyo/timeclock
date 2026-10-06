package clock

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/google/uuid"
)

type fakeToggl struct {
	entries              map[int64]toggl.Entry
	next                 int64
	posts, puts, deletes int
	failCreate           bool
	calls                int
	projects             []toggl.Project
	// slowerThan makes reports spanning more days than this too slow to answer.
	slowerThan int
	slow       time.Duration
}

func (f *fakeToggl) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls++
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch {
	case r.URL.Path == "/api/v9/me/workspaces":
		write([]toggl.Workspace{{ID: 42, OrganizationID: 9, Name: "Trial", Admin: true}})
	case strings.Contains(r.URL.Path, "/workspace_users"):
		write([]toggl.User{{ID: 1, Email: "ADA@example.com", Name: "Ada"}, {ID: 2, Email: "bob@example.com", Name: "Bob"}})
	case strings.HasSuffix(r.URL.Path, "/projects"):
		write(append([]toggl.Project{{ID: 11, WorkspaceID: 42, Name: "Migration", Active: true}}, f.projects...))
	case strings.HasSuffix(r.URL.Path, "/clients"):
		write([]toggl.Customer{})
	case strings.HasPrefix(r.URL.Path, "/reports/"):
		var body struct {
			From string `json:"start_date"`
			To   string `json:"end_date"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.From < "2006-01-01" {
			http.Error(w, "start_date must be on or after 2006-01-01", http.StatusBadRequest)
			return
		}
		from, _ := time.Parse(time.DateOnly, body.From)
		to, _ := time.Parse(time.DateOnly, body.To)
		if f.slowerThan > 0 && to.Sub(from) > time.Duration(f.slowerThan)*24*time.Hour {
			time.Sleep(f.slow)
		}
		groups := []any{}
		for _, e := range f.entries {
			date := e.Start.Format(time.DateOnly)
			if date < body.From || date > body.To {
				continue
			}
			groups = append(groups, map[string]any{"user_id": e.UserID, "project_id": e.ProjectID, "description": e.Description, "time_entries": []any{map[string]any{"id": e.ID, "start": e.Start, "stop": e.Stop, "seconds": e.Duration}}})
		}
		write(groups)
	case strings.HasPrefix(r.URL.Path, "/api/v9/me/time_entries/"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/api/v9/me/time_entries/"), 10, 64)
		e, ok := f.entries[id]
		if !ok {
			w.WriteHeader(404)
			return
		}
		write(e)
	case strings.HasPrefix(r.URL.Path, "/api/v9/workspaces/42/time_entries"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/api/v9/workspaces/42/time_entries/"), 10, 64)
		if r.Method == "DELETE" {
			delete(f.entries, id)
			f.deletes++
			w.WriteHeader(200)
			return
		}
		var body toggl.Write
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(400)
			return
		}
		if r.Method == "POST" {
			f.posts++
			f.next++
			id = f.next
		} else {
			f.puts++
		}
		e := toggl.Entry{ID: id, WorkspaceID: body.WorkspaceID, UserID: body.UserID, ProjectID: body.ProjectID, Description: body.Description, Start: body.Start, Stop: body.Stop, Duration: body.Duration}
		f.entries[id] = e
		if f.failCreate && r.Method == "POST" {
			w.WriteHeader(500)
			return
		}
		write(e)
	default:
		w.WriteHeader(404)
	}
}
func togglFixture(t *testing.T) (*fixture, *Toggl, *fakeToggl) {
	t.Helper()
	f := newFixture(t)
	f.settings(func(s *Settings) { s.RequireProject = false; s.RequireDescription = false })
	fake := &fakeToggl{entries: map[int64]toggl.Entry{}, next: 1000}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	bridge, err := NewToggl(f.Service, "a long test secret key kept outside the database", slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	bridge.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	return f, bridge, fake
}
func setupToggl(t *testing.T, f *fixture, b *Toggl) {
	t.Helper()
	err := b.Configure(t.Context(), f.Service, f.admin, TogglSetup{Token: "private-api-token", WorkspaceID: 42, From: "2026-10-01", People: []TogglMapping{{PersonID: f.ada.ID, UserID: 1}}})
	if err != nil {
		t.Fatal(err)
	}
}
func syncToggl(t *testing.T, f *fixture, b *Toggl) error {
	t.Helper()
	c, err := b.config(t.Context(), f.Service)
	if err != nil {
		return err
	}
	token, err := b.token(t.Context(), f.Service, "")
	if err != nil {
		return err
	}
	return b.withLock(t.Context(), f.Service, func() error { return b.sync(t.Context(), f.Service, c, b.client(token)) })
}
func seedToggl(f *fixture, fake *fakeToggl) {
	end := f.time("2026-10-01 10:00")
	project := int64(11)
	fake.entries[101] = toggl.Entry{ID: 101, WorkspaceID: 42, UserID: 1, ProjectID: &project, Start: f.time("2026-10-01 09:00"), Stop: &end, Duration: 3600, Description: "Original"}
}
func togglEntries(t *testing.T, f *fixture) []Entry {
	t.Helper()
	entries, err := f.Entries(t.Context(), f.admin, f.ada.ID, day(t, "2026-10-01"), day(t, "2026-10-02"))
	if err != nil {
		t.Fatal(err)
	}
	return entries
}
func requireSync(t *testing.T, f *fixture, b *Toggl) {
	t.Helper()
	if err := syncToggl(t, f, b); err != nil {
		t.Fatal(err)
	}
}

func TestTogglTwoWayConflictAndDeletion(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	requireSync(t, f, b)
	requireSync(t, f, b)
	entries := togglEntries(t, f)
	if len(entries) != 1 {
		t.Fatalf("duplicate import: %d", len(entries))
	}
	entry := entries[0]
	if _, err := f.UpdateEntry(t.Context(), f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: entry.EndedAt, ProjectID: entry.ProjectID, Note: "Local edit"}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if fake.entries[101].Description != "Local edit" || fake.puts != 1 || fake.posts != 0 {
		t.Fatal("local change was not pushed once")
	}
	remote := fake.entries[101]
	remote.Description = "Remote edit"
	fake.entries[101] = remote
	requireSync(t, f, b)
	if togglEntries(t, f)[0].Note != "Remote edit" {
		t.Fatal("remote change not pulled")
	}
	if _, err := f.UpdateEntry(t.Context(), f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: entry.EndedAt, ProjectID: entry.ProjectID, Note: "Conflicting local"}); err != nil {
		t.Fatal(err)
	}
	remote.Description = "Conflicting remote"
	fake.entries[101] = remote
	requireSync(t, f, b)
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Issues) != 1 || status.Issues[0].Kind != "conflict" {
		t.Fatalf("missing conflict: %+v", status.Issues)
	}
	issue := status.Issues[0]
	if err = b.Resolve(t.Context(), f.Service, f.admin, issue.EntryID, TogglResolution{Choice: "remote", Version: "stale"}); err == nil {
		t.Fatal("accepted stale conflict")
	}
	if err = b.Resolve(t.Context(), f.Service, f.admin, issue.EntryID, TogglResolution{Choice: "remote", Version: issue.Version}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if togglEntries(t, f)[0].Note != "Conflicting remote" {
		t.Fatal("resolution not applied")
	}
	if err = f.DeleteEntry(t.Context(), f.ada, entry.ID); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	requireSync(t, f, b)
	if fake.deletes != 1 || len(fake.entries) != 0 {
		t.Fatal("delete was not propagated once")
	}
}
func TestTogglMissingRemoteNeedsDecisionAndLockedTimeIsProtected(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	requireSync(t, f, b)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO timesheets(id,workspace_id,person_id,period_start,period_end,status) VALUES($1,$W,$2,'2026-09-28','2026-10-11','submitted')`, uuid.New(), f.ada.ID); err != nil {
		t.Fatal(err)
	}
	remote := fake.entries[101]
	remote.Description = "Changed after payroll"
	fake.entries[101] = remote
	requireSync(t, f, b)
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Issues) != 1 || status.Issues[0].Kind != "locked" || togglEntries(t, f)[0].Note != "Original" {
		t.Fatalf("changed locked time: %+v", status)
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE timesheets SET status='rejected' WHERE workspace_id=$W`); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	delete(fake.entries, 101)
	requireSync(t, f, b)
	status, err = b.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(togglEntries(t, f)) != 1 || len(status.Issues) != 1 || status.Issues[0].Kind != "missing_remote" {
		t.Fatal("missing row silently deleted time")
	}
	issue := status.Issues[0]
	if err = b.Resolve(t.Context(), f.Service, f.admin, issue.EntryID, TogglResolution{Choice: "remote", Version: issue.Version}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	if len(togglEntries(t, f)) != 0 {
		t.Fatal("confirmed deletion not applied")
	}
}
func TestTogglAmbiguousCreateIsNotRetried(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	f.work(f.ada, "2026-10-01 11:00", "2026-10-01 12:00")
	fake.failCreate = true
	if err := syncToggl(t, f, b); err == nil {
		t.Fatal("expected remote failure")
	}
	fake.failCreate = false
	requireSync(t, f, b)
	if fake.posts != 1 || len(togglEntries(t, f)) != 1 {
		t.Fatal("uncertain creation produced duplicates")
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Issues) != 1 || status.Issues[0].Kind != "creation_uncertain" {
		t.Fatalf("missing recovery: %+v", status)
	}
	issue := status.Issues[0]
	if err = b.Resolve(t.Context(), f.Service, f.admin, issue.EntryID, TogglResolution{Choice: "link", RemoteID: fake.next, Version: issue.Version}); err != nil {
		t.Fatal(err)
	}
	requireSync(t, f, b)
	status, err = b.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Issues) != 0 || fake.posts != 1 {
		t.Fatal("failed recovery")
	}
}
func TestTogglDisconnectClearsEverythingExceptImportedData(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	requireSync(t, f, b)
	var sealed []byte
	if err := f.pool.QueryRow(t.Context(), `SELECT token FROM toggl_workspaces WHERE workspace_id=$W`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(sealed), "private-api-token") {
		t.Fatal("plaintext token in database")
	}
	other, err := f.EnsureWorkspace(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.box.Open(nil, nil, sealed, []byte(other.ID.String())); err == nil {
		t.Fatal("credential not bound to workspace")
	}
	if err = b.Disconnect(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"toggl_workspaces", "toggl_people", "toggl_projects", "toggl_entries", "toggl_report_pages"} {
		var n int
		if err = f.pool.QueryRow(t.Context(), fmt.Sprintf("SELECT count(*) FROM %s WHERE workspace_id=$W", table)).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s remains: %d %v", table, n, err)
		}
	}
	if len(togglEntries(t, f)) != 1 {
		t.Fatal("disconnect removed imported time")
	}
	setupToggl(t, f, b)
	requireSync(t, f, b)
	if len(togglEntries(t, f)) != 1 || fake.posts != 0 {
		t.Fatal("reconnect duplicated matching time")
	}
}
func TestTogglAdminAndWorkspaceIsolation(t *testing.T) {
	f, b, fake := togglFixture(t)
	if _, err := b.Preview(t.Context(), f.Service, f.ada, "secret", 42); err == nil || fake.calls != 0 {
		t.Fatal("non-admin reached Toggl")
	}
	setupToggl(t, f, b)
	other, err := f.EnsureWorkspace(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}
	s := f.In(other.ID)
	status, err := b.Status(t.Context(), s, f.admin)
	if err != nil || status.Connected || len(status.People) != 0 {
		t.Fatal("cross-workspace status leak")
	}
	if err = b.Disconnect(t.Context(), s, f.admin); err != nil {
		t.Fatal(err)
	}
	if _, err = b.config(t.Context(), f.Service); err != nil {
		t.Fatal("other workspace disconnected this one")
	}
}
func TestTogglRateLimitBackoff(t *testing.T) {
	f, b, _ := togglFixture(t)
	setupToggl(t, f, b)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7200")
		w.WriteHeader(429)
	}))
	defer server.Close()
	b.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	// New connections use database now(), whereas this fixture has a fixed clock.
	if _, err := f.pool.Exec(t.Context(), `UPDATE toggl_workspaces SET next_sync=$1 WHERE workspace_id=$W`, f.clock.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := b.run(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	c, err := b.config(t.Context(), f.Service)
	if err != nil {
		t.Fatal(err)
	}
	if c.next.Before(f.clock.Add(2 * time.Hour)) {
		t.Fatal("retry-after not honored")
	}
	if err = b.RequestSync(t.Context(), f.Service, f.admin); err != nil {
		t.Fatal(err)
	}
	again, err := b.config(t.Context(), f.Service)
	if err != nil {
		t.Fatal(err)
	}
	if !again.next.Equal(c.next) {
		t.Fatal("manual sync bypassed backoff")
	}
}
func TestTogglStateEquality(t *testing.T) {
	now := time.Now()
	end := now.Add(time.Hour)
	a := togglState{Start: now, End: &end, Note: "x"}
	b := a
	b.Start = now.In(time.FixedZone("offset", 3600))
	if !a.equal(b) {
		t.Fatal("equal instants differ")
	}
	if a.equal(togglState{Deleted: true}) {
		t.Fatal("deletion equals live time")
	}
}

func TestTogglRunningAndOwnershipChangesAreNotOverwritten(t *testing.T) {
	f, b, fake := togglFixture(t)
	setupToggl(t, f, b)
	seedToggl(f, fake)
	requireSync(t, f, b)
	entry := togglEntries(t, f)[0]
	if _, err := f.UpdateEntry(t.Context(), f.ada, entry.ID, EntryInput{StartedAt: entry.StartedAt, EndedAt: entry.EndedAt, ProjectID: entry.ProjectID, Note: "Local edit"}); err != nil {
		t.Fatal(err)
	}
	remote := fake.entries[101]
	remote.Duration = -1
	remote.Stop = nil
	fake.entries[101] = remote
	requireSync(t, f, b)
	if fake.puts != 0 {
		t.Fatal("stopped a timer that was running in Toggl")
	}
	remote.Duration = 3600
	remote.Stop = entry.EndedAt
	remote.UserID = 999
	fake.entries[101] = remote
	requireSync(t, f, b)
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Issues) != 1 || status.Issues[0].Kind != "ownership_changed" || fake.puts != 0 {
		t.Fatal("did not protect changed ownership")
	}
	remote.UserID = 1
	fake.entries[101] = remote
	requireSync(t, f, b)
	if fake.entries[101].Description != "Local edit" {
		t.Fatal("restoring ownership did not unblock sync")
	}
}

func TestTogglDisconnectWaitsForWorkspaceSync(t *testing.T) {
	f, b, _ := togglFixture(t)
	setupToggl(t, f, b)
	locked, release, syncDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		syncDone <- b.withLock(t.Context(), f.Service, func() error { close(locked); <-release; return nil })
	}()
	<-locked
	disconnected := make(chan error, 1)
	go func() { disconnected <- b.Disconnect(t.Context(), f.Service, f.admin) }()
	select {
	case err := <-disconnected:
		close(release)
		t.Fatalf("disconnect did not wait: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-syncDone; err != nil {
		t.Fatal(err)
	}
	if err := <-disconnected; err != nil {
		t.Fatal(err)
	}
	status, err := b.Status(t.Context(), f.Service, f.admin)
	if err != nil || status.Connected {
		t.Fatalf("disconnect failed: %v", err)
	}
}
