package standalone

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/foundation/problem"

	"github.com/giraffesyo/timeclock/internal/clock"
)

const (
	ceremonyCookie = "timeclock_passkey"
	ceremonyTTL    = 5 * time.Minute
)

// newWebAuthn is the relying party: the site people reach Timeclock at.
func newWebAuthn(publicURL string) (*webauthn.WebAuthn, error) {
	u, err := url.Parse(publicURL)
	if err != nil || u.Hostname() == "" {
		return nil, fmt.Errorf("the public URL %q has no host", publicURL)
	}
	return webauthn.New(&webauthn.Config{
		RPDisplayName: "Timeclock",
		RPID:          u.Hostname(),
		RPOrigins:     []string{u.Scheme + "://" + u.Host},
	})
}

// passkeyUser is an account as the WebAuthn library sees it.
type passkeyUser struct {
	id          uuid.UUID
	email, name string
	credentials []webauthn.Credential
}

func (u passkeyUser) WebAuthnID() []byte                         { return u.id[:] }
func (u passkeyUser) WebAuthnName() string                       { return u.email }
func (u passkeyUser) WebAuthnDisplayName() string                { return u.name }
func (u passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func (a *Auth) passkeyUser(ctx context.Context, account uuid.UUID) (passkeyUser, error) {
	u := passkeyUser{id: account}
	if err := a.pool.QueryRow(ctx, `SELECT email, name FROM accounts WHERE id = $1 AND disabled_at IS NULL`, account).Scan(&u.email, &u.name); err != nil {
		return u, fmt.Errorf("read account: %w", err)
	}
	rows, err := a.pool.Query(ctx, `SELECT credential FROM passkeys WHERE account_id = $1`, account)
	if err != nil {
		return u, fmt.Errorf("read passkeys: %w", err)
	}
	var raw []byte
	if _, err := pgx.ForEachRow(rows, []any{&raw}, func() error {
		var c webauthn.Credential
		if err := json.Unmarshal(raw, &c); err != nil {
			return err
		}
		u.credentials = append(u.credentials, c)
		return nil
	}); err != nil {
		return u, fmt.Errorf("read passkeys: %w", err)
	}
	return u, nil
}

// Passkey is a passkey as its owner sees it.
type Passkey struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

func (a *Auth) listPasskeys(ctx context.Context, account uuid.UUID) ([]Passkey, error) {
	rows, err := a.pool.Query(ctx, `SELECT id, name, created_at, last_used_at FROM passkeys WHERE account_id = $1 ORDER BY created_at`, account)
	if err != nil {
		return nil, fmt.Errorf("list passkeys: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Passkey, error) {
		var p Passkey
		err := row.Scan(&p.ID, &p.Name, &p.CreatedAt, &p.LastUsedAt)
		return p, err
	})
	if err != nil {
		return nil, fmt.Errorf("list passkeys: %w", err)
	}
	if out == nil {
		out = []Passkey{}
	}
	return out, nil
}

// begin keeps a ceremony's challenge between its two requests, under a
// cookie of its own.
func (a *Auth) begin(w http.ResponseWriter, r *http.Request, account uuid.UUID, session *webauthn.SessionData) error {
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	token, hash := newToken()
	now := a.now()
	var owner *uuid.UUID
	if account != uuid.Nil {
		owner = &account
	}
	if _, err := a.pool.Exec(r.Context(), `DELETE FROM webauthn_ceremonies WHERE expires_at < $1`, now); err != nil {
		return fmt.Errorf("clear old ceremonies: %w", err)
	}
	if _, err := a.pool.Exec(r.Context(), `INSERT INTO webauthn_ceremonies (token_hash, account_id, session, expires_at) VALUES ($1, $2, $3, $4)`,
		hash, owner, raw, now.Add(ceremonyTTL)); err != nil {
		return fmt.Errorf("keep ceremony: %w", err)
	}
	http.SetCookie(w, &http.Cookie{
		Name: ceremonyCookie, Value: token, Path: "/auth", MaxAge: int(ceremonyTTL.Seconds()),
		HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// ceremony takes back the challenge a ceremony began with. It can be
// finished once.
func (a *Auth) ceremony(w http.ResponseWriter, r *http.Request) (webauthn.SessionData, uuid.UUID, error) {
	var session webauthn.SessionData
	c, err := r.Cookie(ceremonyCookie)
	if err != nil || c.Value == "" {
		return session, uuid.Nil, clock.ErrLinkExpired.New("start again")
	}
	http.SetCookie(w, &http.Cookie{Name: ceremonyCookie, Path: "/auth", MaxAge: -1, HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode})
	var raw []byte
	var owner *uuid.UUID
	err = a.pool.QueryRow(r.Context(), `DELETE FROM webauthn_ceremonies WHERE token_hash = $1 AND expires_at > $2 RETURNING session, account_id`,
		hashOf(c.Value), a.now()).Scan(&raw, &owner)
	if err != nil {
		return session, uuid.Nil, clock.ErrLinkExpired.New("start again")
	}
	if err := json.Unmarshal(raw, &session); err != nil {
		return session, uuid.Nil, err
	}
	if owner != nil {
		return session, *owner, nil
	}
	return session, uuid.Nil, nil
}

// A passkey here is discoverable and verifies its user (a fingerprint, a
// face, a PIN), so it is a whole sign-in on its own.
var passkeySelection = protocol.AuthenticatorSelection{
	ResidentKey:      protocol.ResidentKeyRequirementRequired,
	UserVerification: protocol.VerificationRequired,
}

func (a *Auth) passkeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var in struct {
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
	if err := a.confirmPassword(ctx, s, in.Password); err != nil {
		a.fail(w, r, err)
		return
	}
	user, err := a.passkeyUser(ctx, s.account)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var exclude []protocol.CredentialDescriptor
	for _, c := range user.credentials {
		exclude = append(exclude, c.Descriptor())
	}
	options, session, err := a.webauthn.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(passkeySelection), webauthn.WithExclusions(exclude))
	if err != nil {
		a.fail(w, r, fmt.Errorf("begin passkey registration: %w", err))
		return
	}
	if err := a.begin(w, r, s.account, session); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, options)
}

func (a *Auth) passkeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s, ok := a.session(r)
	if !ok {
		a.fail(w, r, errSignedOut)
		return
	}
	var in struct {
		Name       string          `json:"name"`
		Credential json.RawMessage `json:"credential"`
	}
	if !readLarge(w, r, &in) {
		return
	}
	session, owner, err := a.ceremony(w, r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if owner != s.account {
		a.fail(w, r, clock.ErrLinkExpired.New("start again"))
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(strings.NewReader(string(in.Credential)))
	if err != nil {
		a.fail(w, r, problem.Status(http.StatusBadRequest, "the passkey's answer couldn't be read"))
		return
	}
	user, err := a.passkeyUser(ctx, s.account)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	credential, err := a.webauthn.CreateCredential(user, session, parsed)
	if err != nil {
		a.cfg.Logger.WarnContext(ctx, "timeclock: passkey registration refused", "error", err)
		a.fail(w, r, clock.ErrPasskeyRefused.New(""))
		return
	}
	raw, err := json.Marshal(credential)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "Passkey"
	}
	out := Passkey{ID: uuid.Must(uuid.NewV7()), Name: name, CreatedAt: a.now()}
	if _, err := a.pool.Exec(ctx, `INSERT INTO passkeys (id, account_id, credential_id, name, credential, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
		out.ID, s.account, credential.ID, name, raw, out.CreatedAt); err != nil {
		a.fail(w, r, fmt.Errorf("save passkey: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *Auth) passkeyDelete(w http.ResponseWriter, r *http.Request) {
	s, ok := a.session(r)
	if !ok {
		a.fail(w, r, errSignedOut)
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		a.fail(w, r, problem.Status(http.StatusNotFound, "passkey not found"))
		return
	}
	if _, err := a.pool.Exec(r.Context(), `DELETE FROM passkeys WHERE id = $1 AND account_id = $2`, id, s.account); err != nil {
		a.fail(w, r, fmt.Errorf("remove passkey: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// passkeyLoginBegin starts a sign-in with a passkey. It names no account:
// the passkey says whose it is.
func (a *Auth) passkeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	options, session, err := a.webauthn.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		a.fail(w, r, fmt.Errorf("begin passkey sign-in: %w", err))
		return
	}
	if err := a.begin(w, r, uuid.Nil, session); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, options)
}

func (a *Auth) passkeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	byIP := "ip:" + a.clientIP(r)
	if wait, err := a.paused(ctx, byIP); err == nil && wait > 0 {
		a.tooMany(w, r, wait)
		return
	}
	session, _, err := a.ceremony(w, r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		a.fail(w, r, problem.Status(http.StatusBadRequest, "the passkey's answer couldn't be read"))
		return
	}
	var account uuid.UUID
	_, credential, err := a.webauthn.ValidatePasskeyLogin(func(_, userHandle []byte) (webauthn.User, error) {
		id, err := uuid.FromBytes(userHandle)
		if err != nil {
			return nil, errors.New("unknown passkey")
		}
		account = id
		return a.passkeyUser(ctx, id)
	}, session, parsed)
	if err != nil {
		a.cfg.Logger.WarnContext(ctx, "timeclock: passkey sign-in refused", "error", err)
		a.failed(ctx, byIP)
		a.fail(w, r, clock.ErrPasskeyRefused.New(""))
		return
	}
	// The signature counter moved on; a copy of the passkey would fall behind it.
	raw, err := json.Marshal(credential)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if _, err := a.pool.Exec(ctx, `UPDATE passkeys SET credential = $2, last_used_at = $3 WHERE credential_id = $1`, credential.ID, raw, a.now()); err != nil {
		a.fail(w, r, fmt.Errorf("note passkey use: %w", err))
		return
	}
	if err := a.start(w, r, account, uuid.Nil, uuid.Nil); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
