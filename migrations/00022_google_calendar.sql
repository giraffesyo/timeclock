-- +goose Up
-- A person's own Google Calendar, which they connected themselves: the
-- refresh token Google gave Timeclock, sealed with the integration key and
-- bound to the workspace and person, and the Google account it reads.
CREATE TABLE google_calendars (
    workspace_id uuid NOT NULL,
    person_id    text NOT NULL,
    account      text NOT NULL DEFAULT '',
    token        bytea NOT NULL,
    connected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, person_id),
    FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE google_calendars;
