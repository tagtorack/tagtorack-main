-- The docker entrypoint runs each initdb file as a separate psql invocation
-- connected to POSTGRES_DB (=n8n). 01-create-dbs.sql creates tagtorack_app, but
-- a \connect in one file does NOT carry to the next — so 02 and 03 must each
-- switch explicitly or their tables land in the n8n database.
\connect tagtorack_app

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  store            TEXT NOT NULL,
  phone            TEXT,
  contact_pref     TEXT NOT NULL CHECK (contact_pref IN ('email','text','either')),
  notes            TEXT,
  source           TEXT NOT NULL DEFAULT 'web_form',
  status           TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','responded','scheduling','booked',
                                     'escalated','closed_won','closed_lost')),
  sms_opted_out_at TIMESTAMPTZ,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX leads_status_idx ON leads(status);
CREATE INDEX leads_last_activity_idx ON leads(last_activity_at DESC);

CREATE TABLE threads (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel                 TEXT NOT NULL CHECK (channel IN ('email','sms')),
  gmail_thread_id         TEXT,
  twilio_conversation_sid TEXT,
  subject                 TEXT,
  state                   TEXT NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open','awaiting_prospect',
                                           'awaiting_operator','closed')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX threads_gmail_thread_idx
  ON threads(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX threads_lead_idx ON threads(lead_id);

CREATE TABLE messages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id          UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  lead_id            UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('inbound','outbound','draft')),
  channel            TEXT NOT NULL CHECK (channel IN ('email','sms')),
  gmail_message_id   TEXT,
  in_reply_to        TEXT,
  references_hdr     TEXT,
  subject            TEXT,
  twilio_message_sid TEXT,
  body_text          TEXT NOT NULL,
  body_html          TEXT,
  sent_at            TIMESTAMPTZ,
  received_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_run_id       UUID,
  agent_confidence   NUMERIC(3,2),
  agent_action       TEXT
);
CREATE INDEX messages_thread_idx ON messages(thread_id, created_at);
CREATE INDEX messages_lead_idx   ON messages(lead_id, created_at DESC);
CREATE UNIQUE INDEX messages_gmail_idx
  ON messages(gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_twilio_idx
  ON messages(twilio_message_sid) WHERE twilio_message_sid IS NOT NULL;

CREATE TABLE scheduling_intents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  thread_id      UUID REFERENCES threads(id) ON DELETE SET NULL,
  proposed_start TIMESTAMPTZ NOT NULL,
  proposed_end   TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('agent_proposed','prospect_proposed','calcom_held')),
  status         TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','accepted','declined','expired')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX scheduling_intents_lead_idx ON scheduling_intents(lead_id, status);

CREATE TABLE bookings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source                  TEXT NOT NULL CHECK (source IN ('calcom','conversational')),
  start_at                TIMESTAMPTZ NOT NULL,
  end_at                  TIMESTAMPTZ NOT NULL,
  timezone                TEXT NOT NULL DEFAULT 'America/Chicago',
  gcal_event_id           TEXT UNIQUE,
  meet_url                TEXT,
  calcom_booking_id       TEXT UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'confirmed'
                          CHECK (status IN ('confirmed','rescheduled','cancelled',
                                            'completed','no_show')),
  brief_status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (brief_status IN ('pending','requested','attached','failed')),
  research_signal_sent_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX bookings_lead_idx  ON bookings(lead_id);
CREATE INDEX bookings_start_idx ON bookings(start_at);

CREATE TABLE research_briefs (
  gcal_event_id  TEXT PRIMARY KEY,
  lead_id        UUID NOT NULL REFERENCES leads(id),
  doc_id         TEXT,
  doc_url        TEXT,
  bundle_json    JSONB,
  brief_md       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending','researched','delivered',
                                                'low_confidence','failed','cancelled')),
  confidence     TEXT CHECK (confidence IN ('high','medium','low')),
  sources_count  INT,
  scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at   TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX research_briefs_lead_idx ON research_briefs(lead_id);
CREATE INDEX research_briefs_status_idx ON research_briefs(status, scheduled_at);

CREATE TABLE audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID REFERENCES leads(id) ON DELETE SET NULL,
  thread_id    UUID REFERENCES threads(id) ON DELETE SET NULL,
  agent_run_id UUID NOT NULL,
  event_type   TEXT NOT NULL, -- agent_input | agent_output | agent_escalated
                              -- message_sent | message_failed | booking_created
                              -- autosend_paused | kill_switch_blocked
                              -- brief_started | brief_delivered | brief_failed
  payload      JSONB NOT NULL,
  confidence   NUMERIC(3,2),
  decision     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_log_lead_idx  ON audit_log(lead_id, created_at DESC);
CREATE INDEX audit_log_run_idx   ON audit_log(agent_run_id);
CREATE INDEX audit_log_event_idx ON audit_log(event_type, created_at DESC);

CREATE TABLE kv_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Free-tier rate guardrail counter (Rate Guardrail section).
CREATE TABLE gemini_usage (
  day            DATE NOT NULL,
  model          TEXT NOT NULL CHECK (model IN ('flash','pro')),
  request_count  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
