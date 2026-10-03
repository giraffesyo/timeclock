-- +goose Up

-- A project needn't belong to a customer: internal work such as
-- administration or company holidays has none.
ALTER TABLE projects ALTER COLUMN customer_id DROP NOT NULL;
CREATE UNIQUE INDEX projects_internal_name ON projects (name) WHERE customer_id IS NULL;

-- +goose Down
DROP INDEX projects_internal_name;
DELETE FROM projects WHERE customer_id IS NULL;
ALTER TABLE projects ALTER COLUMN customer_id SET NOT NULL;
