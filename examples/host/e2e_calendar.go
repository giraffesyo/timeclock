//go:build e2e

package main

// Compiled only into the browser-test host, whose Google is the fake one in
// web/e2e/google.mjs.
import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"

	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock"
	"github.com/giraffesyo/timeclock/host"
)

type e2eGoogleTransport struct{ next http.RoundTripper }

func (t e2eGoogleTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Hostname() != "www.googleapis.com" {
		return t.next.RoundTrip(r)
	}
	base, err := url.Parse(os.Getenv("E2E_SERVICES_URL"))
	if err != nil || base.Scheme != "http" || base.Hostname() != "localhost" {
		return nil, errors.New("e2e refuses to contact real Google")
	}
	clone := r.Clone(r.Context())
	clone.URL.Scheme, clone.URL.Host = base.Scheme, base.Host
	clone.URL.Path = "/google" + r.URL.Path
	clone.Host = base.Host
	return t.next.RoundTrip(clone)
}

func init() {
	http.DefaultTransport = e2eGoogleTransport{next: http.DefaultTransport}
	// The host reads the calendars of its own domain's people; everyone else
	// connects theirs.
	e2eCalendar = func(_ context.Context, p host.Person) (oauth2.TokenSource, bool, error) {
		if !strings.HasSuffix(p.Email, "@host.test") {
			return nil, false, nil
		}
		return oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "e2e:" + p.Email}), true, nil
	}
	e2eOAuth = func(publicURL string) *timeclock.GoogleOAuth {
		google := os.Getenv("E2E_SERVICES_URL") + "/google"
		return &timeclock.GoogleOAuth{
			ClientID: "timeclock-e2e", ClientSecret: "the fake Google’s secret",
			RedirectURL: publicURL + "/timeclock/api/v1/calendar/google/callback",
			Endpoint:    oauth2.Endpoint{AuthURL: google + "/auth", TokenURL: google + "/token", AuthStyle: oauth2.AuthStyleInParams},
			RevokeURL:   google + "/revoke",
		}
	}
}
