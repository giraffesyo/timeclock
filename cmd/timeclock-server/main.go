// Command timeclock-server runs Timeclock on its own, with its own sign-in.
//
//	timeclock-server           serve (the default)
//	timeclock-server openapi   print the API's OpenAPI document
//
// It is configured from the environment:
//
//	TIMECLOCK_DATABASE_URL    PostgreSQL URL (required)
//	TIMECLOCK_SCHEMA          schema to use (default "timeclock")
//	PORT                      port to listen on (default 8080)
//	TIMECLOCK_PUBLIC_URL      where people reach it, such as https://time.example.com
//	TIMECLOCK_OIDC_ISSUER     OpenID Connect provider, such as https://accounts.google.com
//	TIMECLOCK_OIDC_CLIENT_ID, TIMECLOCK_OIDC_CLIENT_SECRET
//	TIMECLOCK_SESSION_SECRET  signs session cookies; at least 32 characters
//	TIMECLOCK_ALLOWED_DOMAIN  the only email domain that may sign in
//	TIMECLOCK_ADMIN_EMAILS    comma-separated emails of the people who run payroll
//	TIMECLOCK_DEV_USER        an email every request is signed in as, instead of OIDC (development only)
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

	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/foundation/server"

	"github.com/giraffesyo/timeclock"
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

func serve(ctx context.Context, logger *slog.Logger) error {
	dsn := os.Getenv("TIMECLOCK_DATABASE_URL")
	if dsn == "" {
		return errors.New("TIMECLOCK_DATABASE_URL is not set")
	}
	schema := env("TIMECLOCK_SCHEMA", "timeclock")

	// The accounts tables must exist before sign-in is set up, so migrate
	// here rather than leaving it to timeclock.New.
	pool, err := pgdb.Open(ctx, dsn, schema)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pgdb.Migrate(ctx, pool, pgdb.Migrations{FS: migrations.FS, Logger: logger}); err != nil {
		return err
	}
	auth, err := standalone.New(ctx, pool, standalone.Config{
		Issuer:        os.Getenv("TIMECLOCK_OIDC_ISSUER"),
		ClientID:      os.Getenv("TIMECLOCK_OIDC_CLIENT_ID"),
		ClientSecret:  os.Getenv("TIMECLOCK_OIDC_CLIENT_SECRET"),
		PublicURL:     env("TIMECLOCK_PUBLIC_URL", "http://localhost:"+env("PORT", "8080")),
		SessionSecret: os.Getenv("TIMECLOCK_SESSION_SECRET"),
		AllowedDomain: os.Getenv("TIMECLOCK_ALLOWED_DOMAIN"),
		AdminEmails:   strings.Split(os.Getenv("TIMECLOCK_ADMIN_EMAILS"), ","),
		DevUser:       os.Getenv("TIMECLOCK_DEV_USER"),
		Logger:        logger,
	})
	if err != nil {
		return fmt.Errorf("sign-in: %w", err)
	}

	tc, err := timeclock.New(ctx, timeclock.Options{
		DatabaseURL:    dsn,
		Schema:         schema,
		SkipMigrations: true,
		Caller:         auth.Caller,
		Directory:      auth,
		SignInURL:      "/auth/login?next=",
		SignOutURL:     "/auth/logout",
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
