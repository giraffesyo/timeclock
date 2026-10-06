package cli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const clientID = "timeclock-cli"

type oauthFailure struct {
	Code        string `json:"error"`
	Description string `json:"error_description"`
}

func (e *oauthFailure) Error() string { return e.Code + ": " + e.Description }

func (c *client) form(ctx context.Context, path string, values url.Values) ([]byte, error) {
	values.Set("client_id", clientID)
	return c.send(ctx, http.MethodPost, path, nil, []byte(values.Encode()), "application/x-www-form-urlencoded")
}

func (c *client) exchange(ctx context.Context, values url.Values) (tokens, error) {
	data, err := c.form(ctx, "/auth/cli/token", values)
	if err != nil {
		return tokens{}, err
	}
	var out tokens
	if err = json.Unmarshal(data, &out); err != nil {
		return out, err
	}
	if out.AccessToken == "" || out.RefreshToken == "" || !strings.EqualFold(out.TokenType, "Bearer") || out.ExpiresIn <= 0 || out.ExpiresIn > 86400 {
		return out, errors.New("server returned invalid OAuth tokens")
	}
	out.ExpiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	return out, nil
}

func randomURLToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (o *options) authCommand(version string) *cobra.Command {
	auth := &cobra.Command{Use: "auth", Short: "Sign in through your browser or sign out"}
	var device, noBrowser bool
	var wait time.Duration
	login := &cobra.Command{
		Use: "login [SERVER]", Short: "Authorize this CLI in your browser (OAuth with PKCE)",
		Long:    "Authorize this CLI in your browser (OAuth with PKCE).\n\nSERVER is the Timeclock URL, including any mount path. A bare host such as time.example.com means HTTPS. Without SERVER, the saved server, --server, or TIMECLOCK_URL is used.",
		Example: "  timeclock auth login time.example.com\n  timeclock auth login https://portal.example.com/timeclock --device",
		Args:    cobra.MaximumNArgs(1),
	}
	login.RunE = func(cmd *cobra.Command, args []string) error {
		if len(args) == 1 {
			if cmd.Flags().Changed("server") && o.server != args[0] {
				return errors.New("pass the server either as an argument or with --server, not both")
			}
			o.server = args[0]
		}
		if wait <= 0 {
			return errors.New("--login-timeout must be positive")
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), wait)
		defer cancel()
		c, err := o.client(ctx, version, false)
		if err != nil {
			return err
		}
		cfg, err := o.load()
		if err != nil {
			return err
		}
		// Check storage availability before asking the user to approve.
		if err = o.withCredentials(ctx, c, cfg, func(s *credentialStore) error {
			_, err := s.load()
			if errors.Is(err, errNoCredentials) {
				return nil
			}
			return err
		}); err != nil {
			return err
		}
		var t tokens
		if device {
			t, err = c.deviceLogin(ctx, cmd, noBrowser)
		} else {
			t, err = c.browserLogin(ctx, cmd, noBrowser)
		}
		if err != nil {
			return err
		}
		err = o.withCredentials(ctx, c, cfg, func(s *credentialStore) error {
			// Replacing a login revokes this installation's previous grant.
			if old, loadErr := s.load(); loadErr == nil {
				if _, err := c.form(ctx, "/auth/cli/revoke", url.Values{"token": {old.RefreshToken}}); err != nil {
					return err
				}
			} else if !errors.Is(loadErr, errNoCredentials) {
				return loadErr
			}
			if err := s.save(t); err != nil {
				return err
			}
			return o.save(config{URL: c.base.String(), CredentialStore: s.kind})
		})
		if err != nil {
			// A grant whose credentials couldn't be persisted is not left active.
			_, _ = c.form(ctx, "/auth/cli/revoke", url.Values{"token": {t.RefreshToken}})
			return err
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), "Signed in to "+c.base.String()+".")
		return err
	}
	login.Flags().BoolVar(&device, "device", false, "Use a device code for SSH or a headless machine")
	login.Flags().BoolVar(&noBrowser, "no-browser", false, "Print the sign-in URL without opening a browser")
	login.Flags().DurationVar(&wait, "login-timeout", 10*time.Minute, "How long to wait for browser approval")
	auth.AddCommand(login)
	auth.AddCommand(&cobra.Command{Use: "logout", Short: "Revoke this CLI's grant and remove its credentials", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if o.token != "" {
			return errors.New("unset TIMECLOCK_TOKEN to log out of stored OAuth credentials")
		}
		c, err := o.client(cmd.Context(), version, false)
		if err != nil {
			return err
		}
		cfg, err := o.load()
		if err != nil {
			return err
		}
		err = o.withCredentials(cmd.Context(), c, cfg, func(s *credentialStore) error {
			t, err := s.load()
			if errors.Is(err, errNoCredentials) {
				return nil
			}
			if err != nil {
				return err
			}
			if _, err = c.form(cmd.Context(), "/auth/cli/revoke", url.Values{"token": {t.RefreshToken}}); err != nil {
				return err
			}
			return s.delete()
		})
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), "Signed out.")
		return err
	}})
	return auth
}

func (c *client) browserLogin(ctx context.Context, cmd *cobra.Command, noBrowser bool) (tokens, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return tokens{}, err
	}
	redirect := "http://" + listener.Addr().String() + "/callback"
	state, verifier := randomURLToken(), randomURLToken()
	sum := sha256.Sum256([]byte(verifier))
	result := make(chan url.Values, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Host != listener.Addr().String() || r.URL.Query().Get("state") != state {
			http.Error(w, "Invalid sign-in state. Return to the terminal and try again.", 400)
			return
		}
		q := r.URL.Query()
		if q.Get("code") == "" && q.Get("error") == "" {
			http.Error(w, "Missing authorization code.", 400)
			return
		}
		select {
		case result <- q:
			_, _ = fmt.Fprintln(w, "Authorization received. Return to your terminal.")
		default:
			http.Error(w, "Authorization already received.", http.StatusConflict)
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer func() { _ = server.Close() }()
	go func() { _ = server.Serve(listener) }()
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + "/auth/cli/authorize"
	u.RawPath = ""
	u.RawQuery = url.Values{"client_id": {clientID}, "response_type": {"code"}, "scope": {"timeclock"}, "redirect_uri": {redirect}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}}.Encode()
	cmd.PrintErrln("Open this URL to authorize Timeclock CLI:")
	cmd.PrintErrln(u.String())
	if !noBrowser {
		if err := openBrowser(u.String()); err != nil {
			cmd.PrintErrln("Could not open a browser; open the URL above manually.")
		}
	}
	select {
	case q := <-result:
		if q.Get("error") != "" {
			return tokens{}, &oauthFailure{Code: q.Get("error"), Description: "Browser authorization was not granted."}
		}
		return c.exchange(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {q.Get("code")}, "code_verifier": {verifier}, "redirect_uri": {redirect}})
	case <-ctx.Done():
		return tokens{}, fmt.Errorf("waiting for browser sign-in: %w", ctx.Err())
	}
}

func (c *client) deviceLogin(ctx context.Context, cmd *cobra.Command, noBrowser bool) (tokens, error) {
	data, err := c.form(ctx, "/auth/cli/device", url.Values{"scope": {"timeclock"}})
	if err != nil {
		return tokens{}, err
	}
	var device struct {
		Code     string `json:"device_code"`
		UserCode string `json:"user_code"`
		URI      string `json:"verification_uri"`
		Complete string `json:"verification_uri_complete"`
		Expires  int    `json:"expires_in"`
		Interval int    `json:"interval"`
	}
	if err = json.Unmarshal(data, &device); err != nil {
		return tokens{}, err
	}
	if device.Code == "" || device.UserCode == "" || device.Expires <= 0 || device.Expires > 3600 {
		return tokens{}, errors.New("server returned invalid device authorization")
	}
	u, err := url.Parse(device.URI)
	if err != nil || u.Scheme != c.base.Scheme || u.Host != c.base.Host || u.User != nil {
		return tokens{}, errors.New("device verification URL must belong to the Timeclock server")
	}
	cmd.PrintErrln("Open " + device.URI + " and enter code: " + device.UserCode)
	// Open the plain URL so the browser asks the user to transcribe the code.
	if !noBrowser {
		_ = openBrowser(device.URI)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(device.Expires)*time.Second)
	defer cancel()
	interval := time.Duration(max(device.Interval, 5)) * time.Second
	for {
		timer := time.NewTimer(interval)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return tokens{}, fmt.Errorf("waiting for device approval: %w", ctx.Err())
		}
		t, err := c.exchange(ctx, url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {device.Code}})
		if err == nil {
			return t, nil
		}
		var failure *oauthFailure
		if errors.As(err, &failure) {
			switch failure.Code {
			case "authorization_pending":
				continue
			case "slow_down":
				interval += 5 * time.Second
				continue
			}
		}
		var network net.Error
		if errors.As(err, &network) && network.Timeout() {
			interval = min(interval*2, time.Minute)
			continue
		}
		return tokens{}, err
	}
}

func openBrowser(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
