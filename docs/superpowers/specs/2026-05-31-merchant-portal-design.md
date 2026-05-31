# Tag to Rack — Merchant Portal (v1) Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Author:** brainstormed with Conner (Pivothh)

## Summary

A small authenticated web app where a partner store logs in (passwordless email
link) to see its queue of submissions awaiting review — each with photos and the
AI's decision/notes — and **Approve** or **Reject** them, plus a lightweight
analytics summary. It is net-new on top of the existing Cloudflare Pages site +
n8n/Postgres backend.

Today merchants act only through emailed Approve/Reject magic-links (WF-5 mints
`decision_tokens`; the consuming workflow WF-6 is Phase D, not yet built). The
portal is a logged-in alternative to those links and shares the same decision
core, so the two paths cannot diverge.

### Decisions locked during brainstorming
- **Auth:** passwordless email login link (no passwords). Reuses the existing
  magic-link/token pattern.
- **Identity:** one login per store (the `merchants.contact_email`). No
  multi-user/staff management in v1 (easy to add later).
- **v1 scope:** pending-review queue (photos + AI decision/notes) + Approve/Reject
  + an analytics summary. **Deferred:** submission history/search, counter-offer
  (depends on the Phase F offers/ledger), merchant editing of `rule_set`.
- **Architecture:** Approach 1 — server-rendered Pages Functions, all data access
  via HMAC-signed n8n webhooks (the app's existing invariant: Pages never touches
  Postgres directly).

## Architecture & routing

- Lives in the **same `tag-to-rack` Pages project**, served by Functions under
  **`/portal/*`**. Add `/portal/*` to `_routes.json` `include`, and
  `/portal/assets/*` to `exclude` (static assets bypass Functions, mirroring
  `/submit/assets/*`).
- Canonical URL for v1: `https://tagtorack.com/portal`. A `portal.tagtorack.com`
  (or `app.`) subdomain can front it later via the same Cloudflare redirect-rule
  mechanism `submit.tagtorack.com` uses (`_redirects` + custom domain). **Deferred**
  — not required for v1, avoids host-based routing in a single Pages project.
- **Data-access invariant preserved:** every read/write goes Pages →
  HMAC-signed n8n webhook → Postgres. The portal adds a `merchant/*` webhook family.
- **Decision unification:** the portal's Approve/Reject and Phase D's email
  magic-link (WF-6) both invoke ONE n8n decision core (`merchant/decide` →
  shared logic), so behavior can't drift between the two entry points.

## Authentication & session

Passwordless email login:

1. `/portal` with no valid session → login page (email field only).
2. `POST /portal/api/login-request {email}` → Pages → n8n `merchant/login-request`:
   look up merchant by `contact_email` (CITEXT, status='active'); if found, mint a
   login token (32 random bytes), store its **sha256 hash** + `merchant_id` +
   15-minute `expires_at` in `merchant_login_tokens`, and email the raw link
   `…/portal/auth?t=<raw>` (Mailpit dev / Resend prod). **Always** respond
   `{ok:true}` regardless of whether the email matched (anti-enumeration).
3. `GET /portal/auth?t=<raw>` → Pages → n8n `merchant/login-consume`: hash the raw
   token, find an unused & unexpired row, set `used_at`/`used_ip`, return
   `{merchant_id, slug, display_name}`.
4. Pages sets a **signed session cookie** `tt_portal_session`:
   `base64url(payload) + "." + HMAC-SHA256(base64url(payload), PORTAL_SESSION_SECRET)`,
   where `payload = {merchant_id, slug, exp}`. Attributes:
   `HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=604800` (7 days).
   Redirect to `/portal`.
5. Each `/portal` request runs `requireSession()`: verify signature + `exp`,
   extract `merchant_id`. Invalid/expired → redirect to login. `logout` clears
   the cookie.

**Notes:** Stateless cookie (no server session store) is acceptable for v1; the
only global revocation lever is rotating `PORTAL_SESSION_SECRET`. Login link =
15-minute expiry, single-use, hashed at rest. New env var `PORTAL_SESSION_SECRET`
(repo-root `.dev.vars` for local + Cloudflare dashboard for prod).

## Data model

One new table (additive). Added to **`ops/initdb/05-portal-schema.sql`**
(`\connect tagtorack_app`) for fresh installs, and applied to the running dev DB
as an idempotent migration:

```sql
CREATE TABLE IF NOT EXISTS merchant_login_tokens (
  token_hash   TEXT PRIMARY KEY,                 -- sha256(raw); raw never stored
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
```

No other schema changes. Reads/decisions reuse `merchants`, `seller_submissions`,
`submission_decisions`, `submission_photos`, `decision_tokens`.

## n8n webhooks (new; same build pattern as WF-1…5, HMAC-verified later)

- **`merchant/login-request`** `{email}` → mint + email login link; always `{ok:true}`.
- **`merchant/login-consume`** `{token}` → validate single-use/unexpired →
  `{merchant_id, slug, display_name}` or `{ok:false}`.
- **`merchant/queue`** `{merchant_id}` → array of that merchant's
  `status='merchant_review'` submissions, each joined to its latest
  `submission_decisions` row (decision, confidence, brand, est. retail/resale,
  reasons, internal_note) plus **presigned 24h GET URLs** for its
  `submission_photos` (reuses the WF-5 R2 SigV4 presign Code logic — this is what
  finally renders real photos). Ordered by `submitted_at`.
- **`merchant/decide`** `{merchant_id, submission_id, action}` — the **unified
  decision core**: verify the submission belongs to `merchant_id` AND is in
  `merchant_review`; flip to `merchant_approved`/`merchant_rejected`; set
  `merchant_decided_at`; invalidate that submission's outstanding `decision_tokens`
  (`used_at = NOW()` where null); on approve, email the seller the Cal.com
  drop-off link (`merchants.calcom_event_url`, Mailpit/Resend). Returns
  `{ok, status}`. Idempotent: a second decide on an already-decided submission
  returns the current status without re-acting. **Phase D's WF-6 (email link)
  validates its token, then calls this same core.**
- **`merchant/stats`** `{merchant_id}` → analytics summary (below).

Authorization is enforced twice: Pages attaches `merchant_id` only from a verified
session; n8n re-checks submission ownership in `merchant/queue` and
`merchant/decide`.

## Pages surface (`functions/portal/`)

- `index.js` (GET) — no session → login page; valid session → **queue** (cards:
  photo thumbnail, item summary, AI badge `PASS`/`BORDERLINE` + confidence, est.
  resale, Approve/Reject).
- `api/login-request.js` (POST), `auth.js` (GET `?t=` → consume → set cookie →
  redirect), `logout.js` (clear cookie).
- `submission/[id].js` (GET) — detail: full photos, AI reasons + internal note,
  Approve/Reject.
- `api/decide.js` (POST) — `requireSession` + CSRF check → n8n `merchant/decide`.
- `analytics.js` (GET) — renders `merchant/stats`.
- `functions/_shared/portal-session.js` — `signSession` / `verifySession` /
  `requireSession`.
- Static `/portal/assets/*` — one small CSS + minimal vanilla JS for the POST
  buttons. No framework, no build step (matches the submit portal).

## Security

- **Anti-enumeration:** login-request always returns `{ok:true}`.
- **Login tokens:** single-use, 15-minute expiry, sha256-hashed at rest.
- **Session cookie:** `HttpOnly; Secure; SameSite=Lax; Path=/portal`, HMAC-signed,
  7-day expiry.
- **CSRF:** the decide POST is state-changing — require an `Origin`/`Referer`
  same-origin check **and** a per-session CSRF token embedded in each page/form
  and validated by `api/decide.js` (SameSite=Lax alone is not relied upon).
- **Rate limiting:** login-request throttled per-email + per-IP via the existing
  KV `ratelimit.js` helper.
- **CSP:** portal Function responses send a `Content-Security-Policy` allowing
  `self` + the R2 image host (`https://*.r2.cloudflarestorage.com`), like the
  submit portal.
- **Authorization:** every endpoint scopes by the session `merchant_id`; n8n
  re-validates ownership server-side.

## Analytics summary (`merchant/stats`, read-only, scoped to `merchant_id`)

Computed over `seller_submissions` + `submission_decisions`:
- Pending count (`merchant_review`).
- Approvals / rejections this week.
- **AI↔merchant agreement %** — of AI `PASS` decisions, the share the merchant
  approved (the calibration signal).
- Total estimated resale value of approved items.
- Submissions received this week.

## Testing strategy

Same method as Phase B/C — build the `merchant/*` workflows via the n8n REST API
and test webhooks live; run the Pages Functions via `wrangler pages dev` against
the local n8n stack.

Happy-path: login email lands in **Mailpit**, cookie is set, the queue renders
**real photos** for `demo-pass` (which already has a `merchant_review`
submission — `6864bbdf`), and **Approve** flips the status → sends the seller
Cal.com email → invalidates the submission's `decision_tokens`.

Adversarial: expired/replayed login token rejected; tampered/forged session
cookie rejected; cross-merchant access (merchant A attempting to decide merchant
B's submission) rejected by the n8n ownership check.

## Out of scope (v1)

Multi-user/staff per store; submission history + search; counter-offer / offer
amounts (Phase F offers + store-credit ledger); merchant editing of `rule_set`;
the `portal.tagtorack.com` subdomain (path-based for v1); HMAC verification on the
n8n webhooks (deferred app-wide, consistent with WF-1…5).

## Dependencies & sequencing

- **Phase D overlap:** `merchant/decide` is the shared decision core; building it
  here means WF-6 (email magic-link consume) becomes a thin token-validating
  wrapper over it. Recommend building `merchant/decide` first, then WF-6 reuses it.
- Requires the n8n env already added in Phase C (R2 presign, Mailpit/Resend
  transport). Adds `PORTAL_SESSION_SECRET` to Pages env.
