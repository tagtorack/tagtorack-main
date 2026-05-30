-- 03-submit-schema.sql — TagtoRack Submit (Phase 12)
-- Additive to 02-app-schema.sql. Reuses pgcrypto, citext, audit_log.

-- Merchants. Created when a store onboards. rule_set is the JSONB the AI reads;
-- the projected columns (accepted_categories, brand_allowlist, etc.) are
-- denormalized for fast portal UI rendering.
CREATE TABLE merchants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 CITEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  public_intro         TEXT NOT NULL DEFAULT '',
  brand_color          TEXT NOT NULL DEFAULT '#6a40c9'
                       CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_url             TEXT,
  contact_email        CITEXT NOT NULL,
  dropoff_address      TEXT NOT NULL,
  dropoff_hours        TEXT NOT NULL DEFAULT 'Tue–Sat, 11am–6pm',
  timezone             TEXT NOT NULL DEFAULT 'America/Chicago',
  calcom_event_url     TEXT,                       -- optional per-merchant drop-off booking URL
  rule_set             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Denormalized projections (regenerated on rule_set UPDATE via app code):
  accepted_categories  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  brand_allowlist      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  brand_blocklist      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  condition_floor      TEXT NOT NULL DEFAULT 'good'
                       CHECK (condition_floor IN ('new_with_tags','excellent','good','fair')),
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','archived')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX merchants_active_idx ON merchants(status) WHERE status = 'active';

-- Sellers. One row per (merchant, email) so the same consumer submitting to two
-- different stores gets two rows. This is intentional: per-merchant data
-- isolation is a privacy guarantee.
CREATE TABLE sellers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  email                CITEXT NOT NULL,
  name                 TEXT NOT NULL,
  phone                TEXT,
  zip                  TEXT,
  consent_marketing    BOOLEAN NOT NULL DEFAULT FALSE,
  consent_privacy_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, email)
);
CREATE INDEX sellers_merchant_idx ON sellers(merchant_id);

-- One submission = one item, 1-6 photos. fingerprint dedupes repeat submissions
-- of the same item by the same seller.
CREATE TABLE seller_submissions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id              UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  seller_id                UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  item_description         TEXT NOT NULL,
  declared_brand           TEXT,
  declared_category        TEXT,
  declared_size            TEXT,
  declared_condition       TEXT NOT NULL
                           CHECK (declared_condition IN ('new_with_tags','excellent','good','fair')),
  asking_price_usd         NUMERIC(8,2),
  notes                    TEXT,
  fingerprint              TEXT NOT NULL,          -- sha256(seller_id || normalized description)
  status                   TEXT NOT NULL DEFAULT 'pending_uploads'
                           CHECK (status IN (
                             'pending_uploads',    -- /start ran, photos still arriving
                             'received',           -- /finalize ran, AI queued
                             'ai_reviewing',       -- WF-Submission-Received picked it up
                             'merchant_review',    -- AI=PASS, merchant must approve/reject
                             'ai_borderline',      -- AI=BORDERLINE, Conner queue
                             'ai_failed',          -- AI=FAIL, seller auto-notified
                             'merchant_approved',  -- merchant clicked approve
                             'merchant_rejected',  -- merchant clicked reject
                             'dropoff_scheduled',  -- drop-off booked
                             'completed',          -- drop-off happened
                             'expired',            -- 7-day inaction timeout
                             'withdrawn',          -- seller right-to-delete
                             'deleted'             -- soft-delete after R2 purge
                           )),
  submitted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ai_reviewed_at           TIMESTAMPTZ,
  merchant_decided_at      TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  user_agent               TEXT,
  ip_country               TEXT,
  ip_hash                  TEXT                    -- sha256 of IP for rate-limit forensics
);
-- Dedupe only active submissions; expired/failed/rejected don't block resubmit.
CREATE UNIQUE INDEX seller_submissions_dedupe_idx
  ON seller_submissions(seller_id, fingerprint)
  WHERE status NOT IN ('expired','withdrawn','merchant_rejected','ai_failed','deleted');
CREATE INDEX seller_submissions_merchant_status_idx
  ON seller_submissions(merchant_id, status, submitted_at DESC);
CREATE INDEX seller_submissions_status_idx
  ON seller_submissions(status, submitted_at DESC);
CREATE INDEX seller_submissions_expires_idx
  ON seller_submissions(expires_at)
  WHERE status IN ('received','ai_reviewing','merchant_review','ai_borderline');

CREATE TABLE submission_photos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     UUID NOT NULL REFERENCES seller_submissions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('front','back','tag','flaw')),
  ord               SMALLINT NOT NULL CHECK (ord BETWEEN 1 AND 6),
  r2_key            TEXT NOT NULL UNIQUE,           -- {slug}/{sub_id}/{role}-{ord}-{ts}.{ext}
  cdn_url           TEXT NOT NULL,                  -- pre-signed GET URL (24h) cached at finalize
  thumbnail_r2_key  TEXT,                           -- 600px JPEG written by /photo-complete
  content_type      TEXT NOT NULL,
  byte_size         INT NOT NULL,
  width_px          INT,
  height_px         INT,
  exif_stripped_at  TIMESTAMPTZ,                    -- set when client confirms or worker re-encodes
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  UNIQUE (submission_id, role, ord)
);
CREATE INDEX submission_photos_retention_idx ON submission_photos(retention_until);

-- AI decision record. One row per Gemini call.
CREATE TABLE submission_decisions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id          UUID NOT NULL REFERENCES seller_submissions(id) ON DELETE CASCADE,
  model                  TEXT NOT NULL DEFAULT 'gemini-2.5-pro',
  decision               TEXT NOT NULL CHECK (decision IN ('PASS','FAIL','BORDERLINE')),
  confidence             NUMERIC(3,2) NOT NULL,
  brand_detected         TEXT,
  brand_confidence       NUMERIC(3,2),
  category_detected      TEXT,
  size_detected          TEXT,
  condition_assessment   TEXT,
  flaws_observed         JSONB NOT NULL DEFAULT '[]'::jsonb,
  estimated_retail_usd   NUMERIC(10,2),
  estimated_resale_usd   NUMERIC(10,2),
  rule_evaluation        JSONB NOT NULL,
  pass_reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  fail_reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  borderline_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
  seller_message         TEXT NOT NULL,
  internal_note          TEXT NOT NULL,
  raw_response           JSONB NOT NULL,
  prompt_tokens          INT NOT NULL DEFAULT 0,
  output_tokens          INT NOT NULL DEFAULT 0,
  thoughts_tokens        INT NOT NULL DEFAULT 0,
  override_reason        TEXT,                       -- e.g. 'safety_to_borderline', 'confidence_pass_to_borderline'
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX submission_decisions_sub_idx ON submission_decisions(submission_id, created_at DESC);
CREATE INDEX submission_decisions_dec_idx ON submission_decisions(decision, created_at DESC);

-- Magic-link tokens. token_hash is sha256 of the raw token sent in the URL;
-- raw token is never stored. Single-use enforced via WHERE used_at IS NULL.
CREATE TABLE decision_tokens (
  token_hash         TEXT PRIMARY KEY,
  submission_id      UUID NOT NULL REFERENCES seller_submissions(id) ON DELETE CASCADE,
  merchant_id        UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  action             TEXT NOT NULL CHECK (action IN ('approve','reject')),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  used_ip            INET,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX decision_tokens_sub_idx ON decision_tokens(submission_id);
CREATE INDEX decision_tokens_expiry_idx ON decision_tokens(expires_at) WHERE used_at IS NULL;

-- Drop-off bookings. Analogous to bookings table in Phase 1 but seller-side.
CREATE TABLE dropoff_bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id       UUID NOT NULL UNIQUE REFERENCES seller_submissions(id) ON DELETE CASCADE,
  merchant_id         UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  seller_id           UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  start_at            TIMESTAMPTZ NOT NULL,
  end_at              TIMESTAMPTZ NOT NULL,
  timezone            TEXT NOT NULL DEFAULT 'America/Chicago',
  source              TEXT NOT NULL CHECK (source IN ('calcom','conversational')),
  gcal_event_id       TEXT UNIQUE,
  calcom_booking_id   TEXT UNIQUE,
  status              TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed','rescheduled','cancelled','completed','no_show')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX dropoff_bookings_merchant_start_idx ON dropoff_bookings(merchant_id, start_at);

-- KV-backed rate limit fallback table (used if Cloudflare KV is unreachable).
CREATE TABLE submit_rate_limit (
  bucket_key     TEXT NOT NULL,                    -- 'ip:<sha256>' or 'merchant:<uuid>:<YYYY-MM-DD>'
  window_start   DATE NOT NULL,
  count          INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

-- Extend audit_log with a submission_id FK so we can join submission lifecycle events.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS submission_id UUID
  REFERENCES seller_submissions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS audit_log_submission_idx
  ON audit_log(submission_id, created_at DESC);
