# Tag to Rack — Admin / Operator Dashboard (v1) Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Author:** brainstormed with Conner (Pivothh)

## Summary

An internal, locked-down dashboard at `/admin/*` for the operator (Conner) to **see and
manage everything across all merchants**: a cross-merchant submissions explorer, an operator
queue for resolving BORDERLINE/failed/stuck submissions, merchant management (onboard + edit
rule_set), an AI calibration view, and an audit-log viewer. Net-new on the existing Cloudflare
Pages + n8n + Postgres stack, alongside the shipped merchant portal (`/portal/*`).

### Decisions locked during brainstorming
- **Auth:** Cloudflare Access (Zero Trust) at the edge **+** app-side JWT verification.
- **Scope:** full — all five modules in v1.
- **Operator queue actions:** send-to-merchant-review, approve, reject, re-run AI.
- **Architecture:** Approach 1 — server-rendered Pages Functions, all data via HMAC-signed
  `admin/*` n8n webhooks (preserves the app's "n8n owns the DB" invariant).

## Architecture & routing

- Lives in the **same `tag-to-rack` Pages project**, served by Functions under **`/admin/*`**.
  `_routes.json` gains `/admin/*` (include) + `/admin/assets/*` (exclude). Static assets at
  `admin/assets/` (repo root), served at `/admin/assets/*`.
- **Data invariant preserved:** Pages → HMAC-signed `admin/*` n8n webhook → Postgres. No direct
  DB access from Pages. Operator actions reuse the `merchant/decide` status/token/email core.

## Authentication

Two independent layers (defense-in-depth):

1. **Cloudflare Access (edge).** A Zero Trust Access application protects the `/admin*` path with
   a policy allowing only operator email(s). CF blocks unauthenticated requests before they reach
   the app and injects `Cf-Access-Jwt-Assertion` + `Cf-Access-Authenticated-User-Email`.
   *Prerequisite (dashboard, operator's side):* create the Access app + policy before prod use.
2. **App-side verification** — `functions/_shared/admin-auth.js`, `requireAdmin(request, env)`:
   - Verify the CF Access JWT against the team's public keys
     (`https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`), check `aud === CF_ACCESS_AUD`,
     extract the email, and confirm it is in the `ADMIN_EMAILS` allowlist. Returns `{ email }`
     or a 403. So a CF routing/config slip cannot expose data — the app re-checks.
   - **Local-dev bypass:** `wrangler pages dev` has no CF Access in front (no JWT). When
     `ADMIN_DEV_BYPASS === "true"` (only ever set in `.dev.vars`), `requireAdmin` returns a fixed
     dev operator email so local testing works. **Hard rule: never set in production.**

**New env:** `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ADMIN_EMAILS` (comma-separated),
`ADMIN_DEV_BYPASS` (dev only). The CSRF HMAC reuses the existing `PORTAL_SESSION_SECRET` (no new
secret — it's already present in `.dev.vars`/dashboard and used the same way).

## Data model

**No new tables.** Reads existing tables (`seller_submissions`, `submission_decisions`,
`submission_photos`, `merchants`, `sellers`, `decision_tokens`, `dropoff_bookings`,
`audit_log`, `gemini_usage`). Two specifics:

- **rule_set edits regenerate the denormalized projections.** `admin/merchant-upsert` re-derives:
  `accepted_categories ← rule_set->'categories_accepted'`, `brand_allowlist ←
  rule_set->'brand_allowlist'`, `brand_blocklist ← rule_set->'brand_blocklist'`, `condition_floor
  ← rule_set->>'condition_floor'` (validated against the column CHECK:
  new_with_tags/excellent/good/fair). Note the deliberate key→column rename
  `categories_accepted` → `accepted_categories`. Done in SQL via
  `ARRAY(SELECT jsonb_array_elements_text(...))`.
- **Operator actions are audited into `audit_log`** (no new table): each resolve/approve/reject/
  requeue/merchant-upsert writes a row with `agent_run_id = gen_random_uuid()` (NOT NULL),
  `event_type` in {`operator_resolved`, `operator_merchant_upsert`}, and `payload` capturing the
  verified `operator_email`, the action, and the target id. `submission_id` set when applicable.
- **Allowlist stays in env** (`ADMIN_EMAILS`) — no DB table; matches the CF Access policy.

## n8n `admin/*` webhooks (built with `ops/n8n/wf-lib.mjs`, same pattern as `merchant/*`)

Eight HMAC'd webhooks. Pages calls them only after `requireAdmin` passes and includes the
verified `operator_email` in each payload (n8n records it; it trusts the Pages layer, exactly
like `merchant/*`).

- **`admin/submissions`** `{status?, merchant_id?, q?, limit, offset}` → paginated cross-merchant
  list: merchant name, seller email, status, latest AI decision + confidence, submitted_at.
  Search `q` matches short_id / seller email / declared brand.
- **`admin/submission`** `{submission_id}` → full detail: submission + seller + merchant, all
  photos (presigned 24h GET URLs, reusing the WF-5/WF-M3 R2 presign), the latest
  `submission_decisions` row in full, and that submission's `audit_log` history.
- **`admin/queue`** → worklist: `ai_borderline` + `ai_failed` + stuck `ai_reviewing` (>10 min),
  each with decision reasons + presigned photos inline (actionable without a round-trip).
- **`admin/resolve`** `{submission_id, action, operator_email}`,
  `action ∈ {send_to_merchant, approve, reject, requeue}`:
  - **send_to_merchant** → `→ merchant_review`, mint 2 `decision_tokens`, email the merchant
    (same effect as an AI PASS autosend).
  - **approve / reject** → same status transition + seller email as `merchant/decide`, but
    operator-initiated (merchant_id derived from the submission row; no ownership check — the
    operator is global).
  - **requeue** → `→ received`, clear `ai_reviewed_at`, re-trigger WF-5 (`submit/process`).
  - all four write an `audit_log` row with `operator_email`.
  - *DRY:* the approve/reject/send paths keep the SAME status/token/email SQL as
    `merchant/decide` (and Phase D's WF-6), sourced from the submission instead of a session.
- **`admin/merchants`** `{slug?}` → list all merchants (or one when `slug` given): slug, name,
  contact_email, status, rule_set, submission counts.
- **`admin/merchant-upsert`** `{slug, display_name, contact_email, dropoff_address,
  calcom_event_url, rule_set, operator_email}` → `INSERT … ON CONFLICT (slug) DO UPDATE`,
  regenerating projection columns (Data model), validated, audited.
- **`admin/calibration`** `{range?}` → AI decision distribution (PASS/BORDERLINE/FAIL counts),
  **AI↔merchant agreement %** (AI PASS that the merchant approved), volumes by day, per-merchant
  breakdown, avg confidence, Gemini token usage (`gemini_usage`).
- **`admin/audit`** `{event_type?, submission_id?, limit, offset}` → paginated `audit_log` stream.

## Pages surface (`functions/admin/`)

All pages call `requireAdmin` first; server-rendered HTML with `esc()` on every dynamic value +
an admin CSP + `Cache-Control: no-store`, mirroring `/portal`.

- `index.js` (GET `/admin`) — dashboard home: summary tiles (queue count, counts by status,
  today's volume) + module nav.
- `submissions.js` (GET `/admin/submissions`) — explorer: filter bar (status/merchant/search) +
  paginated table → `admin/submissions`.
- `submission/[id].js` (GET `/admin/submission/<id>`) — detail: photos, full AI decision +
  reasons, `audit_log` history, operator-action buttons → `admin/submission`.
- `queue.js` (GET `/admin/queue`) — operator worklist: borderline/failed/stuck cards with
  reasons + photos + the four action buttons.
- `api/resolve.js` (POST) — `requireAdmin` + CSRF + Origin → `admin/resolve`.
- `merchants.js` (GET `/admin/merchants`) — merchant list + "New merchant" + edit links →
  `admin/merchants`.
- `merchant/[slug].js` (GET `/admin/merchant/<slug>`; `/admin/merchant/new` to onboard) — edit
  form (display_name, contact_email, dropoff, Cal.com, rule_set fields) → `admin/merchants?slug=`.
- `api/merchant-upsert.js` (POST) — `requireAdmin` + CSRF + Origin → `admin/merchant-upsert`.
- `calibration.js` (GET `/admin/calibration`) — AI calibration view → `admin/calibration`.
- `audit.js` (GET `/admin/audit`) — audit-log viewer (paginated/filterable) → `admin/audit`.
- `functions/_shared/admin-auth.js` — `requireAdmin`, `csrfFor`, `ADMIN_CSP`, `callN8n` (reuses
  `postToN8n`).
- Static `admin/assets/admin.css` + minimal `admin.js` (filter submits, POST-action buttons).

**CSRF (no app session cookie — auth is the CF Access cookie/JWT):** token =
`HMAC(secret, "admin-csrf:" + operatorEmail)` embedded in each form, re-checked on POST, plus a
same-origin Origin check. Same shape as the portal's CSRF, bound to the CF Access identity.

## Security

- Two-layer auth (CF Access edge + app-side JWT verify + allowlist). Every page + API gates on
  `requireAdmin`. `ADMIN_DEV_BYPASS` fenced to `.dev.vars`.
- CSRF + same-origin on state-changing POSTs; CSP + `no-store` on all admin responses (CSP allows
  `https://*.r2.cloudflarestorage.com` for photos).
- Operator email audited on every action (`audit_log`).
- `admin/*` webhooks HMAC-signed from Pages; n8n records the passed `operator_email`.
- Input validation in write webhooks: slug regex, `condition_floor` CHECK set, `rule_set` valid
  JSON; `resolve` validates the action enum + submission UUID.
- No secrets committed (`CF_ACCESS_*`, `ADMIN_EMAILS` in `.dev.vars` / dashboard). `/admin/assets/*`
  is static CSS/JS only (no data) but the CF Access app should still cover the whole `/admin*` path.

## Testing strategy

Live integration, same method as the portal. Build each `admin/*` webhook via the n8n REST API,
verify with `ops/n8n/post-webhook.mjs` against seeded data; run Pages via `wrangler pages dev`
with `ADMIN_DEV_BYPASS=true`.

- Webhooks: cross-merchant list; queue surfaces borderline/failed/stuck; `resolve` approve flips
  status + audits + emails (Mailpit); `merchant-upsert` creates/edits and regenerates projection
  columns; `calibration` aggregates; `audit` stream paginates.
- Pages: each page renders under dev bypass; **without** bypass → 403; bad CSRF → 403;
  non-allowlisted email → 403.
- Adversarial: missing/forged JWT, wrong `aud`, cross-checks; operator `resolve` on a non-existent
  submission → graceful error.
- Seeded data (demo-pass, test-thrift, submissions in various statuses) exercises realistic views.

## Out of scope (v1)

Offers / store-credit-ledger views (Phase F); the separate lead/email/SMS operator pipeline
(`leads`/`threads`/`messages` — different unbuilt subsystem); multi-admin roles/permissions
(single operator role); real-time/websocket updates (refresh-based); bulk actions; the
`admin.tagtorack.com` subdomain (path-based `/admin` for v1).

## Dependencies & sequencing

- Reuses `functions/_shared/portal-session.js` patterns (CSP/esc/HMAC helpers), `ops/n8n/wf-lib.mjs`,
  the R2 presign snippet, and the `merchant/decide` decision core.
- Requires the CF Access app configured in the Cloudflare dashboard before prod; adds the new env
  vars above to `.dev.vars` (dev) + dashboard (prod).
- Independent of Phase D (WF-6/WF-7a) but complements it: `admin/resolve` and `merchant/decide`
  share the decision core that WF-6 will also wrap.
