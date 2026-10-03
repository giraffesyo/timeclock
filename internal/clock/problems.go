package clock

import (
	"net/http"

	"github.com/parallelworks/foundation/problem"
)

// Problems are Timeclock's problem types, documented at /problems/. Codes
// are API contract, keyed in the web app's catalog under apiErrors: never
// rename one.
var Problems = problem.NewRegistry("timeclock")

// The failures a status alone doesn't describe.
var (
	ErrClockRunning = Problems.Define(problem.Type{
		Code:   "clock_running",
		Status: http.StatusConflict,
		Title:  "Clock already running",
		Doc:    "The person is already clocked in. Clock out before clocking in again.",
	})
	ErrClockNotRunning = Problems.Define(problem.Type{
		Code:   "clock_not_running",
		Status: http.StatusConflict,
		Title:  "Clock not running",
		Doc:    "The person isn't clocked in, so there is nothing to stop.",
	})
	ErrOverlap = Problems.Define(problem.Type{
		Code:   "entry_overlaps",
		Status: http.StatusConflict,
		Title:  "Time overlaps another entry",
		Doc:    "The person already has time recorded in part of this stretch. Two entries can't cover the same minutes.",
	})
	ErrLocked = Problems.Define(problem.Type{
		Code:   "period_locked",
		Status: http.StatusConflict,
		Title:  "Timesheet already submitted",
		Doc:    "The day is in a timesheet that was submitted or approved, so its time can't change. A manager or admin can send the timesheet back.",
	})
	ErrProjectRequired = Problems.Define(problem.Type{
		Code:   "project_required",
		Status: http.StatusUnprocessableEntity,
		Title:  "Project required",
		Doc:    "This organization requires every time entry to name a project.",
	})
	ErrProjectArchived = Problems.Define(problem.Type{
		Code:   "project_archived",
		Status: http.StatusConflict,
		Title:  "Project archived",
		Doc:    "The project is archived, so no new time can be recorded on it.",
	})
	ErrFuture = Problems.Define(problem.Type{
		Code:   "in_the_future",
		Status: http.StatusUnprocessableEntity,
		Title:  "Time in the future",
		Doc:    "Worked time can't end in the future.",
	})
	ErrPeriodOpen = Problems.Define(problem.Type{
		Code:   "clock_still_running",
		Status: http.StatusConflict,
		Title:  "Clock still running",
		Doc:    "A timesheet can't be submitted while the person is clocked in during its pay period. Clock out first.",
	})
	ErrAlreadySubmitted = Problems.Define(problem.Type{
		Code:   "already_submitted",
		Status: http.StatusConflict,
		Title:  "Timesheet already submitted",
		Doc:    "The timesheet for this pay period was already submitted.",
	})
	ErrNotSubmitted = Problems.Define(problem.Type{
		Code:   "not_awaiting_decision",
		Status: http.StatusConflict,
		Title:  "Nothing to decide",
		Doc:    "It isn't waiting for a decision: it was never submitted, or someone already decided it.",
	})
	ErrOwnApproval = Problems.Define(problem.Type{
		Code:   "own_approval",
		Status: http.StatusForbidden,
		Title:  "Can't approve your own time",
		Doc:    "A manager can't approve their own timesheet or time off. Their manager or an admin does.",
	})
	ErrInUse = Problems.Define(problem.Type{
		Code:   "in_use",
		Status: http.StatusConflict,
		Title:  "Still in use",
		Doc:    "A customer with projects, or a project with time recorded on it, can't be deleted. Archive it instead.",
	})
	ErrNameTaken = Problems.Define(problem.Type{
		Code:   "name_taken",
		Status: http.StatusConflict,
		Title:  "Name already used",
		Doc:    "Another one already has this name.",
	})
	ErrManagerLoop = Problems.Define(problem.Type{
		Code:   "manager_loop",
		Status: http.StatusUnprocessableEntity,
		Title:  "Manager chain loops",
		Doc:    "A person can't be their own manager, directly or through the people they manage.",
	})
)

func notFound(what string) *problem.Problem {
	return problem.Status(http.StatusNotFound, what+" not found")
}

func forbidden(detail string) *problem.Problem {
	return problem.Status(http.StatusForbidden, detail).AsDenial()
}

// invalidField is a validation problem for one field of the request body.
func invalidField(field, detail string) *problem.Problem {
	return problem.ValidationFailed(problem.Invalid.At(problem.Pointer(field), detail))
}

func requiredField(field string) *problem.Problem {
	return problem.ValidationFailed(problem.Required.At(problem.Pointer(field), "required"))
}
