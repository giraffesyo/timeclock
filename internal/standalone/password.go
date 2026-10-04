package standalone

import (
	"context"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // the breach list is indexed by SHA-1; nothing is protected with it
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"

	"github.com/giraffesyo/timeclock/internal/clock"
)

// Passwords are hashed with Argon2id, at the parameters OWASP's password
// storage guidance gives. They are written into each hash, so they can be
// raised later and old hashes still verify.
const (
	argonMemory  = 47104 // KiB
	argonTime    = 1
	argonThreads = 1
	argonKeyLen  = 32
	saltLen      = 16

	minPassword = 10
	maxPassword = 128
)

func hashPassword(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// verifyPassword reports whether password is the one a hash was made from.
func verifyPassword(hash, password string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want))) //nolint:gosec // a key is 32 bytes
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash is verified against when the email is unknown, so an unknown
// email takes as long to refuse as a wrong password.
var dummyHash, _ = hashPassword("timeclock: no such account")

// breaches asks whether a password is in a public list of breached ones.
type breaches interface {
	Breached(ctx context.Context, password string) (bool, error)
}

// pwned looks a password up by the first five characters of its SHA-1, so
// the password never leaves the server (the range API of Have I Been Pwned).
type pwned struct{ client *http.Client }

func (p pwned) Breached(ctx context.Context, password string) (bool, error) {
	sum := sha1.Sum([]byte(password)) //nolint:gosec // see the import
	digest := strings.ToUpper(hex.EncodeToString(sum[:]))
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.pwnedpasswords.com/range/"+digest[:5], nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Add-Padding", "true")
	res, err := p.client.Do(req)
	if err != nil {
		return false, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return false, fmt.Errorf("breach list answered %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return false, err
	}
	for line := range strings.SplitSeq(string(body), "\n") {
		suffix, count, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && suffix == digest[5:] && count != "0" {
			return true, nil
		}
	}
	return false, nil
}

// checkPassword refuses a password that is too short, too long, or known
// from a breach. There are no rules about what characters it has.
func (a *Auth) checkPassword(ctx context.Context, password string) error {
	if n := utf8.RuneCountInString(password); n < minPassword || n > maxPassword {
		return clock.ErrWeakPassword.New("")
	}
	if a.breaches == nil {
		return nil
	}
	found, err := a.breaches.Breached(ctx, password)
	if err != nil {
		// The list being unreachable doesn't stop someone setting a password.
		a.cfg.Logger.WarnContext(ctx, "timeclock: breached-password check unavailable", "error", err)
		return nil
	}
	if found {
		return clock.ErrBreachedPassword.New("")
	}
	return nil
}
