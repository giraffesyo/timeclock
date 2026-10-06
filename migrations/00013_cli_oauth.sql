-- +goose Up

-- Standalone CLI authorization. Browser sessions never become API tokens.
CREATE TABLE cli_requests (
    request_hash bytea PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('code', 'device')),
    user_code_hash bytea UNIQUE,
    code_hash bytea UNIQUE,
    challenge text NOT NULL DEFAULT '',
    redirect_uri text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    sso_workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    next_poll_at timestamptz NOT NULL DEFAULT now(),
    poll_interval integer NOT NULL DEFAULT 5
);
CREATE INDEX cli_requests_expiry ON cli_requests(expires_at);

CREATE TABLE cli_grants (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sso_workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX cli_grants_account ON cli_grants(account_id);
CREATE TABLE cli_access_tokens (
    token_hash bytea PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES cli_grants(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
-- Used refresh hashes remain until the grant expires to detect replay.
CREATE TABLE cli_refresh_tokens (
    token_hash bytea PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES cli_grants(id) ON DELETE CASCADE,
    used boolean NOT NULL DEFAULT false
);
CREATE TABLE cli_rate_limits (
    key bytea PRIMARY KEY,
    window_start timestamptz NOT NULL,
    count integer NOT NULL
);

-- +goose Down
DROP TABLE cli_rate_limits, cli_refresh_tokens, cli_access_tokens, cli_grants, cli_requests;
