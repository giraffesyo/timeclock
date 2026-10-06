package clock

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// HolidayHours is what a holiday day pays when the admin doesn't say.
const HolidayHours = 8.0

// maxHolidayDays bounds one holiday, so a mistyped range can't write a year.
const maxHolidayDays = 31

// HolidayInput is a holiday as an admin enters it: the days the company
// observes, so a holiday on a Saturday is entered on the Friday off.
type HolidayInput struct {
	Name string            `json:"name" minLength:"1" maxLength:"120"`
	Days []HolidayDayInput `json:"days" minItems:"1" maxItems:"31" doc:"The observed days. A holiday can cover several days, not necessarily in a row."`
}

// HolidayDayInput is one observed day and what it pays.
type HolidayDayInput struct {
	Day   Date    `json:"day" format:"date"`
	Hours float64 `json:"hours,omitempty" minimum:"0" maximum:"24" doc:"Paid hours on the day. Absent or 0 pays 8."`
}

// holidayEligible is whether a person (aliased p) is paid for holidays:
// active, with their own choice or else the workspace's.
const holidayEligible = `p.active AND coalesce(p.holiday_pay, (SELECT holiday_pay FROM settings WHERE settings.workspace_id = p.workspace_id))`

// Holidays lists the company's holidays by their first day.
func (s *Service) Holidays(ctx context.Context) ([]Holiday, error) {
	return holidays(ctx, s.pool, uuid.Nil)
}

// holidays reads every holiday, or one when id is set.
func holidays(ctx context.Context, q querier, id uuid.UUID) ([]Holiday, error) {
	rows, err := q.Query(ctx, `SELECT h.id, h.name, d.day, d.hours::float8 FROM holidays h
		JOIN holiday_days d ON d.workspace_id = h.workspace_id AND d.holiday_id = h.id
		WHERE h.workspace_id = $W AND ($1::uuid IS NULL OR h.id = $1) ORDER BY d.day`, nullID(id))
	if err != nil {
		return nil, fmt.Errorf("list holidays: %w", err)
	}
	var out []Holiday
	index := map[uuid.UUID]int{}
	var hid uuid.UUID
	var name string
	var day time.Time
	var hours float64
	if _, err := pgx.ForEachRow(rows, []any{&hid, &name, &day, &hours}, func() error {
		i, ok := index[hid]
		if !ok {
			i = len(out)
			index[hid] = i
			out = append(out, Holiday{ID: hid, Name: name})
		}
		out[i].Days = append(out[i].Days, HolidayDay{Day: DateFromTime(day), Hours: hours})
		return nil
	}); err != nil {
		return nil, fmt.Errorf("list holidays: %w", err)
	}
	return out, nil
}

func nullID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}

// holidayDays is the company holiday on each day from..to, by name and hours.
func holidayDays(ctx context.Context, q querier, from, to Date) (map[Date]HolidayDay, map[Date]string, error) {
	rows, err := q.Query(ctx, `SELECT d.day, d.hours::float8, h.name FROM holiday_days d
		JOIN holidays h ON h.workspace_id = d.workspace_id AND h.id = d.holiday_id
		WHERE d.workspace_id = $W AND d.day BETWEEN $1 AND $2`, from.Time(), to.Time())
	if err != nil {
		return nil, nil, fmt.Errorf("read holidays: %w", err)
	}
	days, names := map[Date]HolidayDay{}, map[Date]string{}
	var day time.Time
	var hours float64
	var name string
	if _, err := pgx.ForEachRow(rows, []any{&day, &hours, &name}, func() error {
		d := DateFromTime(day)
		days[d], names[d] = HolidayDay{Day: d, Hours: hours}, name
		return nil
	}); err != nil {
		return nil, nil, fmt.Errorf("read holidays: %w", err)
	}
	return days, names, nil
}

// holidayLocked refuses a change to a holiday day that someone it pays has
// in a submitted or approved timesheet: their pay for it is settled. An
// admin sends the timesheet back first, as for any other change to it.
func holidayLocked(ctx context.Context, q querier, d Date) error {
	var locked bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM timesheets t JOIN people p ON p.workspace_id = t.workspace_id AND p.id = t.person_id
		WHERE t.workspace_id = $W AND t.status IN ('submitted', 'approved') AND $1 BETWEEN t.period_start AND t.period_end
		AND `+holidayEligible+`)`, d.Time()).Scan(&locked); err != nil {
		return fmt.Errorf("check lock: %w", err)
	}
	if locked {
		return ErrLocked.Newf("%s is in a submitted or approved timesheet", d)
	}
	return nil
}

// SaveHoliday adds a holiday, or with an id changes one. Only the days whose
// pay changes need to be outside settled timesheets.
func (s *Service) SaveHoliday(ctx context.Context, actor Actor, id uuid.UUID, in HolidayInput) (Holiday, error) {
	if !actor.Admin {
		return Holiday{}, forbidden("only an admin changes holidays")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return Holiday{}, requiredField("name")
	}
	if len(in.Days) == 0 {
		return Holiday{}, requiredField("days")
	}
	if len(in.Days) > maxHolidayDays {
		return Holiday{}, invalidField("days", fmt.Sprintf("at most %d days in one holiday", maxHolidayDays))
	}
	want := map[Date]float64{}
	for _, d := range in.Days {
		if d.Day.IsZero() {
			return Holiday{}, requiredField("days")
		}
		if _, dup := want[d.Day]; dup {
			return Holiday{}, invalidField("days", fmt.Sprintf("%s is listed twice", d.Day))
		}
		hours := d.Hours
		if hours == 0 {
			hours = HolidayHours
		}
		if hours < 0 || hours > 24 {
			return Holiday{}, invalidField("days", "hours must be more than 0 and at most 24")
		}
		want[d.Day] = hours
	}

	var out Holiday
	err := s.tx(ctx, "", func(tx querier) error {
		before := Holiday{}
		if id == uuid.Nil {
			id = newID()
			if _, err := tx.Exec(ctx, `INSERT INTO holidays (id, workspace_id, name) VALUES ($1, $W, $2)`, id, name); err != nil {
				return fmt.Errorf("add holiday: %w", err)
			}
		} else {
			list, err := holidays(ctx, tx, id)
			if err != nil {
				return err
			}
			if len(list) == 0 {
				return notFound("holiday")
			}
			before = list[0]
			if _, err := tx.Exec(ctx, `UPDATE holidays SET name = $2, updated_at = now() WHERE id = $1 AND workspace_id = $W`, id, name); err != nil {
				return fmt.Errorf("change holiday: %w", err)
			}
		}
		// The days whose pay changes: added, removed, or paying other hours.
		had := map[Date]float64{}
		for _, d := range before.Days {
			had[d.Day] = d.Hours
		}
		var changed []Date
		for d, h := range want {
			if had[d] != h {
				changed = append(changed, d)
			}
		}
		for d := range had {
			if _, kept := want[d]; !kept {
				changed = append(changed, d)
			}
		}
		sort.Slice(changed, func(i, j int) bool { return changed[i].Before(changed[j]) })
		for _, d := range changed {
			if err := holidayLocked(ctx, tx, d); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM holiday_days WHERE holiday_id = $1 AND workspace_id = $W`, id); err != nil {
			return fmt.Errorf("change holiday: %w", err)
		}
		for d, h := range want {
			_, err := tx.Exec(ctx, `INSERT INTO holiday_days (workspace_id, holiday_id, day, hours) VALUES ($W, $1, $2, $3)`, id, d.Time(), h)
			if isUniqueViolation(err) {
				return ErrHolidayTaken.Newf("another holiday is on %s", d)
			}
			if err != nil {
				return fmt.Errorf("change holiday: %w", err)
			}
		}
		list, err := holidays(ctx, tx, id)
		if err != nil {
			return err
		}
		out = list[0]
		action := "holiday.update"
		if before.ID == uuid.Nil {
			action = "holiday.create"
		}
		return audit(ctx, tx, actor, action, "", map[string]any{"before": before, "after": out})
	})
	return out, err
}

// DeleteHoliday removes a holiday whose days are outside settled timesheets.
func (s *Service) DeleteHoliday(ctx context.Context, actor Actor, id uuid.UUID) error {
	if !actor.Admin {
		return forbidden("only an admin changes holidays")
	}
	return s.tx(ctx, "", func(tx querier) error {
		list, err := holidays(ctx, tx, id)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			return notFound("holiday")
		}
		for _, d := range list[0].Days {
			if err := holidayLocked(ctx, tx, d.Day); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM holidays WHERE id = $1 AND workspace_id = $W`, id); err != nil {
			return fmt.Errorf("delete holiday: %w", err)
		}
		return audit(ctx, tx, actor, "holiday.delete", "", list[0])
	})
}
