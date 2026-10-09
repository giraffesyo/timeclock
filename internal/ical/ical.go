// Package ical writes iCalendar (RFC 5545) feeds of all-day events, which
// calendar apps such as Google Calendar subscribe to by address.
package ical

import (
	"strconv"
	"strings"
	"time"
)

// Calendar is a feed's name and events.
type Calendar struct {
	Name        string
	Description string
	// Refresh is how often a subscriber should fetch the feed again; apps
	// treat it as a hint.
	Refresh time.Duration
	Events  []Event
}

// Event is an all-day event on the days Start..End, both inclusive, as
// dates with no time zone.
type Event struct {
	UID     string
	Summary string
	Start   time.Time
	End     time.Time
}

// Encode writes c as an iCalendar document, stamped now.
func Encode(c Calendar, now time.Time) []byte {
	var b strings.Builder
	line := func(name, value string) { fold(&b, name+":"+value) }
	line("BEGIN", "VCALENDAR")
	line("VERSION", "2.0")
	line("PRODID", "-//Timeclock//Calendar feed//EN")
	line("CALSCALE", "GREGORIAN")
	line("METHOD", "PUBLISH")
	if c.Name != "" {
		line("X-WR-CALNAME", text(c.Name))
	}
	if c.Description != "" {
		line("X-WR-CALDESC", text(c.Description))
	}
	if c.Refresh > 0 {
		d := duration(c.Refresh)
		line("REFRESH-INTERVAL;VALUE=DURATION", d)
		line("X-PUBLISHED-TTL", d)
	}
	stamp := now.UTC().Format("20060102T150405Z")
	for _, e := range c.Events {
		line("BEGIN", "VEVENT")
		line("UID", text(e.UID))
		line("DTSTAMP", stamp)
		line("DTSTART;VALUE=DATE", e.Start.Format("20060102"))
		// DTEND is the day after the last, which isn't in the event.
		line("DTEND;VALUE=DATE", e.End.AddDate(0, 0, 1).Format("20060102"))
		line("SUMMARY", text(e.Summary))
		// Free: a day someone else is out doesn't make the subscriber busy.
		line("TRANSP", "TRANSPARENT")
		line("END", "VEVENT")
	}
	line("END", "VCALENDAR")
	return []byte(b.String())
}

// text escapes a TEXT value.
func text(s string) string {
	return strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`, "\r", `\n`).Replace(s)
}

// duration is d as an RFC 5545 duration, in whole minutes.
func duration(d time.Duration) string {
	m := int(d / time.Minute)
	if m < 1 {
		m = 1
	}
	if m%60 == 0 {
		return "PT" + strconv.Itoa(m/60) + "H"
	}
	return "PT" + strconv.Itoa(m) + "M"
}

// fold writes a content line, folded so no line is longer than 75 octets,
// without splitting a UTF-8 character.
func fold(b *strings.Builder, s string) {
	limit := 75
	for len(s) > limit {
		cut := limit
		for cut > 0 && s[cut]&0xC0 == 0x80 { // a continuation byte
			cut--
		}
		b.WriteString(s[:cut])
		b.WriteString("\r\n ")
		s = s[cut:]
		limit = 74 // the leading space counts
	}
	b.WriteString(s)
	b.WriteString("\r\n")
}
