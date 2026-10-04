package standalone

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

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
	auth, err := New(t.Context(), pool, Config{PublicURL: "https://time.example.com", Mailer: mail, AdminEmails: []string{"Pat@Example.com"}})
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
	ip     string
}

func (f *fixture) browser() *browser { return &browser{f: f, ip: "203.0.113.7"} }

func (b *browser) do(method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	b.f.t.Helper()
	req := httptest.NewRequestWithContext(b.f.t.Context(), method, path, strings.NewReader(body))
	req.RemoteAddr = b.ip + ":4000"
	if b.cookie != nil {
		req.AddCookie(b.cookie)
	}
	rec := httptest.NewRecorder()
	b.f.mux.ServeHTTP(rec, req)
	for _, c := range rec.Result().Cookies() {
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
