package toggl

import (
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestLiveWorkspaceContract is opt-in and read-only. Keep the token in a local
// file, outside the repository, and select the test workspace explicitly:
//
//	TIMECLOCK_TOGGL_TEST_TOKEN_FILE=/path/to/token
//	TIMECLOCK_TOGGL_TEST_WORKSPACE_ID=123
//	go test ./internal/toggl -run '^TestLiveWorkspaceContract$' -count=1 -v
//
// This deliberately uses the production client rather than a second HTTP
// implementation, so live response differences exercise the shipped decoder.
func TestLiveWorkspaceContract(t *testing.T) {
	path := os.Getenv("TIMECLOCK_TOGGL_TEST_TOKEN_FILE")
	if path == "" {
		t.Skip("TIMECLOCK_TOGGL_TEST_TOKEN_FILE is not set")
	}
	id, err := strconv.ParseInt(os.Getenv("TIMECLOCK_TOGGL_TEST_WORKSPACE_ID"), 10, 64)
	if err != nil || id <= 0 {
		t.Fatal("set TIMECLOCK_TOGGL_TEST_WORKSPACE_ID to the test workspace ID")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("could not read the test token file")
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		t.Fatal("the test token file is empty")
	}
	c := &Client{Token: token}
	workspaces, err := c.Workspaces(t.Context())
	if err != nil {
		t.Fatalf("workspace discovery: %v", err)
	}
	var workspace Workspace
	for _, w := range workspaces {
		if w.ID == id {
			workspace = w
			break
		}
	}
	if workspace.ID == 0 {
		t.Fatal("the selected test workspace is not accessible to this token")
	}
	if !workspace.Admin && workspace.Role != "admin" {
		t.Fatal("the selected workspace does not report admin access")
	}
	users, err := c.Users(t.Context(), workspace)
	if err != nil {
		t.Fatalf("workspace users: %v", err)
	}
	for _, u := range users {
		if u.ID <= 0 {
			t.Fatal("a workspace user has no decoded user ID")
		}
	}
	projects, err := c.Projects(t.Context(), id)
	if err != nil {
		t.Fatalf("projects: %v", err)
	}
	customers, err := c.Customers(t.Context(), id)
	if err != nil {
		t.Fatalf("customers: %v", err)
	}
	now := time.Now().UTC()
	entries, err := c.Report(t.Context(), id, now.AddDate(0, 0, -1).Format(time.DateOnly), now.AddDate(0, 0, 1).Format(time.DateOnly))
	if err != nil {
		t.Fatalf("detailed report: %v", err)
	}
	for _, e := range entries {
		if e.ID <= 0 || e.UserID <= 0 || e.Start.IsZero() {
			t.Fatal("a report entry is missing identity or start time")
		}
	}
	t.Logf("Read-only contract passed: %d users, %d projects, %d customers, %d recent entries", len(users), len(projects), len(customers), len(entries))
}
