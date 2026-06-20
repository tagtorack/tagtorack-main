-- Run against the app DB (fix: was implicitly using the default n8n DB on fresh init).
\connect tagtorack_app

-- 06-notify-digest.sql — approval-email digest (one email per seller, not per item)
-- Adds the "has this approval been included in a digest email?" marker.
ALTER TABLE seller_submissions ADD COLUMN IF NOT EXISTS approval_notified_at TIMESTAMPTZ;

-- Backfill: anything approved before the digest cutover was already emailed
-- individually by the old per-item flow — never digest it again.
UPDATE seller_submissions SET approval_notified_at = NOW()
 WHERE status IN ('merchant_approved','dropoff_scheduled','completed')
   AND approval_notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_subs_unnotified
  ON seller_submissions (seller_id)
  WHERE status = 'merchant_approved' AND approval_notified_at IS NULL;
