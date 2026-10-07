-- +goose Up
ALTER TABLE settings ADD COLUMN allow_planned_time boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE settings DROP COLUMN allow_planned_time;
