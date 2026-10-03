//go:build ruleguard

// Package gorules holds the go-ruleguard rules golangci-lint runs (see
// .golangci.yml).
package gorules

import (
	"github.com/parallelworks/foundation/problem/problemrules"
	"github.com/quasilyte/go-ruleguard/dsl"
)

// Internal errors never reach a client: no error, or its Error() text, in a
// problem's detail or params.
func init() { dsl.ImportRules("", problemrules.Bundle) }
