-- +goose Up

-- Reminders already sent, so each goes out once: a clock left running is
-- keyed by its entry, a timesheet that is due by its pay period.
CREATE TABLE reminders (
    person_id text NOT NULL REFERENCES people (id),
    kind      text NOT NULL,
    key       text NOT NULL,
    sent_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, kind, key)
);

-- +goose Down
DROP TABLE reminders;
