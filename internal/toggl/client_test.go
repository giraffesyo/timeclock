package toggl

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReportPaginationAndAuthentication(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		user, password, ok := r.BasicAuth()
		if !ok || user != "secret" || password != "api_token" {
			t.Error("wrong authentication")
		}
		if r.URL.Path != "/reports/api/v3/workspace/42/search/time_entries" {
			t.Errorf("path: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["rounding"] != float64(0) || body["grouped"] != false {
			t.Error("report must preserve original durations and entries")
		}
		if calls == 1 {
			w.Header().Set("X-Next-ID", "12")
			w.Header().Set("X-Next-Row-Number", "2")
		} else if body["first_id"] != float64(12) || body["first_row_number"] != float64(2) {
			t.Error("missing continuation")
		}
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"user_id": 7, "description": "work", "time_entries": []any{map[string]any{"id": calls, "start": "2026-10-01T09:00:00Z", "stop": "2026-10-01T10:00:00Z", "seconds": 3600}}}})
	}))
	defer server.Close()
	c := Client{Token: "secret", BaseURL: server.URL, HTTP: server.Client()}
	entries, err := c.Report(t.Context(), 42, "2026-10-01", "2026-10-02")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(entries) != 2 || entries[1].UserID != 7 || entries[1].WorkspaceID != 42 || entries[1].Duration != 3600 {
		t.Fatalf("incomplete report: %#v", entries)
	}
}
func TestReportFailureDoesNotReturnPartialData(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("X-Next-ID", "1")
			_, _ = w.Write([]byte(`[{"user_id":1,"time_entries":[{"id":1,"start":"2026-10-01T09:00:00Z","seconds":3600}]}]`))
			return
		}
		w.Header().Set("Retry-After", "7200")
		w.WriteHeader(429)
		_, _ = w.Write([]byte("private secret token"))
	}))
	defer server.Close()
	c := Client{BaseURL: server.URL, HTTP: server.Client()}
	entries, err := c.Report(t.Context(), 1, "2026-10-01", "2026-10-02")
	e, ok := errors.AsType[*Error](err)
	if !ok || e.Status != 429 || e.RetryAfter != 2*time.Hour || entries != nil {
		t.Fatalf("unexpected result: %v %v", entries, err)
	}
	if e.Error() == "private secret token" {
		t.Fatal("leaked remote body")
	}
}
func TestReportRepeatedCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Next-ID", "1")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()
	c := Client{BaseURL: server.URL, HTTP: server.Client()}
	if _, err := c.Report(context.Background(), 1, "2026-10-01", "2026-10-02"); err == nil {
		t.Fatal("repeated cursor was accepted")
	}
}
