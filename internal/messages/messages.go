// Package messages holds the words the server sends to people (emails and
// reminders) in a catalog, as the web app keeps its own: one JSON file per
// locale, keyed by dotted path, with {name} placeholders. The catalog is
// checked like the web app's (parallelworks-i18n check), so a message here
// is plain text with simple arguments, no plural or select forms.
package messages

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed locales/*.json
var files embed.FS

// Default is the locale messages are written in, and the one every other
// falls back to.
const Default = "en"

var catalogs = func() map[string]map[string]string {
	out := map[string]map[string]string{}
	entries, err := files.ReadDir("locales")
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		raw, err := files.ReadFile("locales/" + e.Name())
		if err != nil {
			panic(err)
		}
		var tree map[string]any
		if err := json.Unmarshal(raw, &tree); err != nil {
			panic(fmt.Sprintf("messages: %s: %v", e.Name(), err))
		}
		flat := map[string]string{}
		flatten("", tree, flat)
		out[strings.TrimSuffix(e.Name(), ".json")] = flat
	}
	return out
}()

func flatten(prefix string, tree map[string]any, out map[string]string) {
	for k, v := range tree {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		switch v := v.(type) {
		case string:
			out[key] = v
		case map[string]any:
			flatten(key, v, out)
		default:
			panic(fmt.Sprintf("messages: %s is neither text nor a group", key))
		}
	}
}

// Args fill a message's {name} placeholders.
type Args map[string]string

// T is the message at key in the default locale, its placeholders filled.
// A missing key or argument is a programming error, so it panics; the
// package's tests format every message.
func T(key string, args Args) string {
	return In(Default, key, args)
}

// In is the message at key in a locale, falling back to the default.
func In(locale, key string, args Args) string {
	msg, ok := catalogs[locale][key]
	if !ok {
		msg, ok = catalogs[Default][key]
	}
	if !ok {
		panic("messages: no message " + key)
	}
	var b strings.Builder
	for {
		open := strings.IndexByte(msg, '{')
		if open < 0 {
			b.WriteString(msg)
			return b.String()
		}
		end := strings.IndexByte(msg[open:], '}')
		if end < 0 {
			panic("messages: unclosed placeholder in " + key)
		}
		name := msg[open+1 : open+end]
		value, ok := args[name]
		if !ok {
			panic(fmt.Sprintf("messages: %s needs {%s}", key, name))
		}
		b.WriteString(msg[:open])
		b.WriteString(value)
		msg = msg[open+end+1:]
	}
}

// Keys lists the default locale's messages, for tests.
func Keys() []string {
	keys := make([]string, 0, len(catalogs[Default]))
	for k := range catalogs[Default] {
		keys = append(keys, k)
	}
	return keys
}
