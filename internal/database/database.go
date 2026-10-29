// Package database migrates the application's tables and background jobs.
package database

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/parallelworks/foundation/pgdb"
	"github.com/parallelworks/hopper/driver/hopperpgx"
	"github.com/parallelworks/hopper/hoppermigrate"

	"github.com/giraffesyo/timeclock/migrations"
)

// Migrate is safe to call from several replicas at once.
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	if err := pgdb.Migrate(ctx, pool, pgdb.Migrations{FS: migrations.FS, Logger: logger}); err != nil {
		return err
	}
	if _, err := hoppermigrate.Up(ctx, JobDriver(pool), &hoppermigrate.Options{Logger: logger}); err != nil {
		return fmt.Errorf("migrate job queue: %w", err)
	}
	return nil
}

// JobDriver keeps background jobs in the application's schema.
func JobDriver(pool *pgxpool.Pool) *hopperpgx.Driver {
	return hopperpgx.NewWithConfig(pool, &hopperpgx.Config{Schema: pgdb.Schema(pool)})
}
