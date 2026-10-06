// Package toggl implements the Toggl Track endpoints used by the migration bridge.
package toggl

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

const BaseURL = "https://api.track.toggl.com"

type Client struct {
	Token   string
	HTTP    *http.Client
	BaseURL string
}

// Error excludes response bodies: they can contain credentials or private data.
type Error struct {
	Status     int
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	switch e.Status {
	case 401, 403:
		return "Toggl denied access. Check the API token and team time permissions."
	case 429:
		return "Toggl's API limit was reached. Sync will retry later."
	default:
		return fmt.Sprintf("Toggl returned HTTP %d. Sync will retry later.", e.Status)
	}
}

// Timeout reports whether Toggl took too long to answer, as its reports API
// can for a long, busy date range.
func Timeout(err error) bool {
	var e net.Error
	return errors.As(err, &e) && e.Timeout()
}

func (c *Client) request(ctx context.Context, method, path string, body, out any) (http.Header, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return nil, err
		}
	}
	base := c.BaseURL
	if base == "" {
		base = BaseURL
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, &buf)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.Token, "api_token")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Timeclock")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	resp, err := client.Do(req)
	if err != nil {
		// Keep the cause (a timeout, a refused connection) for the admin and the log.
		return nil, fmt.Errorf("toggl could not be reached: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		retry := time.Hour
		if n, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && n > 0 {
			retry = time.Duration(n) * time.Second
		} else if at, err := http.ParseTime(resp.Header.Get("Retry-After")); err == nil && time.Until(at) > 0 {
			retry = time.Until(at)
		}
		return nil, &Error{Status: resp.StatusCode, RetryAfter: retry}
	}
	if out != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out); err != nil {
			return nil, errors.New("toggl returned an unreadable response")
		}
	}
	return resp.Header, nil
}

type Workspace struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	OrganizationID int64  `json:"organization_id"`
	Admin          bool   `json:"admin"`
	Role           string `json:"role"`
}
type User struct {
	ID       int64  `json:"user_id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Inactive bool   `json:"inactive"`
}

func (c *Client) Workspaces(ctx context.Context) ([]Workspace, error) {
	var w []Workspace
	_, err := c.request(ctx, "GET", "/api/v9/me/workspaces", nil, &w)
	return w, err
}

func decodeList[T any](raw json.RawMessage) ([]T, error) {
	var list []T
	if len(raw) > 0 && raw[0] == '[' {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, err
		}
		return list, nil
	}
	var page struct {
		Items []T `json:"items"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, err
	}
	if page.Items == nil {
		return nil, errors.New("toggl returned an incomplete list")
	}
	return page.Items, nil
}
func (c *Client) Users(ctx context.Context, w Workspace) ([]User, error) {
	var all []User
	for page := 1; page <= 100; page++ {
		var raw json.RawMessage
		_, err := c.request(ctx, "GET", fmt.Sprintf("/api/v9/organizations/%d/workspaces/%d/workspace_users?page=%d&per_page=200", w.OrganizationID, w.ID, page), nil, &raw)
		if err != nil {
			return nil, err
		}
		users, err := decodeList[User](raw)
		if err != nil {
			return nil, err
		}
		all = append(all, users...)
		if len(users) < 200 {
			return all, nil
		}
	}
	return nil, errors.New("toggl returned too many users")
}

type Entry struct {
	ID          int64      `json:"id"`
	WorkspaceID int64      `json:"workspace_id"`
	UserID      int64      `json:"user_id"`
	ProjectID   *int64     `json:"project_id"`
	Description string     `json:"description"`
	Start       time.Time  `json:"start"`
	Stop        *time.Time `json:"stop"`
	Duration    int64      `json:"duration"`
	DeletedAt   *time.Time `json:"server_deleted_at"`
}
type ReportGroup struct {
	UserID      int64  `json:"user_id"`
	ProjectID   *int64 `json:"project_id"`
	Description string `json:"description"`
	Entries     []struct {
		ID      int64      `json:"id"`
		Start   time.Time  `json:"start"`
		Stop    *time.Time `json:"stop"`
		Seconds int64      `json:"seconds"`
	} `json:"time_entries"`
}

// Report fetches every page before the caller reconciles anything. It never
// treats an incomplete result, a rate limit, or a missing row as a deletion.
type ReportCursor map[string]int64

// Row offsets and entry/time offsets are alternative pagination methods.
// Sending both makes Toggl skip entries, often returning an empty second page.
// Normalize saved cursors too: older versions persisted all three headers.
func (c ReportCursor) normalized() ReportCursor {
	if row, ok := c["first_row_number"]; ok {
		return ReportCursor{"first_row_number": row}
	}
	return c
}

func (c *Client) ReportPage(ctx context.Context, workspace int64, from, to string, cursor ReportCursor) ([]Entry, ReportCursor, error) {
	body := map[string]any{"start_date": from, "end_date": to, "page_size": 1000, "grouped": false, "rounding": 0, "rounding_minutes": 0, "order_by": "date", "order_dir": "ASC"}
	for k, v := range cursor.normalized() {
		body[k] = v
	}
	var raw json.RawMessage
	h, err := c.request(ctx, "POST", fmt.Sprintf("/reports/api/v3/workspace/%d/search/time_entries", workspace), body, &raw)
	if err != nil {
		return nil, nil, err
	}
	groups, err := decodeList[ReportGroup](raw)
	if err != nil {
		return nil, nil, err
	}
	entries := []Entry{}
	for _, g := range groups {
		for _, e := range g.Entries {
			entries = append(entries, Entry{ID: e.ID, WorkspaceID: workspace, UserID: g.UserID, ProjectID: g.ProjectID, Description: g.Description, Start: e.Start, Stop: e.Stop, Duration: e.Seconds})
		}
	}
	var next ReportCursor
	if h.Get("X-Next-ID") != "" || h.Get("X-Next-Row-Number") != "" {
		next = ReportCursor{}
		for field, value := range map[string]string{"first_id": h.Get("X-Next-ID"), "first_row_number": h.Get("X-Next-Row-Number"), "first_timestamp": h.Get("X-Next-Timestamp")} {
			if value != "" {
				n, err := strconv.ParseInt(value, 10, 64)
				if err != nil {
					return nil, nil, errors.New("toggl returned an invalid report cursor")
				}
				next[field] = n
			}
		}
	}
	return entries, next.normalized(), nil
}

func (c *Client) Report(ctx context.Context, workspace int64, from, to string) ([]Entry, error) {
	var all []Entry
	var cursor ReportCursor
	seen := map[string]bool{}
	for page := 0; page < 1000; page++ {
		entries, next, err := c.ReportPage(ctx, workspace, from, to, cursor)
		if err != nil {
			return nil, err
		}
		all = append(all, entries...)
		if next == nil {
			return all, nil
		}
		raw, _ := json.Marshal(next)
		if seen[string(raw)] {
			return nil, errors.New("toggl repeated a report page")
		}
		seen[string(raw)] = true
		cursor = next
	}
	return nil, errors.New("toggl report is too large")
}
func (c *Client) Entry(ctx context.Context, id int64) (Entry, error) {
	var e Entry
	_, err := c.request(ctx, "GET", fmt.Sprintf("/api/v9/me/time_entries/%d", id), nil, &e)
	return e, err
}

type Project struct {
	ID          int64  `json:"id"`
	WorkspaceID int64  `json:"workspace_id"`
	Name        string `json:"name"`
	ClientID    *int64 `json:"client_id"`
	Billable    bool   `json:"billable"`
	Active      bool   `json:"active"`
}
type Customer struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

func (c *Client) Projects(ctx context.Context, workspace int64) ([]Project, error) {
	var all []Project
	for page := 1; page <= 1000; page++ {
		var raw json.RawMessage
		_, err := c.request(ctx, "GET", fmt.Sprintf("/api/v9/workspaces/%d/projects?active=both&page=%d&per_page=200", workspace, page), nil, &raw)
		if err != nil {
			return nil, err
		}
		p, err := decodeList[Project](raw)
		if err != nil {
			return nil, err
		}
		all = append(all, p...)
		if len(p) < 200 {
			return all, nil
		}
	}
	return nil, errors.New("toggl returned too many projects")
}
func (c *Client) Customers(ctx context.Context, workspace int64) ([]Customer, error) {
	var raw json.RawMessage
	_, err := c.request(ctx, "GET", fmt.Sprintf("/api/v9/workspaces/%d/clients?status=both", workspace), nil, &raw)
	if err != nil {
		return nil, err
	}
	return decodeList[Customer](raw)
}

type Write struct {
	WorkspaceID int64      `json:"workspace_id"`
	UserID      int64      `json:"user_id"`
	ProjectID   *int64     `json:"project_id"`
	Description string     `json:"description"`
	Start       time.Time  `json:"start"`
	Stop        *time.Time `json:"stop"`
	Duration    int64      `json:"duration"`
	CreatedWith string     `json:"created_with,omitempty"`
}

func (c *Client) Save(ctx context.Context, w Write, id int64) (Entry, error) {
	method, path := "PUT", fmt.Sprintf("/api/v9/workspaces/%d/time_entries/%d", w.WorkspaceID, id)
	if id == 0 {
		method = "POST"
		path = fmt.Sprintf("/api/v9/workspaces/%d/time_entries", w.WorkspaceID)
		w.CreatedWith = "Timeclock"
	}
	var e Entry
	_, err := c.request(ctx, method, path, w, &e)
	return e, err
}
func (c *Client) Delete(ctx context.Context, workspace, id int64) error {
	_, err := c.request(ctx, "DELETE", fmt.Sprintf("/api/v9/workspaces/%d/time_entries/%d", workspace, id), nil, nil)
	return err
}
