//go:build e2e

package main

// Compiled only into the browser-test server. Production binaries have no
// endpoint override and always send Toggl requests to the official host.
import (
	"errors"
	"net/http"
	"net/url"
	"os"
)

type e2eTogglTransport struct{ next http.RoundTripper }

func (t e2eTogglTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Hostname() != "api.track.toggl.com" {
		return t.next.RoundTrip(r)
	}
	base, err := url.Parse(os.Getenv("E2E_SERVICES_URL"))
	if err != nil || base.Scheme != "http" || base.Hostname() != "localhost" {
		return nil, errors.New("e2e refuses to contact real Toggl")
	}
	clone := r.Clone(r.Context())
	clone.URL.Scheme, clone.URL.Host = base.Scheme, base.Host
	clone.URL.Path = "/toggl" + r.URL.Path
	clone.Host = base.Host
	return t.next.RoundTrip(clone)
}

func init() { http.DefaultTransport = e2eTogglTransport{next: http.DefaultTransport} }
