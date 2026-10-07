// Package gcal reads the events on a person's Google Calendar, for the week
// to suggest time from.
package gcal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// BaseURL is the Google Calendar API.
const BaseURL = "https://www.googleapis.com/calendar/v3"

// Scope is the one OAuth scope the client needs.
const Scope = "https://www.googleapis.com/auth/calendar.events.readonly"

// Client reads one person's calendars. HTTP carries their credentials, as
// oauth2.NewClient's does.
type Client struct {
	HTTP    *http.Client
	BaseURL string
}

// Event is a timed event someone is going to, or went to.
type Event struct {
	ID string
	// SeriesID is the recurring event this is one occurrence of; empty for
	// a one-off.
	SeriesID string
	Title    string
	// Link opens the event in Google Calendar.
	Link  string
	Start time.Time
	End   time.Time
}

// Calendar is a calendar's events over a span of time.
type Calendar struct {
	// Name is what Google calls the calendar: for a primary one, its owner's
	// email address.
	Name   string
	Events []Event
}

// Error keeps only Google's reason codes from a response, such as
// "accessNotConfigured" for an API not enabled in the project: the rest of
// a body can contain private data.
type Error struct {
	Status  int
	Reasons []string
}

func (e *Error) Error() string {
	var msg string
	switch e.Status {
	case http.StatusUnauthorized, http.StatusForbidden:
		msg = "Google Calendar denied access"
	case http.StatusNotFound:
		msg = "Google Calendar has no such calendar"
	default:
		msg = fmt.Sprintf("Google Calendar returned HTTP %d", e.Status)
	}
	if len(e.Reasons) > 0 {
		msg += " (" + strings.Join(e.Reasons, ", ") + ")"
	}
	return msg
}

// notCode is a character no reason code has.
func notCode(c rune) bool {
	return c != '_' && (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9')
}

// reasons reads the reason codes from a Google API error body.
func reasons(body io.Reader) []string {
	var out struct {
		Error struct {
			Status string `json:"status"`
			Errors []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
			Details []struct {
				Reason string `json:"reason"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(body, 64<<10)).Decode(&out) != nil {
		return nil
	}
	var list []string
	seen := map[string]bool{}
	add := func(r string) {
		// A code, not prose: letters, digits and underscores only.
		if r == "" || seen[r] || len(r) > 64 || strings.IndexFunc(r, notCode) >= 0 {
			return
		}
		seen[r] = true
		list = append(list, r)
	}
	for _, e := range out.Error.Errors {
		add(e.Reason)
	}
	for _, d := range out.Error.Details {
		add(d.Reason)
	}
	if len(list) == 0 {
		add(out.Error.Status)
	}
	return list
}

// Denied reports whether Google refused the credentials.
func Denied(err error) bool {
	var e *Error
	return errors.As(err, &e) && (e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden)
}

type eventTime struct {
	DateTime time.Time `json:"dateTime"`
	// Date is set instead of DateTime for an all-day event.
	Date string `json:"date"`
}

type eventsPage struct {
	Summary string `json:"summary"`
	Items   []struct {
		ID           string    `json:"id"`
		Recurring    string    `json:"recurringEventId"`
		Status       string    `json:"status"`
		Summary      string    `json:"summary"`
		HTMLLink     string    `json:"htmlLink"`
		Start        eventTime `json:"start"`
		End          eventTime `json:"end"`
		Transparency string    `json:"transparency"`
		Attendees    []struct {
			Self           bool   `json:"self"`
			ResponseStatus string `json:"responseStatus"`
		} `json:"attendees"`
	} `json:"items"`
	NextPageToken string `json:"nextPageToken"`
}

// Events lists the primary calendar's timed events that overlap [from, to),
// each occurrence of a recurring one on its own, by start. All-day events,
// cancelled ones and those the person declined are left out: none is time
// anyone worked.
func (c *Client) Events(ctx context.Context, from, to time.Time) (Calendar, error) {
	var out Calendar
	token := ""
	for range 20 { // 5,000 events: more than any week holds
		q := url.Values{
			"timeMin":      {from.UTC().Format(time.RFC3339)},
			"timeMax":      {to.UTC().Format(time.RFC3339)},
			"singleEvents": {"true"},
			"orderBy":      {"startTime"},
			"maxResults":   {"250"},
			// Meetings, focus time and what Gmail added; not working locations,
			// out of office or birthdays.
			"eventTypes": {"default", "focusTime", "fromGmail"},
			"fields":     {"summary,nextPageToken,items(id,recurringEventId,status,summary,htmlLink,start,end,transparency,attendees(self,responseStatus))"},
		}
		if token != "" {
			q.Set("pageToken", token)
		}
		var page eventsPage
		if err := c.get(ctx, "/calendars/primary/events?"+q.Encode(), &page); err != nil {
			return out, err
		}
		out.Name = page.Summary
		for _, it := range page.Items {
			if it.Status == "cancelled" || it.Start.DateTime.IsZero() || it.End.DateTime.IsZero() {
				continue
			}
			declined := false
			for _, a := range it.Attendees {
				declined = declined || (a.Self && a.ResponseStatus == "declined")
			}
			if declined || !it.End.DateTime.After(it.Start.DateTime) {
				continue
			}
			out.Events = append(out.Events, Event{
				ID: it.ID, SeriesID: it.Recurring, Title: it.Summary, Link: it.HTMLLink, Start: it.Start.DateTime, End: it.End.DateTime,
			})
		}
		if page.NextPageToken == "" {
			return out, nil
		}
		token = page.NextPageToken
	}
	return out, errors.New("google calendar returned too many pages of events")
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	base := c.BaseURL
	if base == "" {
		base = BaseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Timeclock")
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("google calendar could not be reached: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &Error{Status: resp.StatusCode, Reasons: reasons(resp.Body)}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out); err != nil {
		return errors.New("google calendar returned an unreadable response")
	}
	return nil
}
