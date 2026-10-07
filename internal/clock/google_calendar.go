package clock

import (
	"context"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/parallelworks/foundation/problem"
	"golang.org/x/oauth2"

	"github.com/giraffesyo/timeclock/internal/gcal"
)

// GoogleCalendars are the calendars people connect themselves. Timeclock
// sends a person to Google's consent screen, keeps the refresh token Google
// gives back, sealed with the integration key, and reads their events with
// it until they disconnect or revoke it.
type GoogleCalendars struct {
	box       cipher.AEAD
	oauth     *oauth2.Config
	revokeURL string
	http      *http.Client
	logger    *slog.Logger
	now       func() time.Time
	// sources keeps each connection's token source, so an access token
	// lasts its hour.
	sources sync.Map // sourceKey → oauth2.TokenSource
}

// GoogleClient is the OAuth client people connect their calendars through.
type GoogleClient struct {
	ClientID, ClientSecret, RedirectURL string
	Endpoint                            oauth2.Endpoint
	RevokeURL                           string
}

// GoogleEndpoint is Google's OAuth endpoint.
var GoogleEndpoint = oauth2.Endpoint{
	AuthURL:   "https://accounts.google.com/o/oauth2/v2/auth",
	TokenURL:  "https://oauth2.googleapis.com/token",
	AuthStyle: oauth2.AuthStyleInParams,
}

// GoogleRevokeURL is where Google takes back a token.
const GoogleRevokeURL = "https://oauth2.googleapis.com/revoke"

// How long someone has on Google's consent screen.
const googleStateTTL = 15 * time.Minute

// NewGoogleCalendars returns nil when there is no client: nobody can connect.
func NewGoogleCalendars(key string, c *GoogleClient, logger *slog.Logger) (*GoogleCalendars, error) {
	if c == nil {
		return nil, nil
	}
	if key == "" {
		return nil, errors.New("timeclock: connecting Google Calendars needs Options.IntegrationSecretKey")
	}
	if c.ClientID == "" || c.ClientSecret == "" {
		return nil, errors.New("timeclock: GoogleOAuth needs a client ID and secret")
	}
	if u, err := url.Parse(c.RedirectURL); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, fmt.Errorf("timeclock: GoogleOAuth.RedirectURL %q must be an absolute http(s) URL", c.RedirectURL)
	}
	box, err := integrationBox(key)
	if err != nil {
		return nil, err
	}
	endpoint := c.Endpoint
	if endpoint.AuthURL == "" {
		endpoint = GoogleEndpoint
	}
	revoke := c.RevokeURL
	if revoke == "" {
		revoke = GoogleRevokeURL
	}
	return &GoogleCalendars{
		box: box, revokeURL: revoke, logger: logger, now: time.Now,
		http: &http.Client{Timeout: 15 * time.Second},
		oauth: &oauth2.Config{
			ClientID: c.ClientID, ClientSecret: c.ClientSecret, RedirectURL: c.RedirectURL, Endpoint: endpoint,
			// email names the account in the ID token, so the person can see which one they connected.
			Scopes: []string{gcal.Scope, "openid", "email"},
		},
	}, nil
}

// GoogleCalendarStatus is whether a person has connected their calendar.
type GoogleCalendarStatus struct {
	Connected   bool       `json:"connected"`
	Account     string     `json:"account,omitempty" doc:"The Google account it reads, normally an email address."`
	ConnectedAt *time.Time `json:"connectedAt,omitempty"`
}

// googleState travels through Google's consent screen and back, sealed: who
// asked, in which workspace, the PKCE verifier, and where to return.
type googleState struct {
	Workspace uuid.UUID `json:"w"`
	Person    string    `json:"p"`
	Verifier  string    `json:"v"`
	Return    string    `json:"r"`
	Expires   int64     `json:"e"`
}

const googleStateAD = "timeclock/google-calendar/state"

func tokenAD(ws uuid.UUID, person string) []byte {
	return []byte("timeclock/google-calendar/" + ws.String() + "/" + person)
}

// AuthURL is Google's consent screen for the actor to connect their
// calendar, coming back to returnPath afterwards.
func (g *GoogleCalendars) AuthURL(s *Service, actor Actor, returnPath string) (string, error) {
	verifier := oauth2.GenerateVerifier()
	raw, err := json.Marshal(googleState{
		Workspace: s.ws, Person: actor.ID, Verifier: verifier, Return: returnPath,
		Expires: g.now().Add(googleStateTTL).Unix(),
	})
	if err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(g.box.Seal(nil, nil, raw, []byte(googleStateAD)))
	opts := []oauth2.AuthCodeOption{
		oauth2.AccessTypeOffline, oauth2.S256ChallengeOption(verifier),
		// Consent every time, so Google always gives a refresh token.
		oauth2.SetAuthURLParam("prompt", "consent"),
	}
	if actor.Email != "" {
		opts = append(opts, oauth2.SetAuthURLParam("login_hint", actor.Email))
	}
	return g.oauth.AuthCodeURL(state, opts...), nil
}

// ErrGoogleState is a consent that came back to someone it wasn't for, or too late.
var ErrGoogleState = problem.Status(http.StatusBadRequest, "this Google Calendar connection was started elsewhere or has expired; start it again")

// Return reads where a consent started from, for whoever it was for: the
// path to go back to.
func (g *GoogleCalendars) Return(s *Service, actor Actor, state string) (string, error) {
	st, err := g.state(s, actor, state)
	return st.Return, err
}

func (g *GoogleCalendars) state(s *Service, actor Actor, state string) (googleState, error) {
	var st googleState
	sealed, err := base64.RawURLEncoding.DecodeString(state)
	if err != nil {
		return st, ErrGoogleState
	}
	raw, err := g.box.Open(nil, nil, sealed, []byte(googleStateAD))
	if err != nil || json.Unmarshal(raw, &st) != nil {
		return st, ErrGoogleState
	}
	// Only the person who started it, in the workspace they started it in:
	// otherwise someone could connect their own calendar to another's time.
	if st.Workspace != s.ws || st.Person != actor.ID || g.now().Unix() > st.Expires {
		return st, ErrGoogleState
	}
	return st, nil
}

// Complete exchanges the code Google returned for the actor's tokens and
// keeps the refresh token.
func (g *GoogleCalendars) Complete(ctx context.Context, s *Service, actor Actor, code, state string) error {
	st, err := g.state(s, actor, state)
	if err != nil {
		return err
	}
	tok, err := g.oauth.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return fmt.Errorf("exchange the Google code: %w", err)
	}
	if tok.RefreshToken == "" {
		return errors.New("google gave no refresh token")
	}
	account := ""
	if id, ok := tok.Extra("id_token").(string); ok {
		// Straight from Google's token endpoint over TLS, so its claims need
		// no signature check (OpenID Connect Core 3.1.3.7).
		account = emailClaim(id)
	}
	sealed := g.box.Seal(nil, nil, []byte(tok.RefreshToken), tokenAD(s.ws, actor.ID))
	if _, err := s.pool.Exec(ctx, `INSERT INTO google_calendars (workspace_id, person_id, account, token)
		VALUES ($W, $1, $2, $3)
		ON CONFLICT (workspace_id, person_id) DO UPDATE SET account = EXCLUDED.account, token = EXCLUDED.token, connected_at = now()`,
		actor.ID, account, sealed); err != nil {
		return fmt.Errorf("save the Google Calendar: %w", err)
	}
	g.sources.Delete(sourceKey{s.ws, actor.ID})
	return nil
}

func emailClaim(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	_ = json.Unmarshal(raw, &claims)
	return claims.Email
}

// Status is whether the actor has connected their calendar.
func (g *GoogleCalendars) Status(ctx context.Context, s *Service, actor Actor) (GoogleCalendarStatus, error) {
	var out GoogleCalendarStatus
	var at time.Time
	err := s.pool.QueryRow(ctx, `SELECT account, connected_at FROM google_calendars WHERE workspace_id = $W AND person_id = $1`, actor.ID).
		Scan(&out.Account, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, fmt.Errorf("read the Google Calendar: %w", err)
	}
	out.Connected, out.ConnectedAt = true, &at
	return out, nil
}

type sourceKey struct {
	ws     uuid.UUID
	person string
}

// TokenSource is the actor's own connection, or ok false when they have none.
func (g *GoogleCalendars) TokenSource(ctx context.Context, s *Service, actor Actor) (oauth2.TokenSource, bool, error) {
	key := sourceKey{s.ws, actor.ID}
	if ts, ok := g.sources.Load(key); ok {
		return ts.(oauth2.TokenSource), true, nil
	}
	refresh, err := g.refreshToken(ctx, s, actor.ID)
	if refresh == "" || err != nil {
		return nil, false, err
	}
	// Not the request's context: the source outlives it.
	ts, _ := g.sources.LoadOrStore(key, g.oauth.TokenSource(context.Background(), &oauth2.Token{RefreshToken: refresh}))
	return ts.(oauth2.TokenSource), true, nil
}

func (g *GoogleCalendars) refreshToken(ctx context.Context, s *Service, person string) (string, error) {
	var sealed []byte
	err := s.pool.QueryRow(ctx, `SELECT token FROM google_calendars WHERE workspace_id = $W AND person_id = $1`, person).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read the Google Calendar: %w", err)
	}
	raw, err := g.box.Open(nil, nil, sealed, tokenAD(s.ws, person))
	if err != nil {
		return "", fmt.Errorf("open the Google Calendar token: %w", err)
	}
	return string(raw), nil
}

// Drop forgets the actor's access token, so the next read refreshes it.
func (g *GoogleCalendars) Drop(s *Service, actor Actor) {
	g.sources.Delete(sourceKey{s.ws, actor.ID})
}

// Revoked reports whether Google no longer honors a connection's refresh
// token: the person revoked it, or their account changed. Forget it then.
func Revoked(err error) bool {
	var re *oauth2.RetrieveError
	return errors.As(err, &re) && re.ErrorCode == "invalid_grant"
}

// Forget drops the actor's connection without asking Google, which has
// already let it go.
func (g *GoogleCalendars) Forget(ctx context.Context, s *Service, actor Actor) error {
	g.sources.Delete(sourceKey{s.ws, actor.ID})
	if _, err := s.pool.Exec(ctx, `DELETE FROM google_calendars WHERE workspace_id = $W AND person_id = $1`, actor.ID); err != nil {
		return fmt.Errorf("forget the Google Calendar: %w", err)
	}
	return nil
}

// Disconnect drops the actor's connection and asks Google to revoke its
// token. A revocation that fails still disconnects: Timeclock no longer has
// the token either way.
func (g *GoogleCalendars) Disconnect(ctx context.Context, s *Service, actor Actor) error {
	refresh, err := g.refreshToken(ctx, s, actor.ID)
	if err != nil {
		return err
	}
	if err := g.Forget(ctx, s, actor); err != nil {
		return err
	}
	if refresh == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.revokeURL, strings.NewReader(url.Values{"token": {refresh}}.Encode()))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := g.http.Do(req)
	if err != nil {
		g.logger.WarnContext(ctx, "timeclock: revoke a Google Calendar token", "error", err)
		return nil
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		g.logger.WarnContext(ctx, "timeclock: revoke a Google Calendar token", "status", resp.StatusCode)
	}
	return nil
}
