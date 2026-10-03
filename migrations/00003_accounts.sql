-- +goose Up

-- People who sign in to a standalone Timeclock. A host application keeps its
-- own users and leaves these tables empty.
CREATE TABLE accounts (
    id         uuid PRIMARY KEY,
    issuer     text NOT NULL,
    subject    text NOT NULL,
    email      text NOT NULL,
    name       text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);

-- Sign-ins that are on their way to the provider and back.
CREATE TABLE login_attempts (
    state         text PRIMARY KEY,
    code_verifier text NOT NULL,
    nonce         text NOT NULL,
    next          text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE login_attempts, accounts;
