package gcal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEventsKeepsTimedEventsAcrossPages(t *testing.T) {
	from := time.Date(2026, 10, 5, 5, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 7)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/calendars/primary/events" {
			t.Errorf("path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("timeMin") != "2026-10-05T05:00:00Z" || q.Get("timeMax") != "2026-10-12T05:00:00Z" || q.Get("singleEvents") != "true" {
			t.Errorf("query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		if q.Get("pageToken") == "" {
			_, _ = w.Write([]byte(`{"summary":"pat@example.com","nextPageToken":"two","items":[
				{"id":"a","status":"confirmed","summary":"Standup","htmlLink":"https://calendar.example/a",
				 "start":{"dateTime":"2026-10-05T09:00:00-05:00"},"end":{"dateTime":"2026-10-05T09:15:00-05:00"}},
				{"id":"b","status":"confirmed","summary":"Holiday","start":{"date":"2026-10-06"},"end":{"date":"2026-10-07"}},
				{"id":"c","status":"cancelled","summary":"Gone","start":{"dateTime":"2026-10-06T10:00:00Z"},"end":{"dateTime":"2026-10-06T11:00:00Z"}}
			]}`))
			return
		}
		_, _ = w.Write([]byte(`{"summary":"pat@example.com","items":[
			{"id":"d","status":"confirmed","summary":"Declined","start":{"dateTime":"2026-10-07T10:00:00Z"},"end":{"dateTime":"2026-10-07T11:00:00Z"},
			 "attendees":[{"self":true,"responseStatus":"declined"}]},
			{"id":"e","status":"confirmed","summary":"Review","start":{"dateTime":"2026-10-08T13:00:00-05:00"},"end":{"dateTime":"2026-10-08T14:00:00-05:00"},
			 "attendees":[{"self":false,"responseStatus":"declined"},{"self":true,"responseStatus":"accepted"}]}
		]}`))
	}))
	defer server.Close()

	cal, err := (&Client{HTTP: server.Client(), BaseURL: server.URL}).Events(context.Background(), from, to)
	if err != nil {
		t.Fatal(err)
	}
	if cal.Name != "pat@example.com" {
		t.Errorf("name: %q", cal.Name)
	}
	if len(cal.Events) != 2 || cal.Events[0].ID != "a" || cal.Events[1].ID != "e" {
		t.Fatalf("events: %+v", cal.Events)
	}
	if got := cal.Events[0]; got.Title != "Standup" || got.Link != "https://calendar.example/a" ||
		!got.Start.Equal(time.Date(2026, 10, 5, 14, 0, 0, 0, time.UTC)) || got.End.Sub(got.Start) != 15*time.Minute {
		t.Errorf("standup: %+v", got)
	}
}

func TestEventsReportsDenial(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":{"message":"secret detail"}}`, http.StatusForbidden)
	}))
	defer server.Close()
	_, err := (&Client{HTTP: server.Client(), BaseURL: server.URL}).Events(context.Background(), time.Now(), time.Now().Add(time.Hour))
	if !Denied(err) {
		t.Fatalf("err: %v", err)
	}
	if err.Error() != "Google Calendar denied access" {
		t.Errorf("message: %q", err)
	}
}
