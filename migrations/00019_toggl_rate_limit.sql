-- +goose Up
-- When Toggl's API limit was reached, until when it holds. Sync now waits only
-- for this, not for the hourly retry after any other error.
ALTER TABLE toggl_workspaces ADD COLUMN rate_limited_until timestamptz;

-- +goose Down
ALTER TABLE toggl_workspaces DROP COLUMN rate_limited_until;
