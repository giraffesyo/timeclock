package timeclock_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/parallelworks/foundation/pgdb/pgdbtest"

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
	url, schema := pgdbtest.Schema(t, "TIMECLOCK_TEST_DATABASE_URL")
	tc, err := timeclock.New(t.Context(), timeclock.Options{
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
		HomeURL:   "/",
		HomeLabel: "Host",
		SignInURL: "/login?next=",
		Theme: host.Theme{
			Light: &host.Scheme{Interface: host.ThemeSeed{Accent: "#06354f", Background: "#f3f4f6"}},
			Dark:  &host.Scheme{Interface: host.ThemeSeed{Accent: "#2f81f7", Background: "#0d1117"}},
		},
	})
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

	// Signed out: the API refuses with a problem, and says where to sign in.
	rec, _ := call(t, h, "", http.MethodGet, api+"/me", "")
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("signed-out /me: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	rec, body := call(t, h, "", http.MethodGet, api+"/info", "")
	if rec.Code != http.StatusOK || body["signInUrl"] != "/login?next=" || body["homeLabel"] != "Host" {
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
		lines[0] != "last_name,first_name,gusto_employee_id,regular_hours,overtime_hours,double_overtime_hours,pto_hours,sick_hours" ||
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
