-- +goose Up
-- Who is an admin: the host's answer, recorded as it is given, and a grant
-- an admin made in Timeclock. Either one makes an admin.
ALTER TABLE people ADD COLUMN host_admin boolean NOT NULL DEFAULT false;
ALTER TABLE people ADD COLUMN admin boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE people DROP COLUMN admin;
ALTER TABLE people DROP COLUMN host_admin;
