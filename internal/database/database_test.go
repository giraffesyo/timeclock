package database_test

import (
	"log/slog"
	"testing"

	"github.com/parallelworks/foundation/pgdb/pgdbtest"
	"github.com/parallelworks/hopper/hoppermigrate"
	"golang.org/x/sync/errgroup"

	"github.com/giraffesyo/timeclock/internal/database"
)

func TestMigrateConcurrent(t *testing.T) {
	ctx := t.Context()
	pool := pgdbtest.Open(t, "TIMECLOCK_TEST_DATABASE_URL", "pool_max_conns=2")
	logger := slog.New(slog.DiscardHandler)
	var g errgroup.Group
	for range 4 {
		g.Go(func() error { return database.Migrate(ctx, pool, logger) })
	}
	if err := g.Wait(); err != nil {
		t.Fatal(err)
	}
	if v, err := hoppermigrate.Version(ctx, database.JobDriver(pool)); err != nil || v != hoppermigrate.Latest() {
		t.Errorf("queue schema version = %d, %v; want %d", v, err, hoppermigrate.Latest())
	}
	for _, table := range []string{"goose_db_version", "hopper_schema", "workspaces"} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists); err != nil || !exists {
			t.Errorf("table %s missing from the application schema (%v)", table, err)
		}
	}
}
