// Package standalone gives a Timeclock that runs on its own what a host
// would: accounts with a password, the workspaces each belongs to, sessions,
// invitations and password resets by email, optional sign-in with an OpenID
// Connect provider, and a directory of each workspace's people.
package standalone

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
)

// Config configures Auth.
type Config struct {
	// PublicURL is where people reach Timeclock: the links in its emails
	// start with it, and an OpenID Connect provider redirects back to it.
	PublicURL string
	// Mailer sends invitations and password resets. Without one they go to
	// the log, for whoever runs the server to pass on.
	Mailer host.Mailer
	// AdminEmails run payroll in every workspace they belong to, and are
	// invited to the default workspace when the server first starts.
	AdminEmails []string
	// SecretKey seals what the server must read back but shouldn't sit in
	// the database in the clear: authenticator secrets and providers' client
	// secrets. At least 32 characters; keep it out of the database's backups.
	SecretKey string
	// TrustProxy says the server is behind a reverse proxy that sets
	// X-Forwarded-For, so sign-in is slowed per client rather than for
	// everyone behind the proxy at once. Leave it off when clients connect
	// directly: they could claim any address.
	TrustProxy bool
	// BreachURL is the range API the breach check asks; empty is the public one.
	BreachURL string
	// BreachCheck refuses passwords found in a public list of breached
	// ones. The lookup sends five characters of a hash, never the password.
	BreachCheck bool

	// Issuer, ClientID and ClientSecret are an OpenID Connect provider
	// people can sign in with besides a password, such as
	// https://accounts.google.com. Empty offers passwords only.
	Issuer       string
	ClientID     string
	ClientSecret string
	// AllowedDomain, if set, is the only email domain the provider may sign in.
	AllowedDomain string

	// DevUser, if set, is an email every request is signed in as, with no
	// sign-in at all. For development only.
	DevUser string
	Logger  *slog.Logger
}

const (
	cookieName = "timeclock_session"
	// A session ends after this long unused, and this long in all.
	sessionIdle = 14 * 24 * time.Hour
	sessionMax  = 30 * 24 * time.Hour
	inviteTTL   = 7 * 24 * time.Hour
	resetTTL    = time.Hour
	attemptTTL  = 10 * time.Minute
)

// Auth is a standalone Timeclock's accounts, sign-in and directory.
type Auth struct {
	pool     *pgxpool.Pool
	cfg      Config
	admins   map[string]bool
	mailer   host.Mailer
	breaches breaches
	box      *box
	webauthn *webauthn.WebAuthn
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config
	devID    string
	devIDs   sync.Map // email → account id, for DevUserHeader
	// providers are the OpenID Connect providers discovered so far, by issuer.
	providers sync.Map
	now       func() time.Time
}

// New sets up sign-in. In development it makes sure DevUser has an account;
// otherwise it invites each admin who has none yet.
func New(ctx context.Context, pool *pgxpool.Pool, cfg Config) (*Auth, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	a := &Auth{pool: pool, cfg: cfg, admins: map[string]bool{}, mailer: cfg.Mailer, now: time.Now}
	if a.mailer == nil {
		a.mailer = logMailer{cfg.Logger}
	}
	if cfg.BreachCheck {
		a.breaches = pwned{client: &http.Client{Timeout: 5 * time.Second}, url: cfg.BreachURL}
	}
	for _, e := range cfg.AdminEmails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			a.admins[e] = true
		}
	}
	if cfg.DevUser == "" || cfg.SecretKey != "" {
		var err error
		if a.box, err = newBox(cfg.SecretKey); err != nil {
			return nil, err
		}
		if a.webauthn, err = newWebAuthn(cfg.PublicURL); err != nil {
			return nil, err
		}
	}
	if cfg.DevUser != "" {
		id, ok := a.devAccount(ctx, strings.ToLower(cfg.DevUser))
		if !ok {
			return nil, errors.New("make the development account")
		}
		a.devID = id
		return a, nil
	}
	if cfg.Issuer != "" {
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
	}
	return a, a.inviteAdmins(ctx)
}

// inviteAdmins invites, to the default workspace, each admin who has no
// account and no invitation waiting: how the first person gets in.
func (a *Auth) inviteAdmins(ctx context.Context) error {
	for email := range a.admins {
		var known bool
		err := a.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM accounts WHERE lower(email) = $1)
			OR EXISTS (SELECT 1 FROM invites WHERE lower(email) = $1 AND accepted_at IS NULL AND expires_at > now())`, email).Scan(&known)
		if err != nil {
			return fmt.Errorf("check admin %s: %w", email, err)
		}
		if known {
			continue
		}
		if _, err := a.Invite(ctx, clock.DefaultWorkspace, email, true, uuid.Nil); err != nil {
			return err
		}
	}
	return nil
}

func newToken() (token string, hash []byte) {
	token = rand.Text() + rand.Text()
	sum := sha256.Sum256([]byte(token))
	return token, sum[:]
}

func hashOf(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// --- Accounts ---

// Account is someone who can sign in.
type Account struct {
	ID    uuid.UUID `json:"id"`
	Email string    `json:"email"`
	Name  string    `json:"name"`
}

// Membership is a workspace an account belongs to.
type Membership struct {
	ID    uuid.UUID `json:"id"`
	Key   string    `json:"key"`
	Name  string    `json:"name"`
	Admin bool      `json:"admin"`
	// SSORequired means it is entered only through its own provider.
	SSORequired bool `json:"ssoRequired"`
}

func (a *Auth) memberships(ctx context.Context, account uuid.UUID, email string) ([]Membership, error) {
	rows, err := a.pool.Query(ctx, `SELECT w.id, w.key, w.name, m.admin,
			EXISTS (SELECT 1 FROM workspace_sso o WHERE o.workspace_id = w.id AND o.required)
		FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.account_id = $1 ORDER BY lower(w.name), w.key`, account)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Membership, error) {
		var m Membership
		err := row.Scan(&m.ID, &m.Key, &m.Name, &m.Admin, &m.SSORequired)
		m.Admin = m.Admin || a.admins[strings.ToLower(email)]
		return m, err
	})
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	return out, nil
}

// join puts an account in a workspace, raising it to admin if asked.
func join(ctx context.Context, q interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, workspace, account uuid.UUID, admin bool) error {
	_, err := q.Exec(ctx, `INSERT INTO memberships (workspace_id, account_id, admin) VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, account_id) DO UPDATE SET admin = memberships.admin OR EXCLUDED.admin`, workspace, account, admin)
	return err
}

// devAccount is the account of a development user, made on first use and
// put in the default workspace.
func (a *Auth) devAccount(ctx context.Context, email string) (string, bool) {
	if id, ok := a.devIDs.Load(email); ok {
		return id.(string), true
	}
	var id uuid.UUID
	err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `INSERT INTO accounts (id, issuer, subject, email, name) VALUES ($1, 'dev', $2, $2, $3)
			ON CONFLICT (lower(email)) DO UPDATE SET name = accounts.name RETURNING id`,
			uuid.Must(uuid.NewV7()), email, strings.Split(email, "@")[0]).Scan(&id)
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
		a.cfg.Logger.ErrorContext(ctx, "make development account", "email", email, "error", err)
		return "", false
	}
	a.devIDs.Store(email, id.String())
	return id.String(), true
}

// --- host.Directory ---

// Person returns a member of the request's workspace.
func (a *Auth) Person(ctx context.Context, id string) (host.Person, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return host.Person{}, host.ErrNotFound
	}
	var email, name string
	var admin bool
	err = a.pool.QueryRow(ctx, `SELECT acc.email, acc.name, m.admin FROM accounts acc
		JOIN memberships m ON m.account_id = acc.id JOIN workspaces w ON w.id = m.workspace_id
		WHERE acc.id = $1 AND w.key = $2 AND acc.disabled_at IS NULL`, parsed, workspaceOf(ctx)).Scan(&email, &name, &admin)
	if errors.Is(err, pgx.ErrNoRows) {
		return host.Person{}, host.ErrNotFound
	}
	if err != nil {
		return host.Person{}, fmt.Errorf("read account: %w", err)
	}
	return a.person(parsed, email, name, admin), nil
}

// People lists the members of the request's workspace.
func (a *Auth) People(ctx context.Context) ([]host.Person, error) {
	rows, err := a.pool.Query(ctx, `SELECT acc.id, acc.email, acc.name, m.admin FROM accounts acc
		JOIN memberships m ON m.account_id = acc.id JOIN workspaces w ON w.id = m.workspace_id
		WHERE w.key = $1 AND acc.disabled_at IS NULL ORDER BY lower(acc.name)`, workspaceOf(ctx))
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	var out []host.Person
	var id uuid.UUID
	var email, name string
	var admin bool
	if _, err := pgx.ForEachRow(rows, []any{&id, &email, &name, &admin}, func() error {
		out = append(out, a.person(id, email, name, admin))
		return nil
	}); err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	return out, nil
}

func workspaceOf(ctx context.Context) string {
	if key := host.Workspace(ctx); key != "" {
		return key
	}
	return clock.DefaultWorkspace
}

func (a *Auth) person(id uuid.UUID, email, name string, admin bool) host.Person {
	if name == "" {
		name = email
	}
	return host.Person{ID: id.String(), Name: name, Email: email, Admin: admin || a.admins[strings.ToLower(email)]}
}

// --- Sessions ---

// DevUserHeader names, in development only (Config.DevUser set), the email a
// request is signed in as instead of DevUser.
const DevUserHeader = "X-Timeclock-Dev-User"

type session struct {
	hash      []byte
	account   uuid.UUID
	workspace string // key; empty when the account is in none
	// sso is the workspace whose provider the session came in through, if
	// it did: such a session sees that workspace only.
	sso uuid.UUID
}

// session reads the request's session, if it has a live one.
func (a *Auth) session(r *http.Request) (session, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return session{}, false
	}
	s := session{hash: hashOf(c.Value)}
	now := a.now()
	var key *string
	var sso *uuid.UUID
	var seen time.Time
	err = a.pool.QueryRow(r.Context(), `SELECT s.account_id, w.key, s.last_seen_at, s.sso_workspace_id FROM sessions s
		JOIN accounts acc ON acc.id = s.account_id AND acc.disabled_at IS NULL
		LEFT JOIN workspaces w ON w.id = s.workspace_id
		WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.last_seen_at > $3`,
		s.hash, now, now.Add(-sessionIdle)).Scan(&s.account, &key, &seen, &sso)
	if err != nil {
		return session{}, false
	}
	if key != nil {
		s.workspace = *key
	}
	if sso != nil {
		s.sso = *sso
	}
	// Using it keeps it alive; noted at most every few minutes.
	if now.Sub(seen) > 5*time.Minute {
		_, _ = a.pool.Exec(r.Context(), `UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1`, s.hash, now)
	}
	return s, true
}

// Caller returns the signed-in account of a request.
func (a *Auth) Caller(r *http.Request) (string, bool) {
	if a.devID != "" {
		// In development a request can name who it is from, which is how
		// the end-to-end tests are several people at once.
		if email := strings.ToLower(strings.TrimSpace(r.Header.Get(DevUserHeader))); email != "" {
			return a.devAccount(r.Context(), email)
		}
		return a.devID, true
	}
	s, ok := a.session(r)
	if !ok {
		return "", false
	}
	return s.account.String(), true
}

// Workspace returns the workspace the request's session is looking at.
func (a *Auth) Workspace(r *http.Request) (string, bool) {
	if a.devID != "" {
		return "", false
	}
	s, ok := a.session(r)
	return s.workspace, ok && s.workspace != ""
}

// start begins a session for an account, looking at the given workspace or
// else the first one it may enter, and sets the cookie. sso is the workspace
// whose provider signed the account in, when one did.
func (a *Auth) start(w http.ResponseWriter, r *http.Request, account, workspace, sso uuid.UUID) error {
	ctx := r.Context()
	token, hash := newToken()
	now := a.now()
	var ws *uuid.UUID
	if workspace != uuid.Nil && workspace != sso {
		// A workspace that requires its provider isn't entered any other way.
		var required bool
		if err := a.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_sso WHERE workspace_id = $1 AND required)`, workspace).Scan(&required); err != nil {
			return fmt.Errorf("check workspace: %w", err)
		}
		if required {
			workspace = uuid.Nil
		}
	}
	if workspace != uuid.Nil {
		ws = &workspace
	} else {
		var first uuid.UUID
		// A workspace that requires its provider isn't entered with a password.
		err := a.pool.QueryRow(ctx, `SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.account_id = $1 AND NOT EXISTS (SELECT 1 FROM workspace_sso o WHERE o.workspace_id = w.id AND o.required)
			ORDER BY lower(w.name), w.key LIMIT 1`, account).Scan(&first)
		if err == nil {
			ws = &first
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("find workspace: %w", err)
		}
	}
	var through *uuid.UUID
	if sso != uuid.Nil {
		through = &sso
	}
	if _, err := a.pool.Exec(ctx, `INSERT INTO sessions (token_hash, account_id, workspace_id, sso_workspace_id, created_at, last_seen_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $5, $6)`, hash, account, ws, through, now, now.Add(sessionMax)); err != nil {
		return fmt.Errorf("start session: %w", err)
	}
	// Old sessions are cleared as new ones begin.
	_, _ = a.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < $1 OR last_seen_at < $2`, now, now.Add(-sessionIdle))
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: token, Path: "/", Expires: now.Add(sessionMax),
		HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (a *Auth) clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/", MaxAge: -1, HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode})
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

// --- Invitations ---

// Invited is an invitation that was just made.
type Invited struct {
	ID    uuid.UUID
	Email string
	// Link is where the person accepts it.
	Link string
}

// Invite invites an email address to a workspace and emails the link.
// invitedBy is the account that asked, or uuid.Nil for whoever runs the server.
func (a *Auth) Invite(ctx context.Context, workspaceKey, email string, admin bool, invitedBy uuid.UUID) (Invited, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \r\n") {
		return Invited{}, fmt.Errorf("%q is not an email address", email)
	}
	var ws uuid.UUID
	var name string
	if err := a.pool.QueryRow(ctx, `SELECT id, name FROM workspaces WHERE key = $1`, workspaceKey).Scan(&ws, &name); err != nil {
		return Invited{}, fmt.Errorf("find workspace %q: %w", workspaceKey, err)
	}
	token, hash := newToken()
	out := Invited{ID: uuid.Must(uuid.NewV7()), Email: email, Link: strings.TrimRight(a.cfg.PublicURL, "/") + "/invite?token=" + token}
	var by *uuid.UUID
	if invitedBy != uuid.Nil {
		by = &invitedBy
	}
	err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		// A new invitation to the same address replaces the one before.
		if _, err := tx.Exec(ctx, `DELETE FROM invites WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL`, ws, email); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO invites (id, token_hash, workspace_id, email, admin, invited_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, out.ID, hash, ws, email, admin, by, a.now().Add(inviteTTL))
		return err
	})
	if err != nil {
		return Invited{}, fmt.Errorf("invite %s: %w", email, err)
	}
	if name == "" {
		name = "Timeclock"
	}
	err = a.mailer.Send(ctx, host.Message{
		To:      email,
		Subject: "You're invited to " + name,
		Text: "You've been invited to track time in " + name + ".\n\n" +
			"Set up your account here:\n" + out.Link + "\n\n" +
			"The link works for 7 days. If you weren't expecting this, you can ignore it.\n",
	})
	if err != nil {
		// The invitation stands: an admin can copy its link, or send it again.
		a.cfg.Logger.ErrorContext(ctx, "timeclock: invitation email not sent", "to", email, "error", err)
	}
	return out, nil
}

// CreateWorkspace makes a workspace, or renames one that exists.
func (a *Auth) CreateWorkspace(ctx context.Context, svc *clock.Service, key, name string) error {
	ws, err := svc.EnsureWorkspace(ctx, key)
	if err != nil {
		return err
	}
	if name != "" {
		if _, err := a.pool.Exec(ctx, `UPDATE workspaces SET name = $2 WHERE id = $1`, ws.ID, name); err != nil {
			return fmt.Errorf("name workspace: %w", err)
		}
	}
	return nil
}
