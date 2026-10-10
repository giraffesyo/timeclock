-- +goose Up
-- History reads the log a page at a time, newest first, for a workspace.
CREATE INDEX audit_log_pages ON audit_log (workspace_id, at DESC, id DESC);

-- +goose Down
DROP INDEX audit_log_pages;
