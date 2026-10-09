package ical

import (
	"strings"
	"testing"
	"time"
)

func TestEncode(t *testing.T) {
	day := func(s string) time.Time { d, _ := time.Parse(time.DateOnly, s); return d }
	got := string(Encode(Calendar{
		Name:    "Acme, Inc. time off",
		Refresh: time.Hour,
		Events: []Event{
			{UID: "a@timeclock", Summary: "Thanksgiving; and the day after", Start: day("2026-11-26"), End: day("2026-11-27")},
		},
	}, time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)))
	for _, want := range []string{
		"BEGIN:VCALENDAR\r\n",
		"X-WR-CALNAME:Acme\\, Inc. time off\r\n",
		"REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n",
		"DTSTAMP:20261009T120000Z\r\n",
		"DTSTART;VALUE=DATE:20261126\r\n",
		"DTEND;VALUE=DATE:20261128\r\n",
		"SUMMARY:Thanksgiving\\; and the day after\r\n",
		"END:VCALENDAR\r\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
}

func TestFoldKeepsLinesShortAndCharactersWhole(t *testing.T) {
	var b strings.Builder
	long := "SUMMARY:" + strings.Repeat("é", 100)
	fold(&b, long)
	lines := strings.Split(strings.TrimSuffix(b.String(), "\r\n"), "\r\n")
	if len(lines) < 2 {
		t.Fatalf("not folded: %q", b.String())
	}
	var joined string
	for i, l := range lines {
		if len(l) > 75 {
			t.Errorf("line %d is %d octets", i, len(l))
		}
		if i > 0 {
			l = strings.TrimPrefix(l, " ")
		}
		joined += l
	}
	if joined != long {
		t.Errorf("unfolded to %q", joined)
	}
}
