package standalone

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/foundation/problem"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
)

// Routes registers sign-in and account management under /auth.
func (a *Auth) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/session", a.getSession)
	mux.HandleFunc("POST /auth/login", a.login)
	mux.HandleFunc("POST /auth/logout", a.logout)
	mux.HandleFunc("POST /auth/workspace", a.switchWorkspace)
	mux.HandleFunc("GET /auth/invite", a.getInvite)
	mux.HandleFunc("POST /auth/invite/accept", a.acceptInvite)
	mux.HandleFunc("POST /auth/password/forgot", a.forgotPassword)
	mux.HandleFunc("POST /auth/password/reset", a.resetPassword)
	mux.HandleFunc("POST /auth/password/change", a.changePassword)
	mux.HandleFunc("GET /auth/invites", a.listInvites)
	mux.HandleFunc("POST /auth/invites", a.createInvite)
	mux.HandleFunc("DELETE /auth/invites/{id}", a.revokeInvite)
	mux.HandleFunc("GET /auth/oidc/login", a.oidcLogin)
	mux.HandleFunc("GET /auth/callback", a.oidcCallback)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// read decodes a small JSON body, answering a problem and reporting false
// when it can't.
func read(w http.ResponseWriter, r *http.Request, into any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	if err := dec.Decode(into); err != nil {
		problem.Write(w, problem.Status(http.StatusBadRequest, "the request body is not the JSON this expects"))
		return false
	}
	return true
}

// fail answers a problem; anything else is logged and answered as a 500.
func (a *Auth) fail(w http.ResponseWriter, r *http.Request, err error) {
	if p, ok := errors.AsType[*problem.Problem](err); ok {
		problem.Write(w, p)
		return
	}
	a.cfg.Logger.ErrorContext(r.Context(), "timeclock: sign-in request failed", "path", r.URL.Path, "error", err)
	problem.Write(w, problem.Status(http.StatusInternalServerError, "something went wrong"))
}

var errSignedOut = problem.Status(http.StatusUnauthorized, "sign in to continue")

// --- Slowing down guesses ---

// Failures within this long count together; after freeFailures of them each
// further one pauses sign-in, for longer each time.
const (
	failureWindow = 15 * time.Minute
	freeFailures  = 5
	maxPause      = 15 * time.Minute
)

func clientIP(r *http.Request) string {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// paused reports how long sign-in for any of the keys is still paused.
func (a *Auth) paused(ctx context.Context, keys ...string) (time.Duration, error) {
	var until *time.Time
	err := a.pool.QueryRow(ctx, `SELECT max(locked_until) FROM auth_failures WHERE key = ANY($1)`, keys).Scan(&until)
	if err != nil {
		return 0, fmt.Errorf("check sign-in pause: %w", err)
	}
	if until == nil {
		return 0, nil
	}
	return max(until.Sub(a.now()), 0), nil
}

// failed counts a failed sign-in against each key.
func (a *Auth) failed(ctx context.Context, keys ...string) {
	now := a.now()
	for _, key := range keys {
		var count int
		err := a.pool.QueryRow(ctx, `INSERT INTO auth_failures (key, count, last_at) VALUES ($1, 1, $2)
			ON CONFLICT (key) DO UPDATE SET count = CASE WHEN auth_failures.last_at < $3 THEN 1 ELSE auth_failures.count + 1 END, last_at = $2
			RETURNING count`, key, now, now.Add(-failureWindow)).Scan(&count)
		if err != nil {
			a.cfg.Logger.ErrorContext(ctx, "timeclock: count failed sign-in", "error", err)
			continue
		}
		if over := count - freeFailures; over > 0 {
			pause := min(time.Duration(1<<min(over-1, 10))*30*time.Second, maxPause)
			_, _ = a.pool.Exec(ctx, `UPDATE auth_failures SET locked_until = $2 WHERE key = $1`, key, now.Add(pause))
		}
	}
}

func (a *Auth) succeeded(ctx context.Context, key string) {
	_, _ = a.pool.Exec(ctx, `DELETE FROM auth_failures WHERE key = $1`, key)
}

// --- Session ---

type sessionBody struct {
	Account    Account      `json:"account"`
	Workspaces []Membership `json:"workspaces"`
	// Workspace is the key of the one the session is looking at.
	Workspace string `json:"workspace"`
}

type methodsBody struct {
	// SSO is whether an OpenID Connect provider is offered besides passwords.
	SSO bool `json:"sso"`
}

func (a *Auth) getSession(w http.ResponseWriter, r *http.Request) {
	if a.devID != "" {
		problem.Write(w, problem.Status(http.StatusNotFound, "this server signs everyone in as its development user"))
		return
	}
	s, ok := a.session(r)
	if !ok {
		// Signed out isn't a failure to ask about: the sign-in page asks, and
		// is told what it needs to know.
		writeJSON(w, http.StatusOK, map[string]any{"methods": methodsBody{SSO: a.oauth != nil}})
		return
	}
	var out sessionBody
	out.Workspace = s.workspace
	if err := a.pool.QueryRow(r.Context(), `SELECT id, email, name FROM accounts WHERE id = $1`, s.account).
		Scan(&out.Account.ID, &out.Account.Email, &out.Account.Name); err != nil {
		a.fail(w, r, fmt.Errorf("read account: %w", err))
		return
	}
	list, err := a.memberships(r.Context(), s.account, out.Account.Email)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out.Workspaces = list
	if out.Workspaces == nil {
		out.Workspaces = []Membership{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *Auth) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	email := strings.ToLower(strings.TrimSpace(in.Email))
	byEmail, byIP := "email:"+email, "ip:"+clientIP(r)
	wait, err := a.paused(ctx, byEmail, byIP)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		a.fail(w, r, clock.ErrTooManyAttempts.New(""))
		return
	}
	var id uuid.UUID
	hash := dummyHash
	err = a.pool.QueryRow(ctx, `SELECT id, password_hash FROM accounts WHERE lower(email) = $1 AND disabled_at IS NULL`, email).Scan(&id, &hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.fail(w, r, fmt.Errorf("read account: %w", err))
		return
	}
	if hash == "" { // an account that only signs in through a provider
		hash = dummyHash
		id = uuid.Nil
	}
	// The same work is done whether or not the email is known.
	if !verifyPassword(hash, in.Password) || id == uuid.Nil {
		a.failed(ctx, byEmail, byIP)
		a.fail(w, r, clock.ErrInvalidCredentials.New(""))
		return
	}
	a.succeeded(ctx, byEmail)
	if err := a.start(w, r, id, uuid.Nil); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Auth) logout(w http.ResponseWriter, r *http.Request) {
	if s, ok := a.session(r); ok {
		_, _ = a.pool.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`, s.hash)
	}
	a.clearCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]string{"redirectUrl": "/login"})
}

func (a *Auth) switchWorkspace(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Workspace string `json:"workspace"`
	}
	if !read(w, r, &in) {
		return
	}
	s, ok := a.session(r)
	if !ok {
		a.fail(w, r, errSignedOut)
		return
	}
	tag, err := a.pool.Exec(r.Context(), `UPDATE sessions SET workspace_id = w.id FROM workspaces w, memberships m
		WHERE sessions.token_hash = $1 AND w.key = $2 AND m.workspace_id = w.id AND m.account_id = sessions.account_id`, s.hash, in.Workspace)
	if err != nil {
		a.fail(w, r, fmt.Errorf("switch workspace: %w", err))
		return
	}
	if tag.RowsAffected() == 0 {
		a.fail(w, r, clock.ErrNotAMember.New("").AsDenial())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Invitations ---

type inviteRow struct {
	id        uuid.UUID
	workspace uuid.UUID
	name      string
	email     string
	admin     bool
}

func (a *Auth) invite(ctx context.Context, token string) (inviteRow, error) {
	var i inviteRow
	err := a.pool.QueryRow(ctx, `SELECT i.id, i.workspace_id, w.name, i.email, i.admin FROM invites i JOIN workspaces w ON w.id = i.workspace_id
		WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > $2`, hashOf(token), a.now()).
		Scan(&i.id, &i.workspace, &i.name, &i.email, &i.admin)
	if errors.Is(err, pgx.ErrNoRows) {
		return i, clock.ErrLinkExpired.New("")
	}
	if err != nil {
		return i, fmt.Errorf("read invitation: %w", err)
	}
	return i, nil
}

func (a *Auth) getInvite(w http.ResponseWriter, r *http.Request) {
	i, err := a.invite(r.Context(), r.URL.Query().Get("token"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var exists bool
	if err := a.pool.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM accounts WHERE lower(email) = $1 AND password_hash <> '')`, i.email).Scan(&exists); err != nil {
		a.fail(w, r, fmt.Errorf("check account: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"email": i.email, "workspace": i.name, "hasAccount": exists})
}

// acceptInvite joins the invited address to the workspace. Someone new sets
// their name and password; someone who already has an account proves it
// with their password.
func (a *Auth) acceptInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	i, err := a.invite(ctx, in.Token)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var id uuid.UUID
	var hash string
	err = a.pool.QueryRow(ctx, `SELECT id, password_hash FROM accounts WHERE lower(email) = $1`, i.email).Scan(&id, &hash)
	switch {
	case errors.Is(err, pgx.ErrNoRows) || (err == nil && hash == ""):
		if err := a.checkPassword(ctx, in.Password); err != nil {
			a.fail(w, r, err)
			return
		}
		if hash, err = hashPassword(in.Password); err != nil {
			a.fail(w, r, err)
			return
		}
	case err != nil:
		a.fail(w, r, fmt.Errorf("read account: %w", err))
		return
	default:
		if !verifyPassword(hash, in.Password) {
			a.failed(ctx, "email:"+i.email, "ip:"+clientIP(r))
			a.fail(w, r, clock.ErrInvalidCredentials.New(""))
			return
		}
		hash = ""
	}
	name := strings.TrimSpace(in.Name)
	err = pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		if id == uuid.Nil {
			id = uuid.Must(uuid.NewV7())
			if name == "" {
				name = strings.Split(i.email, "@")[0]
			}
			if _, err := tx.Exec(ctx, `INSERT INTO accounts (id, issuer, subject, email, name, password_hash) VALUES ($1, 'local', $2, $3, $4, $5)`,
				id, id.String(), i.email, name, hash); err != nil {
				return err
			}
		} else if hash != "" { // known through a provider; this gives it a password
			if _, err := tx.Exec(ctx, `UPDATE accounts SET password_hash = $2 WHERE id = $1`, id, hash); err != nil {
				return err
			}
		}
		if err := join(ctx, tx, i.workspace, id, i.admin); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE invites SET accepted_at = $2 WHERE id = $1 AND accepted_at IS NULL`, i.id, a.now())
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return clock.ErrLinkExpired.New("")
		}
		return nil
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.start(w, r, id, i.workspace); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// admin returns the request's session if its account runs the workspace it
// is looking at.
func (a *Auth) admin(r *http.Request) (session, uuid.UUID, error) {
	s, ok := a.session(r)
	if !ok {
		return s, uuid.Nil, errSignedOut
	}
	var ws uuid.UUID
	var admin bool
	var email string
	err := a.pool.QueryRow(r.Context(), `SELECT w.id, m.admin, acc.email FROM memberships m
		JOIN workspaces w ON w.id = m.workspace_id JOIN accounts acc ON acc.id = m.account_id
		WHERE m.account_id = $1 AND w.key = $2`, s.account, s.workspace).Scan(&ws, &admin, &email)
	if err != nil || (!admin && !a.admins[strings.ToLower(email)]) {
		return s, uuid.Nil, problem.Status(http.StatusForbidden, "only an admin invites people").AsDenial()
	}
	return s, ws, nil
}

func (a *Auth) listInvites(w http.ResponseWriter, r *http.Request) {
	_, ws, err := a.admin(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	rows, err := a.pool.Query(r.Context(), `SELECT id, email, admin, expires_at FROM invites
		WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > $2 ORDER BY created_at DESC`, ws, a.now())
	if err != nil {
		a.fail(w, r, fmt.Errorf("list invitations: %w", err))
		return
	}
	type row struct {
		ID        uuid.UUID `json:"id"`
		Email     string    `json:"email"`
		Admin     bool      `json:"admin"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.ID, &x.Email, &x.Admin, &x.ExpiresAt)
		return x, err
	})
	if err != nil {
		a.fail(w, r, fmt.Errorf("list invitations: %w", err))
		return
	}
	if list == nil {
		list = []row{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": list})
}

func (a *Auth) createInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
		Admin bool   `json:"admin"`
	}
	if !read(w, r, &in) {
		return
	}
	s, _, err := a.admin(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \r\n") {
		a.fail(w, r, problem.ValidationFailed(problem.Invalid.At(problem.Pointer("email"), "not an email address")))
		return
	}
	out, err := a.Invite(r.Context(), s.workspace, email, in.Admin, s.account)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	// The link is given back so an admin can pass it on when no email is sent.
	writeJSON(w, http.StatusOK, map[string]any{"id": out.ID, "email": out.Email, "link": out.Link})
}

func (a *Auth) revokeInvite(w http.ResponseWriter, r *http.Request) {
	_, ws, err := a.admin(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, problem.Status(http.StatusNotFound, "invitation not found"))
		return
	}
	if _, err := a.pool.Exec(r.Context(), `DELETE FROM invites WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL`, id, ws); err != nil {
		a.fail(w, r, fmt.Errorf("withdraw invitation: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Passwords ---

// forgotPassword emails a reset link if the address has an account. The
// answer is the same either way, so it doesn't say who has one.
func (a *Auth) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	email := strings.ToLower(strings.TrimSpace(in.Email))
	byIP := "reset-ip:" + clientIP(r)
	if wait, err := a.paused(ctx, byIP, "reset:"+email); err == nil && wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		a.fail(w, r, clock.ErrTooManyAttempts.New(""))
		return
	}
	// Asking counts too, so one address can't be mailed over and over.
	a.failed(ctx, byIP, "reset:"+email)
	var id uuid.UUID
	err := a.pool.QueryRow(ctx, `SELECT id FROM accounts WHERE lower(email) = $1 AND disabled_at IS NULL`, email).Scan(&id)
	if err == nil {
		token, hash := newToken()
		if _, err := a.pool.Exec(ctx, `INSERT INTO password_resets (token_hash, account_id, expires_at) VALUES ($1, $2, $3)`,
			hash, id, a.now().Add(resetTTL)); err != nil {
			a.fail(w, r, fmt.Errorf("record reset: %w", err))
			return
		}
		link := strings.TrimRight(a.cfg.PublicURL, "/") + "/reset?token=" + token
		if err := a.mailer.Send(ctx, host.Message{
			To:      email,
			Subject: "Reset your Timeclock password",
			Text: "Someone asked to reset the password for this address.\n\n" +
				"Choose a new one here:\n" + link + "\n\n" +
				"The link works for an hour, once. If it wasn't you, ignore this: your password hasn't changed.\n",
		}); err != nil {
			a.cfg.Logger.ErrorContext(ctx, "timeclock: reset email not sent", "to", email, "error", err)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		a.fail(w, r, fmt.Errorf("read account: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// resetPassword sets a new password from a reset link, and ends every
// session the account had.
func (a *Auth) resetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	if err := a.checkPassword(ctx, in.Password); err != nil {
		a.fail(w, r, err)
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var id uuid.UUID
	err = pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
			RETURNING account_id`, hashOf(in.Token), a.now()).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return clock.ErrLinkExpired.New("")
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE accounts SET password_hash = $2 WHERE id = $1`, id, hash); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE account_id = $1`, id)
		return err
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if err := a.start(w, r, id, uuid.Nil); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// changePassword sets a new password for the signed-in account, which proves
// itself with the current one. Its other sessions end.
func (a *Auth) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Current  string `json:"current"`
		Password string `json:"password"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	s, ok := a.session(r)
	if !ok {
		a.fail(w, r, errSignedOut)
		return
	}
	var current string
	if err := a.pool.QueryRow(ctx, `SELECT password_hash FROM accounts WHERE id = $1`, s.account).Scan(&current); err != nil {
		a.fail(w, r, fmt.Errorf("read account: %w", err))
		return
	}
	// An account that came in through a provider has no password to prove.
	if current != "" && !verifyPassword(current, in.Current) {
		a.failed(ctx, "account:"+s.account.String())
		a.fail(w, r, clock.ErrInvalidCredentials.New(""))
		return
	}
	if err := a.checkPassword(ctx, in.Password); err != nil {
		a.fail(w, r, err)
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if _, err := a.pool.Exec(ctx, `UPDATE accounts SET password_hash = $2 WHERE id = $1`, s.account, hash); err != nil {
		a.fail(w, r, fmt.Errorf("set password: %w", err))
		return
	}
	if _, err := a.pool.Exec(ctx, `DELETE FROM sessions WHERE account_id = $1 AND token_hash <> $2`, s.account, s.hash); err != nil {
		a.fail(w, r, fmt.Errorf("end other sessions: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Sign-in with a provider ---

func (a *Auth) oidcLogin(w http.ResponseWriter, r *http.Request) {
	next := safeNext(r.URL.Query().Get("next"))
	if a.oauth == nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	ctx := r.Context()
	state, verifier, nonce := newState(), oauth2.GenerateVerifier(), newState()
	if _, err := a.pool.Exec(ctx, `DELETE FROM login_attempts WHERE created_at < $1`, a.now().Add(-attemptTTL)); err != nil {
		a.failPage(w, r, "clear old sign-ins", err)
		return
	}
	if _, err := a.pool.Exec(ctx, `INSERT INTO login_attempts (state, code_verifier, nonce, next) VALUES ($1, $2, $3, $4)`,
		state, verifier, nonce, next); err != nil {
		a.failPage(w, r, "record sign-in", err)
		return
	}
	http.Redirect(w, r, a.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

func newState() string {
	token, _ := newToken()
	return token
}

func (a *Auth) oidcCallback(w http.ResponseWriter, r *http.Request) {
	if a.oauth == nil {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	var verifier, nonce, next string
	err := a.pool.QueryRow(ctx, `DELETE FROM login_attempts WHERE state = $1 AND created_at > $2 RETURNING code_verifier, nonce, next`,
		r.URL.Query().Get("state"), a.now().Add(-attemptTTL)).Scan(&verifier, &nonce, &next)
	if err != nil {
		a.failPage(w, r, "unknown or expired sign-in", err)
		return
	}
	token, err := a.oauth.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		a.failPage(w, r, "exchange code", err)
		return
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		a.failPage(w, r, "no id_token in the provider's response", nil)
		return
	}
	idToken, err := a.verifier.Verify(ctx, raw)
	if err != nil || idToken.Nonce != nonce {
		a.failPage(w, r, "verify id_token", err)
		return
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified *bool  `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Email == "" || (claims.EmailVerified != nil && !*claims.EmailVerified) {
		a.failPage(w, r, "the provider gave no verified email", err)
		return
	}
	email := strings.ToLower(claims.Email)
	if d := a.cfg.AllowedDomain; d != "" && !strings.HasSuffix(email, "@"+strings.ToLower(d)) {
		a.failPage(w, r, "email outside the allowed domain", nil)
		return
	}
	// The provider vouches for the address, so it signs in the account with
	// that address, making one in the default workspace if there is none.
	var id uuid.UUID
	err = pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `INSERT INTO accounts (id, issuer, subject, email, name) VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (lower(email)) DO UPDATE SET issuer = EXCLUDED.issuer, subject = EXCLUDED.subject,
				name = CASE WHEN accounts.name = '' THEN EXCLUDED.name ELSE accounts.name END
			RETURNING id`, uuid.Must(uuid.NewV7()), idToken.Issuer, idToken.Subject, email, claims.Name).Scan(&id)
		if err != nil {
			return err
		}
		var ws uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE key = $1`, clock.DefaultWorkspace).Scan(&ws); err != nil {
			return err
		}
		return join(ctx, tx, ws, id, false)
	})
	if err != nil {
		a.failPage(w, r, "save account", err)
		return
	}
	if err := a.start(w, r, id, uuid.Nil); err != nil {
		a.failPage(w, r, "start session", err)
		return
	}
	http.Redirect(w, r, next, http.StatusFound)
}

// failPage logs why a provider sign-in didn't complete and sends the person
// back to the sign-in page; the reason stays in the log.
func (a *Auth) failPage(w http.ResponseWriter, r *http.Request, what string, err error) {
	a.cfg.Logger.WarnContext(r.Context(), "timeclock: sign-in failed", "reason", what, "error", err)
	http.Redirect(w, r, "/login?error=sso", http.StatusFound)
}
