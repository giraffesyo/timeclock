-- +goose Up
-- A person's calendar feed: a secret address a calendar app subscribes to,
-- which lists the company's holidays and who is out. Only a hash of the
-- secret is kept, so the address is shown once, when it is made; making a
-- new one replaces it.
CREATE TABLE calendar_feeds (
    workspace_id uuid NOT NULL,
    person_id    text NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, person_id),
    FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE calendar_feeds;
