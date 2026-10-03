// Package web embeds the compiled Vite frontend.
package web

import (
	"embed"
	"io/fs"
)

// dist contains the output of `pnpm build`. The tracked dist/.gitkeep
// (copied from public/) lets the Go module build before the frontend has.
//
//go:embed all:dist
var dist embed.FS

// FS returns the built frontend rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // unreachable: "dist" is a valid, embedded path
	}
	return sub
}
