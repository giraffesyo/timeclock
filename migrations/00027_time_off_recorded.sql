-- +goose Up
-- Time off recorded where no approval is needed counts at once, with no one
-- named as approving it; someone who approves it anyway is named. The Toggl
-- sync named the integration as approving what it recorded there. No one
-- did, so it reads as recorded, like any other.
UPDATE time_off SET decided_by = '', decided_at = NULL
WHERE decided_by = 'integration:toggl' AND status = 'approved';

-- +goose Down
-- Nothing to undo: which rows the integration was named on isn't kept.
SELECT 1;
