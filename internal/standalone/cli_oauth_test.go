package standalone

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func cliCall(t *testing.T, f *fixture, b *browser, path string, form url.Values, body any) (int, map[string]any) {
	t.Helper()
	var input, content string
	if form != nil {
		input = form.Encode()
		content = "application/x-www-form-urlencoded"
	} else {
		data, _ := json.Marshal(body)
		input = string(data)
		content = "application/json"
	}
	r := httptest.NewRequestWithContext(t.Context(), "POST", path, strings.NewReader(input))
	r.Header.Set("Content-Type", content)
	if b != nil {
		r.AddCookie(b.cookie)
	}
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func cliFormValues(grant, key, value string) url.Values {
	return url.Values{"client_id": {cliClientID}, "grant_type": {grant}, key: {value}}
}

func approveCode(t *testing.T, f *fixture, b *browser) (string, url.Values) {
	t.Helper()
	verifier := strings.Repeat("v", 43)
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {cliClientID}, "response_type": {"code"}, "scope": {cliScope}, "state": {strings.Repeat("s", 43)}, "redirect_uri": {"http://127.0.0.1:12345/callback"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}}
	w, _ := b.do("GET", "/auth/cli/authorize?"+q.Encode(), "")
	if w.Code != 302 {
		t.Fatalf("authorize: %d %s", w.Code, w.Body)
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	status, out := cliCall(t, f, b, "/auth/cli/decision", nil, map[string]any{"request": u.Query().Get("request"), "workspace": "default", "approve": true})
	if status != 200 {
		t.Fatalf("approve: %d %v", status, out)
	}
	u, _ = url.Parse(out["redirectUrl"].(string))
	form := cliFormValues("authorization_code", "code", u.Query().Get("code"))
	form.Set("code_verifier", verifier)
	form.Set("redirect_uri", q.Get("redirect_uri"))
	return u.Query().Get("code"), form
}

func tokenAccepted(t *testing.T, f *fixture, token string) bool {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), "GET", "/api/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	_, ok := f.auth.Caller(r)
	return ok
}

func TestCLIPKCERefreshReplayAndRevocation(t *testing.T) {
	f := newFixture(t)
	b := f.member("cli@example.com", true)
	_, form := approveCode(t, f, b)
	valid := form.Get("code_verifier")
	form.Set("code_verifier", strings.Repeat("x", 43))
	status, out := cliCall(t, f, nil, "/auth/cli/token", form, nil)
	if status != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("bad PKCE accepted: %d %v", status, out)
	}
	form.Set("code_verifier", valid)
	status, out = cliCall(t, f, nil, "/auth/cli/token", form, nil)
	if status != 200 {
		t.Fatalf("exchange: %d %v", status, out)
	}
	access, refresh := out["access_token"].(string), out["refresh_token"].(string)
	if !tokenAccepted(t, f, access) {
		t.Fatal("access token refused")
	}
	if status, _ = cliCall(t, f, nil, "/auth/cli/token", form, nil); status != 400 {
		t.Fatal("authorization code reused")
	}
	status, out = cliCall(t, f, nil, "/auth/cli/token", cliFormValues("refresh_token", "refresh_token", refresh), nil)
	if status != 200 {
		t.Fatalf("refresh: %d %v", status, out)
	}
	next := out["access_token"].(string)
	if status, _ = cliCall(t, f, nil, "/auth/cli/token", cliFormValues("refresh_token", "refresh_token", refresh), nil); status != 400 {
		t.Fatal("refresh token reused")
	}
	if tokenAccepted(t, f, next) || tokenAccepted(t, f, access) {
		t.Fatal("replay did not revoke the token family")
	}
	_, form = approveCode(t, f, b)
	_, out = cliCall(t, f, nil, "/auth/cli/token", form, nil)
	access = out["access_token"].(string)
	status, _ = cliCall(t, f, nil, "/auth/cli/revoke", url.Values{"client_id": {cliClientID}, "token": {out["refresh_token"].(string)}}, nil)
	if status != 200 || tokenAccepted(t, f, access) {
		t.Fatal("revocation failed")
	}
}

func TestCLIDevicePendingSlowDownDenialAndExpiry(t *testing.T) {
	f := newFixture(t)
	b := f.member("device@example.com", false)
	now := time.Now()
	f.auth.now = func() time.Time { return now }
	status, out := cliCall(t, f, nil, "/auth/cli/device", url.Values{"client_id": {cliClientID}, "scope": {cliScope}}, nil)
	if status != 200 {
		t.Fatalf("device: %d %v", status, out)
	}
	device, user := out["device_code"].(string), out["user_code"].(string)
	form := cliFormValues("urn:ietf:params:oauth:grant-type:device_code", "device_code", device)
	now = now.Add(time.Second)
	_, out = cliCall(t, f, nil, "/auth/cli/token", form, nil)
	if out["error"] != "authorization_pending" {
		t.Fatalf("pending: %v", out)
	}
	_, out = cliCall(t, f, nil, "/auth/cli/token", form, nil)
	if out["error"] != "slow_down" {
		t.Fatalf("slowdown: %v", out)
	}
	status, out = cliCall(t, f, b, "/auth/cli/decision", nil, map[string]any{"userCode": user, "workspace": "default", "approve": false})
	if status != 200 {
		t.Fatalf("deny: %d %v", status, out)
	}
	now = now.Add(15 * time.Second)
	_, out = cliCall(t, f, nil, "/auth/cli/token", form, nil)
	if out["error"] != "access_denied" {
		t.Fatalf("denied: %v", out)
	}
	now = now.Add(11 * time.Minute)
	_, out = cliCall(t, f, nil, "/auth/cli/token", form, nil)
	if out["error"] != "expired_token" {
		t.Fatalf("expired: %v", out)
	}
}

func TestCLIAuthorizationCannotBypassBrowserOrWorkspace(t *testing.T) {
	f := newFixture(t)
	b := f.member("bound@example.com", false)
	_, form := approveCode(t, f, b)
	_, out := cliCall(t, f, nil, "/auth/cli/token", form, nil)
	access := out["access_token"].(string)
	r := httptest.NewRequestWithContext(t.Context(), "GET", "/auth/security", nil)
	r.Header.Set("Authorization", "Bearer "+access)
	if _, ok := f.auth.Caller(r); ok {
		t.Fatal("API token accepted for account management")
	}
	if status, _ := cliCall(t, f, nil, "/auth/cli/decision", nil, map[string]any{"request": "forged", "workspace": "default", "approve": true}); status != 401 {
		t.Fatal("approval without browser session")
	}
	if status, _ := cliCall(t, f, b, "/auth/cli/decision", nil, map[string]any{"request": "forged", "workspace": "other", "approve": true}); status != 400 {
		t.Fatal("workspace mismatch accepted")
	}
	s, _ := f.auth.session(withCookie(t, b.cookie))
	if _, err := f.auth.pool.Exec(t.Context(), `DELETE FROM memberships WHERE account_id=$1`, s.account); err != nil {
		t.Fatal(err)
	}
	if tokenAccepted(t, f, access) {
		t.Fatal("removed membership retains access")
	}
	if status, _ := cliCall(t, f, nil, "/auth/cli/token", cliFormValues("refresh_token", "refresh_token", out["refresh_token"].(string)), nil); status != 400 {
		t.Fatal("removed membership refreshes")
	}
}

func TestCLIRedirectValidation(t *testing.T) {
	for _, raw := range []string{"https://evil.example/callback", "http://127.0.0.1.evil.example:1234/callback", "http://localhost:1234/callback", "http://127.0.0.1:1234/wrong", "http://user@127.0.0.1:1234/callback", "http://127.0.0.1:1234/callback?evil=1", "http://127.0.0.1:0/callback"} {
		if cliRedirect(raw) {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:1234/callback", "http://[::1]:1234/callback"} {
		if !cliRedirect(raw) {
			t.Errorf("rejected %s", raw)
		}
	}
}

func TestCLIConcurrentRefreshOnlyIssuesOnce(t *testing.T) {
	f := newFixture(t)
	b := f.member("concurrent@example.com", false)
	_, form := approveCode(t, f, b)
	_, out := cliCall(t, f, nil, "/auth/cli/token", form, nil)
	refresh := out["refresh_token"].(string)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Go(func() {
			status, _ := cliCall(t, f, nil, "/auth/cli/token", cliFormValues("refresh_token", "refresh_token", refresh), nil)
			statuses <- status
		})
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[400] != 1 {
		t.Fatalf("concurrent refresh statuses: %v", counts)
	}
	if tokenAccepted(t, f, out["access_token"].(string)) {
		t.Fatal("concurrent reuse must revoke the grant")
	}
}

func TestCLIExpiryDisabledAccountsAndPasswordChange(t *testing.T) {
	for _, reason := range []string{"access expired", "account disabled", "password changed", "SSO now required"} {
		t.Run(reason, func(t *testing.T) {
			f := newFixture(t)
			b := f.member("lifecycle@example.com", false)
			_, form := approveCode(t, f, b)
			_, out := cliCall(t, f, nil, "/auth/cli/token", form, nil)
			s, _ := f.auth.session(withCookie(t, b.cookie))
			var err error
			switch reason {
			case "access expired":
				now := time.Now().Add(11 * time.Minute)
				f.auth.now = func() time.Time { return now }
			case "account disabled":
				_, err = f.auth.pool.Exec(t.Context(), `UPDATE accounts SET disabled_at=now() WHERE id=$1`, s.account)
			case "password changed":
				b.want(204, "POST", "/auth/password/change", `{"current":"`+goodPassword+`","password":"a different long passphrase"}`)
			case "SSO now required":
				_, err = f.auth.pool.Exec(t.Context(), `INSERT INTO workspace_sso(workspace_id,issuer,client_id,client_secret,required) SELECT id,'https://idp.example','client','sealed',true FROM workspaces WHERE key='default'`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if tokenAccepted(t, f, out["access_token"].(string)) {
				t.Fatal("access still accepted")
			}
			status, _ := cliCall(t, f, nil, "/auth/cli/token", cliFormValues("refresh_token", "refresh_token", out["refresh_token"].(string)), nil)
			want := 400
			if reason == "access expired" {
				want = 200
			}
			if status != want {
				t.Fatalf("refresh status=%d want %d", status, want)
			}
		})
	}
}
