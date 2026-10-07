// Command host is the smallest application that has Timeclock inside it: it
// mounts Timeclock under /timeclock, says who is calling and which of its
// organizations they are in, and gives Timeclock its own colors. It is an
// example of embedding, and what the end-to-end tests run to see Timeclock
// as a host's users do.
//
// It has no sign-in of its own: a request says who it is from in the
// X-Example-User header (an email address), and optionally which
// organization in X-Example-Org. A real host reads its session instead.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/parallelworks/foundation/server"

	"github.com/giraffesyo/timeclock"
	"github.com/giraffesyo/timeclock/host"
)

// directory answers Timeclock's questions about people from their email:
// anyone the host let in is a person, and "admin@..." runs payroll.
type directory struct{}

func (directory) Person(_ context.Context, id string) (host.Person, error) {
	if !strings.Contains(id, "@") {
		return host.Person{}, host.ErrNotFound
	}
	name := strings.Split(id, "@")[0]
	return host.Person{ID: id, Name: name, Email: id, Admin: strings.HasPrefix(id, "admin")}, nil
}

func (directory) People(context.Context) ([]host.Person, error) { return nil, nil }

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	calendar, err := googleCalendar(os.Getenv("EXAMPLE_GOOGLE_KEY"))
	if err != nil {
		logger.Error("start Timeclock", "error", err)
		os.Exit(1)
	}
	tc, err := timeclock.New(ctx, timeclock.Options{
		DatabaseURL: os.Getenv("EXAMPLE_DATABASE_URL"),
		Schema:      os.Getenv("EXAMPLE_SCHEMA"),
		BasePath:    "/timeclock",
		Caller: func(r *http.Request) (string, bool) {
			id := strings.ToLower(r.Header.Get("X-Example-User"))
			return id, id != ""
		},
		Workspace: func(r *http.Request) (string, bool) {
			org := r.Header.Get("X-Example-Org")
			return org, org != ""
		},
		Directory:      directory{},
		GoogleCalendar: calendar,
		GoogleOAuth:    googleOAuth(env("EXAMPLE_PUBLIC_URL", "http://localhost:"+os.Getenv("PORT"))),
		// Seals the Google tokens people connect. At least 32 characters.
		IntegrationSecretKey: os.Getenv("EXAMPLE_SECRET_KEY"),
		HomeURL:              "/",
		HomeLabel:            "Example Portal",
		SignInURL:            "/?signin=1&next=",
		// The portal's own look: teal on warm white, and on deep green.
		Theme: host.Theme{
			Light: &host.Scheme{
				Interface: host.ThemeSeed{Accent: "#0f766e", Background: "#fffdf8"},
				Sidebar:   &host.ThemeSeed{Accent: "#0f766e", Background: "#f3efe4"},
			},
			Dark: &host.Scheme{Interface: host.ThemeSeed{Accent: "#5eead4", Background: "#10201d"}},
		},
		Logger: logger,
	})
	if err != nil {
		logger.Error("start Timeclock", "error", err)
		os.Exit(1)
	}
	defer tc.Close()
	go tc.Run(ctx)

	mux := http.NewServeMux()
	mux.Handle("/timeclock/", tc)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, `<!doctype html><title>Example Portal</title><h1>Example Portal</h1><p><a href="/timeclock/">Timeclock</a></p>`)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) { _, _ = fmt.Fprint(w, "ok") })

	addr := ":" + os.Getenv("PORT")
	if err := server.Serve(ctx, server.Listen{Addr: addr, ShutdownTimeout: 5 * time.Second}, mux, logger); err != nil {
		logger.Error("example host stopped", "error", err)
		os.Exit(1)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
