package clock

import (
	"time"

	"github.com/google/uuid"
)

// Settings is how the organization runs payroll.
type Settings struct {
	Timezone            string   `json:"timezone" doc:"IANA time zone that days and workweeks are cut in for everyone who hasn't set their own." example:"America/Chicago"`
	PayCycle            PayCycle `json:"payCycle" enum:"weekly,biweekly,semimonthly,monthly"`
	CycleAnchor         Date     `json:"cycleAnchor" format:"date" doc:"The first day of some weekly or biweekly pay period."`
	WeekStart           int      `json:"weekStart" minimum:"0" maximum:"6" doc:"The day the workweek starts, for overtime: 0 is Sunday."`
	OvertimeWeeklyHours float64  `json:"overtimeWeeklyHours" minimum:"0" maximum:"168" doc:"Hours in a workweek beyond which time is overtime. 0 turns overtime off."`
	ApproveTimesheets   bool     `json:"approveTimesheets" doc:"A submitted timesheet waits for the person's manager or an admin."`
	ApproveTimeOff      bool     `json:"approveTimeOff" doc:"Time off waits for the person's manager or an admin."`
	RequireDescription  bool     `json:"requireDescription" doc:"Every time entry has a description."`
	RequireProject      bool     `json:"requireProject" doc:"Every time entry names a project."`
	LongEntryHours      float64  `json:"longEntryHours" exclusiveMinimum:"0" maximum:"24" doc:"An entry or a running clock longer than this is an exception."`
}

// Location is the settings' time zone.
func (s Settings) Location() *time.Location {
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// LocationOf is the time zone a person's days and workweeks are cut in:
// their own, or the organization's when they have none.
func (s Settings) LocationOf(p Person) *time.Location {
	if p.Timezone != "" {
		if loc, err := time.LoadLocation(p.Timezone); err == nil {
			return loc
		}
	}
	return s.Location()
}

// Overtime is the settings' overtime rule for a person.
func (s Settings) Overtime(exempt bool) OvertimeRule {
	rule := OvertimeRule{WeekStart: time.Weekday(s.WeekStart)}
	if !exempt {
		rule.Weekly = time.Duration(s.OvertimeWeeklyHours * float64(time.Hour))
	}
	return rule
}

// PeriodOf is the pay period a day falls in.
func (s Settings) PeriodOf(d Date) Period { return PeriodContaining(s.PayCycle, s.CycleAnchor, d) }

// Person is someone who tracks time.
type Person struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Email          string `json:"email"`
	Timezone       string `json:"timezone" doc:"The IANA time zone their days and workweeks are cut in; empty uses the organization's." example:"America/Los_Angeles"`
	ManagerID      string `json:"managerId" doc:"Who approves this person's time; empty when no one is assigned."`
	OvertimeExempt bool   `json:"overtimeExempt"`
	PayrollID      string `json:"payrollId" doc:"The person's id in the payroll system, for the export."`
	Active         bool   `json:"active"`
}

// Actor is the person making a request.
type Actor struct {
	Person
	// AvatarURL comes fresh from the host directory, rather than payroll storage.
	AvatarURL string
	// Admin runs payroll.
	Admin bool
}

// Customer is who work is done for.
type Customer struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Archived bool      `json:"archived"`
}

// Project is a body of work that time is tagged with: for a customer, or
// internal when it has none.
type Project struct {
	ID           uuid.UUID  `json:"id"`
	CustomerID   *uuid.UUID `json:"customerId,omitempty" doc:"Absent for internal work."`
	CustomerName string     `json:"customerName" doc:"Empty for internal work."`
	Name         string     `json:"name"`
	Code         string     `json:"code" doc:"A charge code or contract number."`
	Billable     bool       `json:"billable"`
	Archived     bool       `json:"archived" doc:"The project itself is archived."`
	// CustomerArchived means the project takes no new time either way.
	CustomerArchived bool `json:"customerArchived"`
}

// Entry is a stretch of work.
type Entry struct {
	ID        uuid.UUID  `json:"id"`
	PersonID  string     `json:"personId"`
	ProjectID *uuid.UUID `json:"projectId,omitempty"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty" doc:"Absent while the clock is running."`
	Note      string     `json:"note"`
	Source    string     `json:"source" enum:"clock,manual,toggl"`
	Locked    bool       `json:"locked" doc:"In a submitted or approved timesheet, so it can't change."`
}

// The kinds of time off.
const (
	Vacation = "vacation"
	Sick     = "sick"
)

// The states of time off and timesheets.
const (
	StatusPending   = "pending"
	StatusSubmitted = "submitted"
	StatusApproved  = "approved"
	StatusRejected  = "rejected"
)

// TimeOff is vacation or sick hours on one day.
type TimeOff struct {
	ID            uuid.UUID  `json:"id"`
	PersonID      string     `json:"personId"`
	Kind          string     `json:"kind" enum:"vacation,sick"`
	Day           Date       `json:"day" format:"date"`
	Hours         float64    `json:"hours"`
	Note          string     `json:"note"`
	Status        string     `json:"status" enum:"pending,approved,rejected"`
	DecidedBy     string     `json:"decidedBy,omitempty"`
	DecidedByName string     `json:"decidedByName,omitempty"`
	DecidedAt     *time.Time `json:"decidedAt,omitempty"`
	DecisionNote  string     `json:"decisionNote,omitempty"`
	Locked        bool       `json:"locked" doc:"Its day is in a submitted or approved timesheet, so it can't be removed."`
}

// Timesheet is a person's statement that a pay period's time is complete.
type Timesheet struct {
	ID            uuid.UUID  `json:"id"`
	PersonID      string     `json:"personId"`
	Period        Period     `json:"period"`
	Status        string     `json:"status" enum:"submitted,approved,rejected"`
	SubmittedAt   time.Time  `json:"submittedAt"`
	DecidedBy     string     `json:"decidedBy,omitempty" doc:"Who approved it or sent it back; the person themselves when they took it back."`
	DecidedByName string     `json:"decidedByName,omitempty"`
	DecidedAt     *time.Time `json:"decidedAt,omitempty"`
	DecisionNote  string     `json:"decisionNote,omitempty"`
}

// DaySummary is one day of a person's pay period, in hours.
type DaySummary struct {
	Day      Date    `json:"day" format:"date"`
	Regular  float64 `json:"regular"`
	Overtime float64 `json:"overtime"`
	Vacation float64 `json:"vacation"`
	Sick     float64 `json:"sick"`
}

// PeriodSummary is a person's pay period: what payroll pays from.
type PeriodSummary struct {
	Person   Person       `json:"person"`
	Period   Period       `json:"period"`
	Days     []DaySummary `json:"days"`
	Regular  float64      `json:"regular"`
	Overtime float64      `json:"overtime"`
	Vacation float64      `json:"vacation" doc:"Approved vacation hours."`
	Sick     float64      `json:"sick" doc:"Approved sick hours."`
	// PendingTimeOff is hours of time off still waiting for a decision,
	// which are not in Vacation or Sick.
	PendingTimeOff float64    `json:"pendingTimeOff"`
	Running        bool       `json:"running" doc:"A clock is running; its time isn't counted until it stops."`
	Timesheet      *Timesheet `json:"timesheet,omitempty" doc:"Absent until the person submits."`
}

// The kinds of exception.
const (
	ExceptionClockRunning     = "clock_running"     // a clock has run past the long-entry limit
	ExceptionLongEntry        = "long_entry"        // an entry is longer than the limit
	ExceptionNotSubmitted     = "not_submitted"     // the period ended without a timesheet
	ExceptionAwaitingApproval = "awaiting_approval" // a timesheet for an ended period is undecided
	ExceptionRejected         = "rejected"          // a timesheet was sent back and not resubmitted
	ExceptionTimeOffPending   = "time_off_pending"  // time off in the period is undecided
	ExceptionOvertime         = "overtime"          // the person has overtime in the period
	ExceptionNoTime           = "no_time"           // the period ended with nothing recorded
)

// Exception is something in a pay period that payroll should look at before
// paying from it.
type Exception struct {
	Kind       string     `json:"kind" enum:"clock_running,long_entry,not_submitted,awaiting_approval,rejected,time_off_pending,overtime,no_time"`
	PersonID   string     `json:"personId"`
	PersonName string     `json:"personName"`
	Day        *Date      `json:"day,omitempty" format:"date"`
	EntryID    *uuid.UUID `json:"entryId,omitempty"`
	Hours      float64    `json:"hours,omitempty" doc:"The hours the exception is about: the entry's length, the overtime, or the pending time off."`
}

// Activity is what one person is doing now and how much they have tracked.
type Activity struct {
	Person  Person  `json:"person"`
	Running *Entry  `json:"running,omitempty" doc:"Their running clock."`
	Today   float64 `json:"today" doc:"Hours today, with the running clock up to now."`
	Week    float64 `json:"week" doc:"Hours this workweek, with the running clock up to now."`
}

// DayProjectHours is time on one project on one day, with a running clock
// counted up to now.
type DayProjectHours struct {
	Day       Date    `json:"day" format:"date"`
	ProjectID string  `json:"projectId" doc:"Empty for time with no project."`
	Hours     float64 `json:"hours"`
}

// ProjectHours is time on one project by one person, for the project report.
type ProjectHours struct {
	CustomerName string  `json:"customerName"`
	ProjectID    string  `json:"projectId" doc:"Empty for time with no project."`
	ProjectName  string  `json:"projectName"`
	ProjectCode  string  `json:"projectCode"`
	Billable     bool    `json:"billable"`
	PersonID     string  `json:"personId"`
	PersonName   string  `json:"personName"`
	Hours        float64 `json:"hours"`
}
