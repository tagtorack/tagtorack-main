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
- **Code & deploy** — latest `main` commit, commits in last 24h, and open pull requests (via the GitHub API).
- **Leads & revenue** — new website leads (24h), open leads in the pipeline, and Stripe revenue (24h) when a key is configured.
- **Overnight inbox** — count + senders/subjects of email to contact@ in the last 24h (when IMAP is configured).
- **Working** / **Broken or degraded** — live HTTP health check of every public page + the portal & admin.
- **Recommendations** — rule-based, prioritised (what to do first today).

## Data sources & one honest limitation

- Pipeline figures are **live from Postgres** (`seller_submissions`, `submission_decisions`,
  `merchants`, `sellers`, `dropoff_bookings`, `gemini_usage`).
- Site status is a **live fetch** of https://tagtorack.com pages + `/portal` + `/admin`.
- Website **leads** are now captured: the contact form upserts each demo request into the `leads` table
  (via WF-LEAD), so the brief shows new + open leads. Requires deploying WF-LEAD and the updated contact form.
- **Stripe revenue** appears when `STRIPE_API_KEY` is set; otherwise it shows n/a.
- The **inbox** summary reads contact@ over IMAP when `IMAP_*` is configured (see env below). Ad spend is not wired.

## Required n8n env (already used by WF-5)

- `RESEND_API_KEY` — Resend key (prod).
- `EMAIL_TRANSPORT=resend` — in dev this defaults to Mailpit instead.
- `FROM_EMAIL` — e.g. `Tag to Rack <noreply@tagtorack.com>` (must be on a Resend-verified domain).
- Optional: `MORNING_BRIEF_TO` (default `contact@tagtorack.com`), `SITE_BASE` (default `https://tagtorack.com`).
- Optional: `GITHUB_TOKEN` (or `GH_TOKEN`) — enables the **Code & deploy** section; a fine-grained token with `contents:read` + `pull_requests:read` is enough. `GITHUB_REPO` defaults to `tagtorack/tagtorack-main`.
- Optional: `STRIPE_API_KEY` — enables the **revenue** line (read-only restricted key is fine). Omit it and the brief simply shows revenue as n/a.
- Optional inbox: `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` (and `IMAP_PORT`, default 993) — enables the **Overnight inbox** section.
  Requires the `imapflow` package available to n8n Code nodes: `npm i imapflow` in the n8n environment and set
  `NODE_FUNCTION_ALLOW_EXTERNAL=imapflow` on the n8n service. Without these the section is simply omitted.

## Deploy (from repo root, on the machine running n8n)

```bash
# 1. (re)generate the workflow JSON
node ops/n8n/build-morning-brief.mjs

# 2. import into n8n
node ops/n8n/n8n-api.mjs POST /workflows ops/n8n/workflows/WF-MB-morning-brief.json
#    -> note the "id" in the response, then activate:
node ops/n8n/n8n-api.mjs POST /workflows/<id>/activate
```

### Also deploy the lead-capture workflow (for the Leads numbers)

```bash
node ops/n8n/build-contact-lead.mjs
node ops/n8n/n8n-api.mjs POST /workflows ops/n8n/workflows/WF-LEAD-contact.json
node ops/n8n/n8n-api.mjs POST /workflows/<id>/activate
```

Then redeploy the site (push to `main`) so the updated `functions/api/contact.js` starts posting
demo requests to `contact/lead`. It's fire-and-forget: if n8n is unreachable the email path is unaffected.
Requires `INTAKE_WEBHOOK_BASE` + `INTAKE_WEBHOOK_SECRET` set on the Pages project (already used by the submit flow).

## Test it now (don't wait for 8am)

In the n8n editor, open **WF-MB morning-brief** and click **Execute workflow** — it will run the
query, the health checks, and send one email immediately. Confirm it lands in contact@tagtorack.com.

## Rollback

Deactivate or delete the workflow in the n8n UI, or:

```bash
node ops/n8n/n8n-api.mjs POST /workflows/<id>/deactivate
```
