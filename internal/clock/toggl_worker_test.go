package clock

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/hopper"
	"github.com/parallelworks/hopper/hoppertest"
)

func TestTogglWorkerOutlivesDefaultJobTimeout(t *testing.T) {
	f, bridge, fake := togglFixture(t)
	setupToggl(t, f, bridge)
	seedToggl(f, fake)
	if _, err := f.pool.Exec(t.Context(), `UPDATE toggl_workspaces SET next_sync=$1 WHERE workspace_id=$W`, f.clock.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/projects") {
			select {
			case <-time.After(250 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
		fake.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	bridge.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	workers := hopper.NewWorkers()
	bridge.Register(workers)
	client, err := hopper.NewClient(pgdb.HopperDriver(f.raw), &hopper.Config{
		Workers:    workers,
		Queues:     map[string]hopper.QueueConfig{hopper.QueueDefault: {MaxWorkers: 1}},
		JobTimeout: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Only one attempt: a default-timeout cancellation must fail the test,
	// rather than getting hidden by a later retry.
	if _, err := client.Insert(t.Context(), togglJob{}, &hopper.InsertOpts{MaxAttempts: 1}); err != nil {
		t.Fatal(err)
	}
	hoppertest.Start[pgx.Tx](t.Context(), t, client)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, err := bridge.Status(t.Context(), f.Service, f.admin)
		if err != nil {
			t.Fatal(err)
		}
		if status.LastSync != nil {
			if status.Error != "" || len(togglEntries(t, f)) != 1 {
				t.Fatalf("sync did not finish cleanly: %+v", status)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("sync was cancelled by the queue's default timeout before saving progress")
}

func TestTogglWorkerResumesTimedOutHistory(t *testing.T) {
	f, bridge, fake := togglFixture(t)
	setupToggl(t, f, bridge)
	seedToggl(f, fake)
	if _, err := f.pool.Exec(t.Context(), `UPDATE toggl_workspaces SET next_sync=$1 WHERE workspace_id=$W`, f.clock.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	originalClient := bridge.client
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	bridge.client = func(token string) *toggl.Client {
		return &toggl.Client{Token: token, BaseURL: server.URL, HTTP: server.Client()}
	}
	bridge.workspaceTimeout = 50 * time.Millisecond
	if err := bridge.run(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	status, err := bridge.Status(t.Context(), f.Service, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Connected || status.LastSync != nil || status.NextSync == nil || !status.NextSync.Equal(f.clock.Add(time.Minute)) || !strings.Contains(status.Error, "Saved progress will resume") {
		t.Fatalf("timed-out history did not schedule a prompt, honest retry: %+v", status)
	}
	// The same connection must recover without reconnecting or manual retry.
	f.clock = f.clock.Add(2 * time.Minute)
	bridge.client = originalClient
	bridge.workspaceTimeout = 5 * time.Minute
	if err := bridge.run(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	status, err = bridge.Status(t.Context(), f.Service, f.admin)
	if err != nil || status.LastSync == nil || status.Error != "" || len(togglEntries(t, f)) != 1 {
		t.Fatalf("retry did not recover: %+v, %v", status, err)
	}
}
