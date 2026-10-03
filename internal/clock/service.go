package clock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/giraffesyo/timeclock/host"
)

// Service is Timeclock's payroll data and its rules. Every method takes the
// Actor it acts for and refuses what that person may not do.
type Service struct {
	pool *pgxpool.Pool
	// now is the clock, replaceable in tests.
	now func() time.Time
}

// New returns a Service on a pool whose search_path is Timeclock's schema.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: time.Now}
}

// querier is the part of a pool or transaction the queries use.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func newID() uuid.UUID { return uuid.Must(uuid.NewV7()) }

// tx runs fn in a transaction that holds a lock on one person's time, so
// two requests can't both pass the overlap or lock checks and then write.
func (s *Service) tx(ctx context.Context, personID string, fn func(tx pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if personID != "" {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "timeclock/person/"+personID); err != nil {
				return fmt.Errorf("lock person: %w", err)
			}
		}
		return fn(tx)
	})
}

// audit records a change to payroll data in the same transaction as the
// change, so one never exists without the other.
func audit(ctx context.Context, q querier, actor Actor, action, personID string, detail any) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return fmt.Errorf("audit detail: %w", err)
	}
	if _, err := q.Exec(ctx,
		`INSERT INTO audit_log (id, actor, action, person_id, detail) VALUES ($1, $2, $3, $4, $5)`,
		newID(), actor.ID, action, personID, raw); err != nil {
		return fmt.Errorf("write audit log: %w", err)
	}
	return nil
}

// --- Settings ---

const settingsColumns = `timezone, pay_cycle, cycle_anchor, week_start, overtime_weekly_hours::float8,
	approve_timesheets, approve_time_off, require_project, long_entry_hours::float8`

func scanSettings(row pgx.Row) (Settings, error) {
	var s Settings
	var anchor time.Time
	err := row.Scan(&s.Timezone, &s.PayCycle, &anchor, &s.WeekStart, &s.OvertimeWeeklyHours,
		&s.ApproveTimesheets, &s.ApproveTimeOff, &s.RequireProject, &s.LongEntryHours)
	s.CycleAnchor = DateFromTime(anchor)
	return s, err
}

// Settings returns how the organization runs payroll.
func (s *Service) Settings(ctx context.Context) (Settings, error) {
	return settings(ctx, s.pool)
}

func settings(ctx context.Context, q querier) (Settings, error) {
	out, err := scanSettings(q.QueryRow(ctx, `SELECT `+settingsColumns+` FROM settings`))
	if err != nil {
		return out, fmt.Errorf("read settings: %w", err)
	}
	return out, nil
}

// UpdateSettings changes how payroll runs. Timesheets already submitted keep
// the pay period they were submitted for.
func (s *Service) UpdateSettings(ctx context.Context, actor Actor, in Settings) (Settings, error) {
	if !actor.Admin {
		return Settings{}, forbidden("only an admin changes payroll settings")
	}
	if _, err := time.LoadLocation(in.Timezone); err != nil || in.Timezone == "" {
		return Settings{}, invalidField("timezone", "not an IANA time zone")
	}
	err := s.tx(ctx, "", func(tx pgx.Tx) error {
		before, err := settings(ctx, tx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE settings SET timezone = $1, pay_cycle = $2, cycle_anchor = $3, week_start = $4,
			overtime_weekly_hours = $5, approve_timesheets = $6, approve_time_off = $7, require_project = $8,
			long_entry_hours = $9, updated_at = now(), updated_by = $10`,
			in.Timezone, in.PayCycle, in.CycleAnchor.Time(), in.WeekStart, in.OvertimeWeeklyHours,
			in.ApproveTimesheets, in.ApproveTimeOff, in.RequireProject, in.LongEntryHours, actor.ID); err != nil {
			return fmt.Errorf("update settings: %w", err)
		}
		return audit(ctx, tx, actor, "settings.update", "", map[string]any{"before": before, "after": in})
	})
	if err != nil {
		return Settings{}, err
	}
	return s.Settings(ctx)
}

// --- People ---

const personColumns = `id, name, email, CASE WHEN manager_id <> '' THEN manager_id ELSE host_manager_id END,
	overtime_exempt, payroll_id, active`

func scanPerson(row pgx.Row) (Person, error) {
	var p Person
	err := row.Scan(&p.ID, &p.Name, &p.Email, &p.ManagerID, &p.OvertimeExempt, &p.PayrollID, &p.Active)
	return p, err
}

// Sync records the host's current answer about a person and returns them as
// an Actor. It is called for the caller of every request, so the people
// table always has everyone who has used Timeclock.
func (s *Service) Sync(ctx context.Context, hp host.Person) (Actor, error) {
	p, err := scanPerson(s.pool.QueryRow(ctx, `
		INSERT INTO people (id, name, email, host_manager_id) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
			host_manager_id = EXCLUDED.host_manager_id, updated_at = now()
		WHERE (people.name, people.email, people.host_manager_id) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.email, EXCLUDED.host_manager_id)
		RETURNING `+personColumns, hp.ID, hp.Name, hp.Email, hp.ManagerID))
	if errors.Is(err, pgx.ErrNoRows) { // nothing changed, so nothing was returned
		p, err = scanPerson(s.pool.QueryRow(ctx, `SELECT `+personColumns+` FROM people WHERE id = $1`, hp.ID))
	}
	if err != nil {
		return Actor{}, fmt.Errorf("sync person: %w", err)
	}
	return Actor{Person: p, Admin: hp.Admin}, nil
}

// SyncAll records everyone in the host's directory, so admins can assign
// managers and report on people who haven't opened Timeclock yet.
func (s *Service) SyncAll(ctx context.Context, people []host.Person) error {
	for _, hp := range people {
		if _, err := s.Sync(ctx, hp); err != nil {
			return err
		}
	}
	return nil
}

func person(ctx context.Context, q querier, id string) (Person, error) {
	p, err := scanPerson(q.QueryRow(ctx, `SELECT `+personColumns+` FROM people WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, notFound("person")
	}
	if err != nil {
		return p, fmt.Errorf("read person: %w", err)
	}
	return p, nil
}

// canView reports whether actor may see p's time: their own, their reports',
// or anyone's for an admin.
func canView(actor Actor, p Person) bool {
	return actor.Admin || actor.ID == p.ID || (p.ManagerID != "" && p.ManagerID == actor.ID)
}

// viewable returns the person, refusing an actor who may not see their time.
// A person the actor may not see is reported as not found, so ids can't be
// probed.
func (s *Service) viewable(ctx context.Context, q querier, actor Actor, personID string) (Person, error) {
	if personID == "" || personID == actor.ID {
		return actor.Person, nil
	}
	p, err := person(ctx, q, personID)
	if err != nil {
		return p, err
	}
	if !canView(actor, p) {
		return p, notFound("person")
	}
	return p, nil
}

// decidable is viewable for approving: the person's manager or an admin, and
// never a manager deciding their own time.
func (s *Service) decidable(ctx context.Context, q querier, actor Actor, personID string) (Person, error) {
	p, err := s.viewable(ctx, q, actor, personID)
	if err != nil {
		return p, err
	}
	if actor.Admin {
		return p, nil
	}
	if p.ID == actor.ID {
		return p, ErrOwnApproval.New("").AsDenial()
	}
	if p.ManagerID != actor.ID {
		return p, forbidden("only the person's manager or an admin decides this")
	}
	return p, nil
}

// People lists the people whose time actor may see: everyone for an admin,
// otherwise the actor and their reports.
func (s *Service) People(ctx context.Context, actor Actor) ([]Person, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+personColumns+` FROM people
		WHERE $1 OR id = $2 OR (CASE WHEN manager_id <> '' THEN manager_id ELSE host_manager_id END) = $2
		ORDER BY lower(name), id`, actor.Admin, actor.ID)
	if err != nil {
		return nil, fmt.Errorf("list people: %w", err)
	}
	people, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Person, error) { return scanPerson(row) })
	if err != nil {
		return nil, fmt.Errorf("list people: %w", err)
	}
	return people, nil
}

// PersonUpdate is what an admin sets on a person.
type PersonUpdate struct {
	ManagerID      string `json:"managerId" doc:"Who approves this person's time. Empty defers to the host's directory."`
	OvertimeExempt bool   `json:"overtimeExempt"`
	PayrollID      string `json:"payrollId" maxLength:"64"`
	Active         bool   `json:"active" doc:"Inactive people are left out of payroll reports and exceptions."`
}

// UpdatePerson sets a person's manager and payroll details.
func (s *Service) UpdatePerson(ctx context.Context, actor Actor, id string, in PersonUpdate) (Person, error) {
	if !actor.Admin {
		return Person{}, forbidden("only an admin changes people")
	}
	var out Person
	err := s.tx(ctx, id, func(tx pgx.Tx) error {
		before, err := person(ctx, tx, id)
		if err != nil {
			return err
		}
		if in.ManagerID != "" {
			if err := checkManager(ctx, tx, id, in.ManagerID); err != nil {
				return err
			}
		}
		out, err = scanPerson(tx.QueryRow(ctx, `UPDATE people SET manager_id = $2, overtime_exempt = $3, payroll_id = $4,
			active = $5, updated_at = now() WHERE id = $1 RETURNING `+personColumns,
			id, in.ManagerID, in.OvertimeExempt, in.PayrollID, in.Active))
		if err != nil {
			return fmt.Errorf("update person: %w", err)
		}
		return audit(ctx, tx, actor, "person.update", id, map[string]any{"before": before, "after": out})
	})
	return out, err
}

// checkManager refuses a manager who doesn't exist or whose own chain of
// managers leads back to the person.
func checkManager(ctx context.Context, q querier, personID, managerID string) error {
	seen := map[string]bool{personID: true}
	for next := managerID; next != ""; {
		if seen[next] {
			return ErrManagerLoop.New("")
		}
		seen[next] = true
		m, err := person(ctx, q, next)
		if err != nil {
			if next == managerID {
				return invalidField("managerId", "no such person")
			}
			return nil // a manager the host named but who never signed in ends the chain
		}
		next = m.ManagerID
	}
	return nil
}

// personNames returns the names of the people with the given ids.
func personNames(ctx context.Context, q querier, ids []string) (map[string]string, error) {
	names := map[string]string{}
	if len(ids) == 0 {
		return names, nil
	}
	rows, err := q.Query(ctx, `SELECT id, name FROM people WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("read names: %w", err)
	}
	var id, name string
	if _, err := pgx.ForEachRow(rows, []any{&id, &name}, func() error {
		names[id] = name
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read names: %w", err)
	}
	return names, nil
}
