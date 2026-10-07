package clock

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/giraffesyo/timeclock/internal/toggl"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Toggl is the company migration bridge. Credentials are encrypted with a key
// kept outside the database; associated data binds ciphertext to its workspace.
type Toggl struct {
	svc              *Service
	box              cipher.AEAD
	client           func(string) *toggl.Client
	workspaceTimeout time.Duration
	// historyMargin is how much of a run's time must be left to start
	// another history window.
	historyMargin time.Duration
	logger        *slog.Logger
}

func NewToggl(s *Service, key string, logger *slog.Logger) (*Toggl, error) {
	t := &Toggl{svc: s, workspaceTimeout: 5 * time.Minute, historyMargin: time.Minute, logger: logger, client: func(token string) *toggl.Client { return &toggl.Client{Token: token} }}
	if key == "" {
		return t, nil
	}
	var err error
	t.box, err = integrationBox(key)
	return t, err
}

// integrationBox seals integration credentials with the integration secret
// key. Each sealing names what it is for in its associated data, so one
// can't be opened as another.
func integrationBox(key string) (cipher.AEAD, error) {
	if len(key) < 32 {
		return nil, errors.New("timeclock: integration secret key must contain at least 32 characters")
	}
	sum := sha256.Sum256([]byte("timeclock/integrations/" + key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithRandomNonce(block)
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
	TogglRoles
}

// TogglRoles are the Toggl projects that record time away rather than work.
// Each applies to entries from the day it was chosen; zero is none.
type TogglRoles struct {
	HolidayProject  int64 `json:"holidayProject,omitempty" minimum:"0" doc:"Entries on it are left out: company holidays pay that time."`
	VacationProject int64 `json:"vacationProject,omitempty" minimum:"0" doc:"Entries on it become vacation."`
	SickProject     int64 `json:"sickProject,omitempty" minimum:"0" doc:"Entries on it become sick time."`
}
type TogglPreview struct {
	Workspaces []toggl.Workspace `json:"workspaces"`
	Users      []toggl.User      `json:"users"`
	Projects   []TogglProject    `json:"projects"`
	Suggested  []TogglMapping    `json:"suggested"`
}

// TogglProject is a project in the Toggl workspace, to choose roles from.
type TogglProject struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}
type TogglStatus struct {
	HistoryComplete bool       `json:"historyComplete"`
	HistoryThrough  string     `json:"historyThrough"`
	Available       bool       `json:"available"`
	Connected       bool       `json:"connected"`
	WorkspaceID     int64      `json:"workspaceId"`
	From            string     `json:"from"`
	LastSync        *time.Time `json:"lastSync,omitempty"`
	NextSync        *time.Time `json:"nextSync,omitempty"`
	Error           string     `json:"error"`
	// RateLimitedUntil is when Toggl's API limit allows Sync now again.
	RateLimitedUntil *time.Time     `json:"rateLimitedUntil,omitempty"`
	People           []TogglMapping `json:"people"`
	TogglRoles
	HolidayFrom  string       `json:"holidayFrom,omitempty"`
	VacationFrom string       `json:"vacationFrom,omitempty"`
	SickFrom     string       `json:"sickFrom,omitempty"`
	HolidayName  string       `json:"holidayName,omitempty" doc:"The project's name once a sync has brought it in."`
	VacationName string       `json:"vacationName,omitempty"`
	SickName     string       `json:"sickName,omitempty"`
	Issues       []TogglIssue `json:"issues"`
}
type TogglIssue struct {
	EntryID  uuid.UUID  `json:"entryId"`
	PersonID string     `json:"personId"`
	RemoteID *int64     `json:"remoteId,omitempty"`
	Kind     string     `json:"kind"`
	Version  string     `json:"version"`
	Local    togglState `json:"local"`
	Remote   togglState `json:"remote"`
	// TimeOff is set for Toggl entries on the vacation or sick project, which
	// sync to time off on a day rather than to an entry.
	TimeOff *TogglTimeOff `json:"timeOff,omitempty"`
}

// TogglTimeOff is the time off a day's Toggl entries add up to.
type TogglTimeOff struct {
	Kind  string  `json:"kind" enum:"vacation,sick"`
	Day   Date    `json:"day" format:"date"`
	Hours float64 `json:"hours" doc:"What the Toggl entries add up to."`
}
type togglConfig struct {
	history         *time.Time
	historyComplete bool
	// historyDays is how many days the sweep asks Toggl for at a time.
	historyDays int
	remote      int64
	token       []byte
	from        time.Time
	next        time.Time
	roles       []togglRole
}

// togglRole is a project whose entries are not work, from the day it was chosen.
type togglRole struct {
	kind    string // holiday, vacation or sick
	project int64
	from    Date
}

// role is what an entry on project, on day, stands for, if anything.
func (c togglConfig) role(project *int64, day Date) string {
	if project == nil {
		return ""
	}
	for _, r := range c.roles {
		if r.project == *project && !day.Before(r.from) {
			return r.kind
		}
	}
	return ""
}

func (t *Toggl) config(ctx context.Context, s *Service) (togglConfig, error) {
	var c togglConfig
	var projects [3]*int64
	var froms [3]*time.Time
	err := s.pool.QueryRow(ctx, `SELECT remote_id, token, sync_from, next_sync, history_cursor, history_complete, history_days,
    holiday_project, holiday_from, vacation_project, vacation_from, sick_project, sick_from FROM toggl_workspaces WHERE workspace_id=$W`).Scan(
		&c.remote, &c.token, &c.from, &c.next, &c.history, &c.historyComplete, &c.historyDays,
		&projects[0], &froms[0], &projects[1], &froms[1], &projects[2], &froms[2])
	for i, kind := range []string{"holiday", Vacation, Sick} {
		if projects[i] != nil && froms[i] != nil {
			c.roles = append(c.roles, togglRole{kind: kind, project: *projects[i], from: DateFromTime(*froms[i])})
		}
	}
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
	out := TogglPreview{Workspaces: []toggl.Workspace{}, Users: []toggl.User{}, Projects: []TogglProject{}, Suggested: []TogglMapping{}}
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
			projects, err := client.Projects(ctx, w.ID)
			if err != nil {
				return out, invalidField("workspaceId", togglMessage(err))
			}
			for _, p := range projects {
				out.Projects = append(out.Projects, TogglProject{ID: p.ID, Name: p.Name, Active: p.Active})
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
		available := map[int64]bool{}
		for _, p := range preview.Projects {
			available[p.ID] = true
		}
		chosen := map[int64]bool{}
		for _, r := range []struct {
			field   string
			project int64
		}{{"holidayProject", in.HolidayProject}, {"vacationProject", in.VacationProject}, {"sickProject", in.SickProject}} {
			if r.project == 0 {
				continue
			}
			if !available[r.project] || chosen[r.project] {
				return invalidField(r.field, "choose a different Toggl project for each role")
			}
			chosen[r.project] = true
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
			fresh := errors.Is(err, pgx.ErrNoRows)
			var before int
			if err = q.QueryRow(ctx, `SELECT count(*) FROM toggl_people WHERE workspace_id=$W`).Scan(&before); err != nil {
				return err
			}
			_, err = q.Exec(ctx, `INSERT INTO toggl_workspaces(workspace_id,remote_id,token,sync_from) VALUES($W,$1,$2,$3)
    ON CONFLICT(workspace_id) DO UPDATE SET token=EXCLUDED.token,next_sync=now(),last_error=''`, in.WorkspaceID, sealed, from)
			if isUniqueViolation(err) {
				return invalidField("workspaceId", "this Toggl workspace is already linked to another company")
			}
			if err != nil {
				return err
			}
			// A role applies from the day it is chosen: entries already synced as
			// work stay work. Keeping a role keeps its day.
			today := DateOf(s.now(), time.UTC).Time()
			_, err = q.Exec(ctx, `UPDATE toggl_workspaces SET
    holiday_from=CASE WHEN $1::bigint IS NULL THEN NULL WHEN holiday_project IS NOT DISTINCT FROM $1 THEN holiday_from ELSE $4::date END, holiday_project=$1,
    vacation_from=CASE WHEN $2::bigint IS NULL THEN NULL WHEN vacation_project IS NOT DISTINCT FROM $2 THEN vacation_from ELSE $4::date END, vacation_project=$2,
    sick_from=CASE WHEN $3::bigint IS NULL THEN NULL WHEN sick_project IS NOT DISTINCT FROM $3 THEN sick_from ELSE $4::date END, sick_project=$3
    WHERE workspace_id=$W`, nonZero(in.HolidayProject), nonZero(in.VacationProject), nonZero(in.SickProject), today)
			if err != nil {
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
			// New people have history to import; a new token or new roles don't.
			if fresh || total != before {
				if _, err = q.Exec(ctx, `UPDATE toggl_workspaces SET history_cursor=NULL,history_complete=false WHERE workspace_id=$W`); err != nil {
					return err
				}
				if _, err = q.Exec(ctx, `DELETE FROM toggl_report_pages WHERE workspace_id=$W`); err != nil {
					return err
				}
			}
			if err = restoreTogglLinks(ctx, q, in.WorkspaceID); err != nil {
				return err
			}
			return audit(ctx, q, actor, "toggl.configure", "", map[string]any{"workspaceId": in.WorkspaceID, "from": in.From, "people": in.People,
				"holidayProject": in.HolidayProject, "vacationProject": in.VacationProject, "sickProject": in.SickProject})
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
	// A button must not bypass Toggl's rate limit, but any other failure (a
	// timeout, an outage that has passed, a fix just deployed) can be retried.
	_, err := s.pool.Exec(ctx, `UPDATE toggl_workspaces SET next_sync=now() WHERE workspace_id=$W AND token IS NOT NULL
    AND (rate_limited_until IS NULL OR rate_limited_until <= $1)`, s.now())
	return err
}
func (t *Toggl) Status(ctx context.Context, s *Service, actor Actor) (TogglStatus, error) {
	out := TogglStatus{Available: t.box != nil, People: []TogglMapping{}, Issues: []TogglIssue{}}
	if !actor.Admin {
		return out, forbidden("only an admin manages integrations")
	}
	var from time.Time
	var history *time.Time
	var roles [3]*int64
	var froms [3]*time.Time
	err := s.pool.QueryRow(ctx, `SELECT remote_id,token IS NOT NULL,sync_from,last_sync,next_sync,last_error,rate_limited_until,history_cursor,history_complete,
    holiday_project,holiday_from,vacation_project,vacation_from,sick_project,sick_from FROM toggl_workspaces WHERE workspace_id=$W`).Scan(
		&out.WorkspaceID, &out.Connected, &from, &out.LastSync, &out.NextSync, &out.Error, &out.RateLimitedUntil, &history, &out.HistoryComplete,
		&roles[0], &froms[0], &roles[1], &froms[1], &roles[2], &froms[2])
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.From = from.Format(time.DateOnly)
	for i, role := range []struct {
		project    *int64
		from, name *string
	}{{&out.HolidayProject, &out.HolidayFrom, &out.HolidayName}, {&out.VacationProject, &out.VacationFrom, &out.VacationName}, {&out.SickProject, &out.SickFrom, &out.SickName}} {
		if roles[i] == nil || froms[i] == nil {
			continue
		}
		*role.project = *roles[i]
		*role.from = froms[i].Format(time.DateOnly)
		err = s.pool.QueryRow(ctx, `SELECT p.name FROM toggl_projects t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$W AND t.remote_id=$1`, *roles[i]).Scan(role.name)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
	}
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
	rows, err = s.pool.Query(ctx, `SELECT d.id,d.person_id,d.kind,d.day,d.issue,
    COALESCE((SELECT sum(o.seconds) FROM toggl_time_off o WHERE o.workspace_id=d.workspace_id AND o.person_id=d.person_id AND o.day=d.day AND o.kind=d.kind),0)
    FROM toggl_time_off_days d WHERE d.workspace_id=$W AND d.issue<>'' ORDER BY d.day,d.person_id,d.kind`)
	if err != nil {
		return out, err
	}
	var issue TogglIssue
	var off TogglTimeOff
	var day time.Time
	var seconds int64
	_, err = pgx.ForEachRow(rows, []any{&issue.EntryID, &issue.PersonID, &off.Kind, &day, &issue.Kind, &seconds}, func() error {
		off.Day = DateFromTime(day)
		off.Hours = Hours(time.Duration(seconds) * time.Second)
		item, timeOff := issue, off
		item.Local, item.Remote, item.TimeOff = togglState{Deleted: true}, togglState{Deleted: true}, &timeOff
		out.Issues = append(out.Issues, item)
		return nil
	})
	return out, err
}
func togglMessage(err error) string {
	if e, ok := errors.AsType[*toggl.Error](err); ok {
		return e.Error()
	}
	// Say what stopped it: an admin can often fix the cause in Toggl.
	return "Sync could not finish: " + err.Error()
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

// nonZero is a Toggl id, or null for none.
func nonZero(id int64) *int64 {
	if id == 0 {
		return nil
	}
	return &id
}
