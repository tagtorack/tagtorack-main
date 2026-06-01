# Merchant Portal Self-Serve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in merchant self-serve in `/portal`: edit their own acceptance rules (chip form), view their approved/rejected history (search/filter), and export it to CSV.

**Architecture:** Three new server-rendered Pages Functions under `functions/portal/` + a tiny static chip editor, backed by three new **merchant-scoped** n8n webhooks (WF-M6/M7/M8) built with `wf-lib.mjs`. All data access keys on `session.merchant_id` (never a form field). No DB schema changes.

**Tech Stack:** Cloudflare Pages Functions (Web Crypto via `portal-session.js`), n8n 1.74.1 (`wf-lib.mjs`; node versions webhook:2/postgres:2.5/code:2/respondToWebhook:1.1; `require('crypto')`; **this.helpers.httpRequest** not fetch), Postgres (`tagtorack_app`), Mailpit (dev login email).

**Verification model:** No unit-test harness — live integration only. Build webhooks via the `ops/n8n` REST scripts, exercise with `post-webhook.mjs` + psql, run Pages via `wrangler pages dev` with a real merchant session cookie. **Read `~/.claude/plans/transient-soaring-key.md` (BUILD PLAYBOOK) first.** Critical gotchas baked into this plan: build scripts write directly to `ops/n8n/workflows/<name>.json`; **PowerShell tool, not Bash**, for all n8n API/test calls (MSYS mangles `/`-args); `n8n-api.mjs` already sends `Accept: application/json`; brand-new Pages function files need an **mtime touch** before wrangler hot-reloads them; CSV route is **extensionless** (`/portal/api/export-csv`).

**Branch:** `feature/merchant-self-serve` (checked out). Commit after each task.

**Key fixtures:** merchant `demo-pass` (id `255e6d84-f2b8-4549-9754-514839841a84`, login `store-demo@example.com`). PG password = `PG_PASSWORD` in `ops/.env`: `docker exec -e PGPASSWORD=<pw> tt_pg psql -U tagtorack -d tagtorack_app`. n8n PG credential id `GZJQdHGNtdLI18IW`.

**SECURITY INVARIANT (every task respects this):** `merchant_id` is ALWAYS `session.merchant_id` from the verified cookie — never read from a form/query. Webhook SQL filters/updates by exactly the id the Pages layer passes. A merchant can only read/edit their own row.

---

## Mint a merchant session cookie (reused by Tasks 5–8)

Several Pages tasks need a logged-in merchant cookie. Procedure (PowerShell), used wherever a task says "with $cookie":
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{"email":"store-demo@example.com"}' | Out-File -Encoding ascii _login.json
node post-webhook.mjs merchant/login-request _login.json | Out-Null
$raw = ((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/messages").Content | ConvertFrom-Json).messages |
  Where-Object {$_.Subject -like '*sign-in*'} | Select-Object -First 1 |
  ForEach-Object { $mid=$_.ID; (((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/message/$mid").Content | ConvertFrom-Json).HTML -replace '(?s).*portal/auth\?t=([0-9a-f]+).*','$1') }
$r = Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/auth?t=$raw" -MaximumRedirection 0 -SkipHttpErrorCheck
$cookie = (($r.Headers['Set-Cookie'] -join ';') -split ';')[0]   # tt_portal_session=...
```
(PowerShell `Invoke-WebRequest` throws on 30x — always use `-SkipHttpErrorCheck -MaximumRedirection 0` and read `$r.StatusCode`/`$r.Headers`.)

---

## File structure

**New — n8n build scripts + workflows:**
- `ops/n8n/build-m-profile.mjs` → `workflows/WF-M6-merchant-profile.json`
- `ops/n8n/build-m-profile-update.mjs` → `workflows/WF-M7-merchant-profile-update.json`
- `ops/n8n/build-m-history.mjs` → `workflows/WF-M8-merchant-history.json`

**New — Pages Functions + assets:**
- `functions/portal/settings.js` — GET `/portal/settings` (rule form)
- `functions/portal/api/settings.js` — POST `/portal/api/settings` (assemble rule_set → save)
- `functions/portal/history.js` — GET `/portal/history`
- `functions/portal/api/export-csv.js` — GET `/portal/api/export-csv`
- `portal/assets/chips.js` — vanilla tag/chip editor (static, served at `/portal/assets/chips.js`)

**Modified:**
- `functions/portal/index.js` — add Settings + History nav links to the queue header.
- `functions/portal/analytics.js` — add the same nav links (consistency).

No `_routes.json` change (`/portal/*` already routed; `/portal/assets/*` already excluded). No schema change.

---

## Task 1: WF-M6 merchant/profile (read rules)

**Files:** Create `ops/n8n/build-m-profile.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-profile.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT m.id::text AS merchant_id, m.slug, m.display_name, m.rule_set
FROM merchants m, inp
WHERE m.id = NULLIF(inp.d->>'merchant_id','')::uuid
LIMIT 1;
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.merchant_id);
if (!rows.length) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const r = rows[0];
return [{ json: { statusCode: 200, body: { ok:true, slug:r.slug, display_name:r.display_name, rule_set:r.rule_set||{} } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/profile"),
  pgNode("pg", "Load", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M6 merchant-profile", nodes, connections: linearConnections(["Webhook","Load","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M6-merchant-profile.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M6");
```

- [ ] **Step 2: Build + deploy + activate**

Run (PowerShell):
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node build-m-profile.mjs
$id = node n8n-api.mjs POST /workflows workflows/WF-M6-merchant-profile.json 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))"
node n8n-api.mjs POST /workflows/$id/activate 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('active='+JSON.parse(d).active))"
```
Expected: `active=true`.

- [ ] **Step 3: Test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84"}' | Out-File -Encoding ascii _a.json
node post-webhook.mjs merchant/profile _a.json
'{"merchant_id":"00000000-0000-0000-0000-0000000000aa"}' | Out-File -Encoding ascii _b.json
node post-webhook.mjs merchant/profile _b.json
```
Expected: first → HTTP 200 with `slug:"demo-pass"` and a `rule_set` object (categories_accepted/condition_floor present); second → HTTP 404 `{"ok":false,"error":"not_found"}`.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-m-profile.mjs ops/n8n/workflows/WF-M6-merchant-profile.json
git commit -m "feat(portal): WF-M6 merchant/profile (read rule_set)"
```

---

## Task 2: WF-M7 merchant/profile-update (save rules + projection regen + audit)

**Files:** Create `ops/n8n/build-m-profile-update.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-profile-update.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Prep: validate merchant_id + condition_floor + rule_set JSON. rule_set arrives
// as an OBJECT (assembled by the Pages layer) or a JSON string; normalize.
const prep = `
const b = $json.body || {};
const mid = String(b.merchant_id || '');
const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(mid);
let rule_set = b.rule_set;
if (typeof rule_set === 'string') { try { rule_set = JSON.parse(rule_set); } catch { return [{ json:{ payload:{ valid:false, error:'bad_rule_set_json' } } }]; } }
rule_set = rule_set || {};
const floor = String(rule_set.condition_floor || 'good');
const okFloor = ['new_with_tags','excellent','good','fair'].includes(floor);
const valid = !!(isUuid && okFloor);
return [{ json: { payload: {
  valid, error: valid ? null : (!isUuid ? 'bad_merchant_id' : 'bad_condition_floor'),
  merchant_id: mid, rule_set, operator_email: String(b.operator_email || '')
} } }];
`.trim();

// UPDATE keyed on merchant_id (rules only). Regenerate projection columns from
// rule_set (same logic as admin merchant-upsert). Write audit_log row. One row out.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
upd AS (
  UPDATE merchants SET
    rule_set = (SELECT d->'rule_set' FROM inp),
    accepted_categories = ARRAY(SELECT jsonb_array_elements_text(coalesce((SELECT d->'rule_set'->'categories_accepted' FROM inp),'[]'::jsonb))),
    brand_allowlist     = ARRAY(SELECT jsonb_array_elements_text(coalesce((SELECT d->'rule_set'->'brand_allowlist' FROM inp),'[]'::jsonb))),
    brand_blocklist     = ARRAY(SELECT jsonb_array_elements_text(coalesce((SELECT d->'rule_set'->'brand_blocklist' FROM inp),'[]'::jsonb))),
    condition_floor     = coalesce((SELECT d->'rule_set'->>'condition_floor' FROM inp),'good'),
    updated_at = NOW()
  WHERE id = NULLIF((SELECT d->>'merchant_id' FROM inp),'')::uuid
    AND (SELECT (d->>'valid')::boolean FROM inp)
  RETURNING id, slug
),
aud AS (
  INSERT INTO audit_log (agent_run_id, event_type, payload)
  SELECT gen_random_uuid(), 'merchant_rules_updated',
         jsonb_build_object('merchant', (SELECT d->>'operator_email' FROM inp), 'slug', (SELECT slug FROM upd), 'rule_set', (SELECT d->'rule_set' FROM inp))
  WHERE (SELECT id FROM upd) IS NOT NULL
  RETURNING id
)
SELECT (SELECT (d->>'valid')::boolean FROM inp) AS valid,
       (SELECT d->>'error' FROM inp) AS error,
       (SELECT slug FROM upd) AS slug,
       (SELECT id FROM upd) IS NOT NULL AS updated;
`.trim();

const shape = `
const r = $json || {};
if (!r.valid) return [{ json: { statusCode: 400, body: { ok:false, error: r.error||'invalid' } } }];
if (!r.updated) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
return [{ json: { statusCode: 200, body: { ok:true, slug: r.slug } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/profile-update"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Update", sql, "={{ JSON.stringify($json.payload) }}", 220),
  codeNode("shape", "Shape", shape, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-M7 merchant-profile-update", nodes, connections: linearConnections(["Webhook","Prep","Update","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M7-merchant-profile-update.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M7");
```

- [ ] **Step 2: Build + deploy + activate** (same command shape as Task 1 Step 2, with `build-m-profile-update.mjs` / `workflows/WF-M7-merchant-profile-update.json`). Expected `active=true`.

- [ ] **Step 3: Test — update rules, verify projection regen + audit row**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
$body = '{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84","operator_email":"store-demo@example.com","rule_set":{"brand_allowlist":["Patagonia","Levi''s"],"brand_blocklist":["Shein"],"categories_accepted":["denim","jackets","shoes"],"banned_keywords":["fast fashion"],"condition_floor":"good","price_floor_usd":20,"price_ceiling_usd":300,"merchant_notes":"self-serve test"}}'
$body | Out-File -Encoding ascii _u.json
node post-webhook.mjs merchant/profile-update _u.json
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT accepted_categories, brand_allowlist, brand_blocklist, condition_floor FROM merchants WHERE slug='demo-pass';"
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "SELECT event_type, payload->>'merchant', payload->>'slug' FROM audit_log WHERE event_type='merchant_rules_updated' ORDER BY created_at DESC LIMIT 1;"
```
Expected: 200 `{"ok":true,"slug":"demo-pass"}`; DB shows `accepted_categories={denim,jackets,shoes}`, `brand_allowlist={Patagonia,Levi's}`, `brand_blocklist={Shein}`, `condition_floor=good`; audit row `merchant_rules_updated` with merchant `store-demo@example.com`, slug `demo-pass`.

- [ ] **Step 4: Test — bad condition_floor → 400; bad merchant_id → 400**
```powershell
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84","rule_set":{"condition_floor":"perfect"}}' | Out-File -Encoding ascii _bf.json
node post-webhook.mjs merchant/profile-update _bf.json
'{"merchant_id":"not-a-uuid","rule_set":{"condition_floor":"good"}}' | Out-File -Encoding ascii _bm.json
node post-webhook.mjs merchant/profile-update _bm.json
```
Expected: both → HTTP 400 (`bad_condition_floor`, `bad_merchant_id`).

- [ ] **Step 5: Restore demo-pass rules + commit**

Restore the permissive demo rule_set so later demos behave (run via a SQL file piped to psql, or re-post profile-update with the original permissive set: categories `["outdoor-jackets","denim","jackets","jeans","mens-tops","womens-tops","shirts","sweaters","dresses","pants","shoes","mens-boots","womens-boots"]`, empty allow/blocklist, floor `fair`).
```bash
git add ops/n8n/build-m-profile-update.mjs ops/n8n/workflows/WF-M7-merchant-profile-update.json
git commit -m "feat(portal): WF-M7 merchant/profile-update (rules edit + projection regen + audit)"
```

---

## Task 3: WF-M8 merchant/history (approved + rejected)

**Files:** Create `ops/n8n/build-m-history.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-history.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Merchant's decided submissions (approved/rejected only), filterable by status + q.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id, s.status,
       s.declared_brand, s.item_description, s.submitted_at, s.merchant_decided_at,
       dec.decision, dec.confidence, dec.estimated_resale_usd
FROM seller_submissions s
LEFT JOIN LATERAL (SELECT decision, confidence, estimated_resale_usd FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) dec ON true,
     inp
WHERE s.merchant_id = NULLIF(inp.d->>'merchant_id','')::uuid
  AND s.status IN ('merchant_approved','merchant_rejected')
  AND (NULLIF(inp.d->>'status','') IS NULL OR s.status = inp.d->>'status')
  AND (NULLIF(inp.d->>'q','') IS NULL
       OR left(s.id::text,8) ILIKE '%'||(inp.d->>'q')||'%'
       OR coalesce(s.declared_brand,'') ILIKE '%'||(inp.d->>'q')||'%'
       OR coalesce(s.item_description,'') ILIKE '%'||(inp.d->>'q')||'%')
ORDER BY s.merchant_decided_at DESC NULLS LAST
LIMIT (SELECT LEAST(coalesce(NULLIF(d->>'limit','')::int,500),5000) FROM inp);
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.submission_id);
return [{ json: { statusCode: 200, body: { ok:true, submissions: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/history"),
  pgNode("pg", "History", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M8 merchant-history", nodes, connections: linearConnections(["Webhook","History","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M8-merchant-history.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M8");
```
Note: the partial-index/LIMIT-as-subquery form avoids the "OFFSET/LIMIT must not contain variables" error seen on WF-A1/A8.

- [ ] **Step 2: Build + deploy + activate** (Task 1 Step 2 shape, `build-m-history.mjs` / `WF-M8-merchant-history.json`). Expected `active=true`.

- [ ] **Step 3: Seed at least one decided row, then test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
# ensure demo-pass has a decided submission (approve an existing one if needed)
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "SELECT count(*) FROM seller_submissions WHERE merchant_id='255e6d84-f2b8-4549-9754-514839841a84' AND status IN ('merchant_approved','merchant_rejected');"
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84"}' | Out-File -Encoding ascii _h.json
node post-webhook.mjs merchant/history _h.json
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84","status":"merchant_approved"}' | Out-File -Encoding ascii _h2.json
node post-webhook.mjs merchant/history _h2.json
```
Expected: 200 with `submissions[]`; only `merchant_approved`/`merchant_rejected` rows; the status filter narrows to approved. (If count is 0, approve one via WF-M4 admin/resolve or `merchant/decide` first.)

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-m-history.mjs ops/n8n/workflows/WF-M8-merchant-history.json
git commit -m "feat(portal): WF-M8 merchant/history (approved+rejected, filtered)"
```

---

## Task 4: Chip editor asset + nav links

**Files:** Create `portal/assets/chips.js`; Modify `functions/portal/index.js`, `functions/portal/analytics.js`

- [ ] **Step 1: Create `portal/assets/chips.js`** (vanilla; each `.chips[data-name]` syncs a hidden input)

```js
// portal/assets/chips.js — minimal tag/chip editor.
// Markup contract (rendered server-side):
//   <div class="chips" data-name="brand_allowlist">
//     <span class="chip">Patagonia<button type="button" aria-label="remove">×</button></span> ...
//     <input class="chip-entry" type="text" placeholder="type and press Enter">
//   </div>
//   <input type="hidden" name="brand_allowlist" value="Patagonia,Levi's">
// chips.js keeps the hidden input's comma-joined value in sync.
(function () {
  function valuesOf(box) {
    return [...box.querySelectorAll(".chip")].map((c) => c.firstChild.textContent.trim()).filter(Boolean);
  }
  function sync(box) {
    const hidden = document.querySelector('input[type=hidden][name="' + box.dataset.name + '"]');
    if (hidden) hidden.value = valuesOf(box).join(",");
  }
  function addChip(box, text) {
    text = (text || "").trim();
    if (!text) return;
    if (valuesOf(box).some((v) => v.toLowerCase() === text.toLowerCase())) return; // dedupe
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.appendChild(document.createTextNode(text));
    const x = document.createElement("button");
    x.type = "button"; x.setAttribute("aria-label", "remove"); x.textContent = "×";
    x.addEventListener("click", function () { chip.remove(); sync(box); });
    chip.appendChild(x);
    const entry = box.querySelector(".chip-entry");
    box.insertBefore(chip, entry);
    sync(box);
  }
  document.querySelectorAll(".chips").forEach(function (box) {
    // wire existing chips' × buttons
    box.querySelectorAll(".chip button").forEach(function (x) {
      x.addEventListener("click", function () { x.parentElement.remove(); sync(box); });
    });
    const entry = box.querySelector(".chip-entry");
    if (entry) {
      entry.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addChip(box, entry.value); entry.value = ""; }
      });
      entry.addEventListener("blur", function () { addChip(box, entry.value); entry.value = ""; });
    }
    sync(box);
  });
  // category quick-add buttons: <button class="quick" data-target="categories_accepted" data-val="denim">
  document.querySelectorAll("button.quick").forEach(function (b) {
    b.addEventListener("click", function () {
      const box = document.querySelector('.chips[data-name="' + b.dataset.target + '"]');
      if (box) addChip(box, b.dataset.val);
    });
  });
})();
```

- [ ] **Step 2: Add chip + form styles to `portal/assets/portal.css`** (append)

```css
.chips { display:flex; flex-wrap:wrap; gap:6px; border:1px solid var(--line,#e5e7eb); border-radius:8px; padding:6px; }
.chip { display:inline-flex; align-items:center; gap:4px; background:#efe9fb; color:#4a2a9c; border-radius:999px; padding:2px 8px; font-size:13px; }
.chip button { border:0; background:transparent; cursor:pointer; font-size:14px; line-height:1; color:#4a2a9c; }
.chip-entry { border:0; outline:none; flex:1; min-width:120px; font:inherit; padding:4px; }
.quick { border:1px solid var(--line,#e5e7eb); background:#fff; border-radius:999px; padding:2px 8px; font-size:12px; cursor:pointer; margin:2px 4px 2px 0; }
.field { margin:14px 0; } .field label { display:block; font-size:13px; color:var(--soft,#6b7280); margin-bottom:4px; }
```

- [ ] **Step 3: Add nav links to `functions/portal/index.js`**

Find this line (queue header, ~line 50):
```js
  const head = `<div class="top"><h1>${esc(session.slug)} — Queue (${subs.length})</h1>
    <span><a href="/portal/analytics">Analytics</a> · <a href="/portal/logout">Sign out</a></span></div>`;
```
Replace the `<span>` with:
```js
    <span><a href="/portal/history">History</a> · <a href="/portal/settings">Settings</a> · <a href="/portal/analytics">Analytics</a> · <a href="/portal/logout">Sign out</a></span></div>`;
```

- [ ] **Step 4: Add the same nav to `functions/portal/analytics.js`**

Find (~line 21):
```js
    `<div class="top"><h1>Analytics</h1><a href="/portal">← Queue</a></div>
```
Replace with:
```js
    `<div class="top"><h1>Analytics</h1><span><a href="/portal">← Queue</a> · <a href="/portal/history">History</a> · <a href="/portal/settings">Settings</a> · <a href="/portal/logout">Sign out</a></span></div>
```

- [ ] **Step 5: Parse-check + commit** (no server needed yet)
```powershell
cd "C:\AI\Business Owners\TagtoRack"; node --check functions/portal/index.js; node --check functions/portal/analytics.js
```
Expected: clean.
```bash
git add portal/assets/chips.js portal/assets/portal.css functions/portal/index.js functions/portal/analytics.js
git commit -m "feat(portal): chip editor asset + Settings/History nav links"
```

---

## Task 5: Settings page (GET form)

**Files:** Create `functions/portal/settings.js`

- [ ] **Step 1: Write `functions/portal/settings.js`**

```js
// functions/portal/settings.js — GET /portal/settings (merchant edits their acceptance rules)
import { requireSession, getCookie, csrfFor, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const page = (b) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — Settings</title><link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap">${b}<script src="/portal/assets/chips.js" defer></script></div></body></html>`;
const html = (b) => new Response(page(b), { headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": PORTAL_CSP } });

const KNOWN_CATEGORIES = ["denim","jackets","outdoor-jackets","womens-tops","mens-tops","shirts","sweaters","dresses","pants","jeans","shoes","mens-boots","womens-boots"];

const chips = (name, arr) => {
  const items = (arr || []).map(v => `<span class="chip">${esc(v)}<button type="button" aria-label="remove">×</button></span>`).join("");
  return `<div class="chips" data-name="${name}">${items}<input class="chip-entry" type="text" placeholder="type and press Enter"></div>` +
         `<input type="hidden" name="${name}" value="${esc((arr||[]).join(","))}">`;
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  let rs = {};
  try { const r = await postToN8n(env, "merchant/profile", { merchant_id: session.merchant_id }, 8000); rs = (r && r.rule_set) || {}; }
  catch (_) { return html(`<p><a href="/portal">← Queue</a></p><p class="muted">Couldn't load settings. Refresh to retry.</p>`); }

  const csrf = await csrfFor(env, getCookie(request, "tt_portal_session"));
  const cats = rs.categories_accepted || [];
  const floor = rs.condition_floor || "good";
  const msg = new URL(request.url).searchParams.get("m");
  const quickAdd = KNOWN_CATEGORIES.map(c => `<button type="button" class="quick" data-target="categories_accepted" data-val="${esc(c)}">+${esc(c)}</button>`).join(" ");
  const floorOpts = ["new_with_tags","excellent","good","fair"].map(f => `<option value="${f}"${f===floor?" selected":""}>${f}</option>`).join("");

  return html(
    `<div class="top"><h1>${esc(session.slug)} — Settings</h1>
       <span><a href="/portal">← Queue</a> · <a href="/portal/history">History</a> · <a href="/portal/logout">Sign out</a></span></div>
     ${msg ? `<div class="card"><b>${esc(msg)}</b></div>` : ""}
     <form class="card" method="POST" action="/portal/api/settings">
       <input type="hidden" name="csrf" value="${esc(csrf)}">
       <p class="muted">These rules tell the AI what your store accepts. Changes apply to new submissions immediately.</p>
       <div class="field"><label>Accepted categories</label>${chips("categories_accepted", cats)}
         <div style="margin-top:6px">${quickAdd}</div></div>
       <div class="field"><label>Brand allowlist (brands you want)</label>${chips("brand_allowlist", rs.brand_allowlist)}</div>
       <div class="field"><label>Brand blocklist (brands to auto-reject)</label>${chips("brand_blocklist", rs.brand_blocklist)}</div>
       <div class="field"><label>Banned keywords</label>${chips("banned_keywords", rs.banned_keywords)}</div>
       <div class="field"><label>Minimum condition</label><select name="condition_floor">${floorOpts}</select></div>
       <div class="field"><label>Price range (USD, optional)</label>
         <input type="number" name="price_floor_usd" placeholder="min" value="${esc(rs.price_floor_usd ?? "")}" style="width:120px">
         <input type="number" name="price_ceiling_usd" placeholder="max" value="${esc(rs.price_ceiling_usd ?? "")}" style="width:120px"></div>
       <div class="field"><label>Notes for the AI</label>
         <textarea name="merchant_notes" rows="3" style="width:100%">${esc(rs.merchant_notes || "")}</textarea></div>
       <p><button class="btn approve" type="submit">Save rules</button></p>
     </form>`);
}
```

- [ ] **Step 2: Start wrangler (if not running) + test the form pre-fills**

If no dev server is up: `npx wrangler pages dev . --port 8788 --compatibility-date 2025-05-01` (reads `.dev.vars`). New function files need an mtime touch to hot-reload: `(Get-Item functions/portal/settings.js).LastWriteTime = Get-Date`, wait ~3s.

Mint `$cookie` (see top of plan), then:
```powershell
$p = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/settings" -Headers @{ Cookie=$cookie }).Content
($p -match 'Accepted categories'); ($p -match 'class="chips"'); ($p -match 'name="csrf"'); ($p -match 'data-val="denim"')
# no session -> redirect
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/settings" -MaximumRedirection 0 -SkipHttpErrorCheck).StatusCode
```
Expected: first four `True`; last `302`.

- [ ] **Step 3: Commit**
```bash
git add functions/portal/settings.js
git commit -m "feat(portal): settings page (rule-editing chip form)"
```

---

## Task 6: Settings save endpoint (POST)

**Files:** Create `functions/portal/api/settings.js`

- [ ] **Step 1: Write `functions/portal/api/settings.js`**

```js
// functions/portal/api/settings.js — POST /portal/api/settings
import { requireSession, getCookie, csrfFor, postToN8n } from "../../_shared/portal-session.js";

const seeOther = (msg) => new Response(null, { status: 303, headers: { Location: "/portal/settings" + (msg ? "?m="+encodeURIComponent(msg) : ""), "Cache-Control":"no-store" } });
const forbid = (m) => new Response(m, { status: 403, headers: { "Cache-Control":"no-store", "Content-Type":"text/plain", "X-Content-Type-Options":"nosniff" } });

// "a, b ,b, c" -> ["a","b","c"] (trim, drop empties, case-insensitive dedupe)
const toList = (raw) => {
  const seen = new Set(), out = [];
  for (const part of String(raw || "").split(",")) {
    const v = part.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
};
const numOrUndef = (raw) => { const n = parseFloat(String(raw || "").trim()); return Number.isFinite(n) ? n : undefined; };

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return seeOther();
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return forbid("bad origin");
  const form = await request.formData();
  if (String(form.get("csrf")||"") !== (await csrfFor(env, getCookie(request, "tt_portal_session")))) return forbid("bad csrf");

  const floor = String(form.get("condition_floor") || "good");
  if (!["new_with_tags","excellent","good","fair"].includes(floor)) return seeOther("Invalid condition");

  const rule_set = {
    categories_accepted: toList(form.get("categories_accepted")),
    brand_allowlist: toList(form.get("brand_allowlist")),
    brand_blocklist: toList(form.get("brand_blocklist")),
    banned_keywords: toList(form.get("banned_keywords")),
    condition_floor: floor,
    merchant_notes: String(form.get("merchant_notes") || "").slice(0, 2000),
  };
  const pf = numOrUndef(form.get("price_floor_usd"));
  const pc = numOrUndef(form.get("price_ceiling_usd"));
  if (pf !== undefined) rule_set.price_floor_usd = pf;
  if (pc !== undefined) rule_set.price_ceiling_usd = pc;

  // merchant_id ALWAYS from the session — never the form.
  try {
    const r = await postToN8n(env, "merchant/profile-update",
      { merchant_id: session.merchant_id, rule_set, operator_email: session.email || session.slug }, 10000);
    if (!r || !r.ok) return seeOther((r && r.error) || "Save failed");
  } catch (_) { return seeOther("Save failed, try again"); }
  return seeOther("Saved");
}
```
Note: the session payload carries `slug` and `merchant_id` (see `signSession`); if `session.email` isn't present, this falls back to `session.slug` for the audit attribution — both uniquely identify the merchant. (If you want the real email in the audit, it's already on the merchants row; the audit captures slug regardless.)

- [ ] **Step 2: Test — round-trip a rule change through the UI path**

Mint `$cookie`; scrape the CSRF from the settings page; POST a change; verify DB + audit; confirm the page reflects it.
```powershell
$p = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/settings" -Headers @{ Cookie=$cookie }).Content
$csrf = ([regex]'name="csrf" value="([^"]+)"').Match($p).Groups[1].Value
$body = "csrf=$csrf&categories_accepted=denim,jackets&brand_allowlist=Patagonia&brand_blocklist=&banned_keywords=fast+fashion&condition_floor=good&price_floor_usd=25&price_ceiling_usd=&merchant_notes=portal+self-serve+edit"
$r = Invoke-WebRequest -UseBasicParsing -Method POST "http://localhost:8788/portal/api/settings" -Headers @{ Cookie=$cookie; "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body $body -MaximumRedirection 0 -SkipHttpErrorCheck
$r.StatusCode; ($r.Headers.Location -join "")
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT accepted_categories, brand_allowlist, condition_floor, rule_set->>'merchant_notes' FROM merchants WHERE slug='demo-pass';"
```
Expected: `303` → `/portal/settings?m=Saved`; DB shows `accepted_categories={denim,jackets}`, `brand_allowlist={Patagonia}`, floor `good`, notes updated.

- [ ] **Step 3: Negative — bad CSRF → 403; bad Origin → 403**
```powershell
(Invoke-WebRequest -UseBasicParsing -Method POST "http://localhost:8788/portal/api/settings" -Headers @{ Cookie=$cookie; "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body "csrf=wrong&condition_floor=good" -SkipHttpErrorCheck).StatusCode
(Invoke-WebRequest -UseBasicParsing -Method POST "http://localhost:8788/portal/api/settings" -Headers @{ Cookie=$cookie; "Content-Type"="application/x-www-form-urlencoded"; Origin="http://evil.test" } -Body "csrf=$csrf&condition_floor=good" -SkipHttpErrorCheck).StatusCode
```
Expected: both `403`.

- [ ] **Step 4: Restore demo-pass permissive rules + commit**

Re-save via the form (or psql) the permissive set so demos behave: categories = the 13 known, empty allow/blocklist, floor `fair`, notes "Permissive demo merchant for pipeline testing."
```bash
git add functions/portal/api/settings.js
git commit -m "feat(portal): settings save endpoint (session-scoped, CSRF+Origin)"
```

---

## Task 7: History page

**Files:** Create `functions/portal/history.js`

- [ ] **Step 1: Write `functions/portal/history.js`**

```js
// functions/portal/history.js — GET /portal/history?status=&q=
import { requireSession, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const page = (b) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — History</title><link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap">${b}</div></body></html>`;
const html = (b) => new Response(page(b), { headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": PORTAL_CSP } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";
  let subs = [];
  try { const r = await postToN8n(env, "merchant/history", { merchant_id: session.merchant_id, status, q }, 8000); subs = (r && r.submissions) || []; }
  catch (_) { return html(`<p><a href="/portal">← Queue</a></p><p class="muted">Couldn't load history. Refresh to retry.</p>`); }

  const opts = [["","All decisions"],["merchant_approved","Approved"],["merchant_rejected","Rejected"]]
    .map(([v,l]) => `<option value="${v}"${v===status?" selected":""}>${l}</option>`).join("");
  const expQs = new URLSearchParams({ ...(status?{status}:{}) , ...(q?{q}:{}) }).toString();
  const rows = subs.map(s => `<tr>
    <td><a href="/portal/submission/${esc(s.submission_id)}">${esc(s.short_id)}</a></td>
    <td>${s.status === "merchant_approved" ? "Approved" : "Rejected"}</td>
    <td><span class="badge ${esc(s.decision||"")}">${esc(s.decision||"—")}</span> <span class="muted">${esc(s.confidence ?? "")}</span></td>
    <td>${esc(s.declared_brand||"")} ${esc((s.item_description||"").slice(0,40))}</td>
    <td>${s.estimated_resale_usd != null ? "$"+esc(s.estimated_resale_usd) : "n/a"}</td>
    <td class="muted">${esc(String(s.merchant_decided_at||"").slice(0,10))}</td></tr>`).join("");
  return html(
    `<div class="top"><h1>${esc(session.slug)} — History</h1>
       <span><a href="/portal">← Queue</a> · <a href="/portal/settings">Settings</a> · <a href="/portal/logout">Sign out</a></span></div>
     <form class="filters card" method="GET">
       <div><label>Decision</label><select name="status">${opts}</select></div>
       <div><label>Search</label><input name="q" value="${esc(q)}" placeholder="short id / brand / item"></div>
       <div><button class="btn approve" type="submit">Filter</button></div>
       <div style="margin-left:auto"><a class="btn" href="/portal/api/export-csv${expQs?("?"+esc(expQs)):""}">Export CSV</a></div>
     </form>
     <div class="card"><p class="muted">${subs.length} decided</p>
       <table><thead><tr><th>ID</th><th>Decision</th><th>AI</th><th>Item</th><th>Est. resale</th><th>Date</th></tr></thead>
       <tbody>${rows || '<tr><td colspan=6 class=muted>No decided submissions yet.</td></tr>'}</tbody></table></div>`);
}
```

- [ ] **Step 2: Test** (mint `$cookie`; ensure ≥1 decided row exists for demo-pass)
```powershell
$h = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/history" -Headers @{ Cookie=$cookie }).Content
($h -match 'decided'); ($h -match 'Export CSV'); ($h -match 'Decision')
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/history" -MaximumRedirection 0 -SkipHttpErrorCheck).StatusCode  # 302 (no cookie)
```
Expected: first three `True`; no-cookie → `302`.

- [ ] **Step 3: Commit**
```bash
git add functions/portal/history.js
git commit -m "feat(portal): history page (decided submissions + filter/search)"
```

---

## Task 8: CSV export endpoint

**Files:** Create `functions/portal/api/export-csv.js`

- [ ] **Step 1: Write `functions/portal/api/export-csv.js`**

```js
// functions/portal/api/export-csv.js — GET /portal/api/export-csv?status=&q=
// Extensionless route (Pages serves *.csv paths as static assets before Functions).
import { requireSession, postToN8n } from "../../_shared/portal-session.js";

const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
const COLUMNS = [
  ["short_id","Short ID"],["submission_id","Submission ID"],["status","Status"],
  ["decision","AI Decision"],["confidence","Confidence"],["declared_brand","Brand"],
  ["item_description","Item"],["estimated_resale_usd","Est Resale USD"],
  ["submitted_at","Submitted At"],["merchant_decided_at","Decided At"],
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response("Forbidden", { status: 403, headers: { "Cache-Control":"no-store" } });
  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";

  let subs = [];
  try { const r = await postToN8n(env, "merchant/history", { merchant_id: session.merchant_id, status, q, limit: 10000 }, 15000); subs = (r && r.submissions) || []; }
  catch (_) { return new Response("export_failed", { status: 502, headers: { "Cache-Control":"no-store" } }); }

  const header = COLUMNS.map(c => cell(c[1])).join(",");
  const lines = subs.map(s => COLUMNS.map(c => cell(s[c[0]])).join(","));
  const csv = "﻿" + [header, ...lines].join("\r\n") + "\r\n";
  const today = new Date().toISOString().slice(0,10);
  const slug = (session.slug || "store").replace(/[^a-z0-9-]/gi, "");
  return new Response(csv, { status: 200, headers: {
    "Content-Type":"text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${slug}-submissions-${today}.csv"`,
    "Cache-Control":"no-store",
  }});
}
```

- [ ] **Step 2: Test** (mint `$cookie`)
```powershell
$r = Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/api/export-csv" -Headers @{ Cookie=$cookie }
$r.Headers["Content-Type"]; $r.Headers["Content-Disposition"]
($r.Content -split "`r`n")[0]   # header row
# filtered matches history filter
$a = Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/api/export-csv?status=merchant_approved" -Headers @{ Cookie=$cookie }
(($a.Content -split "`r`n") | Select-Object -Skip 1 | Where-Object {$_ -ne ""} | ForEach-Object { ($_ -split ",")[2] } | Sort-Object -Unique)
# no cookie -> 403
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/api/export-csv" -SkipHttpErrorCheck).StatusCode
```
Expected: `text/csv; charset=utf-8`; `attachment; filename="demo-pass-submissions-<date>.csv"`; header row = `Short ID,Submission ID,...`; filtered file's Status column only `merchant_approved`; no-cookie → `403`.

- [ ] **Step 3: Commit**
```bash
git add functions/portal/api/export-csv.js
git commit -m "feat(portal): merchant CSV export (session-scoped, filtered)"
```

---

## Task 9: End-to-end + adversarial + cross-merchant probe

**Files:** none (verification); then docs.

- [ ] **Step 1: Full self-serve flow** (mint `$cookie` for demo-pass)
  1. `/portal/settings` → change a rule (add a category via chip, Save) → `?m=Saved`; verify DB projection regen + a `merchant_rules_updated` audit row.
  2. `/portal/history` → decided items list; filter Approved; search a brand.
  3. Export CSV → downloads, filter honored.
  4. Confirm the nav links appear on `/portal` and `/portal/analytics`.

- [ ] **Step 2: Cross-merchant probe (security)** — confirm a session can only touch its OWN row.

The Pages layer never sends a foreign id, so probe the webhook directly to prove the SQL is keyed correctly: `merchant/profile` and `merchant/history` with `test-thrift`'s id (`66e66420-e873-49fa-8c1c-34dfb1ef8da9`) return ONLY test-thrift data, and with demo-pass's id return ONLY demo-pass data — never mixed. Also confirm there is no code path where `/portal/api/settings` reads a merchant_id from the form (grep: the only `merchant_id` source in `functions/portal/api/settings.js` and `history.js`/`export-csv.js` is `session.merchant_id`).
```powershell
cd "C:\AI\Business Owners\TagtoRack"
Select-String -Path functions/portal/api/settings.js, functions/portal/history.js, functions/portal/api/export-csv.js -Pattern "merchant_id" 
```
Expected: every match is `session.merchant_id` — no `form.get`/`searchParams` merchant_id anywhere.

- [ ] **Step 3: Confirm WF-M6/M7/M8 active**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node n8n-api.mjs GET /workflows 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.data||[]).filter(w=>/WF-M[678]/.test(w.name)).map(w=>w.name+'='+w.active).sort().join('\n'))})"
```
Expected: WF-M6/M7/M8 all `active=true`.

- [ ] **Step 4: Restore demo-pass permissive rules** (if any test left them changed) and stop wrangler; clean scratch `_*.json`.

- [ ] **Step 5: Update docs** — append a "Merchant Self-Serve — DONE" note to `~/.claude/plans/transient-soaring-key.md` (WF-M6/M7/M8 ids, the `/portal/{settings,history}` + `/portal/api/{settings,export-csv}` routes, the `merchant_rules_updated` audit event) and update the `tagtorack-architecture` memory.

- [ ] **Step 6: Final commit**
```bash
git add -A ops/n8n docs
git commit -m "docs(portal): record merchant self-serve completion + workflow ids"
```

---

## Self-review notes (spec coverage)

- **Edit own rules (chip form, rules-only)** → Task 4 (chips.js) + Task 5 (form) + Task 6 (save) + Task 2 (WF-M7 update). ✓
- **Projection regen on save** → Task 2 SQL (ARRAY/jsonb_array_elements_text). ✓
- **Audit log on rule edit** → Task 2 `aud` CTE (`merchant_rules_updated`). ✓
- **History (approved+rejected, filter/search)** → Task 3 (WF-M8) + Task 7 (page). ✓
- **CSV export (merchant-scoped, filtered, extensionless)** → Task 3 (reused) + Task 8. ✓
- **Nav links** → Task 4 Steps 3–4. ✓
- **Security: session-derived merchant_id only** → Tasks 5–8 all pass `session.merchant_id`; Task 9 Step 2 verifies. CSRF+Origin on POST (Task 6); CSP+no-store everywhere; requireSession on all. ✓
- **No schema change** → confirmed; only `audit_log` insert (existing table). ✓

## Out of scope (per spec)
Editing slug/status/contact/dropoff/Cal.com from the portal; history beyond approved/rejected; bulk actions; in-portal audit/diff viewer; subdomain.
