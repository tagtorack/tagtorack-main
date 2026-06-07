# Morning Brief — daily ops email (WF-MB)

A self-contained daily email to **contact@tagtorack.com** at **08:00 America/Denver**, so you
start the day knowing exactly where things stand.

It runs entirely inside the local **n8n** (open-source) stack — which is the only place that can
reach the Postgres pipeline data — and sends through the same **Resend** transport the rest of the
app already uses. No cloud scheduler, no Microsoft/Google account, no desktop app needs to be running.

## What's in the email

- **Where things stand** — one-line headline (site status · new submissions overnight · items needing attention).
- **Needs your attention** — review queue (AI borderline), items waiting on merchants, expiring within 48h,
  awaiting seller photos, mid-AI-review, upcoming drop-offs.
- **Last 24 hours** — new submissions, new sellers, AI pass / fail / borderline counts.
- **Business at a glance** — merchants, sellers, approved resale value (7d), Gemini usage today.
- **Working** / **Broken or degraded** — live HTTP health check of every public page + the portal & admin.
- **Recommendations** — rule-based, prioritised (what to do first today).

## Data sources & one honest limitation

- Pipeline figures are **live from Postgres** (`seller_submissions`, `submission_decisions`,
  `merchants`, `sellers`, `dropoff_bookings`, `gemini_usage`).
- Site status is a **live fetch** of https://tagtorack.com pages + `/portal` + `/admin`.
- It does **not** read your email inbox, Stripe, or ad spend — those aren't wired into n8n. If you want
  leads-from-inbox or revenue in the brief, that's a follow-up.

## Required n8n env (already used by WF-5)

- `RESEND_API_KEY` — Resend key (prod).
- `EMAIL_TRANSPORT=resend` — in dev this defaults to Mailpit instead.
- `FROM_EMAIL` — e.g. `Tag to Rack <noreply@tagtorack.com>` (must be on a Resend-verified domain).
- Optional: `MORNING_BRIEF_TO` (default `contact@tagtorack.com`), `SITE_BASE` (default `https://tagtorack.com`).

## Deploy (from repo root, on the machine running n8n)

```bash
# 1. (re)generate the workflow JSON
node ops/n8n/build-morning-brief.mjs

# 2. import into n8n
node ops/n8n/n8n-api.mjs POST /workflows ops/n8n/workflows/WF-MB-morning-brief.json
#    -> note the "id" in the response, then activate:
node ops/n8n/n8n-api.mjs POST /workflows/<id>/activate
```

## Test it now (don't wait for 8am)

In the n8n editor, open **WF-MB morning-brief** and click **Execute workflow** — it will run the
query, the health checks, and send one email immediately. Confirm it lands in contact@tagtorack.com.

## Rollback

Deactivate or delete the workflow in the n8n UI, or:

```bash
node ops/n8n/n8n-api.mjs POST /workflows/<id>/deactivate
```
