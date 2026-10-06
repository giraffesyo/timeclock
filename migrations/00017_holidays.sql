-- +goose Up
-- Company holidays: paid hours on the days a company observes a holiday,
-- for everyone whose holiday pay is on. A holiday is a name and the days it
-- covers, each with its own hours. Holiday pay is the workspace's default
-- and each person's own choice (null follows the workspace), like
-- submitting timesheets.
ALTER TABLE settings ADD COLUMN holiday_pay boolean NOT NULL DEFAULT true;
ALTER TABLE people ADD COLUMN holiday_pay boolean;

CREATE TABLE holidays (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces (id),
    name         text NOT NULL CHECK (name <> ''),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id)
);

-- One holiday a day, so no day is paid twice.
CREATE TABLE holiday_days (
    workspace_id uuid NOT NULL,
    holiday_id   uuid NOT NULL,
    day          date NOT NULL,
    hours        numeric(4, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
    PRIMARY KEY (workspace_id, day),
    FOREIGN KEY (workspace_id, holiday_id) REFERENCES holidays (workspace_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE holiday_days;
DROP TABLE holidays;
ALTER TABLE people DROP COLUMN holiday_pay;
ALTER TABLE settings DROP COLUMN holiday_pay;
