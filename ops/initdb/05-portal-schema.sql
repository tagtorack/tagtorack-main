-- 05-portal-schema.sql — Merchant Portal (passwordless login tokens).
-- Additive to 03-submit-schema.sql. Each initdb file is its own psql session.
\connect tagtorack_app

CREATE TABLE IF NOT EXISTS merchant_login_tokens (
  token_hash   TEXT PRIMARY KEY,                 -- sha256(raw); raw token never stored
  merchant_id  UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_ip      INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS merchant_login_tokens_merchant_idx
  ON merchant_login_tokens(merchant_id);
CREATE INDEX IF NOT EXISTS merchant_login_tokens_expiry_idx
  ON merchant_login_tokens(expires_at) WHERE used_at IS NULL;
