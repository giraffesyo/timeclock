// Package cli implements the Timeclock command-line client.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type config struct {
	URL             string `json:"url"`
	CredentialStore string `json:"credentialStore,omitempty"`
}

type options struct {
	server, configPath, token, credentialStore string
	json, allowHTTP                            bool
	timeout                                    time.Duration
}

func (o *options) path() (string, error) {
	if o.configPath != "" {
		return o.configPath, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "timeclock", "config.json"), nil
}

func (o *options) load() (config, error) {
	path, err := o.path()
	if err != nil {
		return config{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config{}, nil
	}
	if err != nil {
		return config{}, fmt.Errorf("read config: %w", err)
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config: %w", err)
	}
	return cfg, nil
}

func (o *options) save(cfg config) error {
	path, err := o.path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if _, err := f.Write(append(data, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

type client struct {
	base    *url.URL
	http    *http.Client
	token   string
	version string
}

func (o *options) client(ctx context.Context, version string, credentials bool) (*client, error) {
	cfg, err := o.load()
	if err != nil {
		return nil, err
	}
	server := o.server
	if server == "" {
		server = cfg.URL
	}
	if server == "" {
		return nil, errors.New("no server configured; run timeclock auth login <server> or set TIMECLOCK_URL")
	}
	if !strings.Contains(server, "://") {
		// A bare host means HTTPS, except for local development servers.
		host := server
		if i := strings.IndexAny(host, ":/"); i >= 0 {
			host = host[:i]
		}
		if ip := net.ParseIP(host); host == "localhost" || (ip != nil && ip.IsLoopback()) {
			server = "http://" + server
		} else {
			server = "https://" + server
		}
	}
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("server must be an http(s) URL without credentials, query, or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme == "http" && u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) && !o.allowHTTP {
		return nil, errors.New("use HTTPS for a remote server, or explicitly opt in with --allow-http")
	}
	if o.timeout <= 0 {
		return nil, errors.New("--timeout must be positive")
	}
	c := &client{base: u, version: version, http: &http.Client{
		Timeout: o.timeout,
		// Login redirects must not turn into a successful HTML response, and
		// credentials must never follow a redirect to another server.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	if credentials {
		c.token = o.token
		if c.token == "" {
			if err := o.withCredentials(ctx, c, cfg, func(s *credentialStore) error {
				t, err := s.load()
				if errors.Is(err, errNoCredentials) {
					return nil
				}
				if err != nil {
					return err
				}
				if t.RefreshToken != "" && time.Until(t.ExpiresAt) < 30*time.Second {
					t, err = c.exchange(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {t.RefreshToken}})
					if err != nil {
						return fmt.Errorf("refresh credentials: %w", err)
					}
					if err := s.save(t); err != nil {
						return err
					}
				}
				c.token = t.AccessToken
				return nil
			}); err != nil {
				return nil, err
			}
		}
	}
	return c, nil
}

func (c *client) request(ctx context.Context, method, path string, query url.Values, body []byte) ([]byte, error) {
	return c.send(ctx, method, path, query, body, "application/json")
}

func (c *client) send(ctx context.Context, method, path string, query url.Values, body []byte, contentType string) ([]byte, error) {
	// Paths are relative to the API or standalone auth, never arbitrary URLs.
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "?#\\") {
		return nil, errors.New("invalid API path")
	}
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawPath = ""
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, text/csv")
	req.Header.Set("User-Agent", "timeclock/"+c.version)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	const limit = 32 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if len(data) > limit {
		return nil, errors.New("response exceeds 32 MiB; request a smaller date range")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var oauth oauthFailure
		if json.Unmarshal(data, &oauth) == nil && oauth.Code != "" {
			return nil, &oauth
		}
		var p struct {
			Detail string `json:"detail"`
			Title  string `json:"title"`
			Errors []struct {
				Detail  string `json:"detail"`
				Pointer string `json:"pointer"`
				Code    string `json:"code"`
			} `json:"errors"`
		}
		_ = json.Unmarshal(data, &p)
		detail := p.Detail
		if detail == "" {
			detail = p.Title
		}
		if detail == "" {
			detail = http.StatusText(resp.StatusCode)
		}
		for _, e := range p.Errors {
			detail += "; " + e.Pointer + ": " + e.Code + " " + e.Detail
		}
		if resp.StatusCode == http.StatusUnauthorized {
			detail += "; run timeclock auth login"
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, detail)
	}
	if len(data) > 0 && !json.Valid(data) && !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/csv") {
		return nil, errors.New("server returned neither JSON nor CSV; check the server URL includes the Timeclock mount path")
	}
	return data, nil
}
