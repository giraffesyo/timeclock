package standalone

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const cliClientID = "timeclock-cli"
const cliScope = "timeclock"
const cliAccessTTL = 10 * time.Minute
const cliGrantTTL = 30 * 24 * time.Hour

func oauthError(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": description})
}

func cliForm(w http.ResponseWriter, r *http.Request) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") || r.ParseForm() != nil {
		oauthError(w, 400, "invalid_request", "Expected form-encoded parameters.")
		return false
	}
	return true
}

// cliRate bounds creation and code guessing across replicas, using the same
// trusted-proxy address handling as password sign-in.
func (a *Auth) cliRate(w http.ResponseWriter, r *http.Request, purpose string, limit int) bool {
	now := a.now()
	var count int
	err := a.pool.QueryRow(r.Context(), `INSERT INTO cli_rate_limits(key, window_start, count) VALUES ($1,$2,1)
		ON CONFLICT(key) DO UPDATE SET
		count = CASE WHEN cli_rate_limits.window_start < $3 THEN 1 ELSE cli_rate_limits.count + 1 END,
		window_start = CASE WHEN cli_rate_limits.window_start < $3 THEN $2 ELSE cli_rate_limits.window_start END
		RETURNING count`, hashOf(purpose+":"+a.clientIP(r)), now, now.Add(-time.Minute)).Scan(&count)
	if err != nil {
		a.fail(w, r, err)
		return false
	}
	if count > limit {
		w.Header().Set("Retry-After", "60")
		oauthError(w, 429, "slow_down", "Too many requests. Try again in a minute.")
		return false
	}
	return true
}

// Only the registered loopback callback is allowed; never redirect errors to
// unvalidated input. The CLI is a public client and has no client secret.
func cliRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/callback" {
		return false
	}
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return false
	}
	port, err := strconv.Atoi(u.Port())
	return err == nil && port > 0 && port <= 65535
}

func (a *Auth) cliAuthorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	challenge, err := base64.RawURLEncoding.DecodeString(q.Get("code_challenge"))
	if q.Get("client_id") != cliClientID || q.Get("response_type") != "code" || q.Get("scope") != cliScope ||
		!cliRedirect(q.Get("redirect_uri")) || q.Get("code_challenge_method") != "S256" || err != nil || len(challenge) != 32 ||
		len(q.Get("state")) < 32 || len(q.Get("state")) > 256 {
		oauthError(w, 400, "invalid_request", "A loopback redirect, state and S256 PKCE are required.")
		return
	}
	if !a.cliRate(w, r, "authorize", 30) {
		return
	}
	id, hash := newToken()
	_, err = a.pool.Exec(r.Context(), `INSERT INTO cli_requests(request_hash,kind,challenge,redirect_uri,state,expires_at)
		VALUES ($1,'code',$2,$3,$4,$5)`, hash, q.Get("code_challenge"), q.Get("redirect_uri"), q.Get("state"), a.now().Add(10*time.Minute))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/cli?request="+url.QueryEscape(id), http.StatusFound)
}

func (a *Auth) cliDevice(w http.ResponseWriter, r *http.Request) {
	if !cliForm(w, r) {
		return
	}
	if r.PostForm.Get("client_id") != cliClientID || r.PostForm.Get("scope") != cliScope {
		oauthError(w, 400, "invalid_request", "Unknown client or scope.")
		return
	}
	if !a.cliRate(w, r, "device", 30) {
		return
	}
	device, hash := newToken()
	var random [5]byte
	if _, err := rand.Read(random[:]); err != nil {
		a.fail(w, r, err)
		return
	}
	code := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(random[:])
	code = code[:4] + "-" + code[4:]
	_, err := a.pool.Exec(r.Context(), `INSERT INTO cli_requests(request_hash,kind,user_code_hash,expires_at)
		VALUES ($1,'device',$2,$3)`, hash, hashOf(normalizeUserCode(code)), a.now().Add(10*time.Minute))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	verification := strings.TrimRight(a.cfg.PublicURL, "/") + "/cli"
	writeJSON(w, 200, map[string]any{"device_code": device, "user_code": code, "verification_uri": verification,
		"verification_uri_complete": verification + "?user_code=" + url.QueryEscape(code), "expires_in": 600, "interval": 5})
}

func normalizeUserCode(s string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), "-", ""))
}

// cliBrowserSession never accepts bearer tokens. Approval requires the actual
// browser sign-in, with its MFA and workspace SSO restrictions intact.
func (a *Auth) cliBrowserSession(w http.ResponseWriter, r *http.Request) (session, bool) {
	s, ok := a.session(r)
	if !ok || s.workspace == "" {
		oauthError(w, 401, "login_required", "Sign in and select a workspace first.")
		return s, false
	}
	return s, true
}

func (a *Auth) cliDecision(w http.ResponseWriter, r *http.Request) {
	// Requiring JSON also prevents cross-site HTML form submissions.
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		oauthError(w, 400, "invalid_request", "Expected JSON.")
		return
	}
	s, ok := a.cliBrowserSession(w, r)
	if !ok {
		return
	}
	if !a.cliRate(w, r, "decision", 15) {
		return
	}
	var in struct {
		Request   string `json:"request"`
		UserCode  string `json:"userCode"`
		Approve   bool   `json:"approve"`
		Workspace string `json:"workspace"`
	}
	if !read(w, r, &in) {
		return
	}
	if (in.Request == "") == (in.UserCode == "") || in.Workspace != s.workspace {
		oauthError(w, 400, "invalid_request", "Check the request and selected workspace.")
		return
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var ws uuid.UUID
	err = tx.QueryRow(r.Context(), `SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
		WHERE m.account_id=$1 AND w.key=$2 AND (NOT EXISTS(SELECT 1 FROM workspace_sso o WHERE o.workspace_id=w.id AND o.required) OR w.id=$3)`, s.account, s.workspace, s.sso).Scan(&ws)
	if err != nil {
		oauthError(w, 403, "access_denied", "Workspace access requires sign-in again.")
		return
	}
	var hash []byte
	var kind, redirect, state string
	err = tx.QueryRow(r.Context(), `SELECT request_hash,kind,redirect_uri,state FROM cli_requests
		WHERE ((kind='code' AND request_hash=$1) OR (kind='device' AND user_code_hash=$2)) AND status='pending' AND expires_at>$3 FOR UPDATE`,
		hashOf(in.Request), hashOf(normalizeUserCode(in.UserCode)), a.now()).Scan(&hash, &kind, &redirect, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		oauthError(w, 400, "invalid_request", "This request expired, was already answered, or the code is incorrect.")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	status := "denied"
	if in.Approve {
		status = "approved"
	}
	code, codeHash := newToken()
	var sso *uuid.UUID
	if s.sso != uuid.Nil {
		sso = &s.sso
	}
	_, err = tx.Exec(r.Context(), `UPDATE cli_requests SET status=$2,account_id=$3,workspace_id=$4,sso_workspace_id=$5,code_hash=$6,
		expires_at=CASE WHEN kind='code' THEN $7 ELSE expires_at END WHERE request_hash=$1`, hash, status, s.account, ws, sso, codeHash, a.now().Add(time.Minute))
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := map[string]string{}
	if kind == "code" {
		u, _ := url.Parse(redirect)
		q := url.Values{"state": {state}}
		if in.Approve {
			q.Set("code", code)
		} else {
			q.Set("error", "access_denied")
		}
		u.RawQuery = q.Encode()
		out["redirectUrl"] = u.String()
	}
	writeJSON(w, 200, out)
}

type cliTokens struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func (a *Auth) cliIssue(r *http.Request, tx pgx.Tx, grant uuid.UUID) (cliTokens, error) {
	access, ah := newToken()
	refresh, rh := newToken()
	_, err := tx.Exec(r.Context(), `INSERT INTO cli_access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,$3)`, ah, grant, a.now().Add(cliAccessTTL))
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO cli_refresh_tokens(token_hash,grant_id) VALUES($1,$2)`, rh, grant)
	}
	return cliTokens{access, "Bearer", int(cliAccessTTL.Seconds()), refresh, cliScope}, err
}

func (a *Auth) cliToken(w http.ResponseWriter, r *http.Request) {
	if !cliForm(w, r) {
		return
	}
	if r.PostForm.Get("client_id") != cliClientID {
		oauthError(w, 400, "invalid_client", "Unknown client.")
		return
	}
	if !a.cliRate(w, r, "token", 120) {
		return
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var grant uuid.UUID
	if r.PostForm.Get("grant_type") == "refresh_token" {
		var used, revoked, allowed bool
		var expires time.Time
		err = tx.QueryRow(r.Context(), `SELECT g.id,t.used,g.revoked,g.expires_at,
			(acc.disabled_at IS NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.account_id=g.account_id AND m.workspace_id=g.workspace_id)
			AND (NOT EXISTS(SELECT 1 FROM workspace_sso o WHERE o.workspace_id=g.workspace_id AND o.required) OR g.sso_workspace_id=g.workspace_id)) IS TRUE
			FROM cli_refresh_tokens t JOIN cli_grants g ON g.id=t.grant_id JOIN accounts acc ON acc.id=g.account_id WHERE t.token_hash=$1 FOR UPDATE OF g,t`, hashOf(r.PostForm.Get("refresh_token"))).Scan(&grant, &used, &revoked, &expires, &allowed)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			a.fail(w, r, err)
			return
		}
		if used {
			_, err = tx.Exec(r.Context(), `UPDATE cli_grants SET revoked=true WHERE id=$1`, grant)
			if err == nil {
				err = tx.Commit(r.Context())
			}
			if err != nil {
				a.fail(w, r, err)
				return
			}
		}
		if err != nil || used || revoked || !allowed || !expires.After(a.now()) {
			oauthError(w, 400, "invalid_grant", "Sign in again.")
			return
		}
		_, err = tx.Exec(r.Context(), `UPDATE cli_refresh_tokens SET used=true WHERE token_hash=$1`, hashOf(r.PostForm.Get("refresh_token")))
	} else {
		kind, value := "code", r.PostForm.Get("code")
		switch r.PostForm.Get("grant_type") {
		case "authorization_code":
		case "urn:ietf:params:oauth:grant-type:device_code":
			kind = "device"
			value = r.PostForm.Get("device_code")
		default:
			oauthError(w, 400, "unsupported_grant_type", "Unsupported grant type.")
			return
		}
		var hash []byte
		var status, challenge, redirect string
		var account, workspace, sso *uuid.UUID
		var expires, next time.Time
		var interval int
		err = tx.QueryRow(r.Context(), `SELECT request_hash,status,challenge,redirect_uri,account_id,workspace_id,sso_workspace_id,expires_at,next_poll_at,poll_interval
			FROM cli_requests WHERE kind=$1 AND ((kind='code' AND code_hash=$2) OR (kind='device' AND request_hash=$2)) FOR UPDATE`, kind, hashOf(value)).Scan(&hash, &status, &challenge, &redirect, &account, &workspace, &sso, &expires, &next, &interval)
		if errors.Is(err, pgx.ErrNoRows) {
			oauthError(w, 400, "invalid_grant", "Unknown authorization.")
			return
		}
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if !expires.After(a.now()) {
			errorCode := "invalid_grant"
			if kind == "device" {
				errorCode = "expired_token"
			}
			oauthError(w, 400, errorCode, "Authorization expired.")
			return
		}
		if status == "consumed" {
			oauthError(w, 400, "invalid_grant", "Authorization already used.")
			return
		}
		if kind == "device" {
			if next.After(a.now()) {
				_, err = tx.Exec(r.Context(), `UPDATE cli_requests SET poll_interval=poll_interval+5,next_poll_at=$2 WHERE request_hash=$1`, hash, a.now().Add(time.Duration(interval+5)*time.Second))
				if err == nil {
					err = tx.Commit(r.Context())
				}
				if err != nil {
					a.fail(w, r, err)
					return
				}
				oauthError(w, 400, "slow_down", "Increase the polling interval by five seconds.")
				return
			}
			_, err = tx.Exec(r.Context(), `UPDATE cli_requests SET next_poll_at=$2 WHERE request_hash=$1`, hash, a.now().Add(time.Duration(interval)*time.Second))
			if err != nil {
				a.fail(w, r, err)
				return
			}
			if status == "pending" {
				if err = tx.Commit(r.Context()); err != nil {
					a.fail(w, r, err)
					return
				}
				oauthError(w, 400, "authorization_pending", "Waiting for approval.")
				return
			}
		} else {
			v := r.PostForm.Get("code_verifier")
			sum := sha256.Sum256([]byte(v))
			if len(v) < 43 || len(v) > 128 || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge || r.PostForm.Get("redirect_uri") != redirect {
				oauthError(w, 400, "invalid_grant", "PKCE verification failed.")
				return
			}
		}
		if status == "denied" {
			oauthError(w, 400, "access_denied", "Authorization was denied.")
			return
		}
		if status != "approved" || account == nil || workspace == nil {
			oauthError(w, 400, "invalid_grant", "Authorization is incomplete.")
			return
		}
		// Membership and SSO policy may have changed since browser approval.
		var allowed bool
		err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM accounts acc JOIN memberships m ON m.account_id=acc.id
			WHERE acc.id=$1 AND acc.disabled_at IS NULL AND m.workspace_id=$2 AND
			(NOT EXISTS(SELECT 1 FROM workspace_sso o WHERE o.workspace_id=$2 AND o.required) OR $3::uuid=$2))`, account, workspace, sso).Scan(&allowed)
		if err != nil {
			a.fail(w, r, err)
			return
		}
		if !allowed {
			oauthError(w, 400, "invalid_grant", "Workspace access changed; sign in again.")
			return
		}
		grant = uuid.Must(uuid.NewV7())
		_, err = tx.Exec(r.Context(), `INSERT INTO cli_grants(id,account_id,workspace_id,sso_workspace_id,expires_at) VALUES($1,$2,$3,$4,$5)`, grant, account, workspace, sso, a.now().Add(cliGrantTTL))
		if err == nil {
			_, err = tx.Exec(r.Context(), `UPDATE cli_requests SET status='consumed' WHERE request_hash=$1`, hash)
		}
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	tokens, err := a.cliIssue(r, tx, grant)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, 200, tokens)
	// Bound retained state, including spent refresh tokens after grant expiry.
	_, _ = a.pool.Exec(r.Context(), `DELETE FROM cli_requests WHERE expires_at < $1`, a.now().Add(-time.Hour))
	_, _ = a.pool.Exec(r.Context(), `DELETE FROM cli_grants WHERE expires_at < $1`, a.now())
	_, _ = a.pool.Exec(r.Context(), `DELETE FROM cli_access_tokens WHERE expires_at < $1`, a.now())
	_, _ = a.pool.Exec(r.Context(), `DELETE FROM cli_rate_limits WHERE window_start < $1`, a.now().Add(-time.Hour))
}

func (a *Auth) cliRevoke(w http.ResponseWriter, r *http.Request) {
	if !cliForm(w, r) {
		return
	}
	if r.PostForm.Get("client_id") != cliClientID {
		oauthError(w, 400, "invalid_client", "Unknown client.")
		return
	}
	if !a.cliRate(w, r, "revoke", 60) {
		return
	}
	_, err := a.pool.Exec(r.Context(), `UPDATE cli_grants SET revoked=true WHERE id IN (
		SELECT grant_id FROM cli_refresh_tokens WHERE token_hash=$1 UNION SELECT grant_id FROM cli_access_tokens WHERE token_hash=$1)`, hashOf(r.PostForm.Get("token")))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

func (a *Auth) cliBearer(r *http.Request) (session, bool) {
	// API tokens cannot manage account security or approve more devices.
	if !strings.HasPrefix(r.URL.Path, "/api/v1/") {
		return session{}, false
	}
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return session{}, false
	}
	var s session
	err := a.pool.QueryRow(r.Context(), `SELECT g.account_id,w.key FROM cli_access_tokens t
		JOIN cli_grants g ON g.id=t.grant_id JOIN accounts acc ON acc.id=g.account_id
		JOIN workspaces w ON w.id=g.workspace_id JOIN memberships m ON m.account_id=g.account_id AND m.workspace_id=g.workspace_id
		WHERE t.token_hash=$1 AND t.expires_at>$2 AND g.expires_at>$2 AND NOT g.revoked AND acc.disabled_at IS NULL
		AND (NOT EXISTS(SELECT 1 FROM workspace_sso o WHERE o.workspace_id=g.workspace_id AND o.required) OR g.sso_workspace_id=g.workspace_id)`, hashOf(token), a.now()).Scan(&s.account, &s.workspace)
	return s, err == nil
}
