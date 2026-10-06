-- +goose Up
-- Toggl projects that stand for a holiday, vacation or sick time rather than
-- work, each with the day its role took effect: earlier entries keep syncing
-- as work.
ALTER TABLE toggl_workspaces ADD COLUMN holiday_project bigint;
ALTER TABLE toggl_workspaces ADD COLUMN holiday_from date;
ALTER TABLE toggl_workspaces ADD COLUMN vacation_project bigint;
ALTER TABLE toggl_workspaces ADD COLUMN vacation_from date;
ALTER TABLE toggl_workspaces ADD COLUMN sick_project bigint;
ALTER TABLE toggl_workspaces ADD COLUMN sick_from date;

-- Each Toggl entry on the vacation or sick project, as the last sync saw it.
CREATE TABLE toggl_time_off (
    workspace_id uuid NOT NULL REFERENCES toggl_workspaces(workspace_id) ON DELETE CASCADE,
    remote_id bigint NOT NULL,
    person_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('vacation', 'sick')),
    day date NOT NULL,
    started_at timestamptz NOT NULL,
    seconds integer NOT NULL CHECK (seconds > 0),
    note text NOT NULL DEFAULT '',
    -- The project it was counted under: it stays time off while it stays there.
    project bigint NOT NULL,
    PRIMARY KEY (workspace_id, remote_id)
);
CREATE INDEX toggl_time_off_day ON toggl_time_off (workspace_id, person_id, day, kind);

-- The time off each person, day and kind's entries add up to, and the hours
-- last written to it. No FK to time_off: a person or approver may remove it,
-- and only a change in Toggl writes it again.
CREATE TABLE toggl_time_off_days (
    workspace_id uuid NOT NULL REFERENCES toggl_workspaces(workspace_id) ON DELETE CASCADE,
    id uuid NOT NULL,
    person_id text NOT NULL,
    day date NOT NULL,
    kind text NOT NULL CHECK (kind IN ('vacation', 'sick')),
    time_off_id uuid,
    hours numeric(5, 2) NOT NULL DEFAULT 0,
    issue text NOT NULL DEFAULT '',
    PRIMARY KEY (workspace_id, person_id, day, kind),
    UNIQUE (workspace_id, id)
);

-- +goose Down
DROP TABLE toggl_time_off_days;
DROP TABLE toggl_time_off;
ALTER TABLE toggl_workspaces DROP COLUMN sick_from;
ALTER TABLE toggl_workspaces DROP COLUMN sick_project;
ALTER TABLE toggl_workspaces DROP COLUMN vacation_from;
ALTER TABLE toggl_workspaces DROP COLUMN vacation_project;
ALTER TABLE toggl_workspaces DROP COLUMN holiday_from;
ALTER TABLE toggl_workspaces DROP COLUMN holiday_project;
