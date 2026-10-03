// Package standalone gives a Timeclock that runs on its own what a host
// would: accounts, sign-in with an OpenID Connect provider, a session
// cookie, and a directory of the people who signed in.
package standalone

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/host"
)

// Config configures Auth.
type Config struct {
	// Issuer, ClientID and ClientSecret are the OpenID Connect provider,
	// such as https://accounts.google.com. Empty leaves only DevUser.
	Issuer       string
	ClientID     string
	ClientSecret string
	// PublicURL is where people reach Timeclock, for the provider's
	// redirect back to /auth/callback.
	PublicURL string
	// SessionSecret signs session cookies; at least 32 bytes.
	SessionSecret string
	// AllowedDomain, if set, is the only email domain that may sign in.
	AllowedDomain string
	// AdminEmails run payroll.
	AdminEmails []string
	// DevUser, if set, is an email every request is signed in as, with no
	// provider. For development only.
	DevUser string
	Logger  *slog.Logger
}

const (
	cookieName = "timeclock_session"
	sessionTTL = 14 * 24 * time.Hour
	attemptTTL = 10 * time.Minute
)

// Auth is a standalone Timeclock's sign-in and directory.
type Auth struct {
	pool     *pgxpool.Pool
	cfg      Config
	admins   map[string]bool
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config
	devID    string
}

// New discovers the provider, when one is configured, and in development
// makes sure DevUser has an account.
func New(ctx context.Context, pool *pgxpool.Pool, cfg Config) (*Auth, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	a := &Auth{pool: pool, cfg: cfg, admins: map[string]bool{}}
	for _, e := range cfg.AdminEmails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			a.admins[e] = true
		}
	}
	switch {
	case cfg.DevUser != "":
		id, err := a.upsert(ctx, "dev", cfg.DevUser, cfg.DevUser, strings.Split(cfg.DevUser, "@")[0])
		if err != nil {
			return nil, err
		}
		a.devID = id
	case cfg.Issuer != "":
		if len(cfg.SessionSecret) < 32 {
			return nil, errors.New("the session secret must be at least 32 characters")
		}
		provider, err := oidc.NewProvider(ctx, cfg.Issuer)
		if err != nil {
			return nil, fmt.Errorf("discover OIDC provider %s: %w", cfg.Issuer, err)
		}
		a.verifier = provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})
		a.oauth = &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  strings.TrimRight(cfg.PublicURL, "/") + "/auth/callback",
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
		}
	default:
		return nil, errors.New("no sign-in configured: set an OIDC issuer, or a dev user for local work")
	}
	return a, nil
}

func (a *Auth) upsert(ctx context.Context, issuer, subject, email, name string) (string, error) {
	var id uuid.UUID
	err := a.pool.QueryRow(ctx, `INSERT INTO accounts (id, issuer, subject, email, name) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name RETURNING id`,
		uuid.Must(uuid.NewV7()), issuer, subject, email, name).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("save account: %w", err)
	}
	return id.String(), nil
}

// --- host.Directory ---

func (a *Auth) person(id uuid.UUID, email, name string) host.Person {
	if name == "" {
		name = email
	}
	return host.Person{ID: id.String(), Name: name, Email: email, Admin: a.admins[strings.ToLower(email)]}
}

// Person returns the account with the given id.
func (a *Auth) Person(ctx context.Context, id string) (host.Person, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return host.Person{}, host.ErrNotFound
	}
	var email, name string
	err = a.pool.QueryRow(ctx, `SELECT email, name FROM accounts WHERE id = $1`, parsed).Scan(&email, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return host.Person{}, host.ErrNotFound
	}
	if err != nil {
		return host.Person{}, fmt.Errorf("read account: %w", err)
	}
	return a.person(parsed, email, name), nil
}

// People lists every account.
func (a *Auth) People(ctx context.Context) ([]host.Person, error) {
	rows, err := a.pool.Query(ctx, `SELECT id, email, name FROM accounts ORDER BY lower(name)`)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	var out []host.Person
	var id uuid.UUID
	var email, name string
	if _, err := pgx.ForEachRow(rows, []any{&id, &email, &name}, func() error {
		out = append(out, a.person(id, email, name))
		return nil
	}); err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	return out, nil
}

// --- Sessions ---

// sign returns the session cookie value for an account: its id, when it
// expires, and an HMAC over both.
func (a *Auth) sign(id string, expires time.Time) string {
	payload := id + "." + strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(a.cfg.SessionSecret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Caller returns the signed-in account of a request.
func (a *Auth) Caller(r *http.Request) (string, bool) {
	if a.devID != "" {
		return a.devID, true
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return "", false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return "", false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > expires {
		return "", false
	}
	if !hmac.Equal([]byte(a.sign(parts[0], time.Unix(expires, 0))), []byte(c.Value)) {
		return "", false
	}
	return parts[0], true
}

func secure(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// safeNext keeps a return path on this site.
func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, `/\`) {
		return "/"
	}
	return next
}

// Routes registers /auth/login, /auth/callback and /auth/logout.
func (a *Auth) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/login", a.login)
	mux.HandleFunc("GET /auth/callback", a.callback)
	mux.HandleFunc("POST /auth/logout", a.logout)
}

func (a *Auth) login(w http.ResponseWriter, r *http.Request) {
	next := safeNext(r.URL.Query().Get("next"))
	if a.oauth == nil { // development: already signed in
		http.Redirect(w, r, next, http.StatusFound)
		return
	}
	ctx := r.Context()
	state, verifier, nonce := rand.Text(), oauth2.GenerateVerifier(), rand.Text()
	if _, err := a.pool.Exec(ctx, `DELETE FROM login_attempts WHERE created_at < $1`, time.Now().Add(-attemptTTL)); err != nil {
		a.fail(w, r, "clear old sign-ins", err)
		return
	}
	if _, err := a.pool.Exec(ctx, `INSERT INTO login_attempts (state, code_verifier, nonce, next) VALUES ($1, $2, $3, $4)`,
		state, verifier, nonce, next); err != nil {
		a.fail(w, r, "record sign-in", err)
		return
	}
	http.Redirect(w, r, a.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

func (a *Auth) callback(w http.ResponseWriter, r *http.Request) {
	if a.oauth == nil {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	var verifier, nonce, next string
	err := a.pool.QueryRow(ctx, `DELETE FROM login_attempts WHERE state = $1 AND created_at > $2 RETURNING code_verifier, nonce, next`,
		r.URL.Query().Get("state"), time.Now().Add(-attemptTTL)).Scan(&verifier, &nonce, &next)
	if err != nil {
		a.fail(w, r, "unknown or expired sign-in", err)
		return
	}
	token, err := a.oauth.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		a.fail(w, r, "exchange code", err)
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		a.fail(w, r, "no id_token in the provider's response", nil)
		return
	}
	idToken, err := a.verifier.Verify(ctx, raw)
	if err != nil || idToken.Nonce != nonce {
		a.fail(w, r, "verify id_token", err)
		return
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified *bool  `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Email == "" || (claims.EmailVerified != nil && !*claims.EmailVerified) {
		a.fail(w, r, "the provider gave no verified email", err)
		return
	}
	if d := a.cfg.AllowedDomain; d != "" && !strings.HasSuffix(strings.ToLower(claims.Email), "@"+strings.ToLower(d)) {
		a.fail(w, r, "email outside the allowed domain", nil)
		return
	}
	id, err := a.upsert(ctx, idToken.Issuer, idToken.Subject, claims.Email, claims.Name)
	if err != nil {
		a.fail(w, r, "save account", err)
		return
	}
	expires := time.Now().Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: a.sign(id, expires), Path: "/", Expires: expires,
		HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, next, http.StatusFound)
}

func (a *Auth) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/", MaxAge: -1, HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"redirectUrl":"/"}`))
}

// fail logs why a sign-in didn't complete and shows the person a plain
// page; the reason stays in the log.
func (a *Auth) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	a.cfg.Logger.WarnContext(r.Context(), "timeclock: sign-in failed", "reason", what, "error", err)
	http.Error(w, "Sign-in didn't complete. Go back and try again.", http.StatusBadRequest)
}
