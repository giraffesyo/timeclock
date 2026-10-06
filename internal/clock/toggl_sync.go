package clock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/foundation/problem"
	"github.com/parallelworks/hopper"
)

type togglJob struct{}

type togglWorker struct {
	hopper.WorkerDefaults[togglJob]
	bridge *Toggl
}

func (w togglWorker) Work(ctx context.Context, job *hopper.Job[togglJob]) error {
	return w.bridge.run(ctx, job)
}

// Each workspace has its own five-minute deadline below. The queue's
// one-minute default would cancel larger imports before saving progress.
func (togglWorker) Timeout(*hopper.Job[togglJob]) time.Duration { return -1 }

// Toggl Reports rejects dates before this day, including time-zone padding.
var togglReportFloor = time.Date(2006, 1, 1, 0, 0, 0, 0, time.UTC)

func (togglJob) Kind() string { return "timeclock.toggl" }
func (t *Toggl) Register(workers *hopper.Workers) hopper.PeriodicJob {
	hopper.AddWorker(workers, togglWorker{bridge: t})
	return hopper.Every(togglPollInterval, togglJob{}, &hopper.PeriodicOpts{RunOnStart: true})
}
func (t *Toggl) run(ctx context.Context, _ *hopper.Job[togglJob]) error {
	if t.box == nil {
		return nil
	}
	workspaces, err := t.svc.Workspaces(ctx)
	if err != nil {
		return err
	}
	for _, w := range workspaces {
		s := t.svc.In(w.ID)
		c, err := t.config(ctx, s)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if c.token == nil || c.next.After(s.now()) {
			continue
		}
		// The advisory lock and persisted next_sync make this safe across replicas.
		err = t.withLock(ctx, s, func() error {
			c, err := t.config(ctx, s)
			if err != nil {
				return err
			}
			if c.token == nil || c.next.After(s.now()) {
				return nil
			}
			jobCtx, cancel := context.WithTimeout(ctx, t.workspaceTimeout)
			defer cancel()
			plain, err := t.box.Open(nil, nil, c.token, []byte(s.ws.String()))
			if err == nil {
				err = t.sync(jobCtx, s, c, t.client(string(plain)))
			}
			delay, message := 10*time.Minute, ""
			var limited *time.Time
			if !c.historyComplete {
				delay = time.Minute
			}
			if err != nil {
				delay = time.Hour
				message = togglMessage(err)
				t.logger.ErrorContext(ctx, "toggl sync failed", "workspace", s.ws, "error", err)
				if e, ok := errors.AsType[*toggl.Error](err); ok {
					if e.RetryAfter > delay {
						delay = e.RetryAfter
					}
					if e.Status == 429 {
						until := s.now().Add(delay)
						limited = &until
					}
				} else if !c.historyComplete && errors.Is(jobCtx.Err(), context.DeadlineExceeded) {
					// A large initial import can span several bounded attempts.
					// Its durable progress must resume without an hourly backoff.
					delay = time.Minute
					message = "History import reached its time limit. Saved progress will resume in a minute."
				}
			}
			// A cancelled job must not erase its durable attempt markers.
			_, saveErr := s.pool.Exec(ctx, `UPDATE toggl_workspaces SET next_sync=$1,last_error=$2,rate_limited_until=$3,
    last_sync=CASE WHEN $2='' THEN now() ELSE last_sync END WHERE workspace_id=$W`, s.now().Add(delay), message, limited)
			return saveErr
		})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// A setup request or another replica can hold this workspace lock. The
		// next tick will pick it up; other companies must still be serviced.
		if err != nil {
			if _, ok := errors.AsType[*problem.Problem](err); !ok {
				return err
			}
		}
	}
	return nil
}

func (t *Toggl) sync(ctx context.Context, s *Service, c togglConfig, client *toggl.Client) error {
	// Keep the saved selection (1970 means all history), but start requests
	// at Toggl's supported boundary. This also repairs existing connections.
	if c.from.Before(togglReportFloor) {
		c.from = togglReportFloor
	}
	projects, err := client.Projects(ctx, c.remote)
	if err != nil {
		return err
	}
	customers, err := client.Customers(ctx, c.remote)
	if err != nil {
		return err
	}
	if err = t.catalog(ctx, s, c.remote, projects, customers); err != nil {
		return err
	}
	// Keep current work moving while the historical sweep advances durably.
	recent := s.now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -31)
	if recent.Before(c.from) {
		recent = c.from
	}
	end := s.now().UTC().Truncate(24*time.Hour).AddDate(0, 0, 1)
	cursor := c.from
	if c.history != nil {
		cursor = *c.history
	}
	if cursor.Before(c.from) {
		cursor = c.from
	}
	// A quota wait can cross midnight, changing the recent window's dates.
	// Finish any staged window that the normal ranges would no longer visit.
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT from_date,to_date FROM toggl_report_pages WHERE workspace_id=$W ORDER BY from_date,to_date`)
	if err != nil {
		return err
	}
	type window struct {
		From time.Time
		To   time.Time
	}
	pending, err := pgx.CollectRows(rows, pgx.RowToStructByPos[window])
	if err != nil {
		return err
	}
	for _, w := range pending {
		next := cursor.AddDate(0, 0, 360)
		if next.After(recent) {
			next = recent
		}
		if w.From.Equal(recent) && w.To.Equal(end) || w.From.Equal(cursor) && w.To.Equal(next) {
			continue
		}
		if err := t.syncWindow(ctx, s, c, client, w.From, w.To); err != nil {
			if ctx.Err() != nil || !toggl.Timeout(err) {
				return err
			}
			// Too slow to finish: drop it, and the sweep asks for less at a time.
			if _, err := s.pool.Exec(ctx, `DELETE FROM toggl_report_pages WHERE workspace_id=$W AND from_date=$1 AND to_date=$2`, w.From, w.To); err != nil {
				return err
			}
			continue
		}
		if w.From.Equal(cursor) {
			cursor = w.To
			if _, err := s.pool.Exec(ctx, `UPDATE toggl_workspaces SET history_cursor=$1 WHERE workspace_id=$W`, cursor); err != nil {
				return err
			}
		}
	}
	if err := t.syncWindow(ctx, s, c, client, recent, end); err != nil {
		return err
	}
	// Four bounded windows per job. A failed window never advances the cursor;
	// completed windows survive rate limits and process restarts. Continue
	// sweeping after the first import to discover edits to historical time.
	// Toggl's reports API can take longer than a request may for a year of a
	// busy company's time: a window that times out is asked for again in
	// halves, down to a week, and the run carries on at the smaller size.
	days := 360
	for i := 0; i < 4 && cursor.Before(recent); {
		to := cursor.AddDate(0, 0, days)
		if to.After(recent) {
			to = recent
		}
		if err := t.syncWindow(ctx, s, c, client, cursor, to); err != nil {
			if ctx.Err() != nil || !toggl.Timeout(err) || days <= 7 {
				return err
			}
			if _, err := s.pool.Exec(ctx, `DELETE FROM toggl_report_pages WHERE workspace_id=$W AND from_date=$1 AND to_date=$2`, cursor, to); err != nil {
				return err
			}
			days /= 2
			continue
		}
		i++
		cursor = to
		if _, err := s.pool.Exec(ctx, `UPDATE toggl_workspaces SET history_cursor=$1 WHERE workspace_id=$W`, cursor); err != nil {
			return err
		}
	}
	if !cursor.Before(recent) {
		_, err = s.pool.Exec(ctx, `UPDATE toggl_workspaces SET history_cursor=$1,history_complete=true WHERE workspace_id=$W`, c.from)
	}
	return err
}

func (t *Toggl) syncWindow(ctx context.Context, s *Service, c togglConfig, client *toggl.Client, from, to time.Time) error {
	// Reports use each entry owner's time zone, so fetch boundary days too.
	// Scope reconciliation to the UTC window; omitted pages never imply deletes.
	entries, err := t.report(ctx, s, client, c.remote, from, to)
	if err != nil {
		return err
	}
	// Once a full window is available, discard its staged snapshot before any
	// writes. A retry after a partial reconciliation must fetch fresh data,
	// otherwise the cache could undo an outbound edit that already succeeded.
	if _, err = s.pool.Exec(ctx, `DELETE FROM toggl_report_pages WHERE workspace_id=$W AND from_date=$1 AND to_date=$2`, from, to); err != nil {
		return err
	}
	people, err := togglPeople(ctx, s.pool)
	if err != nil {
		return err
	}
	projectMap, err := togglProjects(ctx, s.pool)
	if err != nil {
		return err
	}
	links, err := togglLinks(ctx, s.pool)
	if err != nil {
		return err
	}
	byRemote := map[int64]togglLink{}
	pending := map[string]bool{}
	for _, l := range links {
		if l.remoteID != nil {
			byRemote[*l.remoteID] = l
		}
		if l.pending {
			pending[l.person] = true
		}
	}
	away, err := newTogglAway(ctx, t, s, c)
	if err != nil {
		return err
	}
	seen := map[int64]bool{}
	for _, e := range entries {
		// A malformed row can't be matched to anyone. Skipping it never deletes:
		// a linked entry missing from the report is read on its own below.
		if e.ID <= 0 || e.UserID <= 0 || e.Start.IsZero() {
			continue
		}
		if e.Start.Before(from) || !e.Start.Before(to) {
			continue
		}
		if seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		personID, ok := people[e.UserID]
		l, linked := byRemote[e.ID]
		if linked && (!ok || l.person != personID) {
			if err = t.issue(ctx, s, l.id, "ownership_changed"); err != nil {
				return err
			}
			continue
		}
		if !ok {
			continue
		}
		// Entries already synced as work stay work, whatever their project.
		if !linked {
			if claimed, err := away.claim(ctx, e, personID); err != nil || claimed {
				if err != nil {
					return err
				}
				continue
			}
		}
		if !linked && (e.Start.Before(c.from) || pending[personID]) {
			continue
		}
		if e.Duration <= 0 && !linked {
			continue
		} // New imports must be completed.
		state, err := togglRemote(e, projectMap)
		issue := togglIssueFor(err)
		if err != nil && issue == "" {
			return err
		}
		if !linked {
			l = togglLink{id: newID(), person: personID, remoteID: &e.ID, base: togglState{Deleted: true}}
			// A fresh connection can reuse an identical, as-yet-unmapped local
			// entry. Match one to one, preserving multiplicity when duplicates exist.
			var existing uuid.UUID
			err = s.pool.QueryRow(ctx, `SELECT e.id FROM time_entries e WHERE e.workspace_id=$W AND e.person_id=$1
    AND e.project_id IS NOT DISTINCT FROM $2 AND e.started_at=$3 AND e.ended_at=$4 AND e.note=$5
    AND NOT EXISTS(SELECT 1 FROM toggl_entries m WHERE m.workspace_id=$W AND m.entry_id=e.id)
    ORDER BY e.id LIMIT 1`, personID, state.ProjectID, state.Start, state.End, state.Note).Scan(&existing)
			if err == nil {
				l.id = existing
				l.base = state
				if err = audit(ctx, s.pool, Actor{Person: Person{ID: "integration:toggl"}, Admin: true}, "toggl.link", l.person,
					map[string]any{"entryId": l.id, "remoteId": e.ID, "remoteWorkspace": c.remote, "remoteUser": e.UserID, "after": state}); err != nil {
					return err
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		_, err = s.pool.Exec(ctx, `INSERT INTO toggl_entries(workspace_id,entry_id,person_id,remote_id,baseline,remote,issue)
   VALUES($W,$1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,entry_id) DO UPDATE SET remote=EXCLUDED.remote,issue=CASE WHEN EXCLUDED.issue<>'' THEN EXCLUDED.issue WHEN toggl_entries.issue IN ('ownership_changed','missing_remote','project_unavailable') THEN '' ELSE toggl_entries.issue END`, l.id, l.person, l.remoteID, stateJSON(l.base), stateJSON(state), issue)
		if err != nil {
			return err
		}
	}
	// Missing report rows can be moved, running, hidden by permissions, or
	// deleted. Read them individually; a 404 requires an admin decision.
	for _, l := range links {
		if l.remoteID == nil || seen[*l.remoteID] || l.base.Deleted && l.remote.Deleted || l.remote.Start.Before(from) || !l.remote.Start.Before(to) {
			continue
		}
		e, err := client.Entry(ctx, *l.remoteID)
		if apiErr, ok := errors.AsType[*toggl.Error](err); ok && apiErr.Status == 404 {
			issue := l.issue
			if !l.remote.Deleted {
				issue = "missing_remote"
			}
			_, err = s.pool.Exec(ctx, `UPDATE toggl_entries SET remote=$2,issue=$3 WHERE workspace_id=$W AND entry_id=$1`, l.id, stateJSON(togglState{Deleted: true}), issue)
			if err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if e.WorkspaceID != c.remote || people[e.UserID] != l.person {
			if err = t.issue(ctx, s, l.id, "ownership_changed"); err != nil {
				return err
			}
			continue
		}
		state, err := togglRemote(e, projectMap)
		issue := togglIssueFor(err)
		if err != nil && issue == "" {
			return err
		}
		_, err = s.pool.Exec(ctx, `UPDATE toggl_entries SET remote=$2,issue=CASE WHEN $3<>'' THEN $3 WHEN issue IN ('ownership_changed','missing_remote','project_unavailable') THEN '' ELSE issue END WHERE workspace_id=$W AND entry_id=$1`, l.id, stateJSON(state), issue)
		if err != nil {
			return err
		}
	}
	if err = away.missing(ctx, client, seen, people, from, to); err != nil {
		return err
	}
	if err = away.settle(ctx); err != nil {
		return err
	}
	// Discover completed local entries only for explicitly matched people.
	_, err = s.pool.Exec(ctx, `INSERT INTO toggl_entries(workspace_id,entry_id,person_id,baseline,remote)
  SELECT $W,e.id,e.person_id,$2::jsonb,$2::jsonb FROM time_entries e
  JOIN toggl_people p ON p.workspace_id=e.workspace_id AND p.person_id=e.person_id
  JOIN people u ON u.workspace_id=e.workspace_id AND u.id=e.person_id AND u.active
  WHERE e.workspace_id=$W AND e.started_at >= $1 AND e.started_at < $3 AND e.ended_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.workspace_id=$W
    AND a.action IN ('toggl.pull','toggl.push','toggl.link') AND a.detail->>'entryId'=e.id::text
    AND a.detail->>'remoteWorkspace'=$4)
  ON CONFLICT(workspace_id,entry_id) DO NOTHING`, from, stateJSON(togglState{Deleted: true}), to, fmt.Sprint(c.remote))
	if err != nil {
		return err
	}
	links, err = togglLinks(ctx, s.pool)
	if err != nil {
		return err
	}
	links, err = togglUnsettledLinks(ctx, s.pool, links)
	if err != nil {
		return err
	}
	for _, l := range links {
		if err = t.reconcile(ctx, s, c, client, l, people, projectMap); err != nil {
			return err
		}
	}
	return nil
}

// Compare local snapshots in one read rather than rereading and acknowledging
// every settled entry after every report window. Include all dates so edits to
// older local entries still get pushed during the recent-window sync. Changed
// entries are reread and validated by reconcile before any write.
func togglUnsettledLinks(ctx context.Context, q querier, links []togglLink) ([]togglLink, error) {
	rows, err := q.Query(ctx, `SELECT e.id,e.project_id,e.started_at,e.ended_at,e.note FROM time_entries e
  JOIN toggl_entries t ON t.workspace_id=e.workspace_id AND t.entry_id=e.id WHERE e.workspace_id=$W`)
	if err != nil {
		return nil, err
	}
	local := map[uuid.UUID]togglState{}
	var id uuid.UUID
	var state togglState
	_, err = pgx.ForEachRow(rows, []any{&id, &state.ProjectID, &state.Start, &state.End, &state.Note}, func() error {
		local[id] = state
		return nil
	})
	if err != nil {
		return nil, err
	}
	unsettled := make([]togglLink, 0)
	for _, l := range links {
		s, ok := local[l.id]
		if !ok {
			s = togglState{Deleted: true}
		}
		if l.issue == "" && !l.pending && s.equal(l.base) && s.equal(l.remote) {
			continue
		}
		unsettled = append(unsettled, l)
	}
	return unsettled, nil
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

// Stage complete report pages durably. A quota failure on a later page resumes
// from that cursor instead of repeatedly spending the quota on page one. No
// reconciliation occurs until the window has a complete report.
func (t *Toggl) report(ctx context.Context, s *Service, client *toggl.Client, workspace int64, from, to time.Time) ([]toggl.Entry, error) {
	reportFrom := from.AddDate(0, 0, -1)
	if reportFrom.Before(togglReportFloor) {
		reportFrom = togglReportFloor
	}
	rows, err := s.pool.Query(ctx, `SELECT entries,next_cursor FROM toggl_report_pages WHERE workspace_id=$W AND from_date=$1 AND to_date=$2 ORDER BY page`, from, to)
	if err != nil {
		return nil, err
	}
	type page struct {
		Entries []toggl.Entry
		Next    toggl.ReportCursor
	}
	pages, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (page, error) {
		var p page
		err := row.Scan(&p.Entries, &p.Next)
		return p, err
	})
	if err != nil {
		return nil, err
	}
	var entries []toggl.Entry
	var cursor toggl.ReportCursor
	seen := map[string]bool{}
	for _, p := range pages {
		entries = append(entries, p.Entries...)
		cursor = p.Next
		seen[string(mustJSON(cursor))] = true
	}
	if len(pages) > 0 && cursor == nil {
		return entries, nil
	}
	for n := len(pages); n < 1000; n++ {
		batch, next, err := client.ReportPage(ctx, workspace, reportFrom.Format(time.DateOnly), to.Format(time.DateOnly), cursor)
		if err != nil {
			return nil, err
		}
		key := string(mustJSON(next))
		if next != nil && seen[key] {
			return nil, errors.New("toggl repeated a report page")
		}
		if _, err = s.pool.Exec(ctx, `INSERT INTO toggl_report_pages(workspace_id,from_date,to_date,page,entries,next_cursor) VALUES($W,$1,$2,$3,$4,$5)`, from, to, n, mustJSON(batch), mustJSON(next)); err != nil {
			return nil, err
		}
		entries = append(entries, batch...)
		if next == nil {
			return entries, nil
		}
		seen[key] = true
		cursor = next
	}
	return nil, errors.New("toggl report is too large")
}
func togglPeople(ctx context.Context, q querier) (map[int64]string, error) {
	rows, err := q.Query(ctx, `SELECT p.remote_user,p.person_id FROM toggl_people p JOIN people u ON u.workspace_id=p.workspace_id AND u.id=p.person_id WHERE p.workspace_id=$W AND u.active`)
	if err != nil {
		return nil, err
	}
	out := map[int64]string{}
	var id int64
	var person string
	_, err = pgx.ForEachRow(rows, []any{&id, &person}, func() error { out[id] = person; return nil })
	return out, err
}
func togglProjects(ctx context.Context, q querier) (map[int64]uuid.UUID, error) {
	rows, err := q.Query(ctx, `SELECT remote_id,project_id FROM toggl_projects WHERE workspace_id=$W`)
	if err != nil {
		return nil, err
	}
	out := map[int64]uuid.UUID{}
	var id int64
	var local uuid.UUID
	_, err = pgx.ForEachRow(rows, []any{&id, &local}, func() error { out[id] = local; return nil })
	return out, err
}
func togglRemote(e toggl.Entry, projects map[int64]uuid.UUID) (togglState, error) {
	if e.DeletedAt != nil {
		return togglState{Deleted: true}, nil
	}
	state := togglState{Start: e.Start.UTC(), Note: e.Description}
	if e.Duration > 0 {
		end := e.Start.Add(time.Duration(e.Duration) * time.Second).UTC()
		if e.Stop != nil {
			end = e.Stop.UTC()
		}
		state.End = &end
	}
	if e.Start.IsZero() {
		return state, errors.New("Toggl entry has no start")
	}
	if e.ProjectID != nil {
		id, ok := projects[*e.ProjectID]
		if !ok {
			// Deleted projects, and ones the connecting admin cannot see, are
			// not in the catalog. The entry waits for an admin; the sync goes on.
			return state, errTogglProjectUnavailable
		}
		state.ProjectID = &id
	}
	return state, nil
}

// errTogglProjectUnavailable marks one entry, never the whole sync: the state
// beside it is complete except for the project.
var errTogglProjectUnavailable = errors.New("Toggl entry references an unavailable project")

// togglIssueFor is the issue an entry's remote state carries on its own.
func togglIssueFor(err error) string {
	if errors.Is(err, errTogglProjectUnavailable) {
		return "project_unavailable"
	}
	return ""
}
func (t *Toggl) issue(ctx context.Context, s *Service, id uuid.UUID, issue string) error {
	_, err := s.pool.Exec(ctx, `UPDATE toggl_entries SET issue=$2 WHERE workspace_id=$W AND entry_id=$1`, id, issue)
	return err
}

func (t *Toggl) reconcile(ctx context.Context, s *Service, c togglConfig, client *toggl.Client, l togglLink, people map[int64]string, projects map[int64]uuid.UUID) error {
	var user int64
	for id, p := range people {
		if p == l.person {
			user = id
			break
		}
	}
	if user == 0 {
		return nil
	}
	if l.pending || l.issue == "missing_remote" || l.issue == "ownership_changed" || l.issue == "project_unavailable" {
		return nil
	}
	local, _, err := togglLocal(ctx, s.pool, l.id)
	if err != nil {
		return err
	}
	if !local.Deleted && local.End == nil || !l.remote.Deleted && l.remote.End == nil {
		return nil
	}
	if local.equal(l.remote) {
		return t.ack(ctx, s.pool, l, local)
	}
	localChanged, remoteChanged := !local.equal(l.base), !l.remote.equal(l.base)
	if localChanged && remoteChanged {
		return t.issue(ctx, s, l.id, "conflict")
	}
	if !localChanged && !remoteChanged {
		return nil
	}
	// Persist intent before an external CREATE. If the process dies after
	// Toggl commits, the next run asks for recovery instead of posting twice.
	if localChanged && !local.Deleted && local.End.Sub(local.Start) < time.Second {
		return t.issue(ctx, s, l.id, "invalid_entry")
	}
	creating := localChanged && !local.Deleted && l.remoteID == nil
	if creating {
		if _, err = s.pool.Exec(ctx, `UPDATE toggl_entries SET pending_create=true,issue='creation_uncertain' WHERE workspace_id=$W AND entry_id=$1`, l.id); err != nil {
			return err
		}
	}
	var validation error
	err = s.tx(ctx, l.person, func(q querier) error {
		current, owner, err := togglLocal(ctx, q, l.id)
		if err != nil {
			return err
		}
		if !current.equal(local) {
			return errors.New("local entry changed during sync")
		}
		if !current.Deleted && owner != l.person {
			return errors.New("local ownership changed")
		}
		cfg, err := settings(ctx, q)
		if err != nil {
			return err
		}
		if current.Deleted && !l.base.Deleted {
			if err = s.checkSpan(ctx, q, cfg, l.person, l.base.Start, l.base.End); err != nil {
				validation = err
				return nil
			}
		}
		if !current.Deleted {
			if err = s.checkSpan(ctx, q, cfg, l.person, current.Start, current.End); err != nil {
				validation = err
				return nil
			}
		}
		actor := Actor{Person: Person{ID: "integration:toggl"}, Admin: true}
		if remoteChanged {
			if !l.remote.Deleted {
				if err = s.checkSpan(ctx, q, cfg, l.person, l.remote.Start, l.remote.End); err != nil {
					validation = err
					return nil
				}
				if err = checkDescription(cfg, l.remote.Note); err != nil {
					validation = err
					return nil
				}
				if len([]rune(l.remote.Note)) > 2000 {
					validation = invalidField("note", "description is too long")
					return nil
				}
				if cfg.RequireProject && l.remote.ProjectID == nil {
					validation = ErrProjectRequired.New("")
					return nil
				}
				_, err = q.Exec(ctx, `INSERT INTO time_entries(id,workspace_id,person_id,project_id,started_at,ended_at,note,source,created_by)
     VALUES($1,$W,$2,$3,$4,$5,$6,'toggl',$7) ON CONFLICT(id) DO UPDATE SET project_id=EXCLUDED.project_id,
     started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at,note=EXCLUDED.note,updated_at=now() WHERE time_entries.workspace_id=$W`, l.id, l.person, l.remote.ProjectID, l.remote.Start, l.remote.End, l.remote.Note, actor.ID)
			} else {
				_, err = q.Exec(ctx, `DELETE FROM time_entries WHERE workspace_id=$W AND id=$1`, l.id)
			}
			if err != nil {
				return err
			}
			if err = audit(ctx, q, actor, "toggl.pull", l.person, map[string]any{"entryId": l.id, "remoteId": l.remoteID, "remoteWorkspace": c.remote, "remoteUser": user, "before": local, "after": l.remote}); err != nil {
				return err
			}
			return t.ack(ctx, q, l, l.remote)
		}
		var project *int64
		if local.ProjectID != nil {
			for id, p := range projects {
				if p == *local.ProjectID {
					v := id
					project = &v
					break
				}
			}
			if project == nil {
				validation = invalidField("projectId", "choose a project imported from Toggl")
				return nil
			}
		}
		// Re-read before writing: the report might predate a concurrent edit.
		if l.remoteID != nil {
			fresh, err := client.Entry(ctx, *l.remoteID)
			if apiErr, ok := errors.AsType[*toggl.Error](err); ok && apiErr.Status == 404 {
				_, err = q.Exec(ctx, `UPDATE toggl_entries SET remote=$2,issue='missing_remote' WHERE workspace_id=$W AND entry_id=$1`, l.id, stateJSON(togglState{Deleted: true}))
				return err
			}
			if err != nil {
				return err
			}
			if fresh.WorkspaceID != c.remote || fresh.UserID != user {
				return errors.New("Toggl ownership changed")
			}
			state, err := togglRemote(fresh, projects)
			if issue := togglIssueFor(err); issue != "" {
				_, err = q.Exec(ctx, `UPDATE toggl_entries SET remote=$2,issue=$3 WHERE workspace_id=$W AND entry_id=$1`, l.id, stateJSON(state), issue)
				return err
			}
			if err != nil {
				return err
			}
			if !state.equal(l.remote) {
				_, err = q.Exec(ctx, `UPDATE toggl_entries SET remote=$2,issue='conflict' WHERE workspace_id=$W AND entry_id=$1`, l.id, stateJSON(state))
				return err
			}
		}
		if local.Deleted {
			if l.remoteID != nil {
				if err = client.Delete(ctx, c.remote, *l.remoteID); err != nil {
					return err
				}
			}
		} else {
			id := int64(0)
			if l.remoteID != nil {
				id = *l.remoteID
			}
			remote, err := client.Save(ctx, toggl.Write{WorkspaceID: c.remote, UserID: user, ProjectID: project, Description: local.Note, Start: local.Start, Stop: local.End, Duration: int64(local.End.Sub(local.Start) / time.Second)}, id)
			if err != nil {
				return err
			}
			if remote.ID <= 0 || remote.WorkspaceID != c.remote || remote.UserID != user {
				return errors.New("Toggl returned unexpected ownership")
			}
			state, err := togglRemote(remote, projects)
			if err != nil {
				return err
			}
			if !state.equal(local) {
				return errors.New("Toggl did not preserve the entry")
			}
			l.remoteID = &remote.ID
		}
		if err = audit(ctx, q, actor, "toggl.push", l.person, map[string]any{"entryId": l.id, "remoteId": l.remoteID, "remoteWorkspace": c.remote, "remoteUser": user, "after": local}); err != nil {
			return err
		}
		return t.ack(ctx, q, l, local)
	})
	if validation != nil {
		kind := "invalid_entry"
		if p, ok := errors.AsType[*problem.Problem](validation); ok {
			switch p.Key() {
			case "period_locked":
				kind = "locked"
			case "project_required":
				kind = "project_required"
			case "description_required":
				kind = "description_required"
			default:
				kind = "invalid_entry"
			}
		}
		if creating {
			if _, e := s.pool.Exec(ctx, `UPDATE toggl_entries SET pending_create=false WHERE workspace_id=$W AND entry_id=$1`, l.id); e != nil {
				return e
			}
		}
		return t.issue(ctx, s, l.id, kind)
	}
	if creating && err != nil {
		if e, ok := errors.AsType[*toggl.Error](err); ok && e.Status >= 400 && e.Status < 500 && e.Status != 408 {
			_, saveErr := s.pool.Exec(ctx, `UPDATE toggl_entries SET pending_create=false,issue='' WHERE workspace_id=$W AND entry_id=$1`, l.id)
			if saveErr != nil {
				return saveErr
			}
		}
	}
	return err
}
func (t *Toggl) ack(ctx context.Context, q querier, l togglLink, state togglState) error {
	_, err := q.Exec(ctx, `UPDATE toggl_entries SET remote_id=$2,baseline=$3,remote=$3,pending_create=false,issue='' WHERE workspace_id=$W AND entry_id=$1`, l.id, l.remoteID, stateJSON(state))
	return err
}

// catalog imports project identity once. Existing local names are reused only
// within the same customer; a second remote project cannot steal a mapping.
func (t *Toggl) catalog(ctx context.Context, s *Service, workspace int64, projects []toggl.Project, customers []toggl.Customer) error {
	return s.tx(ctx, "", func(q querier) error {
		actor := Actor{Person: Person{ID: "integration:toggl"}, Admin: true}
		names := map[int64]string{}
		for _, c := range customers {
			names[c.ID] = c.Name
		}
		for _, p := range projects {
			var id uuid.UUID
			err := q.QueryRow(ctx, `SELECT project_id FROM toggl_projects WHERE workspace_id=$W AND remote_id=$1`, p.ID).Scan(&id)
			if err == nil {
				continue
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if p.Name == "" {
				return errors.New("Toggl project has no name")
			}
			var customer *uuid.UUID
			if p.ClientID != nil {
				name, ok := names[*p.ClientID]
				if !ok {
					return errors.New("Toggl project references an unavailable customer")
				}
				var cid uuid.UUID
				err = q.QueryRow(ctx, `INSERT INTO customers(id,workspace_id,name) VALUES($1,$W,$2) ON CONFLICT(workspace_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, newID(), name).Scan(&cid)
				if err != nil {
					return err
				}
				customer = &cid
			}
			name := p.Name
			for suffix := 0; ; suffix++ {
				err = q.QueryRow(ctx, `SELECT id FROM projects WHERE workspace_id=$W AND customer_id IS NOT DISTINCT FROM $1 AND name=$2`, customer, name).Scan(&id)
				if err != nil {
					break
				}
				var taken bool
				if err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM toggl_projects WHERE workspace_id=$W AND project_id=$1)`, id).Scan(&taken); err != nil {
					return err
				}
				if !taken {
					break
				}
				name = fmt.Sprintf("%s (Toggl %d)", p.Name, p.ID)
				if suffix > 0 {
					name = fmt.Sprintf("%s (Toggl %d, %d)", p.Name, p.ID, suffix)
				}
				if suffix > 100 {
					return errors.New("too many matching Toggl project names")
				}
			}
			if errors.Is(err, pgx.ErrNoRows) {
				id = newID()
				_, err = q.Exec(ctx, `INSERT INTO projects(id,workspace_id,customer_id,name,billable,archived_at) VALUES($1,$W,$2,$3,$4,CASE WHEN $5 THEN NULL ELSE now() END)`, id, customer, name, p.Billable, p.Active)
			}
			if err != nil {
				return err
			}
			_, err = q.Exec(ctx, `INSERT INTO toggl_projects(workspace_id,remote_id,project_id) VALUES($W,$1,$2)`, p.ID, id)
			if err != nil {
				return err
			}
			if err = audit(ctx, q, actor, "toggl.project", "", map[string]any{"projectId": id, "remoteId": p.ID, "remoteWorkspace": workspace}); err != nil {
				return err
			}
		}
		return nil
	})
}

// Resolve records an explicit choice against the exact versions the admin saw.
// The worker still validates payroll locks and rechecks Toggl before pushing.
type TogglResolution struct {
	Choice   string `json:"choice" enum:"local,remote,retry,link"`
	Version  string `json:"version"`
	RemoteID int64  `json:"remoteId,omitempty"`
}

func (t *Toggl) Resolve(ctx context.Context, s *Service, actor Actor, id uuid.UUID, in TogglResolution) error {
	if !actor.Admin {
		return forbidden("only an admin resolves sync conflicts")
	}
	return t.withLock(ctx, s, func() error {
		links, err := togglLinks(ctx, s.pool)
		if err != nil {
			return err
		}
		var l togglLink
		found := false
		for _, v := range links {
			if v.id == id {
				l = v
				found = true
				break
			}
		}
		if !found {
			return notFound("sync entry")
		}
		return s.tx(ctx, l.person, func(q querier) error {
			local, _, err := togglLocal(ctx, q, l.id)
			if err != nil {
				return err
			}
			if in.Version != togglVersion(l, local) {
				return invalidField("version", "the entry changed; refresh before deciding")
			}
			switch in.Choice {
			case "retry":
				if !l.pending {
					return invalidField("choice", "this entry is not awaiting creation recovery")
				}
				l.pending = false
				l.base = togglState{Deleted: true}
			case "link":
				if !l.pending || in.RemoteID <= 0 {
					return invalidField("remoteId", "enter the ID of the Toggl entry created by the previous attempt")
				}
				token, err := t.token(ctx, s, "")
				if err != nil {
					return err
				}
				c, err := t.config(ctx, s)
				if err != nil {
					return err
				}
				e, err := t.client(token).Entry(ctx, in.RemoteID)
				if err != nil {
					return invalidField("remoteId", togglMessage(err))
				}
				people, err := togglPeople(ctx, q)
				if err != nil {
					return err
				}
				if e.WorkspaceID != c.remote || people[e.UserID] != l.person {
					return invalidField("remoteId", "the Toggl entry belongs to a different workspace or person")
				}
				projects, err := togglProjects(ctx, q)
				if err != nil {
					return err
				}
				state, err := togglRemote(e, projects)
				if err != nil {
					return err
				}
				l.remoteID = &in.RemoteID
				l.remote = state
				l.base = local
				l.pending = false
			case "local", "remote":
				if l.pending || l.issue == "ownership_changed" {
					return invalidField("choice", "resolve entry ownership or creation first")
				}
				if in.Choice == "remote" {
					l.base = local
				} else {
					l.base = l.remote
					if l.remote.Deleted {
						l.remoteID = nil
					}
				}
			default:
				return invalidField("choice", "choose a version to keep")
			}
			_, err = q.Exec(ctx, `UPDATE toggl_entries SET baseline=$2,remote=$3,remote_id=$4,pending_create=$5,issue='' WHERE workspace_id=$W AND entry_id=$1`, l.id, stateJSON(l.base), stateJSON(l.remote), l.remoteID, l.pending)
			if isUniqueViolation(err) {
				return invalidField("remoteId", "that Toggl entry is already linked")
			}
			if err != nil {
				return err
			}
			if _, err = q.Exec(ctx, `UPDATE toggl_workspaces SET next_sync=now() WHERE workspace_id=$W
    AND (rate_limited_until IS NULL OR rate_limited_until <= $1)`, s.now()); err != nil {
				return err
			}
			return audit(ctx, q, actor, "toggl.resolve", l.person, map[string]any{"entryId": id, "choice": in.Choice})
		})
	})
}
