package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
)

// New creates a fresh command tree. No configuration or network is needed for help.
func New(version string) *cobra.Command {
	o := &options{token: os.Getenv("TIMECLOCK_TOKEN")}
	root := &cobra.Command{
		Use: "timeclock", Short: "Track time from your terminal", Version: version,
		SilenceUsage: true, SilenceErrors: true,
	}
	f := root.PersistentFlags()
	f.StringVar(&o.server, "server", os.Getenv("TIMECLOCK_URL"), "Server URL, including any mount path (TIMECLOCK_URL)")
	f.StringVar(&o.configPath, "config", os.Getenv("TIMECLOCK_CONFIG"), "Config file (TIMECLOCK_CONFIG; default: user config directory/timeclock/config.json)")
	f.BoolVar(&o.json, "json", false, "Print the full JSON response")
	f.StringVar(&o.credentialStore, "credential-store", os.Getenv("TIMECLOCK_CREDENTIAL_STORE"), "OAuth credential storage: keyring (default) or file (explicit headless fallback)")
	f.BoolVar(&o.allowHTTP, "allow-http", false, "Allow unencrypted HTTP to a remote server")
	f.DurationVar(&o.timeout, "timeout", 30*time.Second, "HTTP request timeout")
	root.AddCommand(o.authCommand(version))
	root.AddCommand(o.endpoint(version, "status", "Show your identity and running clock", "GET", "/me", "status"))
	clock := &cobra.Command{Use: "clock", Short: "Start, stop, or switch your clock"}
	for _, action := range []string{"in", "switch", "out"} {
		cmd := o.endpoint(version, action, map[string]string{"in": "Start your clock", "switch": "Move your running clock to another project", "out": "Stop your clock"}[action], "POST", "/clock/"+action, "entry")
		if action != "out" {
			cmd.Flags().String("project", "", "Project UUID (see timeclock projects)")
			cmd.Flags().String("note", "", "What you are working on")
		}
		clock.AddCommand(cmd)
	}
	root.AddCommand(clock)
	for _, resource := range []string{"projects", "customers", "people", "activity"} {
		cmd := o.endpoint(version, resource, "List "+resource, "GET", "/"+resource, resource)
		if resource == "projects" || resource == "customers" {
			cmd.Flags().Bool("archived", false, "Include archived records")
		}
		root.AddCommand(cmd)
	}
	entries := &cobra.Command{Use: "entries", Short: "List, record, edit, or delete time"}
	list := o.endpoint(version, "list", "List time in a date range", "GET", "/entries", "entries")
	rangeFlags(list, true)
	entries.AddCommand(list)
	for _, action := range []string{"add", "update", "delete"} {
		method, path, use := "POST", "/entries", action
		if action != "add" {
			path += "/{id}"
			use += " ID"
			method = "PUT"
		}
		if action == "delete" {
			method = "DELETE"
		}
		cmd := o.endpoint(version, use, map[string]string{"add": "Record finished time", "update": "Replace an entry's fields (omit --end only for a running entry)", "delete": "Delete an unlocked entry"}[action], method, path, "entry")
		if action != "delete" {
			cmd.Flags().String("start", "", "Start time with offset (RFC3339, e.g. 2026-10-05T09:00:00-05:00)")
			cmd.Flags().String("end", "", "End time with offset (RFC3339)")
			cmd.Flags().String("project", "", "Project UUID; omitted clears the project on update")
			cmd.Flags().String("note", "", "Description; omitted clears the description on update")
			cmd.Flags().String("person", "", "Person ID; defaults to yourself")
			mustRequire(cmd, "start")
			if action == "add" {
				mustRequire(cmd, "end")
			}
		}
		entries.AddCommand(cmd)
	}
	root.AddCommand(entries)
	timesheet := &cobra.Command{Use: "timesheet", Short: "View, submit, approve, or reopen timesheets"}
	show := o.endpoint(version, "show", "Show hours for a pay period", "GET", "/timesheet", "summary")
	dayFlags(show, true)
	timesheet.AddCommand(show)
	submit := o.endpoint(version, "submit", "Submit a pay period and lock its time", "POST", "/timesheet/submit", "summary")
	dayFlags(submit, true)
	mustRequire(submit, "day")
	timesheet.AddCommand(submit)
	for _, action := range []string{"approve", "reject", "reopen"} {
		path := "/timesheets/{id}/decision"
		if action == "reopen" {
			path = "/timesheets/{id}/reopen"
		}
		cmd := o.endpoint(version, action+" ID", strings.ToUpper(action[:1])+action[1:]+" a timesheet", "POST", path, "")
		cmd.Flags().String("note", "", "Reason for the decision")
		timesheet.AddCommand(cmd)
	}
	root.AddCommand(timesheet)
	team := o.endpoint(version, "team", "Show the team's pay period", "GET", "/team", "members")
	dayFlags(team, false)
	root.AddCommand(team)
	reports := &cobra.Command{Use: "reports", Short: "Inspect hours or export CSV to stdout"}
	for _, resource := range []string{"payroll", "projects", "exceptions"} {
		path := "/reports/" + resource
		if resource == "exceptions" {
			path = "/exceptions"
		}
		cmd := o.endpoint(version, resource, "Show the "+resource+" report", "GET", path, "rows")
		if resource == "projects" {
			rangeFlags(cmd, false)
		} else {
			dayFlags(cmd, false)
		}
		if resource != "exceptions" {
			cmd.Flags().Bool("csv", false, "Write CSV to stdout (redirect to a file)")
		}
		if resource == "payroll" {
			cmd.Flags().Bool("all", false, "Include unsettled time in CSV export")
		}
		reports.AddCommand(cmd)
	}
	root.AddCommand(reports, o.apiCommand(version))
	return root
}

func mustRequire(cmd *cobra.Command, name string) {
	if err := cmd.MarkFlagRequired(name); err != nil {
		panic(err)
	}
}

func rangeFlags(cmd *cobra.Command, person bool) {
	cmd.Flags().String("from", "", "First day, inclusive (YYYY-MM-DD)")
	cmd.Flags().String("to", "", "Last day, inclusive (YYYY-MM-DD)")
	mustRequire(cmd, "from")
	mustRequire(cmd, "to")
	if person {
		cmd.Flags().String("person", "", "Person ID; defaults to yourself")
	}
}

func dayFlags(cmd *cobra.Command, person bool) {
	cmd.Flags().String("day", "", "Any day in the pay period (YYYY-MM-DD); defaults to today on the server")
	if person {
		cmd.Flags().String("person", "", "Person ID; defaults to yourself")
	}
}

func flag(cmd *cobra.Command, name string) string {
	if f := cmd.Flags().Lookup(name); f != nil {
		return f.Value.String()
	}
	return ""
}

func (o *options) endpoint(version, use, short, method, path, view string) *cobra.Command {
	cmd := &cobra.Command{Use: use, Short: short, Args: cobra.NoArgs}
	if strings.Contains(path, "{id}") {
		cmd.Args = cobra.ExactArgs(1)
	}
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		endpoint := path
		if len(args) > 0 {
			id, err := uuid.Parse(args[0])
			if err != nil {
				return errors.New("ID must be a UUID")
			}
			endpoint = strings.ReplaceAll(endpoint, "{id}", id.String())
		}
		query, body, err := commandInput(cmd, method)
		if err != nil {
			return err
		}
		if flag(cmd, "csv") == "true" {
			if o.json {
				return errors.New("--csv and --json cannot be combined")
			}
			endpoint += ".csv"
		} else if flag(cmd, "all") == "true" {
			return errors.New("--all requires --csv")
		}
		c, err := o.client(cmd.Context(), version, true)
		if err != nil {
			return err
		}
		data, err := c.request(cmd.Context(), method, "/api/v1"+endpoint, query, body)
		if err != nil {
			return err
		}
		return render(cmd.OutOrStdout(), data, o.json, view)
	}
	return cmd
}

func commandInput(cmd *cobra.Command, method string) (url.Values, []byte, error) {
	q := url.Values{}
	for _, key := range []string{"from", "to", "day"} {
		if s := flag(cmd, key); s != "" {
			if _, err := time.Parse(time.DateOnly, s); err != nil {
				return nil, nil, fmt.Errorf("--%s must be YYYY-MM-DD", key)
			}
		}
	}
	if from, to := flag(cmd, "from"), flag(cmd, "to"); from != "" && to != "" && from > to {
		return nil, nil, errors.New("--to must be on or after --from")
	}
	if method == http.MethodGet {
		for _, key := range []string{"from", "to", "day", "person", "archived", "all"} {
			if value := flag(cmd, key); value != "" {
				q.Set(key, value)
			}
		}
		return q, nil, nil
	}
	if method == http.MethodDelete {
		return q, nil, nil
	}
	body := map[string]any{}
	for _, key := range []string{"note", "day", "person"} {
		if value := flag(cmd, key); value != "" {
			if key == "person" {
				key = "personId"
			}
			body[key] = value
		}
	}
	if s := flag(cmd, "project"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, nil, errors.New("--project must be a UUID")
		}
		body["projectId"] = id.String()
	}
	var start, end time.Time
	for _, key := range []string{"start", "end"} {
		if s := flag(cmd, key); s != "" {
			t, err := time.Parse(time.RFC3339, s)
			if err != nil {
				return nil, nil, fmt.Errorf("--%s must be RFC3339 with a time zone offset", key)
			}
			if key == "start" {
				start = t
				body["startedAt"] = s
			} else {
				end = t
				body["endedAt"] = s
			}
		}
	}
	if !start.IsZero() && !end.IsZero() && !end.After(start) {
		return nil, nil, errors.New("--end must be after --start")
	}
	if cmd.Name() == "approve" || cmd.Name() == "reject" {
		body["approve"] = cmd.Name() == "approve"
	}
	data, err := json.Marshal(body)
	return q, data, err
}

func (o *options) apiCommand(version string) *cobra.Command {
	var method, input string
	cmd := &cobra.Command{
		Use: "api PATH", Short: "Call an API path relative to /api/v1 (JSON or CSV output)", Args: cobra.ExactArgs(1),
		Example: "  timeclock api '/time-off?from=2026-10-01&to=2026-11-01'\n  timeclock api /projects --method POST --input project.json",
		RunE: func(cmd *cobra.Command, args []string) error {
			u, err := url.Parse(args[0])
			if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" {
				return errors.New("PATH must be relative to /api/v1")
			}
			path := "/" + strings.TrimPrefix(u.Path, "/")
			for _, segment := range strings.Split(path, "/") {
				if segment == "." || segment == ".." {
					return errors.New("PATH cannot contain dot segments")
				}
			}
			method = strings.ToUpper(method)
			switch method {
			case "GET", "POST", "PUT", "PATCH", "DELETE":
			default:
				return errors.New("unsupported HTTP method")
			}
			var body []byte
			if input != "" {
				if input == "-" {
					body, err = io.ReadAll(io.LimitReader(cmd.InOrStdin(), 1<<20+1))
				} else {
					body, err = os.ReadFile(input)
				}
				if err != nil {
					return err
				}
				if len(body) > 1<<20 {
					return errors.New("input exceeds 1 MiB")
				}
				if !json.Valid(body) {
					return errors.New("input must be valid JSON")
				}
			}
			c, err := o.client(cmd.Context(), version, true)
			if err != nil {
				return err
			}
			data, err := c.request(cmd.Context(), method, "/api/v1"+path, u.Query(), body)
			if err != nil {
				return err
			}
			return render(cmd.OutOrStdout(), data, true, "")
		},
	}
	cmd.Flags().StringVarP(&method, "method", "X", "GET", "HTTP method")
	cmd.Flags().StringVar(&input, "input", "", "JSON body file; - reads stdin")
	return cmd
}
