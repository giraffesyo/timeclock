package clock

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DefaultWorkspace is the key of the workspace a deployment has without
// asking for any: a host that has one organization, or a server on its own.
const DefaultWorkspace = "default"

// Workspace is one organization's Timeclock.
type Workspace struct {
	ID uuid.UUID `json:"id"`
	// Key is how the host, or the address, names it.
	Key  string `json:"key"`
	Name string `json:"name"`
}

// globalSQL marks a statement that is about no workspace's rows, such as a
// lock. Every other statement must name its workspace with $W.
const globalSQL = "/* global */ "

// scoped runs statements for one workspace. A statement names the workspace
// as $W wherever it filters or writes workspace_id; scoped numbers it after
// the statement's own arguments and supplies the value. A statement that
// doesn't say $W is refused unless it is marked global, so a query that
// forgot its workspace fails instead of reading everyone's rows.
type scoped struct {
	q  querier
	ws uuid.UUID
}

var errUnscoped = errors.New("clock: statement names no workspace ($W)")

func (s scoped) rewrite(sql string, args []any) (string, []any, error) {
	if strings.HasPrefix(sql, globalSQL) {
		return sql, args, nil
	}
	if !strings.Contains(sql, "$W") {
		return "", nil, fmt.Errorf("%w: %.80s", errUnscoped, strings.Join(strings.Fields(sql), " "))
	}
	if s.ws == uuid.Nil {
		return "", nil, errors.New("clock: no workspace: use Service.In")
	}
	n := "$" + strconv.Itoa(len(args)+1)
	return strings.ReplaceAll(sql, "$W", n), append(args[:len(args):len(args)], s.ws), nil
}

func (s scoped) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	sql, args, err := s.rewrite(sql, args)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	return s.q.Exec(ctx, sql, args...)
}

func (s scoped) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	sql, args, err := s.rewrite(sql, args)
	if err != nil {
		return nil, err
	}
	return s.q.Query(ctx, sql, args...)
}

func (s scoped) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	sql, args, err := s.rewrite(sql, args)
	if err != nil {
		return errRow{err}
	}
	return s.q.QueryRow(ctx, sql, args...)
}

// errRow is the row of a statement that was refused.
type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

// In returns the service for one workspace. Everything it reads and writes
// is that workspace's.
func (s *Service) In(workspace uuid.UUID) *Service {
	return &Service{raw: s.raw, pool: scoped{q: s.raw, ws: workspace}, ws: workspace, now: s.now}
}

// Workspace is the workspace this service is for.
func (s *Service) Workspace() uuid.UUID { return s.ws }

// EnsureWorkspace returns the workspace with the given key, making it, with
// default settings, the first time it is asked for.
func (s *Service) EnsureWorkspace(ctx context.Context, key string) (Workspace, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return Workspace{}, errors.New("clock: a workspace needs a key")
	}
	var w Workspace
	err := pgx.BeginFunc(ctx, s.raw, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT id, key, name FROM workspaces WHERE key = $1`, key).Scan(&w.ID, &w.Key, &w.Name)
		if err == nil || !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		w = Workspace{ID: newID(), Key: key}
		tag, err := tx.Exec(ctx, `INSERT INTO workspaces (id, key) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, w.ID, key)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 { // someone else made it just now
			return tx.QueryRow(ctx, `SELECT id, key, name FROM workspaces WHERE key = $1`, key).Scan(&w.ID, &w.Key, &w.Name)
		}
		_, err = tx.Exec(ctx, `INSERT INTO settings (workspace_id) VALUES ($1)`, w.ID)
		return err
	})
	if err != nil {
		return Workspace{}, fmt.Errorf("ensure workspace %q: %w", key, err)
	}
	return w, nil
}

// Workspaces lists every workspace, for jobs that run across all of them.
func (s *Service) Workspaces(ctx context.Context) ([]Workspace, error) {
	rows, err := s.raw.Query(ctx, `SELECT id, key, name FROM workspaces ORDER BY created_at, key`)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Workspace, error) {
		var w Workspace
		err := row.Scan(&w.ID, &w.Key, &w.Name)
		return w, err
	})
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	return out, nil
}
