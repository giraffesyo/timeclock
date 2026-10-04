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

// ThemeSeed is the few values a whole color scheme is derived from.
type ThemeSeed struct {
	// Accent is the color of what stands out, such as "#4b50d9".
	Accent string `json:"accent" example:"#4b50d9"`
	// Background is the color everything sits on, such as "#ffffff".
	Background string `json:"background" example:"#ffffff"`
	// Contrast is how far text and borders sit from the background: 1 is
	// normal, and 0.5 to 1.5 the range. Zero means 1.
	Contrast float64 `json:"contrast,omitempty"`
}

// Scheme is a look in one mode: the page's seed, and the sidebar's when it
// has a look of its own.
type Scheme struct {
	Interface ThemeSeed  `json:"interface"`
	Sidebar   *ThemeSeed `json:"sidebar,omitempty"`
}

// Theme is a look for light and for dark. A nil scheme leaves that mode to
// whatever comes next: the host's theme under a workspace's, and Timeclock's
// own under the host's.
type Theme struct {
	Light *Scheme `json:"light,omitempty"`
	Dark  *Scheme `json:"dark,omitempty"`
}

type workspaceKey struct{}

// WithWorkspace returns ctx carrying the key of the workspace a request is
// in. Timeclock sets it before asking the Directory anything.
func WithWorkspace(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, workspaceKey{}, key)
}

// Workspace is the key of the workspace a request is in, for a Directory
// whose answers depend on it, such as who is an admin where.
func Workspace(ctx context.Context) string {
	key, _ := ctx.Value(workspaceKey{}).(string)
	return key
}

// Message is an email for one person.
type Message struct {
	To      string
	Subject string
	// Text is the body, in plain text.
	Text string
}

// Mailer sends email: SMTP on a standalone server, or whatever the host has.
type Mailer interface {
	Send(ctx context.Context, m Message) error
}
