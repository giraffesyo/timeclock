-- +goose Up

-- A standalone Timeclock's own accounts: a password, the workspaces a person
-- belongs to, sessions that can be ended, and the links sent by email. A
-- host application keeps its own users and leaves these empty.
ALTER TABLE accounts ADD COLUMN password_hash text NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN disabled_at timestamptz;
-- One account per email address, however it is capitalized.
CREATE UNIQUE INDEX accounts_email ON accounts (lower(email));

CREATE TABLE memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces (id),
    account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- Runs payroll in this workspace.
    admin        boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, account_id)
);
CREATE INDEX memberships_account ON memberships (account_id);
-- Everyone who had signed in is in the one workspace there was.
INSERT INTO memberships (workspace_id, account_id)
    SELECT w.id, a.id FROM accounts a, workspaces w WHERE w.key = 'default';

-- A signed-in browser. The cookie holds a random token; only its hash is
-- kept, so a copy of this table signs no one in.
CREATE TABLE sessions (
    token_hash   bytea PRIMARY KEY,
    account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- The workspace the session is looking at.
    workspace_id uuid REFERENCES workspaces (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);

-- An invitation to a workspace, sent to an email address.
CREATE TABLE invites (
    id           uuid PRIMARY KEY,
    token_hash   bytea NOT NULL UNIQUE,
    workspace_id uuid NOT NULL REFERENCES workspaces (id),
    email        text NOT NULL,
    admin        boolean NOT NULL DEFAULT false,
    invited_by   uuid REFERENCES accounts (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    accepted_at  timestamptz
);
CREATE INDEX invites_workspace ON invites (workspace_id);

CREATE TABLE password_resets (
    token_hash bytea PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);

-- Failed sign-ins, by email address and by network address, so guessing is
-- slowed down.
CREATE TABLE auth_failures (
    key          text PRIMARY KEY,
    count        integer NOT NULL,
    last_at      timestamptz NOT NULL,
    locked_until timestamptz
);

-- +goose Down
DROP TABLE auth_failures, password_resets, invites, sessions, memberships;
DROP INDEX accounts_email;
ALTER TABLE accounts DROP COLUMN disabled_at;
ALTER TABLE accounts DROP COLUMN password_hash;
