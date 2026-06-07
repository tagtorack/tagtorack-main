# Approval digest — one email per seller, not per item (WF-ND)

Fixes the "approve 4 items over an afternoon → seller gets 4 emails and books 4
drop-offs" problem. With the digest on, approvals quietly accumulate; once the
manager's review session has gone quiet, the seller gets **one email listing all
approved items with a single drop-off booking link**.

## How it works

1. Manager approves items (portal or admin) — **no email fires**; the item is just
   marked approved-and-unnotified.
2. **WF-ND** runs every 10 minutes. For each seller whose *newest* un-notified
   approval is older than the quiet window (`TT_NOTIFY_QUIET_MIN`, default 30 min —
   i.e. the manager is probably done reviewing), it sends one combined email and
   marks those items notified.
3. Worst-case delay for the seller: quiet window + 10 min. Rejection emails are
   unchanged (still immediate).

## Deploy (on the machine running n8n)

```bash
# 1. apply the migration to the live DB (adds approval_notified_at + backfills old rows)
docker exec -i tt_pg psql -U "$PG_USER" -d "$PG_DB_N8N" < ops/initdb/06-notify-digest.sql
#    ^ adjust -d if the app schema lives in a different database

# 2. import/update the workflows (also re-deploys digest-gated WF-M4 + WF-A4)
node ops/n8n/deploy-workflows.mjs

# 3. flip the switch on the n8n service env, then restart n8n
#    TT_DIGEST_NOTIFY=true
#    TT_NOTIFY_QUIET_MIN=30   (optional)
```

Until `TT_DIGEST_NOTIFY=true` is set, behavior is exactly as before (per-item
emails) — the workflows are deployed dormant, so each step is safe on its own.

## Test

Approve two items for the same test seller in the portal, wait quiet-window + one
cron tick (or temporarily set `TT_NOTIFY_QUIET_MIN=0` and run WF-ND manually) and
confirm ONE email arrives listing both items.

## Rollback

Set `TT_DIGEST_NOTIFY=false` (immediate emails resume) and deactivate WF-ND.
Items already marked notified are never re-sent. The column is harmless to keep.
