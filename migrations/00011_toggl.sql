-- +goose Up
CREATE TABLE toggl_workspaces (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
    remote_id bigint NOT NULL UNIQUE CHECK (remote_id > 0),
    token bytea,
    sync_from date NOT NULL,
    next_sync timestamptz NOT NULL DEFAULT now(),
    last_sync timestamptz,
    last_error text NOT NULL DEFAULT ''
);
CREATE TABLE toggl_people (
    workspace_id uuid NOT NULL REFERENCES toggl_workspaces(workspace_id),
    person_id text NOT NULL,
    remote_user bigint NOT NULL CHECK (remote_user > 0),
    PRIMARY KEY (workspace_id, person_id),
    UNIQUE (workspace_id, remote_user),
    FOREIGN KEY (workspace_id, person_id) REFERENCES people(workspace_id, id)
);
CREATE TABLE toggl_projects (
    workspace_id uuid NOT NULL REFERENCES toggl_workspaces(workspace_id),
    remote_id bigint NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id),
    PRIMARY KEY (workspace_id, remote_id),
    UNIQUE (workspace_id, project_id)
);
CREATE TABLE toggl_entries (
    workspace_id uuid NOT NULL,
    person_id text NOT NULL,
    -- No FK to time_entries: the mapping survives local entry deletion until disconnect.
    entry_id uuid NOT NULL,
    remote_id bigint,
    baseline jsonb NOT NULL,
    remote jsonb NOT NULL,
    pending_create boolean NOT NULL DEFAULT false,
    issue text NOT NULL DEFAULT '',
    PRIMARY KEY (workspace_id, entry_id),
    UNIQUE (workspace_id, remote_id),
    FOREIGN KEY (workspace_id, person_id) REFERENCES toggl_people(workspace_id, person_id)
);
ALTER TABLE time_entries DROP CONSTRAINT time_entries_source_check;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_check CHECK (source IN ('clock', 'manual', 'toggl'));

-- +goose Down
UPDATE time_entries SET source = 'manual' WHERE source = 'toggl';
ALTER TABLE time_entries DROP CONSTRAINT time_entries_source_check;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_check CHECK (source IN ('clock', 'manual'));
DROP TABLE toggl_entries;
DROP TABLE toggl_projects;
DROP TABLE toggl_people;
DROP TABLE toggl_workspaces;
