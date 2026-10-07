package clock

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type togglReadCounter struct {
	querier
	entryReads int
}

func (q *togglReadCounter) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.HasPrefix(sql, "SELECT person_id,project_id,started_at,ended_at,note FROM time_entries") {
		q.entryReads++
	}
	return q.querier.QueryRow(ctx, sql, args...)
}

func TestTogglSettledEntriesNeedNoIndividualReads(t *testing.T) {
	f, bridge, fake := togglFixture(t)
	setupToggl(t, f, bridge)
	seedToggl(f, fake)
	requireSync(t, f, bridge)
	q := &togglReadCounter{querier: f.pool.q}
	f.pool.q = q
	requireSync(t, f, bridge)
	if q.entryReads != 0 {
		t.Fatalf("settled entries were reread individually %d times", q.entryReads)
	}
	// A historical edit must still be discovered when only the recent window
	// is being synced. Skipping all links outside that window loses this edit.
	entry := togglEntries(t, f)[0]
	if _, err := f.UpdateEntry(t.Context(), f.ada, entry.ID, EntryInput{
		StartedAt: entry.StartedAt, EndedAt: entry.EndedAt,
		ProjectID: entry.ProjectID, Note: "Older local edit",
	}); err != nil {
		t.Fatal(err)
	}
	c, err := bridge.config(t.Context(), f.Service)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bridge.syncWindow(t.Context(), f.Service, c, bridge.client("token"), f.time("2026-11-01 00:00"), f.time("2026-11-02 00:00")); err != nil {
		t.Fatal(err)
	}
	if fake.entries[101].Description != "Older local edit" || fake.puts != 1 {
		t.Fatal("historical local edit was not pushed")
	}
}

func TestTogglUnsettledLinksKeepIssuesAndDeletions(t *testing.T) {
	f, bridge, fake := togglFixture(t)
	setupToggl(t, f, bridge)
	seedToggl(f, fake)
	requireSync(t, f, bridge)
	links, err := togglLinks(t.Context(), f.pool)
	if err != nil || len(links) != 1 {
		t.Fatalf("links = %v, err = %v", links, err)
	}
	for _, variant := range []string{"issue", "pending", "baseline", "remote", "deleted"} {
		t.Run(variant, func(t *testing.T) {
			l := links[0]
			switch variant {
			case "issue":
				l.issue = "conflict"
			case "pending":
				l.pending = true
			case "baseline":
				l.base.Note = "old baseline"
			case "remote":
				l.remote.Note = "remote edit"
			case "deleted":
				if err := f.DeleteEntry(t.Context(), f.ada, l.id); err != nil {
					t.Fatal(err)
				}
			}
			unsettled, err := togglUnsettledLinks(t.Context(), f.pool, []togglLink{l})
			if err != nil || len(unsettled) != 1 {
				t.Fatalf("unsettled = %v, err = %v", unsettled, err)
			}
		})
	}
}
