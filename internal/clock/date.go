// Package clock is Timeclock's payroll logic and storage: pay periods, time
// entries, time off, timesheets, approvals, exceptions and reports.
package clock

import (
	"fmt"
	"time"
)

// Date is a calendar day, with no time or zone, written YYYY-MM-DD.
type Date struct{ t time.Time }

const dateLayout = "2006-01-02"

// NewDate returns the given calendar day.
func NewDate(year int, month time.Month, day int) Date {
	return Date{time.Date(year, month, day, 0, 0, 0, 0, time.UTC)}
}

// ParseDate reads a YYYY-MM-DD date.
func ParseDate(s string) (Date, error) {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return Date{}, fmt.Errorf("date %q is not YYYY-MM-DD", s)
	}
	return Date{t}, nil
}

// DateOf is the calendar day t falls on in loc.
func DateOf(t time.Time, loc *time.Location) Date {
	y, m, d := t.In(loc).Date()
	return NewDate(y, m, d)
}

// DateFromTime is the calendar day of a time read from a DATE column.
func DateFromTime(t time.Time) Date {
	y, m, d := t.Date()
	return NewDate(y, m, d)
}

func (d Date) String() string { return d.t.Format(dateLayout) }

// IsZero reports whether d is unset.
func (d Date) IsZero() bool { return d.t.IsZero() }

// Time is midnight UTC on d, as a DATE parameter wants it.
func (d Date) Time() time.Time { return d.t }

// In is the instant d starts in loc.
func (d Date) In(loc *time.Location) time.Time {
	y, m, day := d.t.Date()
	return time.Date(y, m, day, 0, 0, 0, 0, loc)
}

// AddDays returns the day n days after d.
func (d Date) AddDays(n int) Date { return Date{d.t.AddDate(0, 0, n)} }

// DaysSince is the number of days from o to d.
func (d Date) DaysSince(o Date) int { return int(d.t.Sub(o.t).Hours() / 24) }

func (d Date) Before(o Date) bool { return d.t.Before(o.t) }
func (d Date) After(o Date) bool  { return d.t.After(o.t) }

// Weekday is the day of the week.
func (d Date) Weekday() time.Weekday { return d.t.Weekday() }

// MarshalText writes YYYY-MM-DD.
func (d Date) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

// UnmarshalText reads YYYY-MM-DD.
func (d *Date) UnmarshalText(b []byte) error {
	parsed, err := ParseDate(string(b))
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}
