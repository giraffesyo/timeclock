-- +goose Up
-- The project a person copies a meeting from their calendar to, so the next
-- time it comes round it copies there at once. A meeting is a recurring
-- event's series, or a one-off's title. A null project is a choice too: no
-- project.
CREATE TABLE calendar_meetings (
    workspace_id uuid NOT NULL,
    person_id    text NOT NULL,
    meeting      text NOT NULL CHECK (meeting <> ''),
    project_id   uuid REFERENCES projects (id) ON DELETE CASCADE,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, person_id, meeting),
    FOREIGN KEY (workspace_id, person_id) REFERENCES people (workspace_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE calendar_meetings;
