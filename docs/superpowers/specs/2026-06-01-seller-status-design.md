# Tag to Rack — Seller Status Check + Submit-Another Design

**Date:** 2026-06-01
**Status:** Approved design, pre-implementation
**Author:** brainstormed with Conner (Pivothh)

## Summary

Two small, independent seller-facing additions to the submit flow
(`submit.tagtorack.com/m/<slug>`, no-login wizard):

1. **Status check** — a seller can open a tokenized link from their confirmation/result
   email and see, on a public page, where their submission stands (seller-safe).
2. **Submit another item** — after confirming a submission, a one-click way to submit the
   next garment without re-typing contact info. Each item remains an independent, normal
   single-item submission (no batch model, no schema change).

### Decisions locked during brainstorming
- **"Catalog" = many items submitted separately, made frictionless** — NOT a multi-item
  batch and NOT a higher photo cap. One item per submission stays the model.
- **Status auth = stateless HMAC magic-link** (Approach A): no new table, no token lifecycle.
- **Status detail = seller-safe only**: stage tracker + item summary + photos + the brand-safe
  `seller_message` + Cal.com link on approval. NEVER AI confidence / internal_note / raw
  decision label / detected brand / merchant deliberation.
- **No DB schema changes.** One new n8n webhook (`submit/status`), one new Pages page
  (`/submit/status`), one frontend button, email link additions.

## Feature 1 — Status check

### Token (stateless, reuses `PORTAL_SESSION_SECRET`)
`token = base64url(submission_id) + "." + base64url(HMAC-SHA256(submission_id, PORTAL_SESSION_SECRET))`.
Self-validating, unguessable, no storage. Helper added to `functions/_shared/` (a small
`status-token.js`, or folded into `portal-session.js` — implementer's choice, but it must NOT
import portal-session's cookie logic into the public page unnecessarily). Verify = recompute
HMAC over the decoded submission_id and constant-ish compare; on mismatch/garbage → null.

Rationale for stateless: status is low-sensitivity; submissions auto-expire in 7 days; secret
rotation invalidates all links (acceptable). Mirrors the existing HMAC patterns
(`n8n-fanout`, `portal-session`, decision tokens).

### Where the link appears
- **Confirmation screen** (`submit/portal.html`): a "Check your status anytime" link built
  client-side from the returned `submission_id` + a token. **Problem:** the browser can't
  compute the HMAC (no secret client-side). Resolution: `submit/finalize` already returns to
  the browser; extend its response (or the `submit/start` response) to include the
  `status_token` minted server-side (Pages Function has the secret) so the confirmation screen
  can show the link. Specifically: the **finalize** Pages handler (`functions/submit/api/finalize.js`)
  mints the token from the submission_id and returns it as `status_token`; `submit.js` renders
  the link on the confirmation screen.
- **Emails:** WF-5's seller email (and any confirmation email) includes the full URL
  `https://<SUBMIT_PUBLIC_BASE>/submit/status?s=<token>`. WF-5 mints the token in-workflow
  (it has `submission_id` and `$env` access to the secret) — add the secret to n8n env if not
  present (it already has `INTAKE_WEBHOOK_SECRET`; reuse a shared `STATUS_TOKEN_SECRET` =
  the same value as Pages' `PORTAL_SESSION_SECRET`). **Decision:** to keep one source of
  truth, add `PORTAL_SESSION_SECRET` to the n8n `environment:` (compose + ops/.env) so both
  Pages and n8n mint identical tokens. (Pages already has it in `.dev.vars`/dashboard.)

### Page: `functions/submit/status.js` (GET `/submit/status?s=<token>`)
Public (token is the authorization; no session). Verify token → `submission_id`; on failure
render a friendly "This link is invalid or expired — check your email" page (HTTP 200 or 404,
no data, no enumeration). On success, call webhook `submit/status` → render the seller-safe
page with the merchant's branding (the webhook returns the merchant slug/name/brand for
styling). Headers: CSP + `Cache-Control: no-store`; all dynamic values `esc()`-escaped.

### Webhook: `submit/status` `{submission_id}` (built with `wf-lib.mjs`)
Returns ONLY seller-safe fields:
- `merchant`: slug, display_name, brand_color (for page branding).
- `item`: declared_brand, declared_category, declared_size, declared_condition, asking_price_usd.
- `photos`: presigned 24h GET URLs (reuse the WF-5/WF-M3 R2 presign Code snippet).
- `stage`: mapped seller-safe stage (see mapping table).
- `seller_message`: the brand-safe message from the latest `submission_decisions` row, if any
  (this field is explicitly designed to be seller-facing by the vision prompt).
- `calcom_url`: the merchant's `calcom_event_url` (or `CALCOM_BOOKING_URL` fallback) — only
  surfaced by the page when stage is approved.
- Does NOT return: confidence, brand_confidence, internal_note, raw `decision`,
  brand_detected, rule_evaluation, fail/borderline reasons, token counts, or anything from
  merchant deliberation.

### Status → seller-safe stage mapping
| Internal status | Stage (of 3) | Message / next step |
|---|---|---|
| `pending_uploads` | Received (1) | "We've got your photos — finishing up." |
| `received`, `ai_reviewing` | In review (2) | "We're reviewing your item. You'll hear back within 24 hours." |
| `merchant_review`, `ai_borderline` | In review (2) | Same "in review" message (no leak of human-vs-AI). |
| `merchant_approved` | Approved (3) ✓ | brand-safe `seller_message` + "Schedule your drop-off" (Cal.com). |
| `dropoff_scheduled` | Approved — drop-off booked ✓ | "Your drop-off is scheduled." |
| `completed` | Completed ✓ | "Thanks — this item's all done." |
| `ai_failed`, `merchant_rejected` | Decision made | brand-safe decline `seller_message`; no reasons/labels. |
| `expired`, `withdrawn`, `deleted` | Closed | "This submission is no longer active." |

The stage mapping lives in the webhook (single source of truth); the page renders the
3-dot tracker + message + (conditional) drop-off CTA.

## Feature 2 — Submit another item (frontend only)

- On the **confirmation screen** (`submit/portal.html` + `submit/assets/submit.js`), add a
  **"Submit another item"** button.
- On click: keep the `localStorage` draft's **contact** block (name/email/phone/zip/consent),
  clear the **item** fields + in-memory `photoBlobs` + the prior `submission_id`/upload state,
  reset the wizard to **step 2 (item-details)**, and scroll to top. (The draft store +
  contact-prefill on load already exist in `submit.js`; this reuses them.)
- Each subsequent item is a normal independent `submit/start → photo-complete → finalize`
  (→ its own WF-5 review → its own merchant queue card). No batch, no schema, no new webhook.
- Edge cases (documented, unchanged in v1): the `fingerprint` dedupe (seller_id + normalized
  description) still 409s a genuinely-identical re-submission; per-IP rate limit (5/24h) still
  applies, so a very large closet could hit the cap — known limitation, not changed here.

## Security

- Status token: HMAC-verified, unguessable; a bad/edited token reveals nothing (friendly
  invalid page). The page is public-by-token (same trust model as merchant decision links).
- `submit/status` webhook returns only the seller-safe projection (enforced in SQL/Code —
  it simply does not select the unsafe columns).
- CSP + `no-store` + `esc()` on the status page. No new auth surface; no PII beyond what the
  seller already submitted (and only for the one submission the token authorizes).

## Testing strategy

Live integration (same as the rest of the app):
- **Webhook:** build + deploy; `post-webhook.mjs submit/status` against seeded submissions in
  each status; assert correct stage + that unsafe fields are ABSENT from the JSON.
- **Token:** mint via the helper; `/submit/status?s=<token>` renders the right stage + photos
  under `wrangler pages dev`; tamper a char → invalid page (no data); confirm finalize returns
  a `status_token` and WF-5's email contains a working link (Mailpit).
- **Submit-another:** complete a submission in the dev portal, click "Submit another", confirm
  contact persists + item/photos cleared + lands on step 2; finalize item 2 → second queue card
  (auto-AI-trigger).
- **Security:** random/edited token → invalid page; page shows no other submission's data.

## Out of scope (v1)

True multi-item batch / "whole closet" single-upload (deliberately deferred — needs new
schema: batch parent + child submissions + WF-5 fan-out); raising the 1–6 photo cap;
status-page reschedule/cancel; relaxing the seller rate limit; a seller login/account.

## Dependencies & sequencing

- Reuses `functions/_shared/portal-session.js` HMAC helpers (or a small new `status-token.js`),
  `ops/n8n/wf-lib.mjs`, the R2 presign snippet, the existing `submit.js` draft/localStorage
  contact-prefill, and WF-5's stored seller_message.
- Adds `PORTAL_SESSION_SECRET` to the n8n container env (compose + ops/.env) so n8n and Pages
  mint identical status tokens. Extends `functions/submit/api/finalize.js` to return
  `status_token`. No DB schema change.
