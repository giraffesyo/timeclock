package timeclock_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/parallelworks/foundation/pgdb/pgdbtest"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock"
	"github.com/giraffesyo/timeclock/host"
)

// directory is a host's people, as a test knows them.
type directory map[string]host.Person

func (d directory) Person(_ context.Context, id string) (host.Person, error) {
	p, ok := d[id]
	if !ok {
		return host.Person{}, host.ErrNotFound
	}
	return p, nil
}

func (d directory) People(context.Context) ([]host.Person, error) {
	var out []host.Person
	for _, p := range d {
		out = append(out, p)
	}
	return out, nil
}

// mounted is a Timeclock as a host mounts it: under /timeclock, on the
// host's mux, with the caller named by a header standing in for a session.
func mounted(t *testing.T) http.Handler {
	t.Helper()
	return mountedWith(t, nil)
}

// mountedWith is mounted with options of the test's own on top.
func mountedWith(t *testing.T, also func(*timeclock.Options)) http.Handler {
	t.Helper()
	url, schema := pgdbtest.Schema(t, "TIMECLOCK_TEST_DATABASE_URL")
	opts := timeclock.Options{
		DatabaseURL: url,
		Schema:      schema,
		BasePath:    "/timeclock",
		Caller: func(r *http.Request) (string, bool) {
			id := r.Header.Get("X-Test-User")
			return id, id != ""
		},
		Workspace: func(r *http.Request) (string, bool) {
			key := r.Header.Get("X-Test-Workspace")
			return key, key != ""
		},
		Directory: directory{
			"pat": {ID: "pat", Name: "Pat Admin", Email: "pat@example.com", Admin: true},
			"ada": {ID: "ada", Name: "Ada Lovelace", Email: "ada@example.com", ManagerID: "pat", AvatarURL: "/avatars/ada.png"},
		},
		HomeURL:      "/",
		HomeLabel:    "Host",
		SignInURL:    "/login?next=",
		ImageSources: []string{"https://*.googleusercontent.com"},
		APIKeysURL:   "https://portal.example.com/settings/api-keys",
		Theme: host.Theme{
			Light: &host.Scheme{Interface: host.ThemeSeed{Accent: "#06354f", Background: "#f3f4f6"}},
			Dark:  &host.Scheme{Interface: host.ThemeSeed{Accent: "#2f81f7", Background: "#0d1117"}},
		},
	}
	if also != nil {
		also(&opts)
	}
	tc, err := timeclock.New(t.Context(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tc.Close)
	mux := http.NewServeMux()
	mux.Handle("/timeclock/", tc)
	return mux
}

func call(t *testing.T, h http.Handler, user, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequestWithContext(t.Context(), method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if user != "" {
		req.Header.Set("X-Test-User", user)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var decoded map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &decoded)
	return rec, decoded
}

func TestMountedInAHost(t *testing.T) {
	if os.Getenv("TIMECLOCK_TEST_DATABASE_URL") == "" {
		t.Skip("TIMECLOCK_TEST_DATABASE_URL not set")
	}
	h := mounted(t)
	const api = "/timeclock/api/v1"

	// Directory photos load from the host's image origin.
	if rec, _ := call(t, h, "ada", http.MethodGet, "/timeclock/", ""); !strings.Contains(rec.Header().Get("Content-Security-Policy"), "img-src 'self' data: https://*.googleusercontent.com;") {
		t.Fatalf("CSP = %q", rec.Header().Get("Content-Security-Policy"))
	}

	// Signed out: the API refuses with a problem, and says where to sign in.
	rec, _ := call(t, h, "", http.MethodGet, api+"/me", "")
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("signed-out /me: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	rec, body := call(t, h, "", http.MethodGet, api+"/info", "")
	if rec.Code != http.StatusOK || body["signInUrl"] != "/login?next=" || body["homeLabel"] != "Host" ||
		body["apiKeysUrl"] != "https://portal.example.com/settings/api-keys" {
		t.Fatalf("/info: %d %v", rec.Code, body)
	}
	// Someone the host doesn't know is signed out too.
	if rec, _ := call(t, h, "mallory", http.MethodGet, api+"/me", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unknown user /me: %d", rec.Code)
	}

	rec, body = call(t, h, "ada", http.MethodGet, api+"/me", "")
	if rec.Code != http.StatusOK || body["admin"] != false {
		t.Fatalf("ada /me: %d %v", rec.Code, body)
	}
	if person, _ := body["person"].(map[string]any); person["name"] != "Ada Lovelace" || person["managerId"] != "pat" {
		t.Fatalf("ada = %v", body["person"])
	}
	if body["avatarUrl"] != "/avatars/ada.png" {
		t.Fatalf("ada avatar = %v", body["avatarUrl"])
	}

	// Only the admin changes settings; a refusal is a 403 problem.
	settings, _ := json.Marshal(body["settings"])
	if rec, _ := call(t, h, "ada", http.MethodPut, api+"/settings", string(settings)); rec.Code != http.StatusForbidden {
		t.Fatalf("ada changing settings: %d", rec.Code)
	}
	relaxed := strings.Replace(string(settings), `"requireProject":true`, `"requireProject":false`, 1)
	if rec, _ := call(t, h, "pat", http.MethodPut, api+"/settings", relaxed); rec.Code != http.StatusOK {
		t.Fatalf("pat changing settings: %d %s", rec.Code, rec.Body)
	}

	// Clock in and out through the API.
	if rec, _ := call(t, h, "ada", http.MethodPost, api+"/clock/in", `{"note":"hello"}`); rec.Code != http.StatusOK {
		t.Fatalf("clock in: %d %s", rec.Code, rec.Body)
	}
	rec, body = call(t, h, "ada", http.MethodPost, api+"/clock/in", `{}`)
	if rec.Code != http.StatusConflict || body["code"] != "clock_running" || body["type"] != "/problems/timeclock/clock_running" {
		t.Fatalf("second clock in: %d %v", rec.Code, body)
	}
	if rec, _ := call(t, h, "ada", http.MethodPost, api+"/clock/out", ""); rec.Code != http.StatusOK {
		t.Fatalf("clock out: %d %s", rec.Code, rec.Body)
	}

	// The payroll export is the admin's, and a CSV with Gusto's columns.
	if rec, _ := call(t, h, "ada", http.MethodGet, api+"/reports/payroll.csv", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("ada exporting payroll: %d", rec.Code)
	}
	rec, _ = call(t, h, "pat", http.MethodGet, api+"/reports/payroll.csv?all=true", "")
	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/csv") ||
		lines[0] != "last_name,first_name,gusto_employee_id,regular_hours,overtime_hours,double_overtime_hours,holiday_hours,pto_hours,sick_hours" ||
		len(lines) != 3 || !strings.HasPrefix(lines[1], "Lovelace,Ada,") {
		t.Fatalf("payroll csv: %d %q\n%s", rec.Code, rec.Header().Get("Content-Type"), rec.Body)
	}

	// Outside the base path is the host's, not Timeclock's.
	if rec, _ := call(t, h, "ada", http.MethodGet, "/api/v1/me", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("/api/v1/me outside the base path: %d", rec.Code)
	}
	// A cross-site write is refused before it reaches a handler.
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, api+"/clock/in", strings.NewReader(`{}`))
	req.Header.Set("X-Test-User", "ada")
	req.Header.Set("Origin", "https://evil.example")
	out := httptest.NewRecorder()
	h.ServeHTTP(out, req)
	if out.Code != http.StatusForbidden {
		t.Fatalf("cross-site clock in: %d", out.Code)
	}
}

// The web app's client is generated from this document, so every operation
// must be in it, named, under the versioned prefix.
func TestAHostsWorkspacesAreApart(t *testing.T) {
	if os.Getenv("TIMECLOCK_TEST_DATABASE_URL") == "" {
		t.Skip("TIMECLOCK_TEST_DATABASE_URL not set")
	}
	h := mounted(t)
	const api = "/timeclock/api/v1"
	in := func(workspace, user, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		var reader *strings.Reader
		if body != "" {
			reader = strings.NewReader(body)
		} else {
			reader = strings.NewReader("")
		}
		req := httptest.NewRequestWithContext(t.Context(), method, path, reader)
		req.Header.Set("X-Test-User", user)
		req.Header.Set("X-Test-Workspace", workspace)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}

	// The same admin in two of the host's organizations.
	rec, _ := in("north", "pat", http.MethodPost, api+"/customers", `{"name":"Acme"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("add a customer in north: %d %s", rec.Code, rec.Body)
	}
	_, north := in("north", "pat", http.MethodGet, api+"/customers", "")
	_, south := in("south", "pat", http.MethodGet, api+"/customers", "")
	if n, _ := north["customers"].([]any); len(n) != 1 {
		t.Errorf("north's customers = %v", north)
	}
	if s, _ := south["customers"].([]any); len(s) != 0 {
		t.Errorf("south sees north's customers: %v", south)
	}
	// The same name is free in the other one.
	rec, _ = in("south", "pat", http.MethodPost, api+"/customers", `{"name":"Acme"}`)
	if rec.Code != http.StatusOK {
		t.Errorf("the same customer name in south: %d %s", rec.Code, rec.Body)
	}
	// With no workspace named, it is the default one, which has neither.
	_, plain := call(t, h, "pat", http.MethodGet, api+"/customers", "")
	if d, _ := plain["customers"].([]any); len(d) != 0 {
		t.Errorf("the default workspace sees another's customers: %v", plain)
	}
}

func TestThemeIsTheWorkspacesOverTheHosts(t *testing.T) {
	if os.Getenv("TIMECLOCK_TEST_DATABASE_URL") == "" {
		t.Skip("TIMECLOCK_TEST_DATABASE_URL not set")
	}
	h := mounted(t)
	const api = "/timeclock/api/v1"
	accent := func(body map[string]any, key, mode string) any {
		theme, _ := body[key].(map[string]any)
		scheme, _ := theme[mode].(map[string]any)
		seed, _ := scheme["interface"].(map[string]any)
		return seed["accent"]
	}

	// Signed out, the look is already the host's.
	_, info := call(t, h, "", http.MethodGet, api+"/info", "")
	if accent(info, "theme", "light") != "#06354f" || accent(info, "theme", "dark") != "#2f81f7" {
		t.Fatalf("theme without a workspace's own = %v", info["theme"])
	}

	// Only an admin sets the workspace's.
	rec, _ := call(t, h, "ada", http.MethodPut, api+"/theme", `{"light":{"interface":{"accent":"#aa0000","background":"#ffffff"}}}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a non-admin setting the theme: %d", rec.Code)
	}
	rec, info = call(t, h, "pat", http.MethodPut, api+"/theme", `{"light":{"interface":{"accent":"#aa0000","background":"#ffffff"}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("set theme: %d %s", rec.Code, rec.Body)
	}
	// Light is now the workspace's; dark, which it didn't set, is still the host's.
	if accent(info, "theme", "light") != "#aa0000" || accent(info, "theme", "dark") != "#2f81f7" || accent(info, "workspaceTheme", "light") != "#aa0000" {
		t.Errorf("theme after the workspace set light = %v", info)
	}

	// Clearing it goes back to the host's.
	_, info = call(t, h, "pat", http.MethodPut, api+"/theme", `{}`)
	if accent(info, "theme", "light") != "#06354f" || accent(info, "workspaceTheme", "light") != nil {
		t.Errorf("theme after clearing = %v", info)
	}
}

func TestOpenAPIDocumentsEveryOperation(t *testing.T) {
	doc := timeclock.OpenAPI()
	if len(doc.Paths) < 25 {
		t.Fatalf("%d paths, want the whole API", len(doc.Paths))
	}
	seen := map[string]string{}
	for path, item := range doc.Paths {
		if !strings.HasPrefix(path, "/api/v1/") {
			t.Errorf("path %s is outside /api/v1", path)
		}
		for _, op := range []*huma.Operation{item.Get, item.Post, item.Put, item.Delete} {
			if op == nil {
				continue
			}
			if op.OperationID == "" || op.Summary == "" {
				t.Errorf("%s %s has no id or summary", op.Method, path)
			}
			if other, dup := seen[op.OperationID]; dup {
				t.Errorf("operation id %s is used by %s and %s", op.OperationID, other, path)
			}
			seen[op.OperationID] = path
		}
	}
}

func TestIntegrationsRequireAdmin(t *testing.T) {
	h := mounted(t)
	for _, user := range []string{"", "ada"} {
		want := http.StatusForbidden
		if user == "" {
			want = http.StatusUnauthorized
		}
		for _, operation := range []struct{ method, path, body string }{
			{"GET", "/integrations/toggl", ""},
			{"POST", "/integrations/toggl/preview", `{"token":"secret","workspaceId":0}`},
			{"POST", "/integrations/toggl/sync", `{}`},
			{"DELETE", "/integrations/toggl", ""},
		} {
			response, _ := call(t, h, user, operation.method, "/timeclock/api/v1"+operation.path, operation.body)
			if response.Code != want {
				t.Errorf("%s %s as %q: %d, want %d", operation.method, operation.path, user, response.Code, want)
			}
		}
	}
	response, status := call(t, h, "pat", "GET", "/timeclock/api/v1/integrations/toggl", "")
	if response.Code != 200 || status["available"] != false || status["connected"] != false {
		t.Fatalf("unexpected disabled status: %s", response.Body.String())
	}
}

func TestAPIKeysURLMustBeAbsolute(t *testing.T) {
	for _, u := range []string{"/settings/api-keys", "javascript:alert(1)", "portal.example.com/keys"} {
		_, err := timeclock.New(t.Context(), timeclock.Options{
			Caller:     func(*http.Request) (string, bool) { return "", false },
			Directory:  directory{},
			APIKeysURL: u,
		})
		if err == nil || !strings.Contains(err.Error(), "APIKeysURL") {
			t.Errorf("%q: %v", u, err)
		}
	}
}

func TestImageSourcesAreOneSourceEach(t *testing.T) {
	for _, src := range []string{"", "https://a.example https://b.example", "https://a.example; script-src *", "'unsafe-inline'"} {
		_, err := timeclock.New(t.Context(), timeclock.Options{
			Caller:       func(*http.Request) (string, bool) { return "", false },
			Directory:    directory{},
			ImageSources: []string{src},
		})
		if err == nil || !strings.Contains(err.Error(), "image source") {
			t.Errorf("%q: %v", src, err)
		}
	}
}

// toServer sends every request to a test server, wherever it was bound.
type toServer struct{ url *url.URL }

func (s toServer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.URL.Scheme, r.URL.Host = s.url.Scheme, s.url.Host
	return http.DefaultTransport.RoundTrip(r)
}

func TestGoogleCalendarEvents(t *testing.T) {
	if os.Getenv("TIMECLOCK_TEST_DATABASE_URL") == "" {
		t.Skip("TIMECLOCK_TEST_DATABASE_URL not set")
	}
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer pat-token" || r.URL.Path != "/calendar/v3/calendars/primary/events" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, `{"summary":"pat@example.com","items":[{"id":"standup","status":"confirmed","summary":"Standup",
			"htmlLink":"https://calendar.example/standup","start":{"dateTime":"2026-10-05T09:00:00-05:00"},"end":{"dateTime":"2026-10-05T09:15:00-05:00"}}]}`)
	}))
	defer google.Close()
	target, _ := url.Parse(google.URL)
	var asked []string
	h := mountedWith(t, func(o *timeclock.Options) {
		o.GoogleCalendar = func(_ context.Context, p host.Person) (oauth2.TokenSource, bool, error) {
			asked = append(asked, p.Email)
			if p.ID != "pat" {
				return nil, false, nil
			}
			return oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "pat-token"}), true, nil
		}
	})
	// A host chooses the HTTP client its credentials go out on, as oauth2 does.
	h = withContext(h, oauth2.HTTPClient, &http.Client{Transport: toServer{target}})
	const api = "/timeclock/api/v1"

	if _, info := call(t, h, "", http.MethodGet, api+"/info", ""); info["calendar"] != true {
		t.Fatalf("/info: %v", info)
	}
	rec, body := call(t, h, "pat", http.MethodGet, api+"/calendar/events?from=2026-10-05&to=2026-10-11", "")
	events, _ := body["events"].([]any)
	if rec.Code != http.StatusOK || body["connected"] != true || body["calendar"] != "pat@example.com" || len(events) != 1 {
		t.Fatalf("pat: %d %s", rec.Code, rec.Body)
	}
	if e := events[0].(map[string]any); e["title"] != "Standup" || e["startedAt"] != "2026-10-05T14:00:00Z" || e["endedAt"] != "2026-10-05T14:15:00Z" ||
		e["meeting"] != "title:standup" || e["remembered"] != false {
		t.Fatalf("standup: %v", e)
	}

	// The project a meeting is copied to is remembered, while it is in use.
	_, project := call(t, h, "pat", http.MethodPost, api+"/projects", `{"name":"Rituals","billable":false}`)
	id, _ := project["id"].(string)
	if rec, _ := call(t, h, "pat", http.MethodPut, api+"/calendar/meetings", `{"meeting":"title:standup"}`); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("no project where one is required: %d %s", rec.Code, rec.Body)
	}
	if rec, _ := call(t, h, "pat", http.MethodPut, api+"/calendar/meetings", `{"meeting":"title:standup","projectId":"`+id+`"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("remember: %d %s", rec.Code, rec.Body)
	}
	remembered := func() map[string]any {
		t.Helper()
		_, body := call(t, h, "pat", http.MethodGet, api+"/calendar/events?from=2026-10-05&to=2026-10-11", "")
		return body["events"].([]any)[0].(map[string]any)
	}
	if e := remembered(); e["remembered"] != true || e["projectId"] != id {
		t.Fatalf("remembered: %v", e)
	}
	if rec, _ := call(t, h, "pat", http.MethodPut, api+"/projects/"+id, `{"name":"Rituals","billable":false,"archived":true}`); rec.Code != http.StatusOK {
		t.Fatalf("archive: %d %s", rec.Code, rec.Body)
	}
	if e := remembered(); e["remembered"] != false {
		t.Fatalf("an archived project is no choice: %v", e)
	}
	// Someone the host has no credentials for has no calendar, which is no error.
	rec, body = call(t, h, "ada", http.MethodGet, api+"/calendar/events?from=2026-10-05&to=2026-10-11", "")
	if rec.Code != http.StatusOK || body["connected"] != false || len(body["events"].([]any)) != 0 {
		t.Fatalf("ada: %d %s", rec.Code, rec.Body)
	}
	if strings.Join(asked, ",") != "pat@example.com,pat@example.com,pat@example.com,ada@example.com" {
		t.Fatalf("asked for %v", asked)
	}
	if rec, _ := call(t, h, "pat", http.MethodGet, api+"/calendar/events?from=2026-10-05&to=2026-12-31", ""); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("a long range: %d", rec.Code)
	}
}

func withContext(h http.Handler, key, value any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), key, value)))
	})
}

// fakeGoogle is Google's OAuth and Calendar endpoints for one consent: it
// takes the code "good" with the verifier for challenge, and serves events
// to the token it gave until that is revoked.
type fakeGoogle struct {
	t         *testing.T
	challenge string
	revoked   bool
	exchanges int
}

func (g *fakeGoogle) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/token":
		_ = r.ParseForm()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("code") != "good" || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge || r.Form.Get("client_secret") != "shh" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
				return
			}
			g.exchanges++
			g.revoked = false
			claims := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"ada.personal@example.org"}`))
			_, _ = io.WriteString(w, `{"access_token":"ada-access","refresh_token":"ada-refresh","expires_in":3600,"token_type":"Bearer","id_token":"e30.`+claims+`.sig"}`)
		case "refresh_token":
			if g.revoked || r.Form.Get("refresh_token") != "ada-refresh" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
				return
			}
			_, _ = io.WriteString(w, `{"access_token":"ada-access","expires_in":3600,"token_type":"Bearer"}`)
		}
	case "/revoke":
		_ = r.ParseForm()
		g.revoked = g.revoked || r.Form.Get("token") == "ada-refresh"
	case "/calendar/v3/calendars/primary/events":
		if g.revoked || r.Header.Get("Authorization") != "Bearer ada-access" {
			http.Error(w, `{}`, http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"summary":"ada.personal@example.org","items":[{"id":"review","status":"confirmed","summary":"Review",
			"start":{"dateTime":"2026-10-06T10:00:00-05:00"},"end":{"dateTime":"2026-10-06T11:00:00-05:00"}}]}`)
	default:
		g.t.Errorf("unexpected request to Google: %s", r.URL)
	}
}

func TestPeopleConnectTheirOwnGoogleCalendar(t *testing.T) {
	if os.Getenv("TIMECLOCK_TEST_DATABASE_URL") == "" {
		t.Skip("TIMECLOCK_TEST_DATABASE_URL not set")
	}
	google := &fakeGoogle{t: t}
	server := httptest.NewServer(google)
	defer server.Close()
	target, _ := url.Parse(server.URL)
	h := mountedWith(t, func(o *timeclock.Options) {
		o.IntegrationSecretKey = "a key only this test uses, long enough"
		o.GoogleOAuth = &timeclock.GoogleOAuth{
			ClientID: "client", ClientSecret: "shh",
			RedirectURL: "https://portal.example.com/timeclock/api/v1/calendar/google/callback",
			Endpoint:    oauth2.Endpoint{AuthURL: "https://accounts.example/auth", TokenURL: server.URL + "/token", AuthStyle: oauth2.AuthStyleInParams},
			RevokeURL:   server.URL + "/revoke",
		}
	})
	h = withContext(h, oauth2.HTTPClient, &http.Client{Transport: toServer{target}})
	const api = "/timeclock/api/v1"
	week := api + "/calendar/events?from=2026-10-05&to=2026-10-11"

	if _, info := call(t, h, "", http.MethodGet, api+"/info", ""); info["calendar"] != true || info["calendarConnect"] != true {
		t.Fatalf("/info: %v", info)
	}
	if rec, body := call(t, h, "ada", http.MethodGet, week, ""); rec.Code != http.StatusOK || body["connected"] != false || body["connectable"] != true {
		t.Fatalf("before connecting: %d %s", rec.Code, rec.Body)
	}

	// Connecting goes to Google, asking for lasting, read-only access for Ada.
	connect := func(ret string) url.Values {
		t.Helper()
		rec, _ := call(t, h, "ada", http.MethodGet, api+"/calendar/google/connect?return="+url.QueryEscape(ret), "")
		to, err := url.Parse(rec.Header().Get("Location"))
		if rec.Code != http.StatusFound || err != nil || to.Host != "accounts.example" {
			t.Fatalf("connect: %d %q", rec.Code, rec.Header().Get("Location"))
		}
		return to.Query()
	}
	q := connect("/?day=2026-10-05")
	if q.Get("access_type") != "offline" || q.Get("login_hint") != "ada@example.com" || q.Get("code_challenge_method") != "S256" ||
		!strings.Contains(q.Get("scope"), timeclock.GoogleCalendarScope) || q.Get("redirect_uri") != "https://portal.example.com/timeclock/api/v1/calendar/google/callback" {
		t.Fatalf("consent: %v", q)
	}
	google.challenge = q.Get("code_challenge")
	callback := api + "/calendar/google/callback?code=good&state=" + url.QueryEscape(q.Get("state"))

	// Only Ada can finish what Ada started.
	if rec, _ := call(t, h, "pat", http.MethodGet, callback, ""); rec.Code != http.StatusBadRequest || google.exchanges != 0 {
		t.Fatalf("pat finishing ada's: %d", rec.Code)
	}
	rec, _ := call(t, h, "ada", http.MethodGet, callback, "")
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/timeclock/?day=2026-10-05" {
		t.Fatalf("callback: %d %q %s", rec.Code, rec.Header().Get("Location"), rec.Body)
	}
	if _, status := call(t, h, "ada", http.MethodGet, api+"/calendar/google", ""); status["connected"] != true || status["account"] != "ada.personal@example.org" || status["managed"] != false {
		t.Fatalf("status: %v", status)
	}
	rec, body := call(t, h, "ada", http.MethodGet, week, "")
	if events, _ := body["events"].([]any); rec.Code != http.StatusOK || body["connected"] != true || len(events) != 1 {
		t.Fatalf("connected: %d %s", rec.Code, rec.Body)
	}
	// Pat has connected nothing.
	if _, body := call(t, h, "pat", http.MethodGet, week, ""); body["connected"] != false {
		t.Fatalf("pat: %v", body)
	}

	// Revoked at Google, the connection is forgotten, and can be made again.
	google.revoked = true
	if rec, body := call(t, h, "ada", http.MethodGet, week, ""); rec.Code != http.StatusOK || body["connected"] != false || body["connectable"] != true {
		t.Fatalf("after revoking at Google: %d %s", rec.Code, rec.Body)
	}
	if _, status := call(t, h, "ada", http.MethodGet, api+"/calendar/google", ""); status["connected"] != false {
		t.Fatalf("status after revoking: %v", status)
	}

	// Disconnecting revokes Timeclock's access at Google too.
	q = connect("https://elsewhere.example/")
	google.challenge = q.Get("code_challenge")
	rec, _ = call(t, h, "ada", http.MethodGet, api+"/calendar/google/callback?code=good&state="+url.QueryEscape(q.Get("state")), "")
	if rec.Header().Get("Location") != "/timeclock/" {
		t.Fatalf("another site to return to: %q", rec.Header().Get("Location"))
	}
	if rec, _ := call(t, h, "ada", http.MethodDelete, api+"/calendar/google", ""); rec.Code != http.StatusNoContent || !google.revoked {
		t.Fatalf("disconnect: %d revoked=%v", rec.Code, google.revoked)
	}
	if _, body := call(t, h, "ada", http.MethodGet, week, ""); body["connected"] != false {
		t.Fatalf("after disconnecting: %v", body)
	}

	// Refusing at Google comes back to the calendar settings, to say so.
	q = connect("/")
	rec, _ = call(t, h, "ada", http.MethodGet, api+"/calendar/google/callback?error=access_denied&state="+url.QueryEscape(q.Get("state")), "")
	if rec.Header().Get("Location") != "/timeclock/settings?tab=calendar&calendar=denied" {
		t.Fatalf("denied: %q", rec.Header().Get("Location"))
	}
}
