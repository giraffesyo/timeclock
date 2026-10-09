-- +goose Up
-- A person's calendar feed: a secret address a calendar app subscribes to,
-- listing what they chose: the company's holidays, who is out, and their own
-- tracked time. Only a hash of the secret is kept, so the address is shown
-- once, when it is made; making a new one replaces it and keeps the choice.
CREATE TABLE calendar_feeds (
    workspace_id uuid NOT NULL,
    person_id    text NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    holidays     boolean NOT NULL DEFAULT true,
    time_off     boolean NOT NULL DEFAULT true,
    tracked_time boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, person_id),
    FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id) ON DELETE CASCADE,
    CHECK (holidays OR time_off OR tracked_time)
);

-- +goose Down
DROP TABLE calendar_feeds;
