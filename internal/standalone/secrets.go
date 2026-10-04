package standalone

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // TOTP is defined over HMAC-SHA1 (RFC 6238); authenticator apps expect it
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// box seals what the server must be able to read back (an authenticator
// secret, a provider's client secret) with a key that is not in the
// database, so a copy of the database alone gives up neither.
type box struct{ aead cipher.AEAD }

func newBox(key string) (*box, error) {
	if len(key) < 32 {
		return nil, errors.New("the secret key must be at least 32 characters")
	}
	sum := sha256.Sum256([]byte("timeclock/box/v1:" + key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &box{aead: aead}, nil
}

func (b *box) seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plain, nil), nil
}

func (b *box) open(sealed []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealed value is too short")
	}
	return b.aead.Open(nil, sealed[:n], sealed[n:], nil)
}

// --- Codes from an authenticator app (TOTP, RFC 6238) ---

const (
	totpPeriod = 30 * time.Second
	totpDigits = 6
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func newTOTPSecret() ([]byte, error) {
	secret := make([]byte, 20)
	_, err := rand.Read(secret)
	return secret, err
}

func totpCode(secret []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step)) //nolint:gosec // a time step is not negative
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, value%1000000)
}

// totpStep is the time step a code is for, if it is right now: this step or
// the one either side, for a clock that is a little off. Zero if it is none.
func totpStep(secret []byte, code string, now time.Time) int64 {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return 0
	}
	current := now.Unix() / int64(totpPeriod.Seconds())
	var found int64
	for _, step := range []int64{current - 1, current, current + 1} {
		if subtle.ConstantTimeCompare([]byte(totpCode(secret, step)), []byte(code)) == 1 {
			found = step
		}
	}
	return found
}

// totpURI is what an authenticator app reads from the QR code.
func totpURI(secret []byte, email string) string {
	q := url.Values{"secret": {b32.EncodeToString(secret)}, "issuer": {"Timeclock"}}
	return "otpauth://totp/" + url.PathEscape("Timeclock:"+email) + "?" + q.Encode()
}

// --- Recovery codes ---

const recoveryCodes = 10

// newRecoveryCode is ten letters and digits in two groups, such as
// "k3f9a-x7m2q": about fifty bits, typed from paper.
func newRecoveryCode() (string, error) {
	raw := make([]byte, 7)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	s := strings.ToLower(b32.EncodeToString(raw))[:10]
	return s[:5] + "-" + s[5:], nil
}

func normalizeRecovery(code string) string {
	code = strings.ToLower(strings.TrimSpace(code))
	code = strings.NewReplacer(" ", "", "-", "").Replace(code)
	if len(code) != 10 {
		return ""
	}
	return code[:5] + "-" + code[5:]
}
