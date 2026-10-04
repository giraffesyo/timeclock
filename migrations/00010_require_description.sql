-- +goose Up
ALTER TABLE settings ADD COLUMN require_description boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE settings DROP COLUMN require_description;
