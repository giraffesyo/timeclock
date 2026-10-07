//go:build e2e

package main

// Compiled only into the browser-test host: everyone has a calendar, and
// Google is the fake one in web/e2e/services.mjs.
import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"

	"golang.org/x/oauth2"

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
	e2eCalendar = func(_ context.Context, p host.Person) (oauth2.TokenSource, bool, error) {
		return oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "e2e:" + p.Email}), p.Email != "", nil
	}
}
