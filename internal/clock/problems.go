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
		Title:  "Time off already recorded",
		Doc:    "The person already has time off of this kind on one of these days.",
	})
	ErrLocked = Problems.Define(problem.Type{
		Code:   "period_locked",
		Status: http.StatusConflict,
		Title:  "Timesheet already submitted",
		Doc:    "The day is in a timesheet that was submitted or approved, so its time can't change. A manager or admin can send the timesheet back.",
	})
	ErrDescriptionRequired = Problems.Define(problem.Type{
		Code:   "description_required",
		Status: http.StatusUnprocessableEntity,
		Title:  "Description required",
		Doc:    "This workspace requires a nonblank description on every time entry.",
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
	ErrDoesNotSubmit = Problems.Define(problem.Type{
		Code:   "does_not_submit_timesheets",
		Status: http.StatusConflict,
		Title:  "Doesn't submit timesheets",
		Doc:    "This person's time is for reports only: they don't submit timesheets, and aren't in payroll. An admin can change that in Settings.",
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

// What a standalone server's sign-in refuses.
var (
	ErrInvalidCredentials = Problems.Define(problem.Type{
		Code:   "invalid_credentials",
		Status: http.StatusUnauthorized,
		Title:  "Wrong email or password",
		Doc:    "The email and password don't match an account. The answer is the same whether or not the email is known.",
	})
	ErrTooManyAttempts = Problems.Define(problem.Type{
		Code:   "too_many_attempts",
		Status: http.StatusTooManyRequests,
		Title:  "Too many attempts",
		Doc:    "Sign-in for this account or from this address is paused after repeated failures. Retry-After says for how long.",
	})
	ErrWeakPassword = Problems.Define(problem.Type{
		Code:   "weak_password",
		Status: http.StatusUnprocessableEntity,
		Title:  "Password too short",
		Doc:    "A password is at least 10 characters and at most 128. There are no other rules about what it contains.",
	})
	ErrBreachedPassword = Problems.Define(problem.Type{
		Code:   "breached_password",
		Status: http.StatusUnprocessableEntity,
		Title:  "Password is known from a breach",
		Doc:    "The password appears in a public list of passwords from data breaches, so it is easy to guess.",
	})
	ErrLinkExpired = Problems.Define(problem.Type{
		Code:   "link_expired",
		Status: http.StatusGone,
		Title:  "Link no longer works",
		Doc:    "An invitation or password-reset link was already used, was withdrawn, or is too old.",
	})
	ErrInvalidCode = Problems.Define(problem.Type{
		Code:   "invalid_code",
		Status: http.StatusUnauthorized,
		Title:  "Wrong code",
		Doc:    "The authenticator or recovery code isn't right, or was already used.",
	})
	ErrPasskeyRefused = Problems.Define(problem.Type{
		Code:   "passkey_refused",
		Status: http.StatusUnauthorized,
		Title:  "Passkey not accepted",
		Doc:    "The passkey isn't one this server knows, or its answer didn't verify.",
	})
	ErrSSORequired = Problems.Define(problem.Type{
		Code:   "sso_required",
		Status: http.StatusForbidden,
		Title:  "Single sign-on required",
		Doc:    "The workspace can only be entered by signing in through its identity provider.",
	})
	ErrNotAMember = Problems.Define(problem.Type{
		Code:   "not_a_member",
		Status: http.StatusForbidden,
		Title:  "Not in this workspace",
		Doc:    "The account doesn't belong to the workspace it asked for.",
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
