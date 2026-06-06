-- 06-sms-consent.sql — Phase 2 (SMS drop-off notifications)
-- Adds opt-in SMS consent + opt-out tracking to the submit-side `sellers` table.
-- Additive and idempotent: safe to re-run.
--
-- NOTE: files in /docker-entrypoint-initdb.d only run on a FRESH Postgres volume.
-- For the existing tagtorack_app database, apply this manually once:
--   docker exec -i tt_pg psql -U "$PG_USER" -d tagtorack_app < ops/initdb/06-sms-consent.sql
--
-- This runs against the submit/app database (sellers lives in tagtorack_app).

\connect tagtorack_app

-- Express opt-in to transactional SMS (e.g. drop-off invites). Defaults FALSE:
-- no seller is texted unless they explicitly check the SMS box at submission time.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT FALSE;

-- Set when a seller replies STOP (or is otherwise opted out). When non-null, the
-- send path in WF-M4 suppresses all SMS to this seller regardless of sms_consent.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS sms_opted_out_at TIMESTAMPTZ;
