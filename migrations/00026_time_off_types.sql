-- +goose Up
-- The kinds of time off a workspace offers, named as it names them. Each is
-- paid as vacation (PTO) or sick time: time_off.kind keeps that, which can't
-- change once a type has time off, so settled pay never moves. A type is
-- archived rather than removed, so time off always names one.
CREATE TABLE time_off_types (
    workspace_id uuid NOT NULL REFERENCES workspaces (id),
    id           uuid NOT NULL,
    name         text NOT NULL CHECK (name <> ''),
    pays_as      text NOT NULL CHECK (pays_as IN ('vacation', 'sick')),
    position     integer NOT NULL DEFAULT 0,
    archived_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX time_off_types_name ON time_off_types (workspace_id, lower(name));

-- Every workspace starts with the two it always had.
INSERT INTO time_off_types (workspace_id, id, name, pays_as, position)
SELECT id, gen_random_uuid(), 'Vacation', 'vacation', 0 FROM workspaces
UNION ALL
SELECT id, gen_random_uuid(), 'Sick', 'sick', 1 FROM workspaces;

ALTER TABLE time_off ADD COLUMN type_id uuid;
UPDATE time_off o SET type_id = t.id FROM time_off_types t WHERE t.workspace_id = o.workspace_id AND t.pays_as = o.kind;
ALTER TABLE time_off ALTER COLUMN type_id SET NOT NULL;
ALTER TABLE time_off ADD FOREIGN KEY (workspace_id, type_id) REFERENCES time_off_types (workspace_id, id);

-- One of each type a day, so two types paid alike can share a day.
ALTER TABLE time_off DROP CONSTRAINT time_off_workspace_id_person_id_day_kind_key;
ALTER TABLE time_off ADD UNIQUE (workspace_id, person_id, day, type_id);

-- +goose Down
-- Going back keeps one row of each pay kind a day.
DELETE FROM time_off o USING time_off k
WHERE k.workspace_id = o.workspace_id AND k.person_id = o.person_id AND k.day = o.day AND k.kind = o.kind AND k.id < o.id;
ALTER TABLE time_off DROP CONSTRAINT time_off_workspace_id_person_id_day_type_id_key;
ALTER TABLE time_off ADD UNIQUE (workspace_id, person_id, day, kind);
ALTER TABLE time_off DROP COLUMN type_id;
DROP TABLE time_off_types;
