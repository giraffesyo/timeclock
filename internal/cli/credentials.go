package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofrs/flock"
	"github.com/zalando/go-keyring"
)

var errNoCredentials = errors.New("not signed in; run timeclock auth login")

type tokens struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresIn    int       `json:"expires_in"`
	TokenType    string    `json:"token_type"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type credentialStore struct{ kind, key, path string }

func (o *options) withCredentials(ctx context.Context, c *client, cfg config, work func(*credentialStore) error) error {
	path, err := o.path()
	if err != nil {
		return err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return err
	}
	kind := o.credentialStore
	if kind == "" {
		kind = cfg.CredentialStore
	}
	if kind == "" {
		kind = "keyring"
	}
	if kind != "keyring" && kind != "file" {
		return errors.New("--credential-store must be keyring or file")
	}
	hash := sha256.Sum256([]byte(path + "\n" + c.base.String()))
	key := hex.EncodeToString(hash[:])
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	// A refresh token is single-use. Serialize read/refresh/write across CLI
	// processes, including when the tokens themselves live in the OS keyring.
	lock := flock.New(path + ".lock")
	defer func() { _ = lock.Close() }()
	lockCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	ok, err := lock.TryLockContext(lockCtx, 100*time.Millisecond)
	if err != nil {
		return fmt.Errorf("lock credentials: %w", err)
	}
	if !ok {
		return errors.New("credentials are in use; try again")
	}
	return work(&credentialStore{kind: kind, key: key, path: path + "." + key[:16] + ".credentials"})
}

func (s *credentialStore) load() (tokens, error) {
	var data []byte
	var err error
	if s.kind == "file" {
		data, err = os.ReadFile(s.path)
	} else {
		var value string
		value, err = keyring.Get("timeclock-cli", s.key)
		data = []byte(value)
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, keyring.ErrNotFound) {
		return tokens{}, errNoCredentials
	}
	if err != nil {
		return tokens{}, fmt.Errorf("open %s credentials: %w (on headless systems explicitly select --credential-store=file)", s.kind, err)
	}
	var out tokens
	if err := json.Unmarshal(data, &out); err != nil {
		return out, fmt.Errorf("read credentials: %w", err)
	}
	if out.AccessToken == "" || out.RefreshToken == "" {
		return out, errNoCredentials
	}
	return out, nil
}

func (s *credentialStore) save(t tokens) error {
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	if s.kind == "keyring" {
		if err := keyring.Set("timeclock-cli", s.key, string(data)); err != nil {
			return fmt.Errorf("save credentials in OS keyring: %w; explicitly use --credential-store=file if no keyring is available", err)
		}
		return nil
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".credentials-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), s.path)
}

func (s *credentialStore) delete() error {
	var err error
	if s.kind == "file" {
		err = os.Remove(s.path)
	} else {
		err = keyring.Delete("timeclock-cli", s.key)
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
