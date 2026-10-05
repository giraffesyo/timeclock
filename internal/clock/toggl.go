package clock

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Toggl is the company migration bridge. Credentials are encrypted with a key
// kept outside the database; associated data binds ciphertext to its workspace.
type Toggl struct {
	svc    *Service
	box    cipher.AEAD
	client func(string) *toggl.Client
}

func NewToggl(s *Service, key string) (*Toggl, error) {
	t := &Toggl{svc: s, client: func(token string) *toggl.Client { return &toggl.Client{Token: token} }}
	if key == "" {
		return t, nil
	}
	if len(key) < 32 {
		return nil, errors.New("timeclock: integration secret key must contain at least 32 characters")
	}
	sum := sha256.Sum256([]byte("timeclock/integrations/" + key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	t.box, err = cipher.NewGCMWithRandomNonce(block)
	return t, err
}

type TogglMapping struct {
	PersonID string `json:"personId"`
	UserID   int64  `json:"userId" minimum:"1"`
}
type TogglSetup struct {
	Token       string         `json:"token" maxLength:"256"`
	WorkspaceID int64          `json:"workspaceId" minimum:"1"`
	From        string         `json:"from" doc:"Optional start date (YYYY-MM-DD). Empty imports all history."`
	People      []TogglMapping `json:"people" minItems:"1" maxItems:"1000"`
}
type TogglPreview struct {
	Workspaces []toggl.Workspace `json:"workspaces"`
	Users      []toggl.User      `json:"users"`
	Suggested  []TogglMapping    `json:"suggested"`
}
type TogglStatus struct {
	HistoryComplete bool           `json:"historyComplete"`
	HistoryThrough  string         `json:"historyThrough"`
	Available       bool           `json:"available"`
	Connected       bool           `json:"connected"`
	WorkspaceID     int64          `json:"workspaceId"`
	From            string         `json:"from"`
	LastSync        *time.Time     `json:"lastSync,omitempty"`
	NextSync        *time.Time     `json:"nextSync,omitempty"`
	Error           string         `json:"error"`
	People          []TogglMapping `json:"people"`
	Issues          []TogglIssue   `json:"issues"`
}
type TogglIssue struct {
	EntryID  uuid.UUID  `json:"entryId"`
	PersonID string     `json:"personId"`
	RemoteID *int64     `json:"remoteId,omitempty"`
	Kind     string     `json:"kind"`
	Version  string     `json:"version"`
	Local    togglState `json:"local"`
	Remote   togglState `json:"remote"`
}
type togglConfig struct {
	history         *time.Time
	historyComplete bool
	remote          int64
	token           []byte
	from            time.Time
	next            time.Time
}

func (t *Toggl) config(ctx context.Context, s *Service) (togglConfig, error) {
	var c togglConfig
	err := s.pool.QueryRow(ctx, `SELECT remote_id, token, sync_from, next_sync, history_cursor, history_complete FROM toggl_workspaces WHERE workspace_id=$W`).Scan(&c.remote, &c.token, &c.from, &c.next, &c.history, &c.historyComplete)
	return c, err
}
func (t *Toggl) token(ctx context.Context, s *Service, input string) (string, error) {
	if t.box == nil {
		return "", invalidField("token", "the server needs an integration secret key")
	}
	if input != "" {
		return strings.TrimSpace(input), nil
	}
	c, err := t.config(ctx, s)
	if err != nil {
		return "", requiredField("token")
	}
	plain, err := t.box.Open(nil, nil, c.token, []byte(s.ws.String()))
	if err != nil {
		return "", invalidField("token", "enter the Toggl API token again")
	}
	return string(plain), nil
}
func (t *Toggl) Preview(ctx context.Context, s *Service, actor Actor, token string, workspace int64) (TogglPreview, error) {
	out := TogglPreview{Workspaces: []toggl.Workspace{}, Users: []toggl.User{}, Suggested: []TogglMapping{}}
	if !actor.Admin {
		return out, forbidden("only an admin manages integrations")
	}
	token, err := t.token(ctx, s, token)
	if err != nil {
		return out, err
	}
	client := t.client(token)
	workspaces, err := client.Workspaces(ctx)
	if err != nil {
		return out, invalidField("token", togglMessage(err))
	}
	for _, w := range workspaces {
		if !w.Admin && w.Role != "admin" {
			continue
		}
		out.Workspaces = append(out.Workspaces, w)
		if w.ID == workspace {
			out.Users, err = client.Users(ctx, w)
			if err != nil {
				return out, invalidField("workspaceId", togglMessage(err))
			}
		}
	}
	if workspace != 0 {
		found := false
		for _, w := range out.Workspaces {
			found = found || w.ID == workspace
		}
		if !found {
			return out, invalidField("workspaceId", "choose a workspace where the Toggl account is an admin")
		}
	}
	people, err := s.People(ctx, actor)
	if err != nil {
		return out, err
	}
	// Only unambiguous email matches are suggestions; the admin confirms them.
	for _, u := range out.Users {
		if u.Inactive || u.Email == "" {
			continue
		}
		var match string
		count := 0
		for _, p := range people {
			if p.Active && strings.EqualFold(strings.TrimSpace(p.Email), strings.TrimSpace(u.Email)) {
				match = p.ID
				count++
			}
		}
		remoteCount := 0
		for _, v := range out.Users {
			if !v.Inactive && strings.EqualFold(u.Email, v.Email) {
				remoteCount++
			}
		}
		if count == 1 && remoteCount == 1 {
			out.Suggested = append(out.Suggested, TogglMapping{PersonID: match, UserID: u.ID})
		}
	}
	return out, nil
}

// withLock serializes jobs, setup, disconnect and conflict decisions across all
// replicas. A failed unlock discards the physical connection, never its lock.
func (t *Toggl) withLock(ctx context.Context, s *Service, fn func() error) error {
	return t.lock(ctx, s, false, fn)
}
func (t *Toggl) lock(ctx context.Context, s *Service, wait bool, fn func() error) error {
	conn, err := s.raw.Acquire(ctx)
	if err != nil {
		return err
	}
	key := "timeclock/toggl/" + s.ws.String()
	var locked bool
	if wait {
		_, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, key)
		locked = err == nil
	} else {
		err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, key).Scan(&locked)
	}
	if err != nil {
		// An interrupted lock query can have succeeded at the server. Close
		// this physical session rather than returning an uncertain lock to the pool.
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		raw := conn.Hijack()
		_ = raw.Close(cleanup)
		return err
	}
	if !locked {
		conn.Release()
		return invalidField("integration", "sync is in progress; try again shortly")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(cleanup, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, key).Scan(&unlocked); err != nil || !unlocked {
			raw := conn.Hijack()
			_ = raw.Close(cleanup)
		} else {
			conn.Release()
		}
	}()
	return fn()
}
func (t *Toggl) Configure(ctx context.Context, s *Service, actor Actor, in TogglSetup) error {
	if !actor.Admin {
		return forbidden("only an admin manages integrations")
	}
	if in.From == "" {
		in.From = "1970-01-01"
	}
	from, err := time.Parse(time.DateOnly, in.From)
	if err != nil {
		return invalidField("from", "use YYYY-MM-DD")
	}
	if from.After(s.now()) || from.Before(time.Unix(0, 0)) {
		return invalidField("from", "choose a date between 1970-01-01 and today")
	}
	if len(in.People) == 0 {
		return requiredField("people")
	}
	return t.withLock(ctx, s, func() error {
		token, err := t.token(ctx, s, in.Token)
		if err != nil {
			return err
		}
		preview, err := t.Preview(ctx, s, actor, token, in.WorkspaceID)
		if err != nil {
			return err
		}
		users := map[int64]bool{}
		for _, u := range preview.Users {
			if !u.Inactive {
				users[u.ID] = true
			}
		}
		ids := map[string]bool{}
		remote := map[int64]bool{}
		for _, m := range in.People {
			if ids[m.PersonID] || remote[m.UserID] || !users[m.UserID] {
				return invalidField("people", "each person must match one active Toggl user")
			}
			ids[m.PersonID] = true
			remote[m.UserID] = true
			p, err := person(ctx, s.pool, m.PersonID)
			if err != nil {
				return err
			}
			if !p.Active {
				return invalidField("people", "choose active Timeclock people")
			}
		}
		sealed := t.box.Seal(nil, nil, []byte(token), []byte(s.ws.String()))
		return s.tx(ctx, "", func(q querier) error {
			var oldID int64
			var oldFrom time.Time
			err := q.QueryRow(ctx, `SELECT remote_id,sync_from FROM toggl_workspaces WHERE workspace_id=$W`).Scan(&oldID, &oldFrom)
			if err == nil && (oldID != in.WorkspaceID || !oldFrom.Equal(from)) {
				return invalidField("workspaceId", "disconnect before choosing a different workspace or start date")
			}
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			_, err = q.Exec(ctx, `INSERT INTO toggl_workspaces(workspace_id,remote_id,token,sync_from) VALUES($W,$1,$2,$3)
    ON CONFLICT(workspace_id) DO UPDATE SET token=EXCLUDED.token,next_sync=now(),last_error='',history_cursor=NULL,history_complete=false`, in.WorkspaceID, sealed, from)
			if isUniqueViolation(err) {
				return invalidField("workspaceId", "this Toggl workspace is already linked to another company")
			}
			if err != nil {
				return err
			}
			if _, err = q.Exec(ctx, `DELETE FROM toggl_report_pages WHERE workspace_id=$W`); err != nil {
				return err
			}
			// Existing ownership is immutable while connected. Adding new people
			// is allowed; disconnect clears the matches for a fresh setup.
			for _, m := range in.People {
				var old int64
				err = q.QueryRow(ctx, `SELECT remote_user FROM toggl_people WHERE workspace_id=$W AND person_id=$1`, m.PersonID).Scan(&old)
				if err == nil && old != m.UserID {
					return invalidField("people", "existing person matches cannot be reassigned")
				}
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				_, err = q.Exec(ctx, `INSERT INTO toggl_people(workspace_id,person_id,remote_user) VALUES($W,$1,$2) ON CONFLICT(workspace_id,person_id) DO NOTHING`, m.PersonID, m.UserID)
				if isUniqueViolation(err) {
					return invalidField("people", "that Toggl user is already matched")
				}
				if err != nil {
					return err
				}
			}
			var total int
			if err = q.QueryRow(ctx, `SELECT count(*) FROM toggl_people WHERE workspace_id=$W`).Scan(&total); err != nil {
				return err
			}
			if total != len(in.People) {
				return invalidField("people", "keep all existing person matches when updating the connection")
			}
			if err = restoreTogglLinks(ctx, q, in.WorkspaceID); err != nil {
				return err
			}
			return audit(ctx, q, actor, "toggl.configure", "", map[string]any{"workspaceId": in.WorkspaceID, "from": in.From, "people": in.People})
		})
	})
}
func (t *Toggl) Disconnect(ctx context.Context, s *Service, actor Actor) error {
	if !actor.Admin {
		return forbidden("only an admin manages integrations")
	}
	return t.lock(ctx, s, true, func() error {
		return s.tx(ctx, "", func(q querier) error {
			for _, query := range []string{
				`DELETE FROM toggl_entries WHERE workspace_id=$W`,
				`DELETE FROM toggl_people WHERE workspace_id=$W`,
				`DELETE FROM toggl_projects WHERE workspace_id=$W`,
				`DELETE FROM toggl_workspaces WHERE workspace_id=$W`,
			} {
				if _, err := q.Exec(ctx, query); err != nil {
					return err
				}
			}
			return audit(ctx, q, actor, "toggl.disconnect", "", nil)
		})
	})
}
func (t *Toggl) RequestSync(ctx context.Context, s *Service, actor Actor) error {
	if !actor.Admin {
		return forbidden("only an admin manages integrations")
	}
	// Do not let a button bypass persisted rate-limit backoff.
	_, err := s.pool.Exec(ctx, `UPDATE toggl_workspaces SET next_sync=now() WHERE workspace_id=$W AND token IS NOT NULL AND last_error=''`)
	return err
}
func (t *Toggl) Status(ctx context.Context, s *Service, actor Actor) (TogglStatus, error) {
	out := TogglStatus{Available: t.box != nil, People: []TogglMapping{}, Issues: []TogglIssue{}}
	if !actor.Admin {
		return out, forbidden("only an admin manages integrations")
	}
	var from time.Time
	var history *time.Time
	err := s.pool.QueryRow(ctx, `SELECT remote_id,token IS NOT NULL,sync_from,last_sync,next_sync,last_error,history_cursor,history_complete FROM toggl_workspaces WHERE workspace_id=$W`).Scan(&out.WorkspaceID, &out.Connected, &from, &out.LastSync, &out.NextSync, &out.Error, &history, &out.HistoryComplete)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.From = from.Format(time.DateOnly)
	if history != nil {
		out.HistoryThrough = history.AddDate(0, 0, -1).Format(time.DateOnly)
	}
	rows, err := s.pool.Query(ctx, `SELECT person_id,remote_user FROM toggl_people WHERE workspace_id=$W ORDER BY person_id`)
	if err != nil {
		return out, err
	}
	out.People, err = pgx.CollectRows(rows, pgx.RowToStructByPos[TogglMapping])
	if err != nil {
		return out, err
	}
	links, err := togglLinks(ctx, s.pool)
	if err != nil {
		return out, err
	}
	for _, l := range links {
		if l.issue == "" {
			continue
		}
		local, _, err := togglLocal(ctx, s.pool, l.id)
		if err != nil {
			return out, err
		}
		out.Issues = append(out.Issues, TogglIssue{EntryID: l.id, PersonID: l.person, RemoteID: l.remoteID, Kind: l.issue, Local: local, Remote: l.remote, Version: togglVersion(l, local)})
	}
	return out, nil
}
func togglMessage(err error) string {
	if e, ok := errors.AsType[*toggl.Error](err); ok {
		return e.Error()
	}
	return "Sync could not finish. Check the connection and try again."
}

type togglState struct {
	ProjectID *uuid.UUID `json:"projectId,omitempty"`
	Start     time.Time  `json:"start"`
	End       *time.Time `json:"end,omitempty"`
	Note      string     `json:"note"`
	Deleted   bool       `json:"deleted"`
}

func (a togglState) equal(b togglState) bool {
	if a.Deleted || b.Deleted {
		return a.Deleted == b.Deleted
	}
	return a.Start.Equal(b.Start) && sameTime(a.End, b.End) && sameProject(a.ProjectID, b.ProjectID) && a.Note == b.Note
}
func sameTime(a, b *time.Time) bool {
	return a == nil && b == nil || a != nil && b != nil && a.Equal(*b)
}
func sameProject(a, b *uuid.UUID) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func stateJSON(s togglState) []byte { b, _ := json.Marshal(s); return b }

type togglLink struct {
	id           uuid.UUID
	person       string
	remoteID     *int64
	base, remote togglState
	pending      bool
	issue        string
}

func togglLinks(ctx context.Context, q querier) ([]togglLink, error) {
	rows, err := q.Query(ctx, `SELECT entry_id,person_id,remote_id,baseline,remote,pending_create,issue FROM toggl_entries WHERE workspace_id=$W ORDER BY entry_id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (togglLink, error) {
		var l togglLink
		var base, remote []byte
		err := r.Scan(&l.id, &l.person, &l.remoteID, &base, &remote, &l.pending, &l.issue)
		if err != nil {
			return l, err
		}
		if err = json.Unmarshal(base, &l.base); err != nil {
			return l, err
		}
		err = json.Unmarshal(remote, &l.remote)
		return l, err
	})
}
func togglLocal(ctx context.Context, q querier, id uuid.UUID) (togglState, string, error) {
	var s togglState
	var person string
	err := q.QueryRow(ctx, `SELECT person_id,project_id,started_at,ended_at,note FROM time_entries WHERE workspace_id=$W AND id=$1`, id).Scan(&person, &s.ProjectID, &s.Start, &s.End, &s.Note)
	if errors.Is(err, pgx.ErrNoRows) {
		return togglState{Deleted: true}, "", nil
	}
	return s, person, err
}
func togglVersion(l togglLink, local togglState) string {
	return fmt.Sprintf("%x", sha256.Sum256(append(append(stateJSON(local), stateJSON(l.remote)...), []byte(l.issue)...)))
}
