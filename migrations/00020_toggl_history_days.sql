-- +goose Up
-- How many days of history the sweep asks Toggl for at a time: narrowed when
-- Toggl's reports API times out and widened again over quiet stretches, so a
-- run doesn't relearn it.
ALTER TABLE toggl_workspaces ADD COLUMN history_days integer NOT NULL DEFAULT 360 CHECK (history_days BETWEEN 1 AND 360);

-- +goose Down
ALTER TABLE toggl_workspaces DROP COLUMN history_days;
