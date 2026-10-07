package messages

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

func TestEveryMessageFormats(t *testing.T) {
	for _, key := range Keys() {
		args := Args{}
		for _, m := range placeholder.FindAllStringSubmatch(catalogs[Default][key], -1) {
			args[m[1]] = "<" + m[1] + ">"
		}
		got := T(key, args)
		if strings.ContainsAny(got, "{}") {
			t.Errorf("%s left a brace: %q", key, got)
		}
		for name, value := range args {
			if !strings.Contains(got, value) {
				t.Errorf("%s dropped {%s}: %q", key, name, got)
			}
		}
	}
}

func TestMissingArgumentPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("formatting without {link} didn't panic")
		}
	}()
	T("reset.body", nil)
}

func TestOtherLocalesFallBack(t *testing.T) {
	if got, want := In("xx", "reset.subject", nil), T("reset.subject", nil); got != want {
		t.Fatalf("unknown locale gave %q, want the default's %q", got, want)
	}
}

// The server's source names every message, and every message it names exists.
func TestCatalogMatchesSource(t *testing.T) {
	used := regexp.MustCompile(`messages\.(?:T|In)\((?:[^,()]+, )?"([\w.]+)"`)
	named := map[string]bool{}
	root := filepath.Join("..", "..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "node_modules" || d.Name() == "web" || strings.HasPrefix(d.Name(), ".")) && path != root {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range used.FindAllStringSubmatch(string(src), -1) {
			named[m[1]] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	keys := Keys()
	for key := range named {
		if !slices.Contains(keys, key) {
			t.Errorf("source asks for %s, which the catalog doesn't have", key)
		}
	}
	for _, key := range keys {
		if !named[key] {
			t.Errorf("%s is in the catalog but never sent", key)
		}
	}
}
