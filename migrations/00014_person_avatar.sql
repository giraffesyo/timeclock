-- +goose Up
ALTER TABLE people ADD COLUMN avatar_url text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE people DROP COLUMN avatar_url;
