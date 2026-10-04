-- +goose Up

-- A workspace is one organization's Timeclock: its people, time, settings
-- and look. Every table carries the workspace its rows belong to, and every
-- query names it. What was there before becomes the workspace "default".
CREATE TABLE workspaces (
    id         uuid PRIMARY KEY,
    -- How the host, or the address, names it.
    key        text NOT NULL UNIQUE CHECK (key <> ''),
    name       text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces (id, key) VALUES (gen_random_uuid(), 'default');

ALTER TABLE settings ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE people ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE customers ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE projects ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE time_entries ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE time_off ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE timesheets ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE audit_log ADD COLUMN workspace_id uuid REFERENCES workspaces (id);
ALTER TABLE reminders ADD COLUMN workspace_id uuid REFERENCES workspaces (id);

UPDATE settings SET workspace_id = (SELECT id FROM workspaces);
UPDATE people SET workspace_id = (SELECT id FROM workspaces);
UPDATE customers SET workspace_id = (SELECT id FROM workspaces);
UPDATE projects SET workspace_id = (SELECT id FROM workspaces);
UPDATE time_entries SET workspace_id = (SELECT id FROM workspaces);
UPDATE time_off SET workspace_id = (SELECT id FROM workspaces);
UPDATE timesheets SET workspace_id = (SELECT id FROM workspaces);
UPDATE audit_log SET workspace_id = (SELECT id FROM workspaces);
UPDATE reminders SET workspace_id = (SELECT id FROM workspaces);

ALTER TABLE settings ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE people ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE customers ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE time_entries ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE time_off ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE timesheets ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE reminders ALTER COLUMN workspace_id SET NOT NULL;

-- One row of settings per workspace, where there was one row in all.
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings DROP COLUMN id;
ALTER TABLE settings ADD PRIMARY KEY (workspace_id);

-- A person is the host's id within a workspace: the same id in two
-- workspaces is two people.
ALTER TABLE time_entries DROP CONSTRAINT time_entries_person_id_fkey;
ALTER TABLE time_off DROP CONSTRAINT time_off_person_id_fkey;
ALTER TABLE timesheets DROP CONSTRAINT timesheets_person_id_fkey;
ALTER TABLE reminders DROP CONSTRAINT reminders_person_id_fkey;
ALTER TABLE people DROP CONSTRAINT people_pkey;
ALTER TABLE people ADD PRIMARY KEY (workspace_id, id);
ALTER TABLE time_entries ADD FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id);
ALTER TABLE time_off ADD FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id);
ALTER TABLE timesheets ADD FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id);
ALTER TABLE reminders ADD FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id);

-- What was unique in all is unique within a workspace.
ALTER TABLE customers DROP CONSTRAINT customers_name_key;
ALTER TABLE customers ADD UNIQUE (workspace_id, name);
DROP INDEX projects_internal_name;
CREATE UNIQUE INDEX projects_internal_name ON projects (workspace_id, name) WHERE customer_id IS NULL;
CREATE INDEX projects_workspace ON projects (workspace_id);

DROP INDEX time_entries_one_running;
CREATE UNIQUE INDEX time_entries_one_running ON time_entries (workspace_id, person_id) WHERE ended_at IS NULL;
DROP INDEX time_entries_person_started;
CREATE INDEX time_entries_person_started ON time_entries (workspace_id, person_id, started_at);
CREATE INDEX time_entries_workspace_started ON time_entries (workspace_id, started_at);

ALTER TABLE time_off DROP CONSTRAINT time_off_person_id_day_kind_key;
ALTER TABLE time_off ADD UNIQUE (workspace_id, person_id, day, kind);
ALTER TABLE timesheets DROP CONSTRAINT timesheets_person_id_period_start_key;
ALTER TABLE timesheets ADD UNIQUE (workspace_id, person_id, period_start);
ALTER TABLE reminders DROP CONSTRAINT reminders_pkey;
ALTER TABLE reminders ADD PRIMARY KEY (workspace_id, person_id, kind, key);
DROP INDEX audit_log_person;
CREATE INDEX audit_log_person ON audit_log (workspace_id, person_id, at);

-- +goose Down
-- Going back keeps only the default workspace's rows.
DELETE FROM reminders WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM audit_log WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM timesheets WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM time_off WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM time_entries WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM projects WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM customers WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM people WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');
DELETE FROM settings WHERE workspace_id <> (SELECT id FROM workspaces WHERE key = 'default');

DROP INDEX audit_log_person;
CREATE INDEX audit_log_person ON audit_log (person_id, at);
ALTER TABLE reminders DROP CONSTRAINT reminders_pkey;
ALTER TABLE reminders ADD PRIMARY KEY (person_id, kind, key);
ALTER TABLE timesheets DROP CONSTRAINT timesheets_workspace_id_person_id_period_start_key;
ALTER TABLE timesheets ADD UNIQUE (person_id, period_start);
ALTER TABLE time_off DROP CONSTRAINT time_off_workspace_id_person_id_day_kind_key;
ALTER TABLE time_off ADD UNIQUE (person_id, day, kind);
DROP INDEX time_entries_workspace_started;
DROP INDEX time_entries_person_started;
CREATE INDEX time_entries_person_started ON time_entries (person_id, started_at);
DROP INDEX time_entries_one_running;
CREATE UNIQUE INDEX time_entries_one_running ON time_entries (person_id) WHERE ended_at IS NULL;
DROP INDEX projects_workspace;
DROP INDEX projects_internal_name;
CREATE UNIQUE INDEX projects_internal_name ON projects (name) WHERE customer_id IS NULL;
ALTER TABLE customers DROP CONSTRAINT customers_workspace_id_name_key;
ALTER TABLE customers ADD UNIQUE (name);

ALTER TABLE time_entries DROP CONSTRAINT time_entries_workspace_id_person_id_fkey;
ALTER TABLE time_off DROP CONSTRAINT time_off_workspace_id_person_id_fkey;
ALTER TABLE timesheets DROP CONSTRAINT timesheets_workspace_id_person_id_fkey;
ALTER TABLE reminders DROP CONSTRAINT reminders_workspace_id_person_id_fkey;
ALTER TABLE people DROP CONSTRAINT people_pkey;
ALTER TABLE people ADD PRIMARY KEY (id);
ALTER TABLE time_entries ADD FOREIGN KEY (person_id) REFERENCES people (id);
ALTER TABLE time_off ADD FOREIGN KEY (person_id) REFERENCES people (id);
ALTER TABLE timesheets ADD FOREIGN KEY (person_id) REFERENCES people (id);
ALTER TABLE reminders ADD FOREIGN KEY (person_id) REFERENCES people (id);

ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD COLUMN id boolean PRIMARY KEY DEFAULT true CHECK (id);

ALTER TABLE reminders DROP COLUMN workspace_id;
ALTER TABLE audit_log DROP COLUMN workspace_id;
ALTER TABLE timesheets DROP COLUMN workspace_id;
ALTER TABLE time_off DROP COLUMN workspace_id;
ALTER TABLE time_entries DROP COLUMN workspace_id;
ALTER TABLE projects DROP COLUMN workspace_id;
ALTER TABLE customers DROP COLUMN workspace_id;
ALTER TABLE people DROP COLUMN workspace_id;
ALTER TABLE settings DROP COLUMN workspace_id;
DROP TABLE workspaces;
