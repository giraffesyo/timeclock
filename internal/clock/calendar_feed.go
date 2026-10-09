package clock

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// CalendarFeedStatus is whether a person has a calendar feed. Its address
// is shown only when it is made.
type CalendarFeedStatus struct {
	Enabled   bool       `json:"enabled" doc:"Whether the caller has a calendar feed."`
	CreatedAt *time.Time `json:"createdAt,omitempty" doc:"When its address was made."`
}

// FeedOwner is whose a calendar feed is, and the workspace it lists.
type FeedOwner struct {
	Workspace Workspace
	PersonID  string
}

// Absence is a day someone is out: approved vacation or sick time.
type Absence struct {
	PersonID   string
	PersonName string
	Kind       string
	Day        Date
	Hours      float64
}

func feedHash(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// CalendarFeed says whether actor has a calendar feed.
func (s *Service) CalendarFeed(ctx context.Context, actor Actor) (CalendarFeedStatus, error) {
	var created time.Time
	err := s.pool.QueryRow(ctx, `SELECT created_at FROM calendar_feeds WHERE workspace_id = $W AND person_id = $1`, actor.ID).Scan(&created)
	if errors.Is(err, pgx.ErrNoRows) {
		return CalendarFeedStatus{}, nil
	}
	if err != nil {
		return CalendarFeedStatus{}, fmt.Errorf("read calendar feed: %w", err)
	}
	return CalendarFeedStatus{Enabled: true, CreatedAt: &created}, nil
}

// NewCalendarFeed makes actor a calendar feed and returns its secret. Any
// feed they had stops working.
func (s *Service) NewCalendarFeed(ctx context.Context, actor Actor) (string, CalendarFeedStatus, error) {
	token := rand.Text()
	var created time.Time
	if err := s.pool.QueryRow(ctx, `INSERT INTO calendar_feeds (workspace_id, person_id, token_hash) VALUES ($W, $1, $2)
		ON CONFLICT (workspace_id, person_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()
		RETURNING created_at`, actor.ID, feedHash(token)).Scan(&created); err != nil {
		return "", CalendarFeedStatus{}, fmt.Errorf("make calendar feed: %w", err)
	}
	return token, CalendarFeedStatus{Enabled: true, CreatedAt: &created}, nil
}

// StopCalendarFeed turns actor's calendar feed off.
func (s *Service) StopCalendarFeed(ctx context.Context, actor Actor) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM calendar_feeds WHERE workspace_id = $W AND person_id = $1`, actor.ID); err != nil {
		return fmt.Errorf("stop calendar feed: %w", err)
	}
	return nil
}

// CalendarFeedOwner is whose feed a secret opens, in any workspace: a feed
// is fetched by a calendar app, which says nothing about where it is.
func (s *Service) CalendarFeedOwner(ctx context.Context, token string) (FeedOwner, error) {
	var o FeedOwner
	err := s.raw.QueryRow(ctx, `SELECT w.id, w.key, w.name, f.person_id FROM calendar_feeds f
		JOIN workspaces w ON w.id = f.workspace_id WHERE f.token_hash = $1`, feedHash(token)).
		Scan(&o.Workspace.ID, &o.Workspace.Key, &o.Workspace.Name, &o.PersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return o, notFound("calendar feed")
	}
	if err != nil {
		return o, fmt.Errorf("read calendar feed: %w", err)
	}
	return o, nil
}

// Absences is everyone's approved time off on the days from..to, for those
// still active, by day.
func (s *Service) Absences(ctx context.Context, from, to Date) ([]Absence, error) {
	rows, err := s.pool.Query(ctx, `SELECT o.person_id, p.name, o.kind, o.day, o.hours::float8 FROM time_off o
		JOIN people p ON p.workspace_id = o.workspace_id AND p.id = o.person_id
		WHERE o.workspace_id = $W AND o.status = 'approved' AND p.active AND o.day BETWEEN $1 AND $2
		ORDER BY o.person_id, o.kind, o.day`, from.Time(), to.Time())
	if err != nil {
		return nil, fmt.Errorf("list absences: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Absence, error) {
		var a Absence
		var day time.Time
		err := row.Scan(&a.PersonID, &a.PersonName, &a.Kind, &day, &a.Hours)
		a.Day = DateFromTime(day)
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("list absences: %w", err)
	}
	return out, nil
}
