package standalone

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/parallelworks/foundation/problem"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/internal/clock"
)

// A workspace can have its own OpenID Connect provider. What that provider
// says counts in that workspace and nowhere else: a session that came in
// through it sees only that workspace, and can't change how the account
// signs in. Otherwise whoever runs one workspace's provider could sign in
// as anyone, everywhere.

type ssoConfig struct {
	workspace    uuid.UUID
	issuer       string
	clientID     string
	clientSecret string
	required     bool
	autoJoin     bool
}

func (a *Auth) ssoOf(ctx context.Context, workspaceKey string) (ssoConfig, error) {
	var c ssoConfig
	var sealed []byte
	err := a.pool.QueryRow(ctx, `SELECT w.id, o.issuer, o.client_id, o.client_secret, o.required, o.auto_join
		FROM workspace_sso o JOIN workspaces w ON w.id = o.workspace_id WHERE w.key = $1`, workspaceKey).
		Scan(&c.workspace, &c.issuer, &c.clientID, &sealed, &c.required, &c.autoJoin)
	if err != nil {
		return c, err
	}
	secret, err := a.box.open(sealed)
	if err != nil {
		return c, fmt.Errorf("open the provider's client secret: %w", err)
	}
	c.clientSecret = string(secret)
	return c, nil
}

// provider discovers an issuer's endpoints and keys, once.
func (a *Auth) provider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	if p, ok := a.providers.Load(issuer); ok {
		return p.(*oidc.Provider), nil
	}
	// Discovery outlives the request that first asks for it.
	p, err := oidc.NewProvider(context.WithoutCancel(ctx), issuer)
	if err != nil {
		return nil, err
	}
	a.providers.Store(issuer, p)
	return p, nil
}

func (a *Auth) redirectURL() string {
	return strings.TrimRight(a.cfg.PublicURL, "/") + "/auth/callback"
}

func (a *Auth) oauthFor(p *oidc.Provider, c ssoConfig) *oauth2.Config {
	return &oauth2.Config{
		ClientID: c.clientID, ClientSecret: c.clientSecret, Endpoint: p.Endpoint(),
		RedirectURL: a.redirectURL(), Scopes: []string{oidc.ScopeOpenID, "email", "profile"},
	}
}

// --- Settings, for the workspace's admins ---

func (a *Auth) getSSO(w http.ResponseWriter, r *http.Request) {
	s, _, err := a.admin(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := map[string]any{"configured": false, "redirectUrl": a.redirectURL()}
	c, err := a.ssoOf(r.Context(), s.workspace)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		a.fail(w, r, fmt.Errorf("read single sign-on: %w", err))
		return
	default:
		out["configured"], out["issuer"], out["clientId"] = true, c.issuer, c.clientID
		out["required"], out["autoJoin"] = c.required, c.autoJoin
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *Auth) putSSO(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Issuer   string `json:"issuer"`
		ClientID string `json:"clientId"`
		// ClientSecret, when empty, keeps the one already saved.
		ClientSecret string `json:"clientSecret"`
		Required     bool   `json:"required"`
		AutoJoin     bool   `json:"autoJoin"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	s, ws, err := a.admin(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	in.Issuer, in.ClientID = strings.TrimSpace(in.Issuer), strings.TrimSpace(in.ClientID)
	if u, err := url.Parse(in.Issuer); err != nil || (u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1") {
		a.fail(w, r, problem.ValidationFailed(problem.Invalid.At(problem.Pointer("issuer"), "must be an https:// address")))
		return
	}
	if in.ClientID == "" {
		a.fail(w, r, problem.ValidationFailed(problem.Required.At(problem.Pointer("clientId"), "required")))
		return
	}
	// The address must really be a provider before anyone is sent to it.
	if _, err := a.provider(ctx, in.Issuer); err != nil {
		a.cfg.Logger.WarnContext(ctx, "timeclock: provider discovery failed", "issuer", in.Issuer, "error", err)
		a.fail(w, r, problem.ValidationFailed(problem.Invalid.At(problem.Pointer("issuer"), "no OpenID Connect provider answers at this address")))
		return
	}
	var sealed []byte
	if in.ClientSecret != "" {
		if sealed, err = a.box.seal([]byte(in.ClientSecret)); err != nil {
			a.fail(w, r, err)
			return
		}
	}
	err = pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		var tag pgconn.CommandTag
		var err error
		if sealed == nil {
			// No new secret: the provider's other settings change, and it keeps the one it has.
			tag, err = tx.Exec(ctx, `UPDATE workspace_sso SET issuer = $2, client_id = $3, required = $4, auto_join = $5, updated_at = now()
				WHERE workspace_id = $1`, ws, in.Issuer, in.ClientID, in.Required, in.AutoJoin)
		} else {
			tag, err = tx.Exec(ctx, `INSERT INTO workspace_sso (workspace_id, issuer, client_id, client_secret, required, auto_join)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (workspace_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
					client_secret = EXCLUDED.client_secret, required = EXCLUDED.required, auto_join = EXCLUDED.auto_join, updated_at = now()`,
				ws, in.Issuer, in.ClientID, sealed, in.Required, in.AutoJoin)
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return problem.ValidationFailed(problem.Required.At(problem.Pointer("clientSecret"), "required"))
		}
		if in.Required {
			// Sessions that got in with a password stop seeing the workspace,
			// except the admin's own, so they can undo a provider that doesn't work.
			_, err = tx.Exec(ctx, `UPDATE sessions SET workspace_id = NULL
				WHERE workspace_id = $1 AND sso_workspace_id IS DISTINCT FROM $1 AND token_hash <> $2`, ws, s.hash)
		}
		return err
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Auth) deleteSSO(w http.ResponseWriter, r *http.Request) {
	_, ws, err := a.admin(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if _, err := a.pool.Exec(r.Context(), `DELETE FROM workspace_sso WHERE workspace_id = $1`, ws); err != nil {
		a.fail(w, r, fmt.Errorf("remove single sign-on: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Signing in ---

// loginStart answers how an email address signs in: which of its workspaces
// have a provider, and whether a password will do at all.
func (a *Auth) loginStart(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	email := strings.ToLower(strings.TrimSpace(in.Email))
	// Workspaces the address belongs to, or is invited to, that have a provider.
	rows, err := a.pool.Query(ctx, `SELECT DISTINCT w.key, w.name, o.required FROM workspace_sso o JOIN workspaces w ON w.id = o.workspace_id
		WHERE o.auto_join = false AND (
			EXISTS (SELECT 1 FROM memberships m JOIN accounts acc ON acc.id = m.account_id WHERE m.workspace_id = w.id AND lower(acc.email) = $1)
			OR EXISTS (SELECT 1 FROM invites i WHERE i.workspace_id = w.id AND lower(i.email) = $1 AND i.accepted_at IS NULL AND i.expires_at > $2))
		ORDER BY w.name, w.key`, email, a.now())
	if err != nil {
		a.fail(w, r, fmt.Errorf("find providers: %w", err))
		return
	}
	type provider struct {
		Workspace string `json:"workspace"`
		Name      string `json:"name"`
	}
	list := []provider{}
	required := 0
	var key, name string
	var req bool
	if _, err := pgx.ForEachRow(rows, []any{&key, &name, &req}, func() error {
		list = append(list, provider{Workspace: key, Name: name})
		if req {
			required++
		}
		return nil
	}); err != nil {
		a.fail(w, r, fmt.Errorf("find providers: %w", err))
		return
	}
	// A password is no use to someone whose every workspace requires its provider.
	var open int
	if err := a.pool.QueryRow(ctx, `SELECT count(*) FROM memberships m JOIN accounts acc ON acc.id = m.account_id
		WHERE lower(acc.email) = $1 AND NOT EXISTS (SELECT 1 FROM workspace_sso o WHERE o.workspace_id = m.workspace_id AND o.required)`, email).Scan(&open); err != nil {
		a.fail(w, r, fmt.Errorf("count workspaces: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sso": list, "password": required == 0 || open > 0})
}

// ssoLogin sends the browser to a workspace's provider.
func (a *Auth) ssoLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := a.ssoOf(ctx, r.URL.Query().Get("workspace"))
	if err != nil {
		a.failPage(w, r, "no provider for the workspace", err)
		return
	}
	p, err := a.provider(ctx, c.issuer)
	if err != nil {
		a.failPage(w, r, "discover provider", err)
		return
	}
	a.redirectToProvider(w, r, a.oauthFor(p, c), &c.workspace)
}

// redirectToProvider remembers a sign-in on its way out and sends the
// browser to the provider.
func (a *Auth) redirectToProvider(w http.ResponseWriter, r *http.Request, oauth *oauth2.Config, workspace *uuid.UUID) {
	ctx := r.Context()
	next := safeNext(r.URL.Query().Get("next"))
	state, verifier, nonce := newState(), oauth2.GenerateVerifier(), newState()
	if _, err := a.pool.Exec(ctx, `DELETE FROM login_attempts WHERE created_at < $1`, a.now().Add(-attemptTTL)); err != nil {
		a.failPage(w, r, "clear old sign-ins", err)
		return
	}
	if _, err := a.pool.Exec(ctx, `INSERT INTO login_attempts (state, code_verifier, nonce, next, workspace_id) VALUES ($1, $2, $3, $4, $5)`,
		state, verifier, nonce, next, workspace); err != nil {
		a.failPage(w, r, "record sign-in", err)
		return
	}
	http.Redirect(w, r, oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

// enterBySSO signs in the address a workspace's provider vouched for, into
// that workspace only. It must already belong, be invited, or the workspace
// must take anyone its provider signs in.
func (a *Auth) enterBySSO(ctx context.Context, c ssoConfig, issuer, subject, email, name string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		var member, admin bool
		err := tx.QueryRow(ctx, `SELECT acc.id, m.account_id IS NOT NULL FROM accounts acc
			LEFT JOIN memberships m ON m.account_id = acc.id AND m.workspace_id = $2
			WHERE lower(acc.email) = $1 AND acc.disabled_at IS NULL`, email, c.workspace).Scan(&id, &member)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if member {
			return nil
		}
		var invite uuid.UUID
		err = tx.QueryRow(ctx, `UPDATE invites SET accepted_at = $3 WHERE workspace_id = $1 AND lower(email) = $2
			AND accepted_at IS NULL AND expires_at > $3 RETURNING id, admin`, c.workspace, email, a.now()).Scan(&invite, &admin)
		if errors.Is(err, pgx.ErrNoRows) {
			if !c.autoJoin {
				return clock.ErrNotAMember.New("")
			}
		} else if err != nil {
			return err
		}
		if id == uuid.Nil {
			id = uuid.Must(uuid.NewV7())
			if name == "" {
				name = strings.Split(email, "@")[0]
			}
			if _, err := tx.Exec(ctx, `INSERT INTO accounts (id, issuer, subject, email, name) VALUES ($1, $2, $3, $4, $5)`,
				id, issuer, subject, email, name); err != nil {
				return err
			}
		}
		return join(ctx, tx, c.workspace, id, admin)
	})
	return id, err
}
