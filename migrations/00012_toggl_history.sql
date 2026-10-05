-- +goose Up
ALTER TABLE toggl_workspaces ADD COLUMN history_cursor date;
ALTER TABLE toggl_workspaces ADD COLUMN history_complete boolean NOT NULL DEFAULT false;
CREATE TABLE toggl_report_pages (
    workspace_id uuid NOT NULL REFERENCES toggl_workspaces(workspace_id) ON DELETE CASCADE,
    from_date date NOT NULL,
    to_date date NOT NULL,
    page integer NOT NULL,
    entries jsonb NOT NULL,
    next_cursor jsonb NOT NULL,
    PRIMARY KEY(workspace_id, from_date, to_date, page)
);

-- +goose Down
DROP TABLE toggl_report_pages;
ALTER TABLE toggl_workspaces DROP COLUMN history_complete;
ALTER TABLE toggl_workspaces DROP COLUMN history_cursor;
