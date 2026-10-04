-- +goose Up

-- The workspace's own look, set by an admin: for light and for dark, an
-- accent, a background and a contrast, and optionally the same for the
-- sidebar. Empty leaves the host's theme, or Timeclock's own.
ALTER TABLE settings ADD COLUMN theme jsonb NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE settings DROP COLUMN theme;
