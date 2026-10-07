package clock

import (
	"math"
	"sort"
	"time"
)

// Span is a finished stretch of work.
type Span struct {
	Start, End time.Time
}

// minTime is the earlier of two times.
func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

// segment is the part of a span that falls on one calendar day.
type segment struct {
	day        Date
	start, end time.Time
}

// split cuts a span at each midnight in loc, so every hour counts toward
// the day, workweek and pay period it was worked in.
func split(s Span, loc *time.Location) []segment {
	var out []segment
	start := s.Start
	for start.Before(s.End) {
		day := DateOf(start, loc)
		next := day.AddDays(1).In(loc)
		end := s.End
		if next.Before(end) {
			end = next
		}
		out = append(out, segment{day: day, start: start, end: end})
		start = end
	}
	return out
}

// DayHours is one day's worked time.
type DayHours struct {
	Regular  time.Duration
	Overtime time.Duration
}

// Total is the day's regular and overtime together.
func (h DayHours) Total() time.Duration { return h.Regular + h.Overtime }

// OvertimeRule is how overtime is counted.
type OvertimeRule struct {
	// WeekStart is the day the workweek starts.
	WeekStart time.Weekday
	// Weekly is the time in one workweek beyond which work is overtime. Zero
	// means no overtime.
	Weekly time.Duration
}

// merged joins spans that overlap or touch, so time recorded twice over the
// same hours counts once: worked time is never more than the time that passed.
func merged(spans []Span) []Span {
	sorted := append([]Span(nil), spans...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start.Before(sorted[j].Start) })
	var out []Span
	for _, s := range sorted {
		if n := len(out); n > 0 && !s.Start.After(out[n-1].End) {
			if s.End.After(out[n-1].End) {
				out[n-1].End = s.End
			}
			continue
		}
		out = append(out, s)
	}
	return out
}

// HoursByDay adds up spans per calendar day in loc, counting overlapping
// spans once. Within each workweek,
// time beyond the weekly threshold is overtime, counted on the day it was
// worked, so a week that straddles two pay periods puts its overtime in the
// period the extra hours fell in. spans must include the whole of every
// workweek the caller reports on.
func HoursByDay(spans []Span, loc *time.Location, rule OvertimeRule) map[Date]DayHours {
	var segs []segment
	for _, s := range merged(spans) {
		segs = append(segs, split(s, loc)...)
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].start.Before(segs[j].start) })

	out := map[Date]DayHours{}
	worked := map[Date]time.Duration{} // per workweek, by its first day
	for _, seg := range segs {
		d := seg.end.Sub(seg.start)
		h := out[seg.day]
		if rule.Weekly <= 0 {
			h.Regular += d
			out[seg.day] = h
			continue
		}
		week := WeekStart(seg.day, rule.WeekStart)
		before := worked[week]
		worked[week] = before + d
		regular := max(min(d, rule.Weekly-before), 0)
		h.Regular += regular
		h.Overtime += d - regular
		out[seg.day] = h
	}
	return out
}

// Hours is a duration as decimal hours, to the hundredth, as payroll takes it.
func Hours(d time.Duration) float64 {
	return math.Round(d.Hours()*100) / 100
}
