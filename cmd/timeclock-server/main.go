// Command timeclock-server runs Timeclock on its own, with its own accounts.
//
//	timeclock-server                                    serve (the default)
//	timeclock-server workspace KEY [NAME] [--admin EMAIL]   make a workspace, and invite its first admin
//	timeclock-server invite KEY EMAIL [--admin]         invite someone to a workspace
//	timeclock-server openapi                            print the API's OpenAPI document
//
// It is configured from the environment:
//
//	TIMECLOCK_DATABASE_URL    PostgreSQL URL (required)
//	TIMECLOCK_SCHEMA          schema to use (default "timeclock")
//	PORT                      port to listen on (default 8080)
//	TIMECLOCK_PUBLIC_URL      where people reach it, such as https://time.example.com
//	TIMECLOCK_ADMIN_EMAILS    comma-separated emails of the people who run payroll; each is
//	                          invited to the default workspace when the server first starts
//	TIMECLOCK_SMTP_HOST, TIMECLOCK_SMTP_PORT (default 587), TIMECLOCK_SMTP_USERNAME,
//	TIMECLOCK_SMTP_PASSWORD, TIMECLOCK_SMTP_FROM
//	                          the mail server for invitations and password resets; without one
//	                          the links are written to the log
//	TIMECLOCK_SMTP_SECURITY   starttls (the default), tls, or none
//	TIMECLOCK_BREACH_CHECK    "off" stops refusing passwords known from breaches
//	TIMECLOCK_OIDC_ISSUER     an OpenID Connect provider to sign in with besides a password,
//	                          such as https://accounts.google.com
//	TIMECLOCK_OIDC_CLIENT_ID, TIMECLOCK_OIDC_CLIENT_SECRET
//	TIMECLOCK_ALLOWED_DOMAIN  the only email domain the provider may sign in
//	TIMECLOCK_DEV_USER        an email every request is signed in as, with no sign-in (development only)
//	TIMECLOCK_VITE_URL        the Vite dev server, proxied while no web build is embedded
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/foundation/server"

	"github.com/giraffesyo/timeclock"
	"github.com/giraffesyo/timeclock/host"
	"github.com/giraffesyo/timeclock/internal/clock"
	"github.com/giraffesyo/timeclock/internal/standalone"
	"github.com/giraffesyo/timeclock/migrations"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	if len(os.Args) > 1 && os.Args[1] == "openapi" {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(timeclock.OpenAPI()); err != nil {
			logger.Error("print OpenAPI document", "error", err)
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	if len(os.Args) > 1 && (os.Args[1] == "workspace" || os.Args[1] == "invite") {
		if err := manage(ctx, logger, os.Args[1], os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "timeclock-server:", err)
			os.Exit(1)
		}
		return
	}
	if err := serve(ctx, logger); err != nil {
		logger.Error("timeclock-server stopped", "error", err)
		os.Exit(1)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// open connects, migrates, and sets up accounts: what serving and the
// management commands both start from.
func open(ctx context.Context, logger *slog.Logger) (*pgxpool.Pool, *standalone.Auth, string, string, error) {
	dsn := os.Getenv("TIMECLOCK_DATABASE_URL")
	if dsn == "" {
		return nil, nil, "", "", errors.New("TIMECLOCK_DATABASE_URL is not set")
	}
	schema := env("TIMECLOCK_SCHEMA", "timeclock")
	// The accounts tables must exist before sign-in is set up, so migrate
	// here rather than leaving it to timeclock.New.
	pool, err := pgdb.Open(ctx, dsn, schema)
	if err != nil {
		return nil, nil, "", "", err
	}
	if err := pgdb.Migrate(ctx, pool, pgdb.Migrations{FS: migrations.FS, Logger: logger}); err != nil {
		pool.Close()
		return nil, nil, "", "", err
	}
	var mailer host.Mailer
	if h := os.Getenv("TIMECLOCK_SMTP_HOST"); h != "" {
		mailer = standalone.SMTP{
			Host: h, Port: env("TIMECLOCK_SMTP_PORT", "587"),
			Username: os.Getenv("TIMECLOCK_SMTP_USERNAME"), Password: os.Getenv("TIMECLOCK_SMTP_PASSWORD"),
			From: os.Getenv("TIMECLOCK_SMTP_FROM"), Security: os.Getenv("TIMECLOCK_SMTP_SECURITY"),
		}
	}
	auth, err := standalone.New(ctx, pool, standalone.Config{
		PublicURL:     env("TIMECLOCK_PUBLIC_URL", "http://localhost:"+env("PORT", "8080")),
		Mailer:        mailer,
		AdminEmails:   strings.Split(os.Getenv("TIMECLOCK_ADMIN_EMAILS"), ","),
		BreachCheck:   os.Getenv("TIMECLOCK_BREACH_CHECK") != "off",
		Issuer:        os.Getenv("TIMECLOCK_OIDC_ISSUER"),
		ClientID:      os.Getenv("TIMECLOCK_OIDC_CLIENT_ID"),
		ClientSecret:  os.Getenv("TIMECLOCK_OIDC_CLIENT_SECRET"),
		AllowedDomain: os.Getenv("TIMECLOCK_ALLOWED_DOMAIN"),
		DevUser:       os.Getenv("TIMECLOCK_DEV_USER"),
		Logger:        logger,
	})
	if err != nil {
		pool.Close()
		return nil, nil, "", "", fmt.Errorf("accounts: %w", err)
	}
	return pool, auth, dsn, schema, nil
}

// manage makes a workspace or invites someone, from the command line: how
// whoever runs the server lets the first people in.
func manage(ctx context.Context, logger *slog.Logger, command string, args []string) error {
	admin, email := false, ""
	var rest []string
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--admin" && command == "workspace" && i+1 < len(args):
			i++
			email, admin = args[i], true
		case args[i] == "--admin":
			admin = true
		default:
			rest = append(rest, args[i])
		}
	}
	pool, auth, _, _, err := open(ctx, logger)
	if err != nil {
		return err
	}
	defer pool.Close()
	switch command {
	case "workspace":
		if len(rest) < 1 {
			return errors.New("usage: timeclock-server workspace KEY [NAME] [--admin EMAIL]")
		}
		name := strings.Join(rest[1:], " ")
		if err := auth.CreateWorkspace(ctx, clock.New(pool), rest[0], name); err != nil {
			return err
		}
		fmt.Printf("workspace %q is ready\n", rest[0])
		if email == "" {
			return nil
		}
		rest = []string{rest[0], email}
	default:
		if len(rest) != 2 {
			return errors.New("usage: timeclock-server invite KEY EMAIL [--admin]")
		}
	}
	invited, err := auth.Invite(ctx, rest[0], rest[1], admin, uuid.Nil)
	if err != nil {
		return err
	}
	fmt.Printf("invited %s; they accept at:\n%s\n", invited.Email, invited.Link)
	return nil
}

func serve(ctx context.Context, logger *slog.Logger) error {
	pool, auth, dsn, schema, err := open(ctx, logger)
	if err != nil {
		return err
	}
	defer pool.Close()

	tc, err := timeclock.New(ctx, timeclock.Options{
		DatabaseURL:    dsn,
		Schema:         schema,
		SkipMigrations: true,
		Caller:         auth.Caller,
		Workspace:      auth.Workspace,
		Directory:      auth,
		SignInURL:      "/login?next=",
		SignOutURL:     "/auth/logout",
		AccountsURL:    "/auth",
		Routes:         auth.Routes,
		DevServer:      os.Getenv("TIMECLOCK_VITE_URL"),
		HSTS:           strings.HasPrefix(os.Getenv("TIMECLOCK_PUBLIC_URL"), "https://"),
		Logger:         logger,
	})
	if err != nil {
		return err
	}
	defer tc.Close()
	go tc.Run(ctx)

	return server.Serve(ctx, server.Listen{Addr: ":" + env("PORT", "8080"), ShutdownTimeout: 10 * time.Second}, tc, logger)
}
