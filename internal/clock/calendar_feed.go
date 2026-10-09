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

// FeedContents is what a calendar feed lists. At least one is on.
type FeedContents struct {
	Holidays    bool `json:"holidays" doc:"The company's holidays."`
	TimeOff     bool `json:"timeOff" doc:"Who is out: everyone's approved time off."`
	TrackedTime bool `json:"trackedTime" doc:"The subscriber's own tracked and planned time."`
}

// DefaultFeedContents is what a feed lists until its owner says otherwise.
var DefaultFeedContents = FeedContents{Holidays: true, TimeOff: true}

// CalendarFeedStatus is whether a person has a calendar feed, and what it
// lists. Its address is shown only when it is made.
type CalendarFeedStatus struct {
	FeedContents
	Enabled   bool       `json:"enabled" doc:"Whether the caller has a calendar feed."`
	CreatedAt *time.Time `json:"createdAt,omitempty" doc:"When its address was made."`
}

// FeedOwner is whose a calendar feed is, the workspace it lists, and what.
type FeedOwner struct {
	Workspace Workspace
	PersonID  string
	Contents  FeedContents
}

func checkFeedContents(c FeedContents) error {
	if !c.Holidays && !c.TimeOff && !c.TrackedTime {
		return invalidField("holidays", "a calendar feed lists at least one thing")
	}
	return nil
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
	out, err := scanFeedStatus(s.pool.QueryRow(ctx, `SELECT `+feedStatusColumns+` FROM calendar_feeds
		WHERE workspace_id = $W AND person_id = $1`, actor.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CalendarFeedStatus{FeedContents: DefaultFeedContents}, nil
	}
	if err != nil {
		return out, fmt.Errorf("read calendar feed: %w", err)
	}
	return out, nil
}

const feedStatusColumns = `holidays, time_off, tracked_time, created_at`

func scanFeedStatus(row pgx.Row) (CalendarFeedStatus, error) {
	out := CalendarFeedStatus{Enabled: true}
	var created time.Time
	err := row.Scan(&out.Holidays, &out.TimeOff, &out.TrackedTime, &created)
	out.CreatedAt = &created
	return out, err
}

// NewCalendarFeed makes actor a calendar feed listing c, and returns its
// secret. Any feed they had stops working.
func (s *Service) NewCalendarFeed(ctx context.Context, actor Actor, c FeedContents) (string, CalendarFeedStatus, error) {
	if err := checkFeedContents(c); err != nil {
		return "", CalendarFeedStatus{}, err
	}
	token := rand.Text()
	out, err := scanFeedStatus(s.pool.QueryRow(ctx, `INSERT INTO calendar_feeds (workspace_id, person_id, token_hash, holidays, time_off, tracked_time)
		VALUES ($W, $1, $2, $3, $4, $5)
		ON CONFLICT (workspace_id, person_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, holidays = EXCLUDED.holidays,
			time_off = EXCLUDED.time_off, tracked_time = EXCLUDED.tracked_time, created_at = now()
		RETURNING `+feedStatusColumns, actor.ID, feedHash(token), c.Holidays, c.TimeOff, c.TrackedTime))
	if err != nil {
		return "", out, fmt.Errorf("make calendar feed: %w", err)
	}
	return token, out, nil
}

// SetCalendarFeed changes what actor's calendar feed lists, at the same
// address: subscribers see it when they next fetch it.
func (s *Service) SetCalendarFeed(ctx context.Context, actor Actor, c FeedContents) (CalendarFeedStatus, error) {
	if err := checkFeedContents(c); err != nil {
		return CalendarFeedStatus{}, err
	}
	out, err := scanFeedStatus(s.pool.QueryRow(ctx, `UPDATE calendar_feeds SET holidays = $2, time_off = $3, tracked_time = $4
		WHERE workspace_id = $W AND person_id = $1 RETURNING `+feedStatusColumns, actor.ID, c.Holidays, c.TimeOff, c.TrackedTime))
	if errors.Is(err, pgx.ErrNoRows) {
		return out, notFound("calendar feed")
	}
	if err != nil {
		return out, fmt.Errorf("change calendar feed: %w", err)
	}
	return out, nil
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
	err := s.raw.QueryRow(ctx, `SELECT w.id, w.key, w.name, f.person_id, f.holidays, f.time_off, f.tracked_time FROM calendar_feeds f
		JOIN workspaces w ON w.id = f.workspace_id WHERE f.token_hash = $1`, feedHash(token)).
		Scan(&o.Workspace.ID, &o.Workspace.Key, &o.Workspace.Name, &o.PersonID, &o.Contents.Holidays, &o.Contents.TimeOff, &o.Contents.TrackedTime)
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
