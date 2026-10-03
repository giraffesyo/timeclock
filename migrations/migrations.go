// Package migrations embeds Timeclock's SQL schema migrations, applied with
// goose.
package migrations

import "embed"

// FS holds the goose migration files.
//
//go:embed *.sql
var FS embed.FS
