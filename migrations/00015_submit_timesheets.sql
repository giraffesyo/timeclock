-- +goose Up
-- Whether people submit timesheets: the workspace's default, and each
-- person's own choice (null follows the workspace). Someone who doesn't
-- submit tracks time for reports only; their time stays out of payroll.
ALTER TABLE settings ADD COLUMN submit_timesheets boolean NOT NULL DEFAULT true;
ALTER TABLE people ADD COLUMN submits_timesheets boolean;

-- +goose Down
ALTER TABLE people DROP COLUMN submits_timesheets;
ALTER TABLE settings DROP COLUMN submit_timesheets;
