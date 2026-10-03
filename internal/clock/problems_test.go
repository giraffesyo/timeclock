package clock

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/parallelworks/foundation/problem/problemtest"
)

// The web app shows its own message for every code, with the same params.
func TestEveryCodeHasAMessage(t *testing.T) {
	data, err := os.ReadFile("../../web/src/i18n/locales/en/apiErrors.json")
	if err != nil {
		t.Fatal(err)
	}
	var messages map[string]string
	if err := json.Unmarshal(data, &messages); err != nil {
		t.Fatal(err)
	}
	problemtest.CheckMessages(t, messages, Problems)
}
