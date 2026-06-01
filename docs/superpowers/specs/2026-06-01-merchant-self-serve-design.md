# Tag to Rack — Merchant Portal Self-Serve (Settings + History + Export) Design

**Date:** 2026-06-01
**Status:** Approved design, pre-implementation
**Author:** brainstormed with Conner (Pivothh)

## Summary

Three self-serve additions to the merchant portal (`/portal/*`) so a logged-in store
owner can, without operator help:

1. **Edit their own acceptance rules** (`rule_set`: accepted categories, brand
   allowlist/blocklist, banned keywords, condition floor, price range, notes) at any
   time — currently admin-only.
2. **View their submission history** (their approved + rejected decisions) with
   search/filter — currently the portal only shows the pending `merchant_review` queue.
3. **Export their submissions to CSV** — currently admin-only.

Built on the existing stack and patterns; **no DB schema changes**.

### Decisions locked during brainstorming
- **Rule input UX:** structured fields, never raw JSON. List fields (categories, brands,
  banned keywords) use a **tag/chip editor** (vanilla JS, hidden-input synced); categories
  also get **quick-add buttons** for the ~12 known categories. Condition floor = dropdown;
  price floor/ceiling = number inputs; notes = textarea.
- **History scope:** **approved + rejected only** (the merchant's decision record). The
  home queue stays the pending to-do. Mental model: **Queue = act now · History = what you
  decided · Settings = your rules.**
- **Backend:** Approach 1 — three new **merchant-scoped** webhooks (M6–M8) that reuse the
  admin SQL *logic* (projection regen, CSV shaping) but NOT the admin trust boundary.
- **Audit:** merchant rule edits **write an `audit_log` row** (`merchant_rules_updated`).

## Security invariant (non-negotiable)

`merchant_id` is ALWAYS taken from the **verified session cookie** (`session.merchant_id`),
never from a form field or query param. The Pages handler passes `session.merchant_id`; the
webhook SQL filters/updates by exactly that id. A merchant can only ever read or edit their
own row. Enforced at both layers (Pages + webhook). Every POST keeps the existing CSRF token
+ same-origin Origin check; every page keeps CSP + `Cache-Control: no-store`; `requireSession`
gates all routes (redirect to `/portal` login when absent).

## Architecture & routing

- New Pages Functions under `functions/portal/`:
  - `settings.js` (GET `/portal/settings`) — the rule-editing form.
  - `api/settings.js` (POST `/portal/api/settings`) — assembles `rule_set`, saves.
  - `history.js` (GET `/portal/history`) — decided-submissions record + filters.
  - `api/export-csv.js` (GET `/portal/api/export-csv`) — merchant-scoped CSV download.
- New static asset: `portal/assets/chips.js` (tag/chip editor; ~40 lines vanilla JS).
- Nav on existing portal pages (`index.js` queue header, etc.) gains **Settings · History**
  links beside the existing **Analytics · Sign out**.
- `_routes.json` already routes `/portal/*` to Functions and excludes `/portal/assets/*`;
  no change needed. (CSV route is **extensionless** — `/portal/api/export-csv`, NOT `.csv`
  — because Pages serves any path with a file extension as a static asset before Functions.)
- **No DB schema changes.**

## New n8n webhooks (built with `ops/n8n/wf-lib.mjs`, same pattern as M1–M5)

All HMAC'd; all take `merchant_id` from the Pages layer (which sourced it from the session).

- **`merchant/profile`** `{merchant_id}` → returns the merchant's editable acceptance fields:
  `rule_set` (full JSONB) so the form can pre-fill chips/inputs from it, plus `slug`,
  `display_name` (for display only). Read-only.
- **`merchant/profile-update`** `{merchant_id, rule_set, operator_email}` →
  - `UPDATE merchants SET rule_set = $rule_set, accepted_categories = <regen>,
    brand_allowlist = <regen>, brand_blocklist = <regen>, condition_floor = <regen>,
    updated_at = NOW() WHERE id = merchant_id` — regenerating projection columns from
    `rule_set` via `ARRAY(SELECT jsonb_array_elements_text(...))`, exactly like the admin
    upsert, but as an **UPDATE keyed on merchant_id** (no slug, no INSERT, no
    status/contact/dropoff changes — rules only).
  - Writes an `audit_log` row: `agent_run_id = gen_random_uuid()` (NOT NULL),
    `event_type = 'merchant_rules_updated'`, `payload = jsonb_build_object('merchant', email,
    'slug', slug, 'rule_set', rule_set)`. (`email` = the merchant's session email, passed as
    `operator_email`.)
  - Validates: `condition_floor` ∈ {new_with_tags, excellent, good, fair}; `rule_set` is
    valid JSON; returns `{ok:true}` or `{ok:false, error}` (→ 400 on the Pages side).
- **`merchant/history`** `{merchant_id, status?, q?}` →
  the merchant's submissions WHERE `merchant_id = $1` AND `status IN ('merchant_approved',
  'merchant_rejected')`, optional `status` filter (one of those two), optional `q` matching
  short_id / declared_brand / item_description (ILIKE). Each row joined to its latest
  `submission_decisions` (decision, confidence, estimated_resale_usd). Ordered by
  `merchant_decided_at DESC`. Returns `{ok:true, submissions:[...]}`.

## Pages surface

**`/portal/settings`** (`settings.js`) — `requireSession`; GET `merchant/profile`; render a
form pre-filled from `rule_set`:
- **Accepted categories** — chip editor (hidden input `categories`), + quick-add buttons for
  the known set: `denim, jackets, outdoor-jackets, womens-tops, mens-tops, shirts, sweaters,
  dresses, pants, jeans, shoes, mens-boots, womens-boots`.
- **Brand allowlist** — chip editor (`brand_allowlist`).
- **Brand blocklist** — chip editor (`brand_blocklist`).
- **Banned keywords** — chip editor (`banned_keywords`).
- **Condition floor** — `<select>` (4 options).
- **Price floor / ceiling** — two number inputs (`price_floor_usd`, `price_ceiling_usd`;
  blank = no gate).
- **Merchant notes** — `<textarea name="merchant_notes">`.
- A CSRF hidden input (`csrfFor(env, sessionCookie)`); Save button.

**`/portal/api/settings`** (POST) — `requireSession` + Origin + CSRF; read the form; build
`rule_set = { categories_accepted: [...], brand_allowlist: [...], brand_blocklist: [...],
banned_keywords: [...], condition_floor, price_floor_usd?, price_ceiling_usd?, merchant_notes }`
(chip hidden-inputs are comma-joined → split/trim/dedupe server-side; numbers parsed or
omitted); POST `merchant/profile-update` with `{ merchant_id: session.merchant_id, rule_set,
operator_email: session.email }`; 303 → `/portal/settings?m=Saved` (or `?m=<error>`).
> Note the deliberate key name `categories_accepted` in `rule_set` (matches what WF-5/admin
> read) vs. the projected column `accepted_categories`.

**`/portal/history`** (`history.js`) — `requireSession`; GET `merchant/history` with session
id + `status`/`q` from the querystring; render a filter bar (All/Approved/Rejected dropdown +
search box) and a table: short_id (→ `/portal/submission/<id>`), decision badge + AI verdict +
confidence, brand/item, est. resale, decided date. An **Export CSV** link carrying the active
filters. Empty state: "No decided submissions yet."

**`/portal/api/export-csv`** (GET) — `requireSession` (403 if absent); GET `merchant/history`
with session id + same `status`/`q`; stream `text/csv; charset=utf-8` with a UTF-8 BOM and
`Content-Disposition: attachment; filename="<slug>-submissions-<date>.csv"`. Columns: short id,
submission id, status, AI decision, confidence, brand, item, est. resale, submitted, decided.
Merchant-scoped (no other store's data; no merchant column needed).

**Nav:** `index.js`'s header (and the other portal pages' headers) gain `Settings` + `History`
links. The home **queue** page itself is unchanged (still pending `merchant_review`).

## Validation & escaping

- All dynamic values HTML-escaped via the existing `esc()` pattern.
- `condition_floor` validated against the CHECK set; price inputs numeric-or-blank; rule_set
  must serialize to valid JSON (it's assembled server-side, so this is a guard, not user JSON).
- Chip values trimmed, empty-dropped, de-duplicated server-side before building `rule_set`.

## Testing strategy

Live integration (same as portal/admin). Build M6–M8 via REST + `post-webhook.mjs`; Pages via
`wrangler pages dev` with a real merchant session cookie (login → Mailpit → `/portal/auth`).

- `merchant/profile` returns demo-pass's rule_set; `merchant/profile-update` writes rule_set
  **and** regenerates projection columns (verify in Postgres) **and** writes the
  `merchant_rules_updated` audit row; `merchant/history` returns only approved/rejected rows,
  honoring status/q.
- Settings page pre-fills from current rules; chips add/remove sync hidden inputs; Save
  round-trips; re-running a submission shows the AI using the new rules.
- History lists decided items; filter + search work; CSV downloads with correct headers and
  matches the on-screen filter.
- Adversarial: no session → login redirect; bad CSRF / cross-origin POST → 403; cross-merchant
  probe → a session only ever reads/edits its own row (webhook keyed to session id; a tampered
  form field cannot substitute another merchant_id because the id never comes from the form);
  CSP + no-store on all new responses; bypass of the auth gate impossible without a valid
  session cookie.

## Out of scope (v1)

Editing slug / status / contact email / drop-off / Cal.com from the portal (stays admin-only —
a merchant shouldn't pause their own account or alter their drop-off contract); history beyond
approved/rejected (borderline/failed/expired remain in admin); bulk actions; rule-change diff
history UI (the audit row is written, but there's no in-portal viewer for it in v1); the
`portal.tagtorack.com` subdomain (path-based `/portal` for v1).

## Dependencies & sequencing

- Reuses `functions/_shared/portal-session.js` (requireSession/csrfFor/PORTAL_CSP/esc),
  `ops/n8n/wf-lib.mjs`, the admin `merchant-upsert` projection-regen SQL, and the admin
  `export-csv` Pages pattern (extensionless route + Content-Disposition).
- No new env vars, no schema changes. Independent of Phase D.
