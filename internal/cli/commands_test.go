package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func runCLI(t *testing.T, server string, args ...string) (string, error) {
	t.Helper()
	t.Setenv("TIMECLOCK_TOKEN", "")
	t.Setenv("TIMECLOCK_URL", "")
	t.Setenv("TIMECLOCK_CREDENTIAL_STORE", "")
	cmd := New("test")
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(append([]string{"--server", server, "--config", filepath.Join(t.TempDir(), "config.json"), "--credential-store=file"}, args...))
	err := cmd.ExecuteContext(t.Context())
	return out.String(), err
}

func TestCommandRequests(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	tests := []struct {
		args                      []string
		method, path, query, body string
	}{
		{[]string{"status", "--json"}, "GET", "/me", "", ""},
		{[]string{"clock", "in", "--project", id, "--note", "Design review"}, "POST", "/clock/in", "", `{"projectId":"` + id + `","note":"Design review"}`},
		{[]string{"clock", "switch", "--note", "Internal"}, "POST", "/clock/switch", "", `{"note":"Internal"}`},
		{[]string{"clock", "out"}, "POST", "/clock/out", "", `{}`},
		{[]string{"entries", "list", "--from", "2026-10-05", "--to", "2026-10-05", "--person", "alice"}, "GET", "/entries", "from=2026-10-05&person=alice&to=2026-10-05", ""},
		{[]string{"entries", "add", "--start", "2026-10-05T09:00:00-05:00", "--end", "2026-10-05T10:00:00-05:00"}, "POST", "/entries", "", `{"startedAt":"2026-10-05T09:00:00-05:00","endedAt":"2026-10-05T10:00:00-05:00"}`},
		{[]string{"entries", "delete", id}, "DELETE", "/entries/" + id, "", ""},
		{[]string{"timesheet", "submit", "--day", "2026-10-05"}, "POST", "/timesheet/submit", "", `{"day":"2026-10-05"}`},
		{[]string{"timesheet", "reject", id, "--note", "Correct Monday"}, "POST", "/timesheets/" + id + "/decision", "", `{"approve":false,"note":"Correct Monday"}`},
		{[]string{"reports", "payroll", "--csv", "--all", "--day", "2026-10-05"}, "GET", "/reports/payroll.csv", "all=true&day=2026-10-05", ""},
		{[]string{"api", "/time-off?from=2026-10-01&to=2026-10-31"}, "GET", "/time-off", "from=2026-10-01&to=2026-10-31", ""},
	}
	for _, tc := range tests {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			called := false
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if r.Method != tc.method || r.URL.Path != "/mounted/api/v1"+tc.path || r.URL.RawQuery != tc.query {
					t.Errorf("request: %s %s", r.Method, r.URL)
				}
				body, _ := io.ReadAll(r.Body)
				if tc.body != "" {
					var got, want any
					_ = json.Unmarshal(body, &got)
					_ = json.Unmarshal([]byte(tc.body), &want)
					g, _ := json.Marshal(got)
					v, _ := json.Marshal(want)
					if string(g) != string(v) {
						t.Errorf("body=%s want %s", body, tc.body)
					}
				} else if len(body) > 0 {
					t.Errorf("unexpected body %s", body)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"ok":true}`)
			}))
			defer s.Close()
			if _, err := runCLI(t, s.URL+"/mounted", tc.args...); err != nil {
				t.Fatal(err)
			}
			if !called {
				t.Fatal("no request")
			}
		})
	}
}

func TestInvalidInputNeverMakesRequest(t *testing.T) {
	for _, args := range [][]string{
		{"clock", "in", "--project", "bogus"}, {"entries", "list", "--from", "2026-13-01", "--to", "2026-10-05"},
		{"entries", "list", "--from", "2026-10-06", "--to", "2026-10-05"}, {"timesheet", "submit"},
		{"reports", "payroll", "--all"}, {"reports", "payroll", "--csv", "--json"},
		{"api", "https://example.com/"}, {"api", "/../auth/session"}, {"api", "/%2e%2e/auth/session"},
		{"entries", "add", "--start", "2026-10-05T10:00:00Z", "--end", "2026-10-05T09:00:00Z"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unexpected request") }))
			defer s.Close()
			if _, err := runCLI(t, s.URL, args...); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestClientRefusesRedirectsAndHTML(t *testing.T) {
	for _, status := range []int{200, 302, 401, 422} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/me" {
					t.Error("followed redirect")
				}
				w.Header().Set("Location", "/login")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, "<html>Sign in</html>")
			}))
			defer s.Close()
			out, err := runCLI(t, s.URL, "status")
			if err == nil || strings.Contains(out, "<html>") {
				t.Fatalf("%q %v", out, err)
			}
		})
	}
}

func TestCredentialsArePrivateAndBoundToServer(t *testing.T) {
	o := &options{configPath: filepath.Join(t.TempDir(), "config.json"), credentialStore: "file", timeout: time.Second}
	o.server = "https://one.example.com"
	c, err := o.client(t.Context(), "test", false)
	if err != nil {
		t.Fatal(err)
	}
	err = o.withCredentials(t.Context(), c, config{}, func(s *credentialStore) error {
		if err := s.save(tokens{AccessToken: "secret", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
			return err
		}
		info, err := os.Stat(s.path)
		if err == nil && info.Mode().Perm() != 0600 {
			t.Errorf("permissions=%v", info.Mode())
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	c, err = o.client(t.Context(), "test", true)
	if err != nil || c.token != "secret" {
		t.Fatalf("stored token: %v", err)
	}
	o.server = "https://two.example.com"
	c, err = o.client(t.Context(), "test", true)
	if err != nil || c.token != "" {
		t.Fatalf("credentials leaked: %v", err)
	}
}

func TestRefreshAndCancellation(t *testing.T) {
	refreshes := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/cli/token" {
			t.Errorf("path=%s", r.URL.Path)
		}
		_ = r.ParseForm()
		if r.PostForm.Get("refresh_token") != "old-refresh" || r.PostForm.Get("client_id") != clientID {
			t.Errorf("form=%v", r.PostForm)
		}
		refreshes++
		_, _ = io.WriteString(w, `{"access_token":"new-access","refresh_token":"new-refresh","expires_in":600,"token_type":"Bearer"}`)
	}))
	defer s.Close()
	o := &options{server: s.URL, configPath: filepath.Join(t.TempDir(), "config.json"), credentialStore: "file", timeout: time.Second}
	c, _ := o.client(t.Context(), "test", false)
	if err := o.withCredentials(t.Context(), c, config{}, func(s *credentialStore) error {
		return s.save(tokens{AccessToken: "old", RefreshToken: "old-refresh", ExpiresAt: time.Now().Add(-time.Hour)})
	}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		c, err := o.client(t.Context(), "test", true)
		if err != nil || c.token != "new-access" {
			t.Fatalf("refresh: %v", err)
		}
	}
	if refreshes != 1 {
		t.Fatalf("refreshes=%d", refreshes)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := c.request(ctx, "GET", "/api/v1/me", url.Values{}, nil); err == nil {
		t.Fatal("canceled request succeeded")
	}
}

func TestTextOutputEscapesTerminalControls(t *testing.T) {
	var out bytes.Buffer
	if err := render(&out, []byte(`{"projects":[{"id":"id","name":"evil\u001b[2J\nnext"}]}`), false, "projects"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "\x1b") || strings.Count(out.String(), "\n") != 2 {
		t.Fatalf("unsafe output %q", out.String())
	}
}

func TestOSCredentialStore(t *testing.T) {
	keyring.MockInit()
	s := &credentialStore{kind: "keyring", key: "test-server", path: filepath.Join(t.TempDir(), "should-not-exist")}
	if err := s.save(tokens{AccessToken: "access", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	tokens, err := s.load()
	if err != nil || tokens.AccessToken != "access" {
		t.Fatalf("read keyring: %v", err)
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("keyring credentials written to disk")
	}
	if err := s.delete(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.load(); err != errNoCredentials {
		t.Fatalf("delete keyring: %v", err)
	}
}
