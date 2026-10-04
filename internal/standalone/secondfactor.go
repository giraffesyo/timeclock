package standalone

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/foundation/problem"

	"github.com/giraffesyo/timeclock/internal/clock"
)

const (
	pendingCookie = "timeclock_pending"
	pendingTTL    = 5 * time.Minute
)

// factors is what an account has set up beyond its password.
type factors struct {
	TOTP     bool `json:"totp"`
	Passkeys int  `json:"passkeys"`
}

func (a *Auth) factors(ctx context.Context, account uuid.UUID) (factors, error) {
	var f factors
	err := a.pool.QueryRow(ctx, `SELECT totp_confirmed_at IS NOT NULL, (SELECT count(*) FROM passkeys WHERE account_id = $1)
		FROM accounts WHERE id = $1`, account).Scan(&f.TOTP, &f.Passkeys)
	if err != nil {
		return f, fmt.Errorf("read sign-in methods: %w", err)
	}
	return f, nil
}

// hold remembers that an account gave the right password and still owes a
// second step, in a short-lived cookie of its own.
func (a *Auth) hold(w http.ResponseWriter, r *http.Request, account uuid.UUID) error {
	token, hash := newToken()
	now := a.now()
	if _, err := a.pool.Exec(r.Context(), `DELETE FROM pending_logins WHERE expires_at < $1`, now); err != nil {
		return fmt.Errorf("clear old sign-ins: %w", err)
	}
	if _, err := a.pool.Exec(r.Context(), `INSERT INTO pending_logins (token_hash, account_id, expires_at) VALUES ($1, $2, $3)`,
		hash, account, now.Add(pendingTTL)); err != nil {
		return fmt.Errorf("hold sign-in: %w", err)
	}
	http.SetCookie(w, &http.Cookie{
		Name: pendingCookie, Value: token, Path: "/auth", MaxAge: int(pendingTTL.Seconds()),
		HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// held is the account whose password was just accepted in this browser.
func (a *Auth) held(r *http.Request) (uuid.UUID, []byte, bool) {
	c, err := r.Cookie(pendingCookie)
	if err != nil || c.Value == "" {
		return uuid.Nil, nil, false
	}
	hash := hashOf(c.Value)
	var id uuid.UUID
	if err := a.pool.QueryRow(r.Context(), `SELECT account_id FROM pending_logins WHERE token_hash = $1 AND expires_at > $2`,
		hash, a.now()).Scan(&id); err != nil {
		return uuid.Nil, nil, false
	}
	return id, hash, true
}

// finish turns a held sign-in into a session.
func (a *Auth) finish(w http.ResponseWriter, r *http.Request, account uuid.UUID, hash []byte) error {
	if _, err := a.pool.Exec(r.Context(), `DELETE FROM pending_logins WHERE token_hash = $1`, hash); err != nil {
		return fmt.Errorf("finish sign-in: %w", err)
	}
	http.SetCookie(w, &http.Cookie{Name: pendingCookie, Path: "/auth", MaxAge: -1, HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode})
	return a.start(w, r, account, uuid.Nil, uuid.Nil)
}

// checkTOTP reports whether code is the account's current authenticator
// code, and uses it up: the same code doesn't work twice.
func (a *Auth) checkTOTP(ctx context.Context, account uuid.UUID, code string, confirmed bool) (bool, error) {
	var sealed []byte
	var last int64
	err := a.pool.QueryRow(ctx, `SELECT totp_secret, totp_last_step FROM accounts
		WHERE id = $1 AND totp_secret IS NOT NULL AND (totp_confirmed_at IS NOT NULL) = $2`, account, confirmed).Scan(&sealed, &last)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read authenticator: %w", err)
	}
	secret, err := a.box.open(sealed)
	if err != nil {
		return false, fmt.Errorf("open authenticator secret: %w", err)
	}
	step := totpStep(secret, code, a.now())
	if step == 0 || step <= last {
		return false, nil
	}
	tag, err := a.pool.Exec(ctx, `UPDATE accounts SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2`, account, step)
	if err != nil {
		return false, fmt.Errorf("use authenticator code: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// loginSecond completes a sign-in with an authenticator code or a recovery code.
func (a *Auth) loginSecond(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code     string `json:"code"`
		Recovery string `json:"recovery"`
	}
	if !read(w, r, &in) {
		return
	}
	ctx := r.Context()
	account, hash, ok := a.held(r)
	if !ok {
		a.fail(w, r, clock.ErrLinkExpired.New("sign in again"))
		return
	}
	key := "second:" + account.String()
	if wait, err := a.paused(ctx, key); err != nil || wait > 0 {
		if err != nil {
			a.fail(w, r, err)
			return
		}
		a.tooMany(w, r, wait)
		return
	}
	var good bool
	var err error
	if in.Recovery != "" {
		var tag interface{ RowsAffected() int64 }
		tag, err = a.pool.Exec(ctx, `UPDATE recovery_codes SET used_at = $3 WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL`,
			account, hashOf(normalizeRecovery(in.Recovery)), a.now())
		good = err == nil && normalizeRecovery(in.Recovery) != "" && tag.RowsAffected() == 1
	} else {
		good, err = a.checkTOTP(ctx, account, in.Code, true)
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if !good {
		a.failed(ctx, key)
		a.fail(w, r, clock.ErrInvalidCode.New(""))
		return
	}
	a.succeeded(ctx, key)
	if err := a.finish(w, r, account, hash); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// confirmPassword checks the signed-in account's password again, which the
// changes to how it signs in ask for. An account with no password (it came
// in through a provider) has nothing to confirm.
func (a *Auth) confirmPassword(ctx context.Context, s session, password string) error {
	// One workspace's provider vouched for this session, so it doesn't get
	// to add ways into the account's other workspaces.
	if s.sso != uuid.Nil {
		return clock.ErrSSORequired.New("sign in with your password to change how you sign in").AsDenial()
	}
	account := s.account
	var hash string
	if err := a.pool.QueryRow(ctx, `SELECT password_hash FROM accounts WHERE id = $1`, account).Scan(&hash); err != nil {
		return fmt.Errorf("read account: %w", err)
	}
	if hash == "" {
		return nil
	}
	key := "account:" + account.String()
	if wait, err := a.paused(ctx, key); err != nil {
		return err
	} else if wait > 0 {
		return clock.ErrTooManyAttempts.New("")
	}
	if !verifyPassword(hash, password) {
		a.failed(ctx, key)
		return clock.ErrInvalidCredentials.New("")
	}
	return nil
}

func (a *Auth) getSecurity(w http.ResponseWriter, r *http.Request) {
	s, ok := a.session(r)
	if !ok {
		a.fail(w, r, errSignedOut)
		return
	}
	f, err := a.factors(r.Context(), s.account)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var codes int
	var hasPassword bool
	if err := a.pool.QueryRow(r.Context(), `SELECT (SELECT count(*) FROM recovery_codes WHERE account_id = $1 AND used_at IS NULL),
		password_hash <> '' FROM accounts WHERE id = $1`, s.account).Scan(&codes, &hasPassword); err != nil {
		a.fail(w, r, fmt.Errorf("read security: %w", err))
		return
	}
	keys, err := a.listPasskeys(r.Context(), s.account)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"totp": f.TOTP, "recoveryCodes": codes, "password": hasPassword, "passkeys": keys,
	})
}

// totpSetup begins setting up an authenticator: it makes a secret and gives
// it to the page to show. Nothing changes at sign-in until a code confirms it.
func (a *Auth) totpSetup(w http.ResponseWriter, r *http.Request) {
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
	secret, err := newTOTPSecret()
	if err != nil {
		a.fail(w, r, err)
		return
	}
	sealed, err := a.box.seal(secret)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var email string
	err = a.pool.QueryRow(ctx, `UPDATE accounts SET totp_secret = $2, totp_last_step = 0 WHERE id = $1 AND totp_confirmed_at IS NULL
		RETURNING email`, s.account, sealed).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		a.fail(w, r, problem.Status(http.StatusConflict, "an authenticator is already set up; turn it off first"))
		return
	}
	if err != nil {
		a.fail(w, r, fmt.Errorf("save authenticator: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"secret": b32.EncodeToString(secret), "uri": totpURI(secret, email)})
}

// totpConfirm turns the authenticator on once a code shows it works, and
// gives the recovery codes, this once.
func (a *Auth) totpConfirm(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
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
	good, err := a.checkTOTP(ctx, s.account, in.Code, false)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if !good {
		a.fail(w, r, clock.ErrInvalidCode.New(""))
		return
	}
	var codes []string
	err = pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE accounts SET totp_confirmed_at = $2 WHERE id = $1`, s.account, a.now()); err != nil {
			return err
		}
		codes, err = a.newRecoveryCodes(ctx, tx, s.account)
		return err
	})
	if err != nil {
		a.fail(w, r, fmt.Errorf("turn on authenticator: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
}

func (a *Auth) newRecoveryCodes(ctx context.Context, tx pgx.Tx, account uuid.UUID) ([]string, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM recovery_codes WHERE account_id = $1`, account); err != nil {
		return nil, err
	}
	codes := make([]string, 0, recoveryCodes)
	for range recoveryCodes {
		code, err := newRecoveryCode()
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO recovery_codes (account_id, code_hash) VALUES ($1, $2)`, account, hashOf(code)); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, nil
}

// recoveryRenew replaces the recovery codes with new ones.
func (a *Auth) recoveryRenew(w http.ResponseWriter, r *http.Request) {
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
	var codes []string
	err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		var err error
		codes, err = a.newRecoveryCodes(ctx, tx, s.account)
		return err
	})
	if err != nil {
		a.fail(w, r, fmt.Errorf("renew recovery codes: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
}

// totpDisable turns the authenticator off and throws away its recovery codes.
func (a *Auth) totpDisable(w http.ResponseWriter, r *http.Request) {
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
	err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE accounts SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = 0 WHERE id = $1`, s.account); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM recovery_codes WHERE account_id = $1`, s.account)
		return err
	})
	if err != nil {
		a.fail(w, r, fmt.Errorf("turn off authenticator: %w", err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
