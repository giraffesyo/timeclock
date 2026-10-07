package standalone

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"

	"github.com/giraffesyo/timeclock/host"
)

// SMTP is how a standalone server sends email.
type SMTP struct {
	// Host and Port are the server, such as "smtp.example.com" and "587".
	Host, Port string
	// Username and Password sign in, when the server asks for it.
	Username, Password string
	// From is the address mail comes from, such as "Timeclock <time@example.com>".
	From string
	// Security is "starttls" (the default), "tls" for a TLS connection from
	// the start (port 465), or "none" for a server on a trusted network.
	Security string
}

// Send delivers one message.
func (s SMTP) Send(ctx context.Context, m host.Message) error {
	from, err := mail.ParseAddress(s.From)
	if err != nil {
		return fmt.Errorf("smtp: the from address: %w", err)
	}
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("smtp: the to address: %w", err)
	}
	addr := net.JoinHostPort(s.Host, s.Port)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	dialer := &net.Dialer{}
	var conn net.Conn
	if s.Security == "tls" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp: connect: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp: greeting: %w", err)
	}
	defer func() { _ = c.Close() }()
	if s.Security == "" || s.Security == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("smtp: the server doesn't offer STARTTLS; set the security to tls or none")
		}
		if err := c.StartTLS(&tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("smtp: starttls: %w", err)
		}
	}
	if s.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", s.Username, s.Password, s.Host)); err != nil {
			return fmt.Errorf("smtp: sign in: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("smtp: from: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("smtp: to: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp: data: %w", err)
	}
	// Header values are single lines: a newline in one would start another header.
	clean := strings.NewReplacer("\r", " ", "\n", " ")
	msg := "From: " + from.String() + "\r\n" +
		"To: " + to.String() + "\r\n" +
		// Encoded where it isn't plain ASCII (a curly apostrophe, a workspace's accented name).
		"Subject: " + mime.QEncoding.Encode("utf-8", clean.Replace(m.Subject)) + "\r\n" +
		"Date: " + time.Now().Format(time.RFC1123Z) + "\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
		strings.ReplaceAll(strings.ReplaceAll(m.Text, "\r\n", "\n"), "\n", "\r\n") + "\r\n"
	if _, err := w.Write([]byte(msg)); err != nil {
		return fmt.Errorf("smtp: write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp: send: %w", err)
	}
	return c.Quit()
}

// logMailer is the mailer of a server with none configured: the message goes
// to the log, so whoever runs the server can pass a link on by hand.
type logMailer struct{ logger *slog.Logger }

func (l logMailer) Send(ctx context.Context, m host.Message) error {
	l.logger.WarnContext(ctx, "timeclock: no mail server is configured, so this email was not sent", "to", m.To, "subject", m.Subject, "text", m.Text)
	return nil
}
