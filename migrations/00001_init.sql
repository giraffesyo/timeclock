-- +goose Up

-- One row: how the organization runs payroll.
CREATE TABLE settings (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
    -- Days, weeks and pay periods are cut in this time zone.
    timezone              text NOT NULL DEFAULT 'America/Chicago',
    pay_cycle             text NOT NULL DEFAULT 'biweekly'
        CHECK (pay_cycle IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
    -- The first day of some weekly or biweekly period; the others follow from it.
    cycle_anchor          date NOT NULL DEFAULT '2026-01-05',
    -- The day the workweek starts, for overtime: 0 is Sunday.
    week_start            smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
    -- Hours in a workweek beyond which time is overtime. 0 turns overtime off.
    overtime_weekly_hours numeric(5, 2) NOT NULL DEFAULT 40 CHECK (overtime_weekly_hours >= 0),
    approve_timesheets    boolean NOT NULL DEFAULT true,
    approve_time_off      boolean NOT NULL DEFAULT true,
    require_project       boolean NOT NULL DEFAULT true,
    -- An entry or a running clock longer than this is flagged as an exception.
    long_entry_hours      numeric(4, 2) NOT NULL DEFAULT 12 CHECK (long_entry_hours > 0),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            text NOT NULL DEFAULT ''
);
INSERT INTO settings DEFAULT VALUES;

-- Everyone who has tracked time. Identity belongs to the host; name and
-- email are copies, so reports still read after someone leaves.
CREATE TABLE people (
    id              text PRIMARY KEY,
    name            text NOT NULL DEFAULT '',
    email           text NOT NULL DEFAULT '',
    -- Who approves this person's time. Set by an admin; empty defers to
    -- host_manager_id, the host directory's answer at their last request.
    manager_id      text NOT NULL DEFAULT '',
    host_manager_id text NOT NULL DEFAULT '',
    -- Salaried-exempt people earn no overtime.
    overtime_exempt boolean NOT NULL DEFAULT false,
    -- The person's id in the payroll system, for the export.
    payroll_id      text NOT NULL DEFAULT '',
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
    id          uuid PRIMARY KEY,
    name        text NOT NULL UNIQUE CHECK (name <> ''),
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id          uuid PRIMARY KEY,
    customer_id uuid NOT NULL REFERENCES customers (id),
    name        text NOT NULL CHECK (name <> ''),
    -- A charge code or contract number, for reports.
    code        text NOT NULL DEFAULT '',
    billable    boolean NOT NULL DEFAULT true,
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_id, name)
);

-- A stretch of work. ended_at is null while the clock is running.
CREATE TABLE time_entries (
    id         uuid PRIMARY KEY,
    person_id  text NOT NULL REFERENCES people (id),
    project_id uuid REFERENCES projects (id),
    started_at timestamptz NOT NULL,
    ended_at   timestamptz,
    note       text NOT NULL DEFAULT '',
    source     text NOT NULL CHECK (source IN ('clock', 'manual')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX time_entries_one_running ON time_entries (person_id) WHERE ended_at IS NULL;
CREATE INDEX time_entries_person_started ON time_entries (person_id, started_at);
CREATE INDEX time_entries_project ON time_entries (project_id, started_at);

-- Vacation or sick hours on one day. Balances are the payroll system's.
CREATE TABLE time_off (
    id            uuid PRIMARY KEY,
    person_id     text NOT NULL REFERENCES people (id),
    kind          text NOT NULL CHECK (kind IN ('vacation', 'sick')),
    day           date NOT NULL,
    hours         numeric(4, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
    note          text NOT NULL DEFAULT '',
    status        text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by    text NOT NULL DEFAULT '',
    decided_at    timestamptz,
    decision_note text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (person_id, day, kind)
);
CREATE INDEX time_off_day ON time_off (day);

-- A person's statement that a pay period's time is complete. Its time is
-- locked while it is submitted or approved. No row means not submitted.
CREATE TABLE timesheets (
    id            uuid PRIMARY KEY,
    person_id     text NOT NULL REFERENCES people (id),
    period_start  date NOT NULL,
    period_end    date NOT NULL,
    status        text NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
    submitted_at  timestamptz NOT NULL DEFAULT now(),
    decided_by    text NOT NULL DEFAULT '',
    decided_at    timestamptz,
    decision_note text NOT NULL DEFAULT '',
    UNIQUE (person_id, period_start),
    CHECK (period_end >= period_start)
);
CREATE INDEX timesheets_period ON timesheets (period_start);

-- Who changed what in payroll data, kept for good.
CREATE TABLE audit_log (
    id        uuid PRIMARY KEY,
    at        timestamptz NOT NULL DEFAULT now(),
    actor     text NOT NULL,
    action    text NOT NULL,
    -- Whose time it concerns, when it concerns someone's.
    person_id text NOT NULL DEFAULT '',
    detail    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_person ON audit_log (person_id, at);

-- +goose Down
DROP TABLE audit_log, timesheets, time_off, time_entries, projects, customers, people, settings;
