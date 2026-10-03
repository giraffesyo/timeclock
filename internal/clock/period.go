package clock

import "time"

// PayCycle is how often payroll runs.
type PayCycle string

// The pay cycles.
const (
	Weekly      PayCycle = "weekly"
	Biweekly    PayCycle = "biweekly"
	Semimonthly PayCycle = "semimonthly" // the 1st–15th and the 16th–end
	Monthly     PayCycle = "monthly"
)

// Period is a pay period: both days are in it.
type Period struct {
	Start Date `json:"start" format:"date"`
	End   Date `json:"end" format:"date"`
}

// Contains reports whether d is in the period.
func (p Period) Contains(d Date) bool { return !d.Before(p.Start) && !d.After(p.End) }

// Days lists the period's days in order.
func (p Period) Days() []Date {
	var days []Date
	for d := p.Start; !d.After(p.End); d = d.AddDays(1) {
		days = append(days, d)
	}
	return days
}

// PeriodContaining returns the pay period d falls in. anchor is the first
// day of some weekly or biweekly period; the other cycles follow the calendar.
func PeriodContaining(cycle PayCycle, anchor, d Date) Period {
	switch cycle {
	case Weekly, Biweekly:
		n := 7
		if cycle == Biweekly {
			n = 14
		}
		days := d.DaysSince(anchor)
		k := days / n
		if days%n < 0 {
			k-- // floor, for days before the anchor
		}
		start := anchor.AddDays(k * n)
		return Period{Start: start, End: start.AddDays(n - 1)}
	case Semimonthly:
		y, m, day := d.t.Date()
		if day <= 15 {
			return Period{Start: NewDate(y, m, 1), End: NewDate(y, m, 15)}
		}
		return Period{Start: NewDate(y, m, 16), End: lastOfMonth(y, m)}
	default: // Monthly
		y, m, _ := d.t.Date()
		return Period{Start: NewDate(y, m, 1), End: lastOfMonth(y, m)}
	}
}

// PeriodBefore returns the pay period that ends the day before p starts.
func PeriodBefore(cycle PayCycle, anchor Date, p Period) Period {
	return PeriodContaining(cycle, anchor, p.Start.AddDays(-1))
}

// PeriodAfter returns the pay period that starts the day after p ends.
func PeriodAfter(cycle PayCycle, anchor Date, p Period) Period {
	return PeriodContaining(cycle, anchor, p.End.AddDays(1))
}

func lastOfMonth(y int, m time.Month) Date {
	return NewDate(y, m+1, 1).AddDays(-1)
}

// WeekStart returns the first day of the workweek d falls in.
func WeekStart(d Date, first time.Weekday) Date {
	back := (int(d.Weekday()) - int(first) + 7) % 7
	return d.AddDays(-back)
}
