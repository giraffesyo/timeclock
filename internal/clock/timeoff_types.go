package clock

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/giraffesyo/timeclock/internal/messages"
)

// TimeOffTypeInput is a time off type as an admin enters it.
type TimeOffTypeInput struct {
	Name     string `json:"name" minLength:"1" maxLength:"60"`
	PaysAs   string `json:"paysAs" enum:"vacation,sick" doc:"How payroll pays it: vacation is PTO. Fixed once time off of the type is recorded."`
	Archived bool   `json:"archived,omitempty" doc:"Stop offering it for new time off."`
}

const timeOffTypeColumns = `t.id, t.name, t.pays_as, t.archived_at IS NOT NULL,
	EXISTS (SELECT 1 FROM time_off o WHERE o.workspace_id = t.workspace_id AND o.type_id = t.id)`

func scanTimeOffType(row pgx.Row) (TimeOffType, error) {
	var t TimeOffType
	err := row.Scan(&t.ID, &t.Name, &t.PaysAs, &t.Archived, &t.Used)
	return t, err
}

// TimeOffTypes lists the workspace's time off types in the order they were
// added, archived ones too, since time off recorded as them still names them.
func (s *Service) TimeOffTypes(ctx context.Context) ([]TimeOffType, error) {
	return timeOffTypes(ctx, s.pool)
}

func timeOffTypes(ctx context.Context, q querier) ([]TimeOffType, error) {
	rows, err := q.Query(ctx, `SELECT `+timeOffTypeColumns+` FROM time_off_types t
		WHERE t.workspace_id = $W ORDER BY t.position, t.created_at, t.id`)
	if err != nil {
		return nil, fmt.Errorf("list time off types: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (TimeOffType, error) { return scanTimeOffType(row) })
	if err != nil {
		return nil, fmt.Errorf("list time off types: %w", err)
	}
	return out, nil
}

func timeOffType(ctx context.Context, q querier, id uuid.UUID) (TimeOffType, error) {
	t, err := scanTimeOffType(q.QueryRow(ctx, `SELECT `+timeOffTypeColumns+` FROM time_off_types t WHERE t.workspace_id = $W AND t.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, notFound("time off type")
	}
	if err != nil {
		return t, fmt.Errorf("read time off type: %w", err)
	}
	return t, nil
}

// typeFor is the type time off is recorded as: the one named, or, for a
// caller that names only how it's paid, the first type still offered that
// pays that way (else the first that ever did).
func typeFor(ctx context.Context, q querier, id uuid.UUID, kind string) (TimeOffType, error) {
	if id != uuid.Nil {
		t, err := timeOffType(ctx, q, id)
		if err != nil {
			return t, invalidField("typeId", "no such time off type")
		}
		return t, nil
	}
	if kind == "" {
		return TimeOffType{}, requiredField("typeId")
	}
	t, err := scanTimeOffType(q.QueryRow(ctx, `SELECT `+timeOffTypeColumns+` FROM time_off_types t
		WHERE t.workspace_id = $W AND t.pays_as = $1 ORDER BY t.archived_at IS NOT NULL, t.position, t.created_at, t.id LIMIT 1`, kind))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, invalidField("kind", "no time off type is paid this way")
	}
	if err != nil {
		return t, fmt.Errorf("read time off type: %w", err)
	}
	return t, nil
}

// nameTypes fills in each one's type name.
func nameTypes(ctx context.Context, q querier, list []TimeOff) error {
	if len(list) == 0 {
		return nil
	}
	types, err := timeOffTypes(ctx, q)
	if err != nil {
		return err
	}
	names := make(map[uuid.UUID]string, len(types))
	for _, t := range types {
		names[t.ID] = t.Name
	}
	for i := range list {
		list[i].TypeName = names[list[i].TypeID]
	}
	return nil
}

// seedTimeOffTypes gives a new workspace the types every workspace starts
// with, for its admins to rename, add to or archive.
func seedTimeOffTypes(ctx context.Context, tx pgx.Tx, workspace uuid.UUID) error {
	for i, typ := range []struct{ name, paysAs string }{
		{messages.T("timeOffType.vacation", nil), Vacation},
		{messages.T("timeOffType.sick", nil), Sick},
	} {
		if _, err := tx.Exec(ctx, `INSERT INTO time_off_types (workspace_id, id, name, pays_as, position) VALUES ($1, $2, $3, $4, $5)`,
			workspace, newID(), typ.name, typ.paysAs, i); err != nil {
			return fmt.Errorf("add time off types: %w", err)
		}
	}
	return nil
}

// SaveTimeOffType adds a time off type, or with an id renames, archives or
// restores one. How a type is paid is fixed once it has time off, so pay
// already recorded never moves between PTO and sick.
func (s *Service) SaveTimeOffType(ctx context.Context, actor Actor, id uuid.UUID, in TimeOffTypeInput) (TimeOffType, error) {
	if !actor.Admin {
		return TimeOffType{}, forbidden("only an admin changes time off types")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return TimeOffType{}, requiredField("name")
	}
	if in.PaysAs != Vacation && in.PaysAs != Sick {
		return TimeOffType{}, invalidField("paysAs", "must be vacation or sick")
	}
	var out TimeOffType
	err := s.tx(ctx, "", func(tx querier) error {
		before := TimeOffType{}
		if id == uuid.Nil {
			id = newID()
			_, err := tx.Exec(ctx, `INSERT INTO time_off_types (workspace_id, id, name, pays_as, position, archived_at)
				VALUES ($W, $1, $2, $3, (SELECT coalesce(max(position), -1) + 1 FROM time_off_types WHERE workspace_id = $W),
				CASE WHEN $4 THEN now() END)`, id, name, in.PaysAs, in.Archived)
			if isUniqueViolation(err) {
				return ErrNameTaken.Newf("a time off type is already named %q", name)
			}
			if err != nil {
				return fmt.Errorf("add time off type: %w", err)
			}
		} else {
			var err error
			before, err = timeOffType(ctx, tx, id)
			if err != nil {
				return err
			}
			if before.Used && before.PaysAs != in.PaysAs {
				return ErrTimeOffTypeUsed.New("")
			}
			_, err = tx.Exec(ctx, `UPDATE time_off_types SET name = $2, pays_as = $3,
				archived_at = CASE WHEN NOT $4 THEN NULL ELSE coalesce(archived_at, now()) END
				WHERE workspace_id = $W AND id = $1`, id, name, in.PaysAs, in.Archived)
			if isUniqueViolation(err) {
				return ErrNameTaken.Newf("a time off type is already named %q", name)
			}
			if err != nil {
				return fmt.Errorf("change time off type: %w", err)
			}
		}
		var err error
		out, err = timeOffType(ctx, tx, id)
		if err != nil {
			return err
		}
		if out.Archived {
			// Something is always offered, or no one could record time off.
			var offered bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM time_off_types WHERE workspace_id = $W AND archived_at IS NULL)`).Scan(&offered); err != nil {
				return fmt.Errorf("check time off types: %w", err)
			}
			if !offered {
				return invalidField("archived", "at least one time off type stays offered")
			}
		}
		action := "time_off_type.update"
		if before.ID == uuid.Nil {
			action = "time_off_type.create"
		}
		return audit(ctx, tx, actor, action, "", map[string]any{"before": before, "after": out})
	})
	return out, err
}
