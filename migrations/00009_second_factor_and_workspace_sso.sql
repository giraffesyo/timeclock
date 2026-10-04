-- +goose Up

-- A second step at sign-in: codes from an authenticator app, with recovery
-- codes for when the app is gone, and passkeys.
-- The secret is sealed with the server's key; null means none is set up.
ALTER TABLE accounts ADD COLUMN totp_secret bytea;
ALTER TABLE accounts ADD COLUMN totp_confirmed_at timestamptz;
-- The time step of the last code accepted, so a code works once.
ALTER TABLE accounts ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;

CREATE TABLE recovery_codes (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    code_hash  bytea NOT NULL,
    used_at    timestamptz,
    PRIMARY KEY (account_id, code_hash)
);

-- Someone who gave the right password and still owes the second step.
CREATE TABLE pending_logins (
    token_hash bytea PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE TABLE passkeys (
    id            uuid PRIMARY KEY,
    account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    credential_id bytea NOT NULL UNIQUE,
    name          text NOT NULL DEFAULT '',
    -- The credential record as the WebAuthn library keeps it.
    credential    jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);
CREATE INDEX passkeys_account ON passkeys (account_id);

-- A passkey ceremony under way: the challenge, between its two requests.
CREATE TABLE webauthn_ceremonies (
    token_hash bytea PRIMARY KEY,
    account_id uuid REFERENCES accounts (id) ON DELETE CASCADE,
    session    jsonb NOT NULL,
    expires_at timestamptz NOT NULL
);

-- A workspace's own OpenID Connect provider. What it vouches for counts in
-- that workspace only.
CREATE TABLE workspace_sso (
    workspace_id  uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    issuer        text NOT NULL,
    client_id     text NOT NULL,
    -- Sealed with the server's key.
    client_secret bytea NOT NULL,
    -- The workspace can only be entered through the provider.
    required      boolean NOT NULL DEFAULT false,
    -- Anyone the provider signs in becomes a member; otherwise only people
    -- already invited or in the workspace.
    auto_join     boolean NOT NULL DEFAULT false,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
-- A session that came in through a workspace's provider sees that workspace only.
ALTER TABLE sessions ADD COLUMN sso_workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE;
ALTER TABLE login_attempts ADD COLUMN workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE;

-- +goose Down
ALTER TABLE login_attempts DROP COLUMN workspace_id;
ALTER TABLE sessions DROP COLUMN sso_workspace_id;
DROP TABLE workspace_sso, webauthn_ceremonies, passkeys, pending_logins, recovery_codes;
ALTER TABLE accounts DROP COLUMN totp_last_step;
ALTER TABLE accounts DROP COLUMN totp_confirmed_at;
ALTER TABLE accounts DROP COLUMN totp_secret;
