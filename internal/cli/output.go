package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

func render(w io.Writer, data []byte, asJSON bool, view string) error {
	if len(data) == 0 {
		return nil
	}
	if !json.Valid(data) {
		_, err := w.Write(data)
		return err
	}
	var value map[string]any
	if !asJSON && json.Unmarshal(data, &value) == nil {
		if view == "status" {
			if _, err := fmt.Fprintf(w, "%s (%s)\n", field(value, "person.name"), field(value, "person.email")); err != nil {
				return err
			}
			if running, ok := value["running"].(map[string]any); ok {
				return table(w, []any{running}, []string{"id", "startedAt", "projectId", "note"})
			}
			_, err := fmt.Fprintln(w, "Clock stopped.")
			return err
		}
		columns := map[string][]string{
			"projects":   {"id", "name", "customerName", "code", "archived"},
			"customers":  {"id", "name", "archived"},
			"people":     {"id", "name", "email"},
			"activity":   {"person.name", "today", "week", "running.note"},
			"entries":    {"id", "startedAt", "endedAt", "projectId", "note", "locked"},
			"members":    {"person.name", "regular", "overtime", "vacation", "sick", "timesheet.status"},
			"exceptions": {"personName", "kind", "day", "hours"},
		}
		if view == "entry" {
			return table(w, []any{value}, columns["entries"])
		}
		if view == "summary" {
			return table(w, []any{value}, columns["members"])
		}
		key := view
		if key == "activity" {
			key = "people"
		}
		if _, ok := value["exceptions"]; ok {
			key = "exceptions"
			view = key
		}
		if rows, ok := value[key].([]any); ok {
			cols := columns[view]
			if view == "rows" && len(rows) > 0 {
				if row, ok := rows[0].(map[string]any); ok {
					if _, payroll := row["person"]; payroll {
						cols = append(append([]string{}, columns["members"]...), "ready")
					} else {
						cols = []string{"customerName", "projectName", "personName", "hours"}
					}
				}
			}
			if len(rows) == 0 {
				_, err := fmt.Fprintln(w, "No records.")
				return err
			}
			if len(cols) > 0 {
				return table(w, rows, cols)
			}
		}
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, data, "", "  "); err != nil {
		return err
	}
	pretty.WriteByte('\n')
	_, err := w.Write(pretty.Bytes())
	return err
}

func field(row map[string]any, path string) string {
	var value any = row
	for _, key := range strings.Split(path, ".") {
		object, ok := value.(map[string]any)
		if !ok {
			return "-"
		}
		value = object[key]
	}
	if value == nil || value == "" {
		return "-"
	}
	// Server-controlled text must not inject terminal escapes or table rows.
	return strings.Map(func(r rune) rune {
		if r < 32 || (r >= 127 && r < 160) {
			return ' '
		}
		return r
	}, fmt.Sprint(value))
}

func table(w io.Writer, rows []any, columns []string) error {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, strings.Join(columns, "\t")); err != nil {
		return err
	}
	for _, row := range rows {
		object, ok := row.(map[string]any)
		if !ok {
			continue
		}
		cells := make([]string, len(columns))
		for i, key := range columns {
			cells[i] = field(object, key)
		}
		if _, err := fmt.Fprintln(tw, strings.Join(cells, "\t")); err != nil {
			return err
		}
	}
	return tw.Flush()
}
