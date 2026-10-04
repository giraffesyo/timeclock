package standalone

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/foundation/pgdb/pgdbtest"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
	"github.com/giraffesyo/timeclock/migrations"
)

const dbEnv = "TIMECLOCK_TEST_DATABASE_URL"

// outbox is a mailer that keeps what it was asked to send.
type outbox struct {
	mu   sync.Mutex
	sent []host.Message
}

func (o *outbox) Send(_ context.Context, m host.Message) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.sent = append(o.sent, m)
	return nil
}

var linkToken = regexp.MustCompile(`token=([A-Za-z0-9]+)`)

// token is the token in the link of the last email to an address.
func (o *outbox) token(t *testing.T, to string) string {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := len(o.sent) - 1; i >= 0; i-- {
		if o.sent[i].To == to {
			if m := linkToken.FindStringSubmatch(o.sent[i].Text); m != nil {
				return m[1]
			}
		}
	}
	t.Fatalf("no email with a link was sent to %s", to)
	return ""
}

type known map[string]bool

func (k known) Breached(_ context.Context, password string) (bool, error) { return k[password], nil }

type fixture struct {
	t    *testing.T
	auth *Auth
	mux  *http.ServeMux
	mail *outbox
	svc  *clock.Service
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	if os.Getenv(dbEnv) == "" {
		t.Skip(dbEnv + " not set")
	}
	pool := pgdbtest.Migrated(t, dbEnv, pgdb.Migrations{FS: migrations.FS})
	mail := &outbox{}
	auth, err := New(t.Context(), pool, Config{
		PublicURL: "https://time.example.com", Mailer: mail, AdminEmails: []string{"Pat@Example.com"},
		SecretKey: "a key for tests that is long enough to use",
	})
	if err != nil {
		t.Fatal(err)
	}
	auth.breaches = known{"password123": true}
	mux := http.NewServeMux()
	auth.Routes(mux)
	return &fixture{t: t, auth: auth, mux: mux, mail: mail, svc: clock.New(pool)}
}

// browser is one person's cookies.
type browser struct {
	f      *fixture
	cookie *http.Cookie
	// held is the cookie of a sign-in that still owes its second step.
	held    *http.Cookie
	pending bool
	ip      string
}

func (f *fixture) browser() *browser { return &browser{f: f, ip: "203.0.113.7"} }

func (b *browser) do(method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	b.f.t.Helper()
	req := httptest.NewRequestWithContext(b.f.t.Context(), method, path, strings.NewReader(body))
	req.RemoteAddr = b.ip + ":4000"
	if b.cookie != nil {
		req.AddCookie(b.cookie)
	}
	if b.held != nil {
		req.AddCookie(b.held)
	}
	rec := httptest.NewRecorder()
	b.f.mux.ServeHTTP(rec, req)
	for _, c := range rec.Result().Cookies() {
		if c.Name == pendingCookie {
			b.held = c
			if c.MaxAge < 0 {
				b.held = nil
			}
		}
		if c.Name == cookieName {
			b.cookie = c
			if c.MaxAge < 0 {
				b.cookie = nil
			}
		}
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func (b *browser) want(status int, method, path, body string) map[string]any {
	b.f.t.Helper()
	rec, out := b.do(method, path, body)
	if rec.Code != status {
		b.f.t.Fatalf("%s %s = %d %s, want %d", method, path, rec.Code, rec.Body, status)
	}
	return out
}

const goodPassword = "a long enough passphrase"

func TestTheFirstAdminIsInvitedAndSetsAPassword(t *testing.T) {
	f := newFixture(t)
	b := f.browser()

	// Signed out, the page learns only how to sign in.
	out := b.want(http.StatusOK, http.MethodGet, "/auth/session", "")
	if out["account"] != nil || out["methods"] == nil {
		t.Fatalf("signed-out session = %v", out)
	}

	// Starting the server invited the admin it was told about.
	token := f.mail.token(t, "pat@example.com")
	invite := b.want(http.StatusOK, http.MethodGet, "/auth/invite?token="+token, "")
	if invite["email"] != "pat@example.com" || invite["hasAccount"] != false {
		t.Fatalf("invitation = %v", invite)
	}

	// A password that is too short, or known from a breach, is refused.
	rec, out := b.do(http.MethodPost, "/auth/invite/accept", `{"token":"`+token+`","name":"Pat","password":"short"}`)
	if rec.Code != http.StatusUnprocessableEntity || out["code"] != "weak_password" {
		t.Fatalf("a short password: %d %v", rec.Code, out)
	}
	rec, out = b.do(http.MethodPost, "/auth/invite/accept", `{"token":"`+token+`","name":"Pat","password":"password123"}`)
	if rec.Code != http.StatusUnprocessableEntity || out["code"] != "breached_password" {
		t.Fatalf("a breached password: %d %v", rec.Code, out)
	}

	b.want(http.StatusNoContent, http.MethodPost, "/auth/invite/accept", `{"token":"`+token+`","name":"Pat","password":"`+goodPassword+`"}`)
	if b.cookie == nil || !b.cookie.HttpOnly || b.cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie = %+v", b.cookie)
	}
	session := b.want(http.StatusOK, http.MethodGet, "/auth/session", "")
	if session["workspace"] != clock.DefaultWorkspace {
		t.Errorf("session = %v", session)
	}
	// The link works once.
	rec, out = f.browser().do(http.MethodPost, "/auth/invite/accept", `{"token":"`+token+`","password":"`+goodPassword+`"}`)
	if rec.Code != http.StatusGone || out["code"] != "link_expired" {
		t.Errorf("an invitation used twice: %d %v", rec.Code, out)
	}

	// Timeclock sees the account as a person of the workspace, and an admin.
	id, ok := f.auth.Caller(withCookie(t, b.cookie))
	if !ok {
		t.Fatal("the session is not a caller")
	}
	p, err := f.auth.Person(host.WithWorkspace(t.Context(), clock.DefaultWorkspace), id)
	if err != nil || !p.Admin || p.Name != "Pat" {
		t.Errorf("person = %+v, %v", p, err)
	}
	if _, err := f.auth.Person(host.WithWorkspace(t.Context(), "elsewhere"), id); err == nil {
		t.Error("the account is a person of a workspace it isn't in")
	}

	// Signing out ends the session, not just the cookie.
	old := b.cookie
	b.want(http.StatusOK, http.MethodPost, "/auth/logout", "")
	if _, ok := f.auth.Caller(withCookie(t, old)); ok {
		t.Error("the old cookie still signs in after signing out")
	}
}

func withCookie(t *testing.T, c *http.Cookie) *http.Request {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	req.AddCookie(c)
	return req
}

// member makes an account in the default workspace and signs it in.
func (f *fixture) member(email string, admin bool) *browser {
	f.t.Helper()
	if _, err := f.auth.Invite(f.t.Context(), clock.DefaultWorkspace, email, admin, uuid.Nil); err != nil {
		f.t.Fatal(err)
	}
	b := f.browser()
	b.want(http.StatusNoContent, http.MethodPost, "/auth/invite/accept",
		`{"token":"`+f.mail.token(f.t, email)+`","name":"`+strings.Split(email, "@")[0]+`","password":"`+goodPassword+`"}`)
	return b
}

func TestSignInIsSlowedAfterWrongPasswords(t *testing.T) {
	f := newFixture(t)
	f.member("ada@example.com", false)
	b := f.browser()

	// An unknown address and a wrong password are told the same thing.
	_, unknown := b.do(http.MethodPost, "/auth/login", `{"email":"nobody@example.com","password":"`+goodPassword+`"}`)
	_, wrong := b.do(http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"not her password"}`)
	if unknown["code"] != "invalid_credentials" || wrong["code"] != "invalid_credentials" || unknown["detail"] != wrong["detail"] {
		t.Fatalf("unknown = %v, wrong = %v", unknown, wrong)
	}

	// Guessing from a different address each time is still slowed: the
	// account is paused, whatever address asks next.
	for i := range freeFailures {
		guesser := f.browser()
		guesser.ip = "198.51.100." + strconv.Itoa(i+1)
		guesser.do(http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"not her password"}`)
	}
	other := f.browser()
	other.ip = "198.51.100.200"
	rec, out := other.do(http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`)
	if rec.Code != http.StatusTooManyRequests || out["code"] != "too_many_attempts" || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("after repeated failures, even the right password: %d %v", rec.Code, out)
	}

	// One address guessing at many accounts is paused too.
	sprayer := f.browser()
	sprayer.ip = "192.0.2.50"
	for i := range freeFailures + 1 {
		sprayer.do(http.MethodPost, "/auth/login", `{"email":"user`+strconv.Itoa(i)+`@example.com","password":"`+goodPassword+`"}`)
	}
	if rec, _ := sprayer.do(http.MethodPost, "/auth/login", `{"email":"someone@example.com","password":"x"}`); rec.Code != http.StatusTooManyRequests {
		t.Errorf("one address after many failures: %d", rec.Code)
	}

	// Once the pause is over, the right password signs in.
	f.auth.now = func() time.Time { return time.Now().Add(maxPause + time.Minute) }
	other.want(http.StatusNoContent, http.MethodPost, "/auth/login", `{"email":"ADA@example.com","password":"`+goodPassword+`"}`)
}

func TestAResetLinkSetsANewPasswordAndEndsOtherSessions(t *testing.T) {
	f := newFixture(t)
	old := f.member("ada@example.com", false)

	// Asking answers the same for an address with no account, and sends nothing.
	sent := len(f.mail.sent)
	f.browser().want(http.StatusNoContent, http.MethodPost, "/auth/password/forgot", `{"email":"nobody@example.com"}`)
	if len(f.mail.sent) != sent {
		t.Fatal("a reset was emailed to an address with no account")
	}
	b := f.browser()
	b.ip = "198.51.100.20"
	b.want(http.StatusNoContent, http.MethodPost, "/auth/password/forgot", `{"email":"ada@example.com"}`)
	token := f.mail.token(t, "ada@example.com")

	const next = "another long passphrase"
	b.want(http.StatusNoContent, http.MethodPost, "/auth/password/reset", `{"token":"`+token+`","password":"`+next+`"}`)
	if _, out := old.do(http.MethodGet, "/auth/session", ""); out["account"] != nil {
		t.Errorf("a session from before the reset is still signed in: %v", out)
	}
	if rec, out := f.browser().do(http.MethodPost, "/auth/password/reset", `{"token":"`+token+`","password":"`+next+`"}`); rec.Code != http.StatusGone {
		t.Errorf("a reset link used twice: %d %v", rec.Code, out)
	}
	fresh := f.browser()
	fresh.ip = "198.51.100.21"
	if rec, _ := fresh.do(http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("the old password after a reset: %d", rec.Code)
	}
	fresh.want(http.StatusNoContent, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+next+`"}`)

	// Changing it needs the current one, and ends the other sessions.
	rec, out := fresh.do(http.MethodPost, "/auth/password/change", `{"current":"wrong","password":"a third long passphrase"}`)
	if rec.Code != http.StatusUnauthorized || out["code"] != "invalid_credentials" {
		t.Errorf("changing with the wrong current password: %d %v", rec.Code, out)
	}
	fresh.want(http.StatusNoContent, http.MethodPost, "/auth/password/change", `{"current":"`+next+`","password":"a third long passphrase"}`)
	if _, out := b.do(http.MethodGet, "/auth/session", ""); out["account"] != nil {
		t.Errorf("another session after a password change is still signed in: %v", out)
	}
	if out := fresh.want(http.StatusOK, http.MethodGet, "/auth/session", ""); out["account"] == nil {
		t.Errorf("the session that changed the password was signed out: %v", out)
	}
}

func TestAdminsInviteAndPeopleSwitchWorkspaces(t *testing.T) {
	f := newFixture(t)
	admin := f.member("boss@example.com", true)
	ada := f.member("ada@example.com", false)

	// Only an admin invites.
	if rec, _ := ada.do(http.MethodPost, "/auth/invites", `{"email":"bob@example.com"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("a member inviting: %d", rec.Code)
	}
	invited := admin.want(http.StatusOK, http.MethodPost, "/auth/invites", `{"email":"Bob@Example.com"}`)
	if invited["email"] != "bob@example.com" || !strings.Contains(invited["link"].(string), "https://time.example.com/invite?token=") {
		t.Fatalf("invited = %v", invited)
	}
	list := admin.want(http.StatusOK, http.MethodGet, "/auth/invites", "")
	// Bob's, and the one the server made for its admin when it started.
	if n := len(list["invites"].([]any)); n != 2 {
		t.Fatalf("waiting invitations = %d", n)
	}
	// A withdrawn invitation no longer works.
	admin.want(http.StatusNoContent, http.MethodDelete, "/auth/invites/"+invited["id"].(string), "")
	if rec, _ := f.browser().do(http.MethodGet, "/auth/invite?token="+f.mail.token(t, "bob@example.com"), ""); rec.Code != http.StatusGone {
		t.Errorf("a withdrawn invitation: %d", rec.Code)
	}

	// A second workspace, which Ada is invited to and already has an account for.
	if err := f.auth.CreateWorkspace(t.Context(), f.svc, "north", "North Office"); err != nil {
		t.Fatal(err)
	}
	if rec, _ := ada.do(http.MethodPost, "/auth/workspace", `{"workspace":"north"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("switching to a workspace she isn't in: %d", rec.Code)
	}
	if _, err := f.auth.Invite(t.Context(), "north", "ada@example.com", true, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	token := f.mail.token(t, "ada@example.com")
	if got := f.browser().want(http.StatusOK, http.MethodGet, "/auth/invite?token="+token, ""); got["hasAccount"] != true || got["workspace"] != "North Office" {
		t.Fatalf("invitation for someone with an account = %v", got)
	}
	// She proves the account is hers with her password, not a new one.
	if rec, _ := f.browser().do(http.MethodPost, "/auth/invite/accept", `{"token":"`+token+`","password":"someone else guessing"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("accepting with the wrong password: %d", rec.Code)
	}
	ada.want(http.StatusNoContent, http.MethodPost, "/auth/invite/accept", `{"token":"`+token+`","password":"`+goodPassword+`"}`)

	session := ada.want(http.StatusOK, http.MethodGet, "/auth/session", "")
	if session["workspace"] != "north" || len(session["workspaces"].([]any)) != 2 {
		t.Fatalf("session after joining = %v", session)
	}
	key, ok := f.auth.Workspace(withCookie(t, ada.cookie))
	if !ok || key != "north" {
		t.Errorf("the session's workspace = %q, %v", key, ok)
	}
	// She is an admin in the one she was invited to as one, and not in the other.
	id, _ := f.auth.Caller(withCookie(t, ada.cookie))
	if p, err := f.auth.Person(host.WithWorkspace(t.Context(), "north"), id); err != nil || !p.Admin {
		t.Errorf("in north = %+v, %v", p, err)
	}
	if p, err := f.auth.Person(host.WithWorkspace(t.Context(), clock.DefaultWorkspace), id); err != nil || p.Admin {
		t.Errorf("in default = %+v, %v", p, err)
	}
	ada.want(http.StatusNoContent, http.MethodPost, "/auth/workspace", `{"workspace":"default"}`)
	if key, _ := f.auth.Workspace(withCookie(t, ada.cookie)); key != clock.DefaultWorkspace {
		t.Errorf("after switching back = %q", key)
	}
	people, err := f.auth.People(host.WithWorkspace(t.Context(), "north"))
	if err != nil || len(people) != 1 {
		t.Errorf("north's people = %v, %v", people, err)
	}
}

func TestPasswordHashing(t *testing.T) {
	hash, err := hashPassword(goodPassword)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=47104,t=1,p=1$") {
		t.Errorf("hash = %s", hash)
	}
	if !verifyPassword(hash, goodPassword) || verifyPassword(hash, goodPassword+"x") || verifyPassword("", goodPassword) || verifyPassword("$argon2id$bad", goodPassword) {
		t.Error("verifyPassword is wrong")
	}
	again, _ := hashPassword(goodPassword)
	if again == hash {
		t.Error("two hashes of one password are the same: no salt")
	}
}

// code is the authenticator's current code for a secret, as an app would show.
func code(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	raw, err := b32.DecodeString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return totpCode(raw, at.Unix()/30)
}

func TestAnAuthenticatorIsAskedForAfterThePassword(t *testing.T) {
	f := newFixture(t)
	ada := f.member("ada@example.com", false)
	now := time.Now()
	f.auth.now = func() time.Time { return now }

	// Setting one up asks for the password again, and changes nothing until a code confirms it.
	if rec, _ := ada.do(http.MethodPost, "/auth/totp/setup", `{"password":"wrong"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("setup with the wrong password: %d", rec.Code)
	}
	setup := ada.want(http.StatusOK, http.MethodPost, "/auth/totp/setup", `{"password":"`+goodPassword+`"}`)
	secret := setup["secret"].(string)
	if !strings.HasPrefix(setup["uri"].(string), "otpauth://totp/Timeclock:ada@example.com?") {
		t.Errorf("uri = %v", setup["uri"])
	}
	plain := f.browser()
	plain.want(http.StatusNoContent, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`)

	if rec, out := ada.do(http.MethodPost, "/auth/totp/confirm", `{"code":"000000"}`); rec.Code != http.StatusUnauthorized || out["code"] != "invalid_code" {
		t.Fatalf("confirming with a wrong code: %d %v", rec.Code, out)
	}
	confirmed := ada.want(http.StatusOK, http.MethodPost, "/auth/totp/confirm", `{"code":"`+code(t, secret, now)+`"}`)
	recovery := confirmed["recoveryCodes"].([]any)
	if len(recovery) != recoveryCodes {
		t.Fatalf("recovery codes = %v", recovery)
	}
	if got := ada.want(http.StatusOK, http.MethodGet, "/auth/security", ""); got["totp"] != true || got["recoveryCodes"] != float64(recoveryCodes) {
		t.Errorf("security = %v", got)
	}

	// Now the password alone doesn't sign in.
	b := f.browser()
	out := b.want(http.StatusOK, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`)
	if out["secondStep"] != true || b.cookie != nil {
		t.Fatalf("after the password = %v, session cookie %v", out, b.cookie)
	}
	if rec, _ := b.do(http.MethodPost, "/auth/login/second", `{"code":"000000"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a wrong code: %d", rec.Code)
	}
	// The code that confirmed setup was used; the next one works, once.
	if rec, _ := b.do(http.MethodPost, "/auth/login/second", `{"code":"`+code(t, secret, now)+`"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a code used before: %d", rec.Code)
	}
	now = now.Add(30 * time.Second)
	b.want(http.StatusNoContent, http.MethodPost, "/auth/login/second", `{"code":"`+code(t, secret, now)+`"}`)
	if got := b.want(http.StatusOK, http.MethodGet, "/auth/session", ""); got["account"] == nil {
		t.Fatalf("after the second step = %v", got)
	}

	// A recovery code stands in for the app, once.
	c := f.browser()
	c.pending = true
	c.want(http.StatusOK, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`)
	one := recovery[0].(string)
	c.want(http.StatusNoContent, http.MethodPost, "/auth/login/second", `{"recovery":"`+strings.ToUpper(one)+`"}`)
	d := f.browser()
	d.want(http.StatusOK, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`)
	if rec, _ := d.do(http.MethodPost, "/auth/login/second", `{"recovery":"`+one+`"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("a recovery code used twice: %d", rec.Code)
	}

	// A reset link doesn't get around it either.
	e := f.browser()
	e.ip = "198.51.100.77"
	e.want(http.StatusNoContent, http.MethodPost, "/auth/password/forgot", `{"email":"ada@example.com"}`)
	got := e.want(http.StatusOK, http.MethodPost, "/auth/password/reset", `{"token":"`+f.mail.token(t, "ada@example.com")+`","password":"another long passphrase"}`)
	if got["secondStep"] != true || e.cookie != nil {
		t.Errorf("after a reset = %v, session cookie %v", got, e.cookie)
	}

	// Guessing codes is slowed like guessing passwords.
	g := f.browser()
	g.want(http.StatusOK, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"another long passphrase"}`)
	for range freeFailures + 2 {
		g.do(http.MethodPost, "/auth/login/second", `{"code":"123456"}`)
	}
	if rec, out := g.do(http.MethodPost, "/auth/login/second", `{"code":"123456"}`); rec.Code != http.StatusTooManyRequests || out["code"] != "too_many_attempts" {
		t.Errorf("after many wrong codes: %d %v", rec.Code, out)
	}

	// Turning it off needs the password; then the password is enough again.
	// (The reset ended the earlier sessions, so this is a new one.)
	now = now.Add(maxPause + time.Minute)
	h := f.browser()
	h.want(http.StatusOK, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"another long passphrase"}`)
	h.want(http.StatusNoContent, http.MethodPost, "/auth/login/second", `{"code":"`+code(t, secret, now)+`"}`)
	h.want(http.StatusNoContent, http.MethodPost, "/auth/totp/disable", `{"password":"another long passphrase"}`)
	f.browser().want(http.StatusNoContent, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"another long passphrase"}`)

	// The secret was never in the database in the clear.
	var sealed []byte
	ada2 := f.member("eve@example.com", false)
	s2 := ada2.want(http.StatusOK, http.MethodPost, "/auth/totp/setup", `{"password":"`+goodPassword+`"}`)
	if err := f.auth.pool.QueryRow(t.Context(), `SELECT totp_secret FROM accounts WHERE email = 'eve@example.com'`).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	raw, _ := b32.DecodeString(s2["secret"].(string))
	if strings.Contains(string(sealed), string(raw)) || len(sealed) <= len(raw) {
		t.Error("the authenticator secret is stored unsealed")
	}
}

func TestTOTPMatchesTheStandard(t *testing.T) {
	// RFC 6238's test secret and times, at six digits.
	secret := []byte("12345678901234567890")
	for at, want := range map[int64]string{59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"} {
		if got := totpCode(secret, at/30); got != want {
			t.Errorf("code at %d = %s, want %s", at, got, want)
		}
	}
	now := time.Unix(1111111109, 0)
	if totpStep(secret, "081804", now) == 0 || totpStep(secret, "081 804", now.Add(29*time.Second)) == 0 || totpStep(secret, "081804", now.Add(90*time.Second)) != 0 {
		t.Error("the window of accepted codes is wrong")
	}
}

// idp is a pretend OpenID Connect provider: it signs in whoever the test says.
type idp struct {
	*httptest.Server
	key      *rsa.PrivateKey
	clientID string
	// What the next token will say.
	email    string
	verified bool
	nonce    string
}

func newIDP(t *testing.T) *idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{key: key, clientID: "timeclock-client", verified: true}
	mux := http.NewServeMux()
	p.Server = httptest.NewServer(mux)
	t.Cleanup(p.Close)
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": p.URL, "authorization_endpoint": p.URL + "/authorize", "token_endpoint": p.URL + "/token",
			"jwks_uri": p.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("GET /keys", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, _ *http.Request) {
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
		if err != nil {
			t.Error(err)
		}
		claims, _ := json.Marshal(map[string]any{
			"iss": p.URL, "sub": "sub-" + p.email, "aud": p.clientID, "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
			"nonce": p.nonce, "email": p.email, "email_verified": p.verified, "name": "From The Provider",
		})
		sig, err := signer.Sign(claims)
		if err != nil {
			t.Error(err)
		}
		token, _ := sig.CompactSerialize()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "x", "token_type": "Bearer", "id_token": token})
	})
	return p
}

// through signs a browser in through a workspace's provider as an address,
// and returns where it was sent afterwards.
func (b *browser) through(p *idp, workspace, email string) string {
	b.f.t.Helper()
	rec, _ := b.do(http.MethodGet, "/auth/sso/login?workspace="+workspace+"&next=/timesheet", "")
	out, err := url.Parse(rec.Header().Get("Location"))
	if err != nil || rec.Code != http.StatusFound || !strings.HasPrefix(out.String(), p.URL+"/authorize") {
		b.f.t.Fatalf("sso login for %s: %d to %q", workspace, rec.Code, rec.Header().Get("Location"))
	}
	p.email, p.nonce = email, out.Query().Get("nonce")
	rec, _ = b.do(http.MethodGet, "/auth/callback?code=c&state="+url.QueryEscape(out.Query().Get("state")), "")
	return rec.Header().Get("Location")
}

func TestAWorkspacesOwnProviderSignsInToThatWorkspaceOnly(t *testing.T) {
	f := newFixture(t)
	p := newIDP(t)
	f.auth.cfg.PublicURL = "https://time.example.com"
	if err := f.auth.CreateWorkspace(t.Context(), f.svc, "north", "North Office"); err != nil {
		t.Fatal(err)
	}
	// Ada is in both workspaces, with a password; she runs north.
	ada := f.member("ada@example.com", false)
	if _, err := f.auth.Invite(t.Context(), "north", "ada@example.com", true, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	ada.want(http.StatusNoContent, http.MethodPost, "/auth/invite/accept", `{"token":"`+f.mail.token(t, "ada@example.com")+`","password":"`+goodPassword+`"}`)

	// Only an admin sets the provider, and it must really be one.
	settings := `{"issuer":"` + p.URL + `","clientId":"timeclock-client","clientSecret":"s3cret","required":false,"autoJoin":false}`
	bob := f.member("bob@example.com", false)
	if rec, _ := bob.do(http.MethodPut, "/auth/sso", settings); rec.Code != http.StatusForbidden {
		t.Fatalf("a member setting the provider: %d", rec.Code)
	}
	if rec, _ := ada.do(http.MethodPut, "/auth/sso", `{"issuer":"http://127.0.0.1:1","clientId":"x","clientSecret":"y"}`); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("an address that is no provider: %d", rec.Code)
	}
	ada.want(http.StatusNoContent, http.MethodPut, "/auth/sso", settings)
	got := ada.want(http.StatusOK, http.MethodGet, "/auth/sso", "")
	if got["configured"] != true || got["issuer"] != p.URL || got["clientSecret"] != nil || got["redirectUrl"] != "https://time.example.com/auth/callback" {
		t.Fatalf("sso settings = %v", got)
	}
	var sealed []byte
	if err := f.auth.pool.QueryRow(t.Context(), `SELECT client_secret FROM workspace_sso`).Scan(&sealed); err != nil || strings.Contains(string(sealed), "s3cret") {
		t.Errorf("the client secret is stored unsealed (%v)", err)
	}

	// Her address is offered the workspace's provider, and a password still works.
	start := f.browser().want(http.StatusOK, http.MethodPost, "/auth/login/start", `{"email":"ada@example.com"}`)
	if list := start["sso"].([]any); len(list) != 1 || list[0].(map[string]any)["workspace"] != "north" || start["password"] != true {
		t.Fatalf("how ada signs in = %v", start)
	}
	if other := f.browser().want(http.StatusOK, http.MethodPost, "/auth/login/start", `{"email":"nobody@example.com"}`); len(other["sso"].([]any)) != 0 || other["password"] != true {
		t.Errorf("how a stranger signs in = %v", other)
	}

	// Through the provider she is in north, and only north.
	b := f.browser()
	if to := b.through(p, "north", "ada@example.com"); to != "/timesheet" {
		t.Fatalf("after the provider, sent to %q", to)
	}
	session := b.want(http.StatusOK, http.MethodGet, "/auth/session", "")
	if session["workspace"] != "north" || session["limited"] != true {
		t.Fatalf("session through the provider = %v", session)
	}
	if rec, out := b.do(http.MethodPost, "/auth/workspace", `{"workspace":"default"}`); rec.Code != http.StatusForbidden || out["code"] != "sso_required" {
		t.Errorf("leaving the provider's workspace: %d %v", rec.Code, out)
	}
	// Nor can that session add a way into the account.
	for _, path := range []string{"/auth/totp/setup", "/auth/passkeys/register/begin", "/auth/password/change"} {
		if rec, _ := b.do(http.MethodPost, path, `{"password":"`+goodPassword+`","current":"`+goodPassword+`"}`); rec.Code != http.StatusForbidden {
			t.Errorf("%s from a provider's session: %d", path, rec.Code)
		}
	}

	// Someone the provider signs in who isn't in the workspace is turned away,
	// and so is an address the provider hasn't verified.
	stranger := f.browser()
	if to := stranger.through(p, "north", "mallory@example.com"); !strings.HasPrefix(to, "/login?error=sso") || stranger.cookie != nil {
		t.Errorf("a stranger through the provider: sent to %q, cookie %v", to, stranger.cookie)
	}
	p.verified = false
	unverified := f.browser()
	if to := unverified.through(p, "north", "ada@example.com"); !strings.HasPrefix(to, "/login?error=sso") || unverified.cookie != nil {
		t.Errorf("an unverified address: sent to %q", to)
	}
	p.verified = true

	// An invitation is taken up by signing in through the provider.
	if _, err := f.auth.Invite(t.Context(), "north", "carol@example.com", false, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	carol := f.browser()
	if to := carol.through(p, "north", "carol@example.com"); to != "/timesheet" || carol.cookie == nil {
		t.Fatalf("an invited address through the provider: sent to %q", to)
	}

	// Required: a password no longer gets into north.
	ada.want(http.StatusNoContent, http.MethodPut, "/auth/sso", `{"issuer":"`+p.URL+`","clientId":"timeclock-client","required":true}`)
	pw := f.browser()
	pw.ip = "198.51.100.90"
	pw.want(http.StatusNoContent, http.MethodPost, "/auth/login", `{"email":"ada@example.com","password":"`+goodPassword+`"}`)
	if s := pw.want(http.StatusOK, http.MethodGet, "/auth/session", ""); s["workspace"] != clock.DefaultWorkspace {
		t.Errorf("a password session's workspace = %v", s["workspace"])
	}
	if rec, out := pw.do(http.MethodPost, "/auth/workspace", `{"workspace":"north"}`); rec.Code != http.StatusForbidden || out["code"] != "sso_required" {
		t.Errorf("entering a provider-only workspace with a password: %d %v", rec.Code, out)
	}
	// Carol is only in north, so a password is no use to her at all.
	if how := f.browser().want(http.StatusOK, http.MethodPost, "/auth/login/start", `{"email":"carol@example.com"}`); how["password"] != false {
		t.Errorf("how carol signs in = %v", how)
	}

	// Anyone the provider signs in joins, when the workspace says so.
	ada.want(http.StatusNoContent, http.MethodPut, "/auth/sso", `{"issuer":"`+p.URL+`","clientId":"timeclock-client","required":true,"autoJoin":true}`)
	dave := f.browser()
	if to := dave.through(p, "north", "dave@example.com"); to != "/timesheet" || dave.cookie == nil {
		t.Fatalf("auto-join through the provider: sent to %q", to)
	}
	id, _ := f.auth.Caller(withCookie(t, dave.cookie))
	if person, err := f.auth.Person(host.WithWorkspace(t.Context(), "north"), id); err != nil || person.Admin || person.Name != "From The Provider" {
		t.Errorf("the person who joined = %+v, %v", person, err)
	}
}

// Behind a proxy the client is the last address the proxy wrote; without
// one, a client's own X-Forwarded-For is ignored.
func TestClientIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	r.RemoteAddr = "192.0.2.10:4000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.7")
	direct := &Auth{}
	if got := direct.clientIP(r); got != "192.0.2.10" {
		t.Errorf("direct: %q, want the connection's address", got)
	}
	proxied := &Auth{cfg: Config{TrustProxy: true}}
	if got := proxied.clientIP(r); got != "198.51.100.7" {
		t.Errorf("proxied: %q, want the address the proxy added", got)
	}
	r.Header.Del("X-Forwarded-For")
	if got := proxied.clientIP(r); got != "192.0.2.10" {
		t.Errorf("proxied, no header: %q, want the connection's address", got)
	}
}
