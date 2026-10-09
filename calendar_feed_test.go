package timeclock_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/giraffesyo/timeclock"
)

func TestCalendarFeed(t *testing.T) {
	if os.Getenv("TIMECLOCK_TEST_DATABASE_URL") == "" {
		t.Skip("TIMECLOCK_TEST_DATABASE_URL not set")
	}
	people := directory{
		"pat": {ID: "pat", Name: "Pat Admin", Email: "pat@example.com", Admin: true},
		"ada": {ID: "ada", Name: "Ada Lovelace", Email: "ada@example.com", ManagerID: "pat"},
		"sam": {ID: "sam", Name: "Sam Rivera", Email: "sam@example.com", ManagerID: "pat"},
	}
	h := mountedWith(t, func(o *timeclock.Options) { o.Directory = people })
	const api = "/timeclock/api/v1"
	in := func(workspace, user, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
		if user != "" {
			req.Header.Set("X-Test-User", user)
		}
		if workspace != "" {
			req.Header.Set("X-Test-Workspace", workspace)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}
	// fetch is a calendar app reading a feed: signed out, in no workspace.
	fetch := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		rec, _ := in("", "", http.MethodGet, path, "")
		return rec
	}
	day := func(n int) string { return time.Now().AddDate(0, 0, n).Format(time.DateOnly) }
	compact := func(n int) string { return time.Now().AddDate(0, 0, n).Format("20060102") }

	if _, body := in("", "ada", http.MethodGet, api+"/calendar/feed", ""); body["enabled"] != false {
		t.Fatalf("ada's feed before making one: %v", body)
	}
	rec, body := in("", "ada", http.MethodPost, api+"/calendar/feed", "")
	adaFeed, _ := body["path"].(string)
	if rec.Code != http.StatusOK || body["enabled"] != true || !strings.HasPrefix(adaFeed, api+"/calendar/feeds/") || !strings.HasSuffix(adaFeed, ".ics") {
		t.Fatalf("make ada's feed: %d %v", rec.Code, body)
	}
	if _, body := in("", "ada", http.MethodGet, api+"/calendar/feed", ""); body["enabled"] != true || body["path"] != nil {
		t.Fatalf("ada's feed after: %v", body)
	}
	_, body = in("", "pat", http.MethodPost, api+"/calendar/feed", "")
	patFeed, _ := body["path"].(string)

	// A holiday, Ada's approved vacation, Sam's half day sick and a request
	// still pending.
	if rec, _ := in("", "pat", http.MethodPost, api+"/holidays", fmt.Sprintf(`{"name":"Founders, Day","days":[{"day":%q},{"day":%q}]}`, day(30), day(31))); rec.Code != http.StatusOK {
		t.Fatalf("add a holiday: %d %s", rec.Code, rec.Body)
	}
	approve := func(user, request string) {
		t.Helper()
		rec, body := in("", user, http.MethodPost, api+"/time-off", request)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s requests time off: %d %s", user, rec.Code, rec.Body)
		}
		for _, o := range body["timeOff"].([]any) {
			id := o.(map[string]any)["id"].(string)
			if rec, _ := in("", "pat", http.MethodPost, api+"/time-off/"+id+"/decision", `{"approve":true}`); rec.Code != http.StatusOK {
				t.Fatalf("approve: %d %s", rec.Code, rec.Body)
			}
		}
	}
	approve("ada", fmt.Sprintf(`{"kind":"vacation","from":%q,"to":%q,"hours":8,"weekends":true}`, day(20), day(22)))
	approve("sam", fmt.Sprintf(`{"kind":"sick","from":%q,"to":%q,"hours":4,"weekends":true}`, day(5), day(5)))
	if rec, _ := in("", "sam", http.MethodPost, api+"/time-off", fmt.Sprintf(`{"kind":"vacation","from":%q,"to":%q,"hours":8,"weekends":true}`, day(40), day(40))); rec.Code != http.StatusOK {
		t.Fatalf("sam requests time off: %d %s", rec.Code, rec.Body)
	}

	rec = fetch(adaFeed)
	ics := strings.ReplaceAll(rec.Body.String(), "\r\n ", "")
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/calendar") {
		t.Fatalf("ada's feed: %d %q %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body)
	}
	for _, want := range []string{
		"X-WR-CALNAME:Timeclock time off\r\n",
		"DTSTART;VALUE=DATE:" + compact(30) + "\r\nDTEND;VALUE=DATE:" + compact(32) + "\r\nSUMMARY:Founders\\, Day\r\n",
		// Her own says what it is, over three days.
		"DTSTART;VALUE=DATE:" + compact(20) + "\r\nDTEND;VALUE=DATE:" + compact(23) + "\r\nSUMMARY:Vacation\r\n",
		// Someone else's only that they're out.
		"DTSTART;VALUE=DATE:" + compact(5) + "\r\nDTEND;VALUE=DATE:" + compact(6) + "\r\nSUMMARY:Sam Rivera out (4h)\r\n",
	} {
		if !strings.Contains(ics, want) {
			t.Errorf("ada's feed is missing %q:\n%s", want, ics)
		}
	}
	if strings.Contains(ics, compact(40)) || strings.Contains(strings.ToLower(ics), "sick") {
		t.Errorf("ada's feed shows pending time off, or what kind Sam's is:\n%s", ics)
	}
	if ics := fetch(patFeed).Body.String(); !strings.Contains(ics, "SUMMARY:Ada Lovelace out\r\n") {
		t.Errorf("pat's feed doesn't show Ada out:\n%s", ics)
	}

	// Making a new address retires the old one; turning it off retires both.
	_, body = in("", "ada", http.MethodPost, api+"/calendar/feed", "")
	newFeed, _ := body["path"].(string)
	if fetch(adaFeed).Code != http.StatusNotFound || fetch(newFeed).Code != http.StatusOK {
		t.Fatalf("a new address: old %d, new %d", fetch(adaFeed).Code, fetch(newFeed).Code)
	}
	if rec, _ := in("", "ada", http.MethodDelete, api+"/calendar/feed", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("turn off: %d", rec.Code)
	}
	if fetch(newFeed).Code != http.StatusNotFound {
		t.Fatal("a feed turned off still works")
	}
	for _, path := range []string{api + "/calendar/feeds/nope.ics", api + "/calendar/feeds/" + strings.TrimSuffix(strings.TrimPrefix(patFeed, api+"/calendar/feeds/"), ".ics")} {
		if rec := fetch(path); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}

	// Someone who leaves the host's directory takes their feed with them.
	_, body = in("", "sam", http.MethodPost, api+"/calendar/feed", "")
	samFeed, _ := body["path"].(string)
	if fetch(samFeed).Code != http.StatusOK {
		t.Fatal("sam's feed")
	}
	delete(people, "sam")
	if rec := fetch(samFeed); rec.Code != http.StatusNotFound {
		t.Fatalf("the feed of someone who left: %d", rec.Code)
	}

	// A feed lists its own workspace's, though the app fetching it names none.
	in("north", "pat", http.MethodPost, api+"/holidays", fmt.Sprintf(`{"name":"North Day","days":[{"day":%q}]}`, day(50)))
	_, body = in("north", "pat", http.MethodPost, api+"/calendar/feed", "")
	north := fetch(body["path"].(string)).Body.String()
	if !strings.Contains(north, "SUMMARY:North Day") || strings.Contains(north, "Founders") || strings.Contains(north, "Ada") {
		t.Errorf("north's feed:\n%s", north)
	}
}
