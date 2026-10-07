package main

import (
	"context"
	"fmt"
	"os"
	"sync"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/giraffesyo/timeclock"
	"github.com/giraffesyo/timeclock/host"
)

// e2eCalendar and e2eOAuth are the browser tests'; production builds have neither.
var (
	e2eCalendar func(context.Context, host.Person) (oauth2.TokenSource, bool, error)
	e2eOAuth    func(publicURL string) *timeclock.GoogleOAuth
)

// googleOAuth lets each person connect their own calendar, where
// googleCalendar has none for them, through the Google OAuth client in
// EXAMPLE_GOOGLE_CLIENT_ID and EXAMPLE_GOOGLE_CLIENT_SECRET. Its authorized
// redirect URI is the portal's address, then
// /timeclock/api/v1/calendar/google/callback.
func googleOAuth(publicURL string) *timeclock.GoogleOAuth {
	if e2eOAuth != nil {
		return e2eOAuth(publicURL)
	}
	id := os.Getenv("EXAMPLE_GOOGLE_CLIENT_ID")
	if id == "" {
		return nil
	}
	return &timeclock.GoogleOAuth{
		ClientID: id, ClientSecret: os.Getenv("EXAMPLE_GOOGLE_CLIENT_SECRET"),
		RedirectURL: publicURL + "/timeclock/api/v1/calendar/google/callback",
	}
}

// googleCalendar reads everyone's Google Calendar as a Google Workspace
// service account with domain-wide delegation: a Workspace admin allows the
// account's client ID the calendar scope, and Google lets it act as each
// person by their email. keyFile is the account's JSON key; without one,
// Timeclock shows no calendar.
func googleCalendar(keyFile string) (func(context.Context, host.Person) (oauth2.TokenSource, bool, error), error) {
	if keyFile == "" {
		return e2eCalendar, nil
	}
	key, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("read the Google key: %w", err)
	}
	if _, err := google.JWTConfigFromJSON(key, timeclock.GoogleCalendarScope); err != nil {
		return nil, fmt.Errorf("read the Google key: %w", err)
	}
	var sources sync.Map // email → oauth2.TokenSource, so a token lasts its hour
	return func(_ context.Context, p host.Person) (oauth2.TokenSource, bool, error) {
		if p.Email == "" {
			return nil, false, nil
		}
		if ts, ok := sources.Load(p.Email); ok {
			return ts.(oauth2.TokenSource), true, nil
		}
		cfg, err := google.JWTConfigFromJSON(key, timeclock.GoogleCalendarScope)
		if err != nil {
			return nil, false, err
		}
		cfg.Subject = p.Email
		// Not the request's context: the source outlives it.
		ts, _ := sources.LoadOrStore(p.Email, cfg.TokenSource(context.Background()))
		return ts.(oauth2.TokenSource), true, nil
	}, nil
}
