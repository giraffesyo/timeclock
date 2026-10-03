package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/giraffesyo/timeclock/internal/clock"
)

// payrollRow is one person's line in the payroll report.
type payrollRow struct {
	clock.PeriodSummary
	Ready bool `json:"ready" doc:"The person's time is settled for this period: approved, or submitted when timesheets need no approval. Only ready people are in the export."`
}

type payrollBody struct {
	Period clock.Period `json:"period"`
	Rows   []payrollRow `json:"rows"`
	// NotReady counts the people left out of the export.
	NotReady int `json:"notReady"`
}

type exceptionsBody struct {
	Period     clock.Period      `json:"period"`
	Exceptions []clock.Exception `json:"exceptions"`
}

type csvResponse struct {
	ContentType        string `header:"Content-Type"`
	ContentDisposition string `header:"Content-Disposition"`
	Body               []byte
}

func csvFile(name string, rows [][]string) (*csvResponse, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	if err := w.WriteAll(rows); err != nil {
		return nil, fmt.Errorf("write csv: %w", err)
	}
	return &csvResponse{
		ContentType:        "text/csv; charset=utf-8",
		ContentDisposition: `attachment; filename="` + name + `"`,
		Body:               buf.Bytes(),
	}, nil
}

func hours(h float64) string { return strconv.FormatFloat(h, 'f', 2, 64) }

// splitName gives a person's name as payroll files want it: everything
// before the last word, and the last word.
func splitName(name string) (first, last string) {
	parts := strings.Fields(name)
	if len(parts) < 2 {
		return name, ""
	}
	return strings.Join(parts[:len(parts)-1], " "), parts[len(parts)-1]
}

func (d Deps) payroll(ctx context.Context, dayParam string) (payrollBody, error) {
	actor, err := d.actor(ctx)
	if err != nil {
		return payrollBody{}, err
	}
	day, err := d.day(ctx, "day", dayParam)
	if err != nil {
		return payrollBody{}, err
	}
	cfg, err := d.Clock.Settings(ctx)
	if err != nil {
		return payrollBody{}, err
	}
	team, err := d.Clock.Payroll(ctx, actor, day)
	if err != nil {
		return payrollBody{}, err
	}
	out := payrollBody{Period: cfg.PeriodOf(day), Rows: []payrollRow{}}
	for _, sum := range team {
		row := payrollRow{PeriodSummary: sum, Ready: sum.Timesheet != nil && sum.Timesheet.Status == clock.StatusApproved}
		if !row.Ready {
			out.NotReady++
		}
		out.Rows = append(out.Rows, row)
	}
	return out, nil
}

func registerReports(a huma.API, d Deps) {
	huma.Register(a, op(http.MethodGet, "/exceptions", "list-exceptions", "What payroll should look at in a pay period", "Reports"),
		func(ctx context.Context, in *struct {
			Day string `query:"day" format:"date" doc:"Any day in the pay period. Defaults to today."`
		}) (*struct{ Body exceptionsBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			day, err := d.day(ctx, "day", in.Day)
			if err != nil {
				return nil, err
			}
			cfg, err := d.Clock.Settings(ctx)
			if err != nil {
				return nil, err
			}
			list, err := d.Clock.Exceptions(ctx, actor, day)
			if err != nil {
				return nil, err
			}
			return &struct{ Body exceptionsBody }{exceptionsBody{Period: cfg.PeriodOf(day), Exceptions: orEmpty(list)}}, nil
		})

	huma.Register(a, op(http.MethodGet, "/reports/payroll", "payroll-report", "Everyone's hours for a pay period", "Reports"),
		func(ctx context.Context, in *struct {
			Day string `query:"day" format:"date" doc:"Any day in the pay period. Defaults to today."`
		}) (*struct{ Body payrollBody }, error) {
			out, err := d.payroll(ctx, in.Day)
			if err != nil {
				return nil, err
			}
			return &struct{ Body payrollBody }{out}, nil
		})

	// The columns are the ones Gusto's hours import reads. People whose time
	// isn't settled are left out, so nothing unapproved is paid by accident;
	// the JSON report says who they are.
	huma.Register(a, op(http.MethodGet, "/reports/payroll.csv", "payroll-export", "A pay period's hours as a file for the payroll system", "Reports"),
		func(ctx context.Context, in *struct {
			Day string `query:"day" format:"date" doc:"Any day in the pay period. Defaults to today."`
			All bool   `query:"all" doc:"Include people whose time isn't settled."`
		}) (*csvResponse, error) {
			report, err := d.payroll(ctx, in.Day)
			if err != nil {
				return nil, err
			}
			rows := [][]string{{"last_name", "first_name", "gusto_employee_id", "regular_hours", "overtime_hours", "double_overtime_hours", "pto_hours", "sick_hours"}}
			for _, r := range report.Rows {
				if !r.Ready && !in.All {
					continue
				}
				first, last := splitName(r.Person.Name)
				rows = append(rows, []string{last, first, r.Person.PayrollID, hours(r.Regular), hours(r.Overtime), hours(0), hours(r.Vacation), hours(r.Sick)})
			}
			return csvFile(fmt.Sprintf("payroll-%s-to-%s.csv", report.Period.Start, report.Period.End), rows)
		})

	type projectsBody struct {
		Rows []clock.ProjectHours `json:"rows"`
	}
	huma.Register(a, op(http.MethodGet, "/reports/projects", "project-report", "Hours by customer, project and person", "Reports"),
		func(ctx context.Context, in *rangeQuery) (*struct{ Body projectsBody }, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			from, to, err := in.dates()
			if err != nil {
				return nil, err
			}
			rows, err := d.Clock.ProjectReport(ctx, actor, from, to)
			if err != nil {
				return nil, err
			}
			return &struct{ Body projectsBody }{projectsBody{Rows: rows}}, nil
		})

	huma.Register(a, op(http.MethodGet, "/reports/projects.csv", "project-export", "Hours by customer, project and person, as a file", "Reports"),
		func(ctx context.Context, in *rangeQuery) (*csvResponse, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			from, to, err := in.dates()
			if err != nil {
				return nil, err
			}
			report, err := d.Clock.ProjectReport(ctx, actor, from, to)
			if err != nil {
				return nil, err
			}
			rows := [][]string{{"customer", "project", "code", "billable", "person", "hours"}}
			for _, r := range report {
				rows = append(rows, []string{r.CustomerName, r.ProjectName, r.ProjectCode, strconv.FormatBool(r.Billable), r.PersonName, hours(r.Hours)})
			}
			return csvFile(fmt.Sprintf("projects-%s-to-%s.csv", from, to), rows)
		})

	huma.Register(a, op(http.MethodGet, "/audit", "list-audit", "Recent changes to payroll data", "Reports"),
		func(ctx context.Context, in *struct {
			Person string `query:"person" doc:"Only changes to this person's time."`
			Limit  int    `query:"limit" minimum:"1" maximum:"500" default:"100"`
		}) (*struct {
			Body struct {
				Entries []clock.AuditEntry `json:"entries"`
			}
		}, error) {
			actor, err := d.actor(ctx)
			if err != nil {
				return nil, err
			}
			list, err := d.Clock.Audit(ctx, actor, in.Person, in.Limit)
			if err != nil {
				return nil, err
			}
			out := &struct {
				Body struct {
					Entries []clock.AuditEntry `json:"entries"`
				}
			}{}
			out.Body.Entries = orEmpty(list)
			return out, nil
		})
}
