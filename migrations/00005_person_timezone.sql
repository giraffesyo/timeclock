-- +goose Up

-- A person's own time zone: their days and workweeks are cut at their own
-- midnight. Empty uses the organization's.
ALTER TABLE people ADD COLUMN timezone text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE people DROP COLUMN timezone;
