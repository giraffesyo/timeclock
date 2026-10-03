// Package host defines what a platform embedding Timeclock tells it about
// its people and, optionally, how to reach them. The platform implements
// [Directory], and [Notifier] to deliver reminders itself.
package host

import (
	"context"
	"errors"
)

// ErrNotFound is returned for an unknown person.
var ErrNotFound = errors.New("not found")

// Person is one of the platform's users.
type Person struct {
	// ID identifies the person for good; Timeclock keys their time on it.
	ID    string
	Name  string
	Email string
	// Admin runs payroll: they see everyone's time, approve anything, change
	// settings and export reports.
	Admin bool
	// ManagerID is the person who approves this person's timesheets and time
	// off, when the platform knows. An admin can set it in Timeclock instead,
	// which takes precedence.
	ManagerID string
}

// Directory answers Timeclock's questions about the platform's people.
// Every request looks up its caller, so Person should be cheap.
type Directory interface {
	Person(ctx context.Context, id string) (Person, error)
	// People lists everyone who tracks time.
	People(ctx context.Context) ([]Person, error)
}

// Notification is a reminder for one person.
type Notification struct {
	// Kind names what it is about, such as "clock_running" or
	// "timesheet_due", so a platform can group or mute them.
	Kind  string
	Title string
	Body  string
	// Path is where in Timeclock it leads, relative to the base path.
	Path string
}

// Notifier delivers reminders through the platform's own notifications.
// Without one, Timeclock only shows them in its web app.
type Notifier interface {
	Notify(ctx context.Context, personID string, n Notification) error
}
