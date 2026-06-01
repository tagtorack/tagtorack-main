# Admin / Operator Dashboard v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An internal `/admin/*` dashboard (behind Cloudflare Access) for the operator to see/manage everything across all merchants: submissions explorer, operator queue (resolve borderline/failed/stuck), merchant management, AI calibration, and audit log.

**Architecture:** Server-rendered Cloudflare Pages Functions under `functions/admin/`; auth = Cloudflare Access at the edge **+** app-side CF Access JWT verification in `functions/_shared/admin-auth.js`; all data via new HMAC-signed `admin/*` n8n webhooks → Postgres (the app's existing invariant). Operator actions reuse the `merchant/decide` status/token/email core. **No new DB tables.**

**Tech Stack:** Cloudflare Pages Functions (Web Crypto: `crypto.subtle` RS256 verify, `crypto.subtle` HMAC), n8n 1.74.1 (`wf-lib.mjs` helpers; `this.helpers.httpRequest`; `require('crypto')`; node versions webhook:2/postgres:2.5/code:2/respondToWebhook:1.1), Postgres (`tagtorack_app`), Mailpit (dev) / Resend (prod).

**Verification model:** No unit-test harness in this repo — verification is live integration testing, identical to the merchant portal. Each task: build/deploy via `ops/n8n` REST scripts, exercise via `ops/n8n/post-webhook.mjs` + psql + Mailpit, and run Pages via `wrangler pages dev` with `ADMIN_DEV_BYPASS=true`. **Read `~/.claude/plans/transient-soaring-key.md` (BUILD PLAYBOOK) first** — n8n REST pattern, Code-node gotchas (`this.helpers.httpRequest` not `fetch`; no `$helpers`; `$env`/`require('crypto')` OK; strip dotenv ` #` comments; **build scripts write directly to `ops/n8n/workflows/<name>.json`**), and **PowerShell tool, not Bash** (MSYS mangles `/workflows` args).

**Branch:** `feature/admin-dashboard` (already checked out). Commit after each task.

**Key fixtures (seeded):** merchants `demo-pass` (id `255e6d84-f2b8-4549-9754-514839841a84`) and `test-thrift` (id `66e66420-e873-49fa-8c1c-34dfb1ef8da9`); submission `6864bbdf-84a4-4531-9634-872043f515bd`. Postgres: `docker exec -e PGPASSWORD=<ops/.env PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app`. n8n PG credential id `GZJQdHGNtdLI18IW`.

---

## File structure

**New — Pages shared + auth:**
- `functions/_shared/admin-auth.js` — `requireAdmin` (CF Access JWT verify + allowlist + dev bypass), `getCookie`, `csrfFor`, `ADMIN_CSP`, re-export `postToN8n`.

**New — n8n build scripts + workflows (reuse `ops/n8n/wf-lib.mjs`):**
- `ops/n8n/build-admin-submissions.mjs`  → `workflows/WF-A1-admin-submissions.json`
- `ops/n8n/build-admin-submission.mjs`   → `workflows/WF-A2-admin-submission.json`
- `ops/n8n/build-admin-queue.mjs`        → `workflows/WF-A3-admin-queue.json`
- `ops/n8n/build-admin-resolve.mjs`      → `workflows/WF-A4-admin-resolve.json`
- `ops/n8n/build-admin-merchants.mjs`    → `workflows/WF-A5-admin-merchants.json`
- `ops/n8n/build-admin-merchant-upsert.mjs` → `workflows/WF-A6-admin-merchant-upsert.json`
- `ops/n8n/build-admin-calibration.mjs`  → `workflows/WF-A7-admin-calibration.json`
- `ops/n8n/build-admin-audit.mjs`        → `workflows/WF-A8-admin-audit.json`

**New — Pages Functions + assets:**
- `functions/admin/index.js`, `submissions.js`, `submission/[id].js`, `queue.js`, `merchants.js`, `merchant/[slug].js`, `calibration.js`, `audit.js`
- `functions/admin/api/resolve.js`, `functions/admin/api/merchant-upsert.js`
- `admin/assets/admin.css`, `admin/assets/admin.js`

**Modified:**
- `_routes.json` — add `/admin/*` (include) + `/admin/assets/*` (exclude).
- `.dev.vars` — add `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ADMIN_EMAILS`, `ADMIN_DEV_BYPASS=true`.

---

## Task 1: Admin auth module + routing + env + styles

**Files:**
- Create: `functions/_shared/admin-auth.js`
- Modify: `_routes.json`
- Modify: `.dev.vars`
- Create: `admin/assets/admin.css`

- [ ] **Step 1: Write `functions/_shared/admin-auth.js`**

```js
// functions/_shared/admin-auth.js
// Cloudflare Access JWT verification (RS256 via Web Crypto) + operator allowlist,
// with a fenced local-dev bypass. CSRF + CSP helpers for the admin dashboard.
import { postToN8n } from "./n8n-fanout.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToString = (s) => dec.decode(b64urlToBytes(s));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Per-isolate JWKS cache (1h TTL).
let _jwks = { keys: [], at: 0 };
async function getJwks(teamDomain) {
  const now = Date.now();
  if (_jwks.keys.length && now - _jwks.at < 3600000) return _jwks.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("jwks_fetch_failed_" + res.status);
  const data = await res.json();
  _jwks = { keys: data.keys || [], at: now };
  return _jwks.keys;
}

async function verifyAccessJwt(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try { header = JSON.parse(b64urlToString(h)); payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!env.CF_ACCESS_AUD || !aud.includes(env.CF_ACCESS_AUD)) return null;
  let jwks;
  try { jwks = await getJwks(env.CF_ACCESS_TEAM_DOMAIN); } catch { return null; }
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), enc.encode(`${h}.${p}`));
  return ok ? payload : null;
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) { try { return decodeURIComponent(v.join("=")); } catch { return null; } }
  }
  return null;
}

// Returns { email } for an authorized operator, or null.
export async function requireAdmin(request, env) {
  if (env.ADMIN_DEV_BYPASS === "true") {
    const first = (env.ADMIN_EMAILS || "dev@local").split(",")[0].trim();
    return { email: first || "dev@local", dev: true };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || getCookie(request, "CF_Authorization");
  if (!token) return null;
  const payload = await verifyAccessJwt(token, env);
  if (!payload || !payload.email) return null;
  const allow = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length || !allow.includes(String(payload.email).toLowerCase())) return null;
  return { email: payload.email };
}

// CSRF token bound to the operator email (reuses PORTAL_SESSION_SECRET).
export async function csrfFor(env, email) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.PORTAL_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode("admin-csrf:" + email))).slice(0, 32);
}

export const ADMIN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self'; " +
  "form-action 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'";

export { postToN8n };
```

- [ ] **Step 2: Update `_routes.json`** (add admin include/exclude; keep all existing entries)

```json
{
  "version": 1,
  "include": ["/api/*", "/submit/*", "/portal/*", "/admin/*"],
  "exclude": [
    "/submit/portal",
    "/submit/portal.html",
    "/submit/privacy.html",
    "/submit/assets/*",
    "/portal/assets/*",
    "/admin/assets/*"
  ]
}
```

- [ ] **Step 3: Append admin dev vars to `.dev.vars`** (repo root, gitignored — do NOT commit)

```
CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
CF_ACCESS_AUD=replace-with-access-app-aud-tag
ADMIN_EMAILS=cmcelvain@pivothh.com
ADMIN_DEV_BYPASS=true
```
(Production: set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ADMIN_EMAILS` in the Cloudflare dashboard; leave `ADMIN_DEV_BYPASS` UNSET in prod.)

- [ ] **Step 4: Create `admin/assets/admin.css`**

```css
:root { --violet:#6a40c9; --ink:#15131f; --soft:#6b7280; --line:#e5e7eb; --bg:#f7f6fb; }
* { box-sizing:border-box; } body { font-family:system-ui,sans-serif; color:var(--ink); margin:0; background:var(--bg); }
.wrap { max-width:1100px; margin:0 auto; padding:20px; }
.top { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:16px; }
nav a { margin-right:14px; color:var(--violet); text-decoration:none; font-weight:600; }
.card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:14px; margin:12px 0; }
table { width:100%; border-collapse:collapse; font-size:14px; } th,td { text-align:left; padding:8px; border-bottom:1px solid var(--line); }
th { color:var(--soft); font-weight:600; } tr:hover td { background:#faf9fe; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
.badge.PASS{background:#e7f6ec;color:#1a7f37;} .badge.BORDERLINE{background:#fff4e5;color:#b25e00;} .badge.FAIL{background:#fde8e8;color:#b42318;}
.btn{border:0;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer;margin-right:6px;}
.btn.primary{background:var(--violet);color:#fff;} .btn.danger{background:#fff;color:#b42318;border:1px solid #f0c2bd;} .btn.ghost{background:#eee;color:#333;}
.thumb{width:84px;height:84px;object-fit:cover;border-radius:8px;background:#eee;}
.stat{display:inline-block;min-width:150px;margin:8px 16px 8px 0;} .stat b{display:block;font-size:24px;}
.muted{color:var(--soft);font-size:13px;} input,select,textarea{padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;}
label{display:block;margin:8px 0 4px;font-size:13px;color:var(--soft);} textarea{width:100%;min-height:160px;font-family:ui-monospace,monospace;}
.filters{display:flex;gap:10px;align-items:end;flex-wrap:wrap;}
```

- [ ] **Step 5: Verify the module parses**

Run (PowerShell): `cd "C:\AI\Business Owners\TagtoRack"; node --check functions/_shared/admin-auth.js`
Expected: exit 0, no output.

- [ ] **Step 6: Commit** (do NOT stage `.dev.vars` — it's gitignored)
```bash
git add functions/_shared/admin-auth.js _routes.json admin/assets/admin.css
git commit -m "feat(admin): CF Access auth module, routing, CSP, styles"
```

---

## Task 2: WF-A1 admin/submissions

**Files:** Create `ops/n8n/build-admin-submissions.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-submissions.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id, s.status, s.submitted_at,
       s.declared_brand, s.item_description,
       m.slug AS merchant_slug, m.display_name AS merchant_name,
       se.email AS seller_email,
       dec.decision, dec.confidence
FROM seller_submissions s
JOIN merchants m ON m.id = s.merchant_id
JOIN sellers se ON se.id = s.seller_id
LEFT JOIN LATERAL (SELECT decision, confidence FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) dec ON true,
     inp
WHERE (NULLIF(inp.d->>'status','') IS NULL OR s.status = inp.d->>'status')
  AND (NULLIF(inp.d->>'merchant_id','') IS NULL OR s.merchant_id = (inp.d->>'merchant_id')::uuid)
  AND (NULLIF(inp.d->>'q','') IS NULL
       OR left(s.id::text,8) ILIKE '%'||(inp.d->>'q')||'%'
       OR se.email ILIKE '%'||(inp.d->>'q')||'%'
       OR coalesce(s.declared_brand,'') ILIKE '%'||(inp.d->>'q')||'%')
ORDER BY s.submitted_at DESC
LIMIT LEAST(coalesce(NULLIF(inp.d->>'limit','')::int,50),200)
OFFSET coalesce(NULLIF(inp.d->>'offset','')::int,0);
`.trim();

const shape = `
const rows = $input.all().map(i => i.json).filter(r => r && r.submission_id);
return [{ json: { statusCode: 200, body: { ok: true, submissions: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/submissions"),
  pgNode("pg", "List", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A1 admin-submissions", nodes, connections: linearConnections(["Webhook","List","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A1-admin-submissions.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A1");
```

- [ ] **Step 2: Build + deploy + activate**

Run (PowerShell):
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node build-admin-submissions.mjs
$id = node n8n-api.mjs POST /workflows workflows/WF-A1-admin-submissions.json 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))"
node n8n-api.mjs POST /workflows/$id/activate 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('active='+JSON.parse(d).active))"
```
Expected: `active=true`.

- [ ] **Step 3: Test — unfiltered + filtered**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{}' | Out-File -Encoding ascii _a.json; node post-webhook.mjs admin/submissions _a.json
'{"status":"merchant_review"}' | Out-File -Encoding ascii _a2.json; node post-webhook.mjs admin/submissions _a2.json
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84"}' | Out-File -Encoding ascii _a3.json; node post-webhook.mjs admin/submissions _a3.json
```
Expected: HTTP 200; first returns a cross-merchant array (both demo-pass and test-thrift submissions); status filter narrows; merchant filter returns only demo-pass rows. Each row has `merchant_slug`, `seller_email`, `decision`.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-submissions.mjs ops/n8n/workflows/WF-A1-admin-submissions.json
git commit -m "feat(admin): WF-A1 admin/submissions (cross-merchant explorer)"
```

---

## Task 3: WF-A2 admin/submission (detail)

**Files:** Create `ops/n8n/build-admin-submission.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-submission.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sid AS (SELECT NULLIF(inp.d->>'submission_id','')::uuid AS id FROM inp)
SELECT
  to_jsonb(s.*) AS submission,
  jsonb_build_object('slug',m.slug,'display_name',m.display_name,'contact_email',m.contact_email,'calcom_event_url',m.calcom_event_url) AS merchant,
  jsonb_build_object('email',se.email,'name',se.name,'zip',se.zip) AS seller,
  (SELECT to_jsonb(d2.*) FROM submission_decisions d2 WHERE d2.submission_id=s.id ORDER BY created_at DESC LIMIT 1) AS decision,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb) FROM submission_photos p WHERE p.submission_id=s.id) AS photos,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('event_type',a.event_type,'decision',a.decision,'confidence',a.confidence,'payload',a.payload,'created_at',a.created_at) ORDER BY a.created_at DESC),'[]'::jsonb) FROM audit_log a WHERE a.submission_id=s.id) AS history
FROM seller_submissions s
JOIN merchants m ON m.id=s.merchant_id
JOIN sellers se ON se.id=s.seller_id
WHERE s.id=(SELECT id FROM sid);
`.trim();

const shape = `
${r2PresignSnippet()}
const rows = $input.all().map(i=>i.json).filter(r=>r && r.submission);
if (!rows.length) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const r = rows[0];
const photos = (r.photos||[]).map(p=>({ role:p.role, ord:p.ord, url: presignGet(p.r2_key, 86400) }));
return [{ json: { statusCode: 200, body: { ok:true, submission:r.submission, merchant:r.merchant, seller:r.seller, decision:r.decision, photos, history:r.history } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/submission"),
  pgNode("pg", "Load", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A2 admin-submission", nodes, connections: linearConnections(["Webhook","Load","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A2-admin-submission.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A2");
```

- [ ] **Step 2: Build + deploy + activate** (same command shape as Task 2 Step 2, with `build-admin-submission.mjs` / `WF-A2-admin-submission.json`). Expected `active=true`.

- [ ] **Step 3: Test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{"submission_id":"6864bbdf-84a4-4531-9634-872043f515bd"}' | Out-File -Encoding ascii _a.json
node post-webhook.mjs admin/submission _a.json
```
Expected: 200 with `submission`, `merchant`, `seller`, `decision`, `photos[].url` (presigned), `history` (audit rows). Then fetch `photos[0].url` → 200. Bad id → 404.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-submission.mjs ops/n8n/workflows/WF-A2-admin-submission.json
git commit -m "feat(admin): WF-A2 admin/submission (full detail + history + presigned photos)"
```

---

## Task 4: WF-A3 admin/queue

**Files:** Create `ops/n8n/build-admin-queue.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-queue.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

const sql = `
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id, s.status, s.submitted_at,
       s.declared_brand, s.item_description,
       m.slug AS merchant_slug, m.display_name AS merchant_name, se.email AS seller_email,
       dec.decision, dec.confidence, dec.borderline_reasons, dec.fail_reasons, dec.internal_note,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb) FROM submission_photos p WHERE p.submission_id=s.id) AS photos
FROM seller_submissions s
JOIN merchants m ON m.id=s.merchant_id
JOIN sellers se ON se.id=s.seller_id
LEFT JOIN LATERAL (SELECT * FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) dec ON true
WHERE s.status IN ('ai_borderline','ai_failed')
   OR (s.status='ai_reviewing' AND s.submitted_at < NOW() - INTERVAL '10 minutes')
ORDER BY s.submitted_at;
`.trim();

const shape = `
${r2PresignSnippet()}
const rows = $input.all().map(i=>i.json).filter(r=>r && r.submission_id);
const out = rows.map(r => ({ ...r, photos: (r.photos||[]).map(p=>({ role:p.role, ord:p.ord, url: presignGet(p.r2_key, 86400) })) }));
return [{ json: { statusCode: 200, body: { ok:true, queue: out } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/queue"),
  pgNode("pg", "Queue", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A3 admin-queue", nodes, connections: linearConnections(["Webhook","Queue","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A3-admin-queue.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A3");
```

- [ ] **Step 2: Build + deploy + activate** (Task 2 Step 2 shape). Expected `active=true`.

- [ ] **Step 3: Test** — first put a submission into a queue state, then query:
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "UPDATE seller_submissions SET status='ai_borderline' WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';"
'{}' | Out-File -Encoding ascii _a.json; node post-webhook.mjs admin/queue _a.json
```
Expected: 200, `queue` contains `6864bbdf` with `borderline_reasons` + `photos[].url`.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-queue.mjs ops/n8n/workflows/WF-A3-admin-queue.json
git commit -m "feat(admin): WF-A3 admin/queue (operator worklist)"
```

---

## Task 5: WF-A4 admin/resolve (operator actions)

**Files:** Create `ops/n8n/build-admin-resolve.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-resolve.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Prep: validate + mint approve/reject tokens when action=send_to_merchant.
const prep = `
const crypto = require('crypto');
const b = $json.body || {};
const sid = String(b.submission_id||'');
const action = String(b.action||'');
const operator = String(b.operator_email||'');
const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sid);
const valid = isUuid && ['send_to_merchant','approve','reject','requeue'].includes(action);
let tokens = [];
if (valid && action === 'send_to_merchant') {
  for (const a of ['approve','reject']) {
    const raw = crypto.randomBytes(32).toString('hex');
    tokens.push({ action: a, hash: crypto.createHash('sha256').update(raw).digest('hex'), raw });
  }
}
return [{ json: { payload: { submission_id: sid, action, operator_email: operator, valid, tokens: tokens.map(t=>({action:t.action,hash:t.hash})) }, rawTokens: tokens } }];
`.trim();

// One CTE handles all actions (operator is global: merchant_id derived from the row).
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sub AS (
  SELECT s.id, s.status, left(s.id::text,8) AS short_id, s.merchant_id,
         m.display_name AS merchant_name, m.contact_email AS merchant_email, m.calcom_event_url,
         se.email AS seller_email, se.name AS seller_name
  FROM seller_submissions s JOIN merchants m ON m.id=s.merchant_id JOIN sellers se ON se.id=s.seller_id
  WHERE s.id = NULLIF((SELECT d->>'submission_id' FROM inp),'')::uuid AND (SELECT (d->>'valid')::boolean FROM inp)
  LIMIT 1
),
upd AS (
  UPDATE seller_submissions SET
    status = CASE (SELECT d->>'action' FROM inp)
               WHEN 'approve' THEN 'merchant_approved'
               WHEN 'reject' THEN 'merchant_rejected'
               WHEN 'send_to_merchant' THEN 'merchant_review'
               WHEN 'requeue' THEN 'received' END,
    merchant_decided_at = CASE WHEN (SELECT d->>'action' FROM inp) IN ('approve','reject') THEN NOW() ELSE merchant_decided_at END,
    ai_reviewed_at = CASE WHEN (SELECT d->>'action' FROM inp)='requeue' THEN NULL ELSE ai_reviewed_at END
  WHERE id = (SELECT id FROM sub)
  RETURNING id, status
),
tok AS (
  INSERT INTO decision_tokens (token_hash, submission_id, merchant_id, action, expires_at)
  SELECT t->>'hash', (SELECT id FROM sub), (SELECT merchant_id FROM sub), t->>'action', NOW() + INTERVAL '7 days'
  FROM inp, jsonb_array_elements(coalesce((SELECT d->'tokens' FROM inp),'[]'::jsonb)) t
  WHERE (SELECT id FROM upd) IS NOT NULL AND (SELECT d->>'action' FROM inp)='send_to_merchant'
  RETURNING token_hash
),
aud AS (
  INSERT INTO audit_log (agent_run_id, event_type, payload, submission_id)
  SELECT gen_random_uuid(), 'operator_resolved',
         jsonb_build_object('operator', (SELECT d->>'operator_email' FROM inp), 'action', (SELECT d->>'action' FROM inp), 'new_status', (SELECT status FROM upd)),
         (SELECT id FROM sub)
  WHERE (SELECT id FROM upd) IS NOT NULL
  RETURNING id
)
SELECT (SELECT id FROM sub) IS NOT NULL AS found, (SELECT status FROM upd) AS new_status,
       (SELECT short_id FROM sub) AS short_id, (SELECT merchant_id::text FROM sub) AS merchant_id,
       (SELECT merchant_name FROM sub) AS merchant_name, (SELECT merchant_email FROM sub) AS merchant_email,
       (SELECT calcom_event_url FROM sub) AS calcom_event_url,
       (SELECT seller_email FROM sub) AS seller_email, (SELECT seller_name FROM sub) AS seller_name;
`.trim();

// Notify: emails + requeue trigger. fromAddr normalized (FROM_EMAIL may be display-name form).
const notify = `
const r = $json;
const action = String(($('Webhook').first().json.body||{}).action||'');
if (!r.found) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const enabled = String($env.TT_AUTOSEND_ENABLED||'').toLowerCase()==='true';
const transport = ($env.EMAIL_TRANSPORT||'mailpit').toLowerCase();
const from = $env.FROM_EMAIL || 'submissions@tagtorack.com';
const fromAddr = from.includes('<') ? (from.match(/<([^>]+)>/)||[,from])[1] : from;
const send = async (to, subject, html) => {
  if (!enabled) return;
  try {
    if (transport==='resend') await this.helpers.httpRequest({ method:'POST', url:'https://api.resend.com/emails', headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+$env.RESEND_API_KEY }, body:{ from:'Tag to Rack <'+fromAddr+'>', to:[to], subject, html }, json:true });
    else await this.helpers.httpRequest({ method:'POST', url:'http://mailpit:8025/api/v1/send', headers:{ 'Content-Type':'application/json' }, body:{ From:{ Email:fromAddr, Name:'Tag to Rack' }, To:[{ Email:to }], Subject:subject, HTML:html }, json:true });
  } catch(e) {}
};
const W = (t,b)=>'<div style="font-family:sans-serif;max-width:520px"><h2>'+t+'</h2>'+b+'</div>';
if (action==='approve') {
  const cal = r.calcom_event_url || ($env.CALCOM_BOOKING_URL||'');
  await send(r.seller_email, (r.merchant_name||'The store')+' approved your item ('+r.short_id+')', W('Good news, '+(r.seller_name||'there'),'<p>Approved. Book a drop-off:</p><p><a href="'+cal+'">Schedule drop-off</a></p>'));
} else if (action==='reject') {
  await send(r.seller_email, 'Update on your submission ('+r.short_id+')', W('Thanks for your submission','<p>This item isn\\'t a match right now. You\\'re welcome to submit other pieces anytime.</p>'));
} else if (action==='send_to_merchant') {
  const base=($env.SUBMIT_PUBLIC_BASE||'https://tagtorack.com').replace(/\\/$/,'');
  const toks=$('Prep').first().json.rawTokens||[];
  const ap=(toks.find(t=>t.action==='approve')||{}).raw, rj=(toks.find(t=>t.action==='reject')||{}).raw;
  await send(r.merchant_email, 'New submission to review ('+r.short_id+')', W('New item for '+(r.merchant_name||'your store'),'<p>An operator routed this for your review.</p><p><a href="'+base+'/submit/decision?t='+ap+'">Approve</a> | <a href="'+base+'/submit/decision?t='+rj+'">Reject</a></p>'));
} else if (action==='requeue') {
  try { await this.helpers.httpRequest({ method:'POST', url:'http://localhost:5678/webhook/submit/process', headers:{ 'Content-Type':'application/json' }, body:{ submission_id: $('Webhook').first().json.body.submission_id }, json:true }); } catch(e) {}
}
return [{ json: { statusCode: 200, body: { ok:true, status: r.new_status } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/resolve"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Resolve", sql, "={{ JSON.stringify($json.payload) }}", 220),
  codeNode("notify", "Notify", notify, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-A4 admin-resolve", nodes, connections: linearConnections(["Webhook","Prep","Resolve","Notify","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A4-admin-resolve.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A4");
```

- [ ] **Step 2: Build + deploy + activate** (Task 2 Step 2 shape). Expected `active=true`.

- [ ] **Step 3: Test each action** (re-arm the fixture between actions)
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
$PG="<PG_PASSWORD>"; $SID="6864bbdf-84a4-4531-9634-872043f515bd"
# send_to_merchant
docker exec -e PGPASSWORD=$PG tt_pg psql -U tagtorack -d tagtorack_app -c "UPDATE seller_submissions SET status='ai_borderline',merchant_decided_at=NULL WHERE id='$SID'; UPDATE decision_tokens SET used_at=NOW() WHERE submission_id='$SID';"
"{`"submission_id`":`"$SID`",`"action`":`"send_to_merchant`",`"operator_email`":`"cmcelvain@pivothh.com`"}" | Out-File -Encoding ascii _a.json
node post-webhook.mjs admin/resolve _a.json
docker exec -e PGPASSWORD=$PG tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT status FROM seller_submissions WHERE id='$SID'; SELECT count(*) FILTER (WHERE used_at IS NULL) AS live_tokens FROM decision_tokens WHERE submission_id='$SID'; SELECT event_type,payload->>'operator' FROM audit_log WHERE submission_id='$SID' ORDER BY created_at DESC LIMIT 1;"
```
Expected: 200 status `merchant_review`; DB status `merchant_review`; 2 live tokens; audit row `operator_resolved` with operator email + a merchant email in Mailpit with working links.

Repeat for `approve` (re-arm to ai_borderline first → 200 `merchant_approved` + seller Cal.com email), `reject` (→ `merchant_rejected` + seller email), and `requeue` (→ `received`, then WF-5 re-runs it). Bad submission_id → 404.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-resolve.mjs ops/n8n/workflows/WF-A4-admin-resolve.json
git commit -m "feat(admin): WF-A4 admin/resolve (operator actions, audited)"
```

---

## Task 6: WF-A5 admin/merchants

**Files:** Create `ops/n8n/build-admin-merchants.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-merchants.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT m.id::text AS merchant_id, m.slug, m.display_name, m.contact_email, m.dropoff_address,
       m.dropoff_hours, m.calcom_event_url, m.brand_color, m.public_intro, m.status, m.rule_set,
       (SELECT count(*) FROM seller_submissions s WHERE s.merchant_id=m.id) AS total_submissions,
       (SELECT count(*) FROM seller_submissions s WHERE s.merchant_id=m.id AND s.status='merchant_review') AS pending
FROM merchants m, inp
WHERE (NULLIF(inp.d->>'slug','') IS NULL OR m.slug = inp.d->>'slug')
ORDER BY m.display_name;
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.merchant_id);
return [{ json: { statusCode: 200, body: { ok:true, merchants: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/merchants"),
  pgNode("pg", "List", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A5 admin-merchants", nodes, connections: linearConnections(["Webhook","List","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A5-admin-merchants.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A5");
```

- [ ] **Step 2: Build + deploy + activate** (Task 2 Step 2 shape). Expected `active=true`.

- [ ] **Step 3: Test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{}' | Out-File -Encoding ascii _a.json; node post-webhook.mjs admin/merchants _a.json
'{"slug":"demo-pass"}' | Out-File -Encoding ascii _a2.json; node post-webhook.mjs admin/merchants _a2.json
```
Expected: 200; list includes demo-pass + test-thrift with counts; slug filter returns just demo-pass with its `rule_set`.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-merchants.mjs ops/n8n/workflows/WF-A5-admin-merchants.json
git commit -m "feat(admin): WF-A5 admin/merchants (list/get)"
```

---

## Task 7: WF-A6 admin/merchant-upsert

**Files:** Create `ops/n8n/build-admin-merchant-upsert.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-merchant-upsert.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Prep: validate slug + condition_floor + rule_set JSON.
const prep = `
const b = $json.body || {};
let rule_set = b.rule_set;
if (typeof rule_set === 'string') { try { rule_set = JSON.parse(rule_set); } catch { return [{ json: { payload:{ valid:false, error:'bad_rule_set_json' } } }]; } }
rule_set = rule_set || {};
const slug = String(b.slug||'').trim().toLowerCase();
const floor = String(rule_set.condition_floor||'good');
const okSlug = /^[a-z0-9-]{2,64}$/.test(slug);
const okFloor = ['new_with_tags','excellent','good','fair'].includes(floor);
const valid = okSlug && okFloor && b.display_name && b.contact_email && b.dropoff_address;
return [{ json: { payload: {
  valid, error: valid ? null : (!okSlug?'bad_slug':!okFloor?'bad_condition_floor':'missing_fields'),
  slug, display_name: b.display_name||'', contact_email: b.contact_email||'', dropoff_address: b.dropoff_address||'',
  dropoff_hours: b.dropoff_hours||'Tue\\u2013Sat, 11am\\u20136pm', calcom_event_url: b.calcom_event_url||null,
  brand_color: /^#[0-9A-Fa-f]{6}$/.test(String(b.brand_color||'')) ? b.brand_color : '#6a40c9',
  public_intro: b.public_intro||'', status: ['active','paused','archived'].includes(b.status)?b.status:'active',
  rule_set, operator_email: b.operator_email||''
} } }];
`.trim();

const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
v AS (SELECT (d->>'valid')::boolean AS valid, d FROM inp),
up AS (
  INSERT INTO merchants (slug, display_name, contact_email, dropoff_address, dropoff_hours, calcom_event_url,
    brand_color, public_intro, status, rule_set,
    accepted_categories, brand_allowlist, brand_blocklist, condition_floor, updated_at)
  SELECT d->>'slug', d->>'display_name', d->>'contact_email', d->>'dropoff_address', d->>'dropoff_hours',
    NULLIF(d->>'calcom_event_url',''), d->>'brand_color', d->>'public_intro', d->>'status', d->'rule_set',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(d->'rule_set'->'categories_accepted','[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(d->'rule_set'->'brand_allowlist','[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(d->'rule_set'->'brand_blocklist','[]'::jsonb))),
    coalesce(d->'rule_set'->>'condition_floor','good'), NOW()
  FROM v WHERE v.valid
  ON CONFLICT (slug) DO UPDATE SET
    display_name=EXCLUDED.display_name, contact_email=EXCLUDED.contact_email, dropoff_address=EXCLUDED.dropoff_address,
    dropoff_hours=EXCLUDED.dropoff_hours, calcom_event_url=EXCLUDED.calcom_event_url, brand_color=EXCLUDED.brand_color,
    public_intro=EXCLUDED.public_intro, status=EXCLUDED.status, rule_set=EXCLUDED.rule_set,
    accepted_categories=EXCLUDED.accepted_categories, brand_allowlist=EXCLUDED.brand_allowlist,
    brand_blocklist=EXCLUDED.brand_blocklist, condition_floor=EXCLUDED.condition_floor, updated_at=NOW()
  RETURNING id, slug
),
aud AS (
  INSERT INTO audit_log (agent_run_id, event_type, payload)
  SELECT gen_random_uuid(), 'operator_merchant_upsert', jsonb_build_object('operator',(SELECT d->>'operator_email' FROM inp),'slug',(SELECT slug FROM up))
  WHERE (SELECT id FROM up) IS NOT NULL RETURNING id
)
SELECT (SELECT (d->>'valid')::boolean FROM inp) AS valid, (SELECT d->>'error' FROM inp) AS error, (SELECT slug FROM up) AS slug;
`.trim();

const shape = `
const r=$json;
if (!r.valid) return [{ json: { statusCode: 400, body: { ok:false, error: r.error||'invalid' } } }];
return [{ json: { statusCode: 200, body: { ok:true, slug: r.slug } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/merchant-upsert"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Upsert", sql, "={{ JSON.stringify($json.payload) }}", 220),
  codeNode("shape", "Shape", shape, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-A6 admin-merchant-upsert", nodes, connections: linearConnections(["Webhook","Prep","Upsert","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A6-admin-merchant-upsert.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A6");
```

- [ ] **Step 2: Build + deploy + activate** (Task 2 Step 2 shape). Expected `active=true`.

- [ ] **Step 3: Test — create new + edit existing (projection regen)**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
$body='{"slug":"admintest","display_name":"Admin Test Co","contact_email":"a@example.com","dropoff_address":"1 Test St","rule_set":{"brand_allowlist":["Patagonia"],"categories_accepted":["denim","jackets"],"condition_floor":"good"},"operator_email":"cmcelvain@pivothh.com"}'
$body | Out-File -Encoding ascii _a.json; node post-webhook.mjs admin/merchant-upsert _a.json
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT slug, accepted_categories, brand_allowlist, condition_floor FROM merchants WHERE slug='admintest';"
```
Expected: 200 `{ok:true,slug:admintest}`; DB row shows `accepted_categories={denim,jackets}`, `brand_allowlist={Patagonia}`, `condition_floor=good` (projections regenerated from rule_set). Re-post with edited rule_set → projections update. Bad slug / bad condition_floor → 400.

- [ ] **Step 4: Cleanup test row + commit**
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "DELETE FROM merchants WHERE slug='admintest';"
```
```bash
git add ops/n8n/build-admin-merchant-upsert.mjs ops/n8n/workflows/WF-A6-admin-merchant-upsert.json
git commit -m "feat(admin): WF-A6 admin/merchant-upsert (rule_set edit + projection regen)"
```

---

## Task 8: WF-A7 admin/calibration

**Files:** Create `ops/n8n/build-admin-calibration.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-calibration.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
SELECT
  (SELECT jsonb_object_agg(decision, n) FROM (SELECT decision, count(*) n FROM submission_decisions GROUP BY decision) x) AS decision_counts,
  (SELECT coalesce(round(100.0*count(*) FILTER (WHERE s.status='merchant_approved')/NULLIF(count(*),0)),0)
     FROM seller_submissions s JOIN LATERAL (SELECT decision FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE d.decision='PASS' AND s.status IN ('merchant_approved','merchant_rejected')) AS ai_agreement_pct,
  (SELECT round(avg(confidence),2) FROM submission_decisions) AS avg_confidence,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('day',day,'model',model,'count',request_count) ORDER BY day DESC),'[]'::jsonb)
     FROM gemini_usage WHERE day > current_date - INTERVAL '14 days') AS token_usage,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('slug',slug,'received',received,'approved',approved) ORDER BY received DESC),'[]'::jsonb)
     FROM (SELECT m.slug,
                  count(s.*) AS received,
                  count(s.*) FILTER (WHERE s.status='merchant_approved') AS approved
           FROM merchants m LEFT JOIN seller_submissions s ON s.merchant_id=m.id GROUP BY m.slug) pm) AS per_merchant,
  (SELECT count(*) FROM seller_submissions WHERE submitted_at > NOW()-INTERVAL '7 days') AS received_week;
`.trim();

const shape = `return [{ json: { statusCode: 200, body: { ok:true, calibration: $json } } }];`;

const nodes = [
  webhookNode("w", "Webhook", "admin/calibration"),
  pgNode("pg", "Calc", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A7 admin-calibration", nodes, connections: linearConnections(["Webhook","Calc","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A7-admin-calibration.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A7");
```

- [ ] **Step 2: Build + deploy + activate** (Task 2 Step 2 shape). Expected `active=true`.

- [ ] **Step 3: Test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; '{}' | Out-File -Encoding ascii _a.json; node post-webhook.mjs admin/calibration _a.json
```
Expected: 200 with `calibration` containing `decision_counts`, `ai_agreement_pct`, `avg_confidence`, `token_usage[]`, `per_merchant[]`, `received_week`.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-calibration.mjs ops/n8n/workflows/WF-A7-admin-calibration.json
git commit -m "feat(admin): WF-A7 admin/calibration (AI analytics)"
```

---

## Task 9: WF-A8 admin/audit

**Files:** Create `ops/n8n/build-admin-audit.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-admin-audit.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT a.id::text AS id, a.event_type, a.decision, a.confidence, a.payload, a.created_at,
       a.submission_id::text AS submission_id
FROM audit_log a, inp
WHERE (NULLIF(inp.d->>'event_type','') IS NULL OR a.event_type = inp.d->>'event_type')
  AND (NULLIF(inp.d->>'submission_id','') IS NULL OR a.submission_id = (inp.d->>'submission_id')::uuid)
ORDER BY a.created_at DESC
LIMIT LEAST(coalesce(NULLIF(inp.d->>'limit','')::int,100),500)
OFFSET coalesce(NULLIF(inp.d->>'offset','')::int,0);
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.id);
return [{ json: { statusCode: 200, body: { ok:true, events: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/audit"),
  pgNode("pg", "Audit", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A8 admin-audit", nodes, connections: linearConnections(["Webhook","Audit","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A8-admin-audit.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A8");
```

- [ ] **Step 2: Build + deploy + activate** (Task 2 Step 2 shape). Expected `active=true`.

- [ ] **Step 3: Test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; '{}' | Out-File -Encoding ascii _a.json; node post-webhook.mjs admin/audit _a.json
'{"event_type":"operator_resolved"}' | Out-File -Encoding ascii _a2.json; node post-webhook.mjs admin/audit _a2.json
```
Expected: 200 with `events[]` (most recent first); event_type filter narrows to the operator actions from Task 5.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-admin-audit.mjs ops/n8n/workflows/WF-A8-admin-audit.json
git commit -m "feat(admin): WF-A8 admin/audit (event stream)"
```

---

## Task 10: Pages — admin home + shared render helpers

**Files:** Create `functions/admin/index.js`

- [ ] **Step 1: Write `functions/admin/index.js`**

```js
// functions/admin/index.js — GET /admin
import { requireAdmin, postToN8n, ADMIN_CSP } from "../_shared/admin-auth.js";

export const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
export const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>TtR Admin — ${esc(title)}</title><link rel="stylesheet" href="/admin/assets/admin.css"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap"><div class="top"><strong>Tag to Rack — Admin</strong>` +
  `<nav><a href="/admin">Home</a><a href="/admin/queue">Queue</a><a href="/admin/submissions">Submissions</a>` +
  `<a href="/admin/merchants">Merchants</a><a href="/admin/calibration">Calibration</a><a href="/admin/audit">Audit</a></nav></div>${body}</div></body></html>`;
export const html = (title, body, status = 200) =>
  new Response(page(title, body), { status, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": ADMIN_CSP } });
export const forbidden = () => new Response("Forbidden", { status: 403, headers: { "Cache-Control":"no-store" } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let q = {}, cal = {};
  try { q = (await postToN8n(env, "admin/queue", {}, 8000)) || {}; } catch (_) {}
  try { cal = (await postToN8n(env, "admin/calibration", {}, 8000)) || {}; } catch (_) {}
  const queueN = (q.queue || []).length;
  const c = cal.calibration || {};
  const stat = (l, v) => `<div class="stat"><b>${esc(v)}</b><span class="muted">${esc(l)}</span></div>`;
  return html("Home",
    `<p class="muted">Signed in as ${esc(admin.email)}${admin.dev ? " (dev bypass)" : ""}</p>
     <div class="card">${stat("Operator queue", queueN)}${stat("Received (7d)", c.received_week ?? 0)}${stat("AI agreement", (c.ai_agreement_pct ?? 0)+"%")}${stat("Avg confidence", c.avg_confidence ?? "n/a")}</div>
     <div class="card"><a class="btn primary" href="/admin/queue">Work the queue (${queueN})</a></div>`);
}
```

- [ ] **Step 2: Test** (start dev server once for Tasks 10–16):

In a terminal: `cd "C:\AI\Business Owners\TagtoRack"; wrangler pages dev . --port 8788 --compatibility-date 2025-05-01` (reads `.dev.vars` incl `ADMIN_DEV_BYPASS=true`). New function files may need an mtime touch to hot-reload: `(Get-Item functions/admin/index.js).LastWriteTime = Get-Date`.

```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin).StatusCode   # 200 (dev bypass)
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin).Content -match 'Operator queue'  # True
```
Expected: 200 with the home tiles + nav. (Without `ADMIN_DEV_BYPASS`, this would be 403 — verified in Task 16.)

- [ ] **Step 3: Commit**
```bash
git add functions/admin/index.js
git commit -m "feat(admin): home dashboard + shared render helpers"
```

---

## Task 11: Pages — submissions explorer + detail

**Files:** Create `functions/admin/submissions.js`, `functions/admin/submission/[id].js`

- [ ] **Step 1: Write `functions/admin/submissions.js`**

```js
// functions/admin/submissions.js — GET /admin/submissions?status=&merchant_id=&q=
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

const STATUSES = ["pending_uploads","received","ai_reviewing","merchant_review","ai_borderline","ai_failed","merchant_approved","merchant_rejected","dropoff_scheduled","completed","expired","withdrawn","deleted"];

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";
  let subs = [];
  try { const r = await postToN8n(env, "admin/submissions", { status, q, limit: 100 }, 8000); subs = (r && r.submissions) || []; } catch (_) {}
  const opts = ['<option value="">all statuses</option>'].concat(STATUSES.map(s => `<option value="${s}"${s===status?" selected":""}>${s}</option>`)).join("");
  const rows = subs.map(s => `<tr>
    <td><a href="/admin/submission/${esc(s.submission_id)}">${esc(s.short_id)}</a></td>
    <td><span class="badge ${esc(s.decision||"")}">${esc(s.decision||"—")}</span></td>
    <td>${esc(s.status)}</td><td>${esc(s.merchant_slug)}</td><td>${esc(s.seller_email)}</td>
    <td>${esc(s.declared_brand||"")} ${esc((s.item_description||"").slice(0,40))}</td></tr>`).join("");
  return html("Submissions",
    `<form class="filters card" method="GET">
       <div><label>Status</label><select name="status">${opts}</select></div>
       <div><label>Search</label><input name="q" value="${esc(q)}" placeholder="short id / email / brand"></div>
       <div><button class="btn primary" type="submit">Filter</button></div></form>
     <div class="card"><p class="muted">${subs.length} result(s)</p>
       <table><thead><tr><th>ID</th><th>AI</th><th>Status</th><th>Merchant</th><th>Seller</th><th>Item</th></tr></thead><tbody>${rows||'<tr><td colspan=6 class=muted>none</td></tr>'}</tbody></table></div>`);
}
```

- [ ] **Step 2: Write `functions/admin/submission/[id].js`**

```js
// functions/admin/submission/[id].js — GET /admin/submission/<id>
import { requireAdmin, postToN8n, csrfFor } from "../../_shared/admin-auth.js";
import { esc, html, forbidden } from "../index.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let data = null;
  try { data = await postToN8n(env, "admin/submission", { submission_id: params.id }, 8000); } catch (_) {}
  if (!data || !data.ok) return html("Submission", `<p><a href="/admin/submissions">← Submissions</a></p><div class="card"><p class="muted">Not found.</p></div>`, 404);
  const csrf = await csrfFor(env, admin.email);
  const s = data.submission || {}, d = data.decision || {};
  const photos = (data.photos||[]).map(p => `<img class="thumb" style="width:140px;height:180px" src="${esc(p.url)}" alt="${esc(p.role)}">`).join(" ");
  const reasons = [].concat(d.pass_reasons||[], d.borderline_reasons||[], d.fail_reasons||[]).map(x=>`<li>${esc(x)}</li>`).join("");
  const hist = (data.history||[]).map(h=>`<li class="muted">${esc(h.created_at)} — ${esc(h.event_type)} ${esc(h.decision||"")}</li>`).join("");
  const act = (a, label, cls) => `<form method="POST" action="/admin/api/resolve" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(params.id)}">
    <button class="btn ${cls}" name="action" value="${a}">${label}</button></form>`;
  return html("Submission "+esc(s.id?String(s.id).slice(0,8):""),
    `<p><a href="/admin/submissions">← Submissions</a></p>
     <div class="card"><span class="badge ${esc(d.decision||"")}">${esc(d.decision||"—")}</span> <span class="muted">conf ${esc(d.confidence??"n/a")}</span>
       <h2>${esc(s.declared_brand||"")} ${esc(s.item_description||"")}</h2>
       <p class="muted">${esc(s.status)} · ${esc((data.merchant||{}).display_name||"")} · seller ${esc((data.seller||{}).email||"")}</p>
       <div>${photos}</div>
       <h3>AI reasons</h3><ul>${reasons||"<li class=muted>none</li>"}</ul>
       <p class="muted">${esc(d.internal_note||"")}</p>
       <h3>Operator actions</h3>
       ${act("send_to_merchant","Send to merchant","primary")}${act("approve","Approve","primary")}${act("reject","Reject","danger")}${act("requeue","Re-run AI","ghost")}
       <h3>History</h3><ul>${hist||"<li class=muted>none</li>"}</ul></div>`);
}
```

- [ ] **Step 3: Test** (dev server; touch new files to hot-reload)
```powershell
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/admin/submissions").Content -match 'result'   # True
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/admin/submission/6864bbdf-84a4-4531-9634-872043f515bd").Content -match 'Operator actions'  # True
```
Expected: explorer table renders; detail shows photos + reasons + the 4 action buttons + history.

- [ ] **Step 4: Commit**
```bash
git add functions/admin/submissions.js functions/admin/submission/[id].js
git commit -m "feat(admin): submissions explorer + detail page"
```

---

## Task 12: Pages — queue + resolve endpoint

**Files:** Create `functions/admin/queue.js`, `functions/admin/api/resolve.js`, `admin/assets/admin.js`

- [ ] **Step 1: Write `functions/admin/queue.js`**

```js
// functions/admin/queue.js — GET /admin/queue
import { requireAdmin, postToN8n, csrfFor } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let items = [];
  try { const r = await postToN8n(env, "admin/queue", {}, 8000); items = (r && r.queue) || []; } catch (_) {}
  const csrf = await csrfFor(env, admin.email);
  const act = (id,a,label,cls) => `<form method="POST" action="/admin/api/resolve" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(id)}">
    <button class="btn ${cls}" name="action" value="${a}">${label}</button></form>`;
  const cards = items.map(s => {
    const thumb = (s.photos && s.photos[0] && s.photos[0].url) || "";
    const reasons = [].concat(s.borderline_reasons||[], s.fail_reasons||[]).map(x=>`<li>${esc(x)}</li>`).join("");
    return `<div class="card"><div style="display:flex;gap:14px">
      <img class="thumb" src="${esc(thumb)}" alt="">
      <div style="flex:1"><span class="badge ${esc(s.decision||"")}">${esc(s.decision||s.status)}</span> <span class="muted">${esc(s.status)} · ${esc(s.merchant_slug)} · conf ${esc(s.confidence??"n/a")}</span>
        <p><b>${esc(s.declared_brand||"")} ${esc(s.item_description||"")}</b></p>
        <ul class="muted">${reasons||"<li>—</li>"}</ul>
        ${act(s.submission_id,"send_to_merchant","Send to merchant","primary")}${act(s.submission_id,"approve","Approve","primary")}${act(s.submission_id,"reject","Reject","danger")}${act(s.submission_id,"requeue","Re-run AI","ghost")}
        <a class="muted" href="/admin/submission/${esc(s.submission_id)}" style="margin-left:8px">details</a></div></div></div>`;
  }).join("");
  return html("Queue", `<h2>Operator queue (${items.length})</h2>${cards||'<div class="card"><p class="muted">Nothing waiting.</p></div>'}`);
}
```

- [ ] **Step 2: Write `functions/admin/api/resolve.js`**

```js
// functions/admin/api/resolve.js — POST /admin/api/resolve
import { requireAdmin, csrfFor, postToN8n } from "../../_shared/admin-auth.js";

const seeOther = (msg) => new Response(null, { status: 303, headers: { Location: "/admin/queue" + (msg ? "?m="+encodeURIComponent(msg) : ""), "Cache-Control":"no-store" } });
const forbid = (m) => new Response(m, { status: 403, headers: { "Cache-Control":"no-store", "Content-Type":"text/plain" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbid("forbidden");
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return forbid("bad origin");
  const form = await request.formData();
  if (String(form.get("csrf")||"") !== (await csrfFor(env, admin.email))) return forbid("bad csrf");
  const submission_id = String(form.get("submission_id")||"");
  const action = String(form.get("action")||"");
  if (!/^[0-9a-fA-F-]{36}$/.test(submission_id) || !["send_to_merchant","approve","reject","requeue"].includes(action)) return seeOther("invalid");
  try { await postToN8n(env, "admin/resolve", { submission_id, action, operator_email: admin.email }, 10000); }
  catch (_) { return seeOther("action failed"); }
  return seeOther(action+" done");
}
```

- [ ] **Step 3: Write `admin/assets/admin.js`** (tiny — confirm destructive actions)

```js
// admin/assets/admin.js
document.querySelectorAll('button[name="action"]').forEach((b) => {
  b.addEventListener("click", (e) => {
    if ((b.value === "reject" || b.value === "approve") && !confirm("Confirm: " + b.value + "?")) e.preventDefault();
  });
});
```
(Reference it from `index.js` `page()` by adding `<script src="/admin/assets/admin.js" defer></script>` before `</body>` — update the `page()` helper accordingly.)

- [ ] **Step 4: Test** (dev server)
```powershell
$PG="<PG_PASSWORD>"; $SID="6864bbdf-84a4-4531-9634-872043f515bd"
docker exec -e PGPASSWORD=$PG tt_pg psql -U tagtorack -d tagtorack_app -c "UPDATE seller_submissions SET status='ai_borderline',merchant_decided_at=NULL WHERE id='$SID';"
$page=(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/queue).Content; ($page -match 'Operator queue')  # True
$csrf=([regex]'name="csrf" value="([^"]+)"').Match($page).Groups[1].Value
$r=Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:8788/admin/api/resolve -Headers @{ "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body "csrf=$csrf&submission_id=$SID&action=send_to_merchant" -MaximumRedirection 0 -SkipHttpErrorCheck
$r.StatusCode  # 303
docker exec -e PGPASSWORD=$PG tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT status FROM seller_submissions WHERE id='$SID';"  # merchant_review
# bad csrf -> 403
(Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:8788/admin/api/resolve -Headers @{ "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body "csrf=wrong&submission_id=$SID&action=approve" -SkipHttpErrorCheck).StatusCode  # 403
```
Expected: queue renders; resolve → 303 + DB status flips + audit row; bad CSRF → 403.

- [ ] **Step 5: Commit**
```bash
git add functions/admin/queue.js functions/admin/api/resolve.js admin/assets/admin.js functions/admin/index.js
git commit -m "feat(admin): operator queue + resolve endpoint (CSRF/Origin)"
```

---

## Task 13: Pages — merchants list + edit + upsert endpoint

**Files:** Create `functions/admin/merchants.js`, `functions/admin/merchant/[slug].js`, `functions/admin/api/merchant-upsert.js`

- [ ] **Step 1: Write `functions/admin/merchants.js`**

```js
// functions/admin/merchants.js — GET /admin/merchants
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let ms = [];
  try { const r = await postToN8n(env, "admin/merchants", {}, 8000); ms = (r && r.merchants) || []; } catch (_) {}
  const rows = ms.map(m => `<tr><td><a href="/admin/merchant/${esc(m.slug)}">${esc(m.slug)}</a></td>
    <td>${esc(m.display_name)}</td><td>${esc(m.contact_email)}</td><td>${esc(m.status)}</td>
    <td>${esc(m.pending)}</td><td>${esc(m.total_submissions)}</td></tr>`).join("");
  return html("Merchants",
    `<div class="card"><a class="btn primary" href="/admin/merchant/new">+ New merchant</a></div>
     <div class="card"><table><thead><tr><th>Slug</th><th>Name</th><th>Email</th><th>Status</th><th>Pending</th><th>Total</th></tr></thead>
       <tbody>${rows||'<tr><td colspan=6 class=muted>none</td></tr>'}</tbody></table></div>`);
}
```

- [ ] **Step 2: Write `functions/admin/merchant/[slug].js`**

```js
// functions/admin/merchant/[slug].js — GET /admin/merchant/<slug>  (or /new)
import { requireAdmin, postToN8n, csrfFor } from "../../_shared/admin-auth.js";
import { esc, html, forbidden } from "../index.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  const isNew = params.slug === "new";
  let m = { slug:"", display_name:"", contact_email:"", dropoff_address:"", dropoff_hours:"", calcom_event_url:"", brand_color:"#6a40c9", public_intro:"", status:"active", rule_set:{} };
  if (!isNew) {
    try { const r = await postToN8n(env, "admin/merchants", { slug: params.slug }, 8000); if (r && r.merchants && r.merchants[0]) m = r.merchants[0]; } catch (_) {}
  }
  const csrf = await csrfFor(env, admin.email);
  const f = (name,label,val) => `<label>${label}</label><input name="${name}" value="${esc(val)}" ${name==="slug"&&!isNew?"readonly":""}>`;
  return html(isNew?"New merchant":"Edit "+esc(m.slug),
    `<p><a href="/admin/merchants">← Merchants</a></p>
     <form class="card" method="POST" action="/admin/api/merchant-upsert">
       <input type="hidden" name="csrf" value="${esc(csrf)}">
       ${f("slug","Slug",m.slug)}${f("display_name","Display name",m.display_name)}${f("contact_email","Contact email",m.contact_email)}
       ${f("dropoff_address","Drop-off address",m.dropoff_address)}${f("dropoff_hours","Drop-off hours",m.dropoff_hours)}
       ${f("calcom_event_url","Cal.com URL",m.calcom_event_url||"")}${f("brand_color","Brand color",m.brand_color)}
       <label>Status</label><select name="status">${["active","paused","archived"].map(s=>`<option${s===m.status?" selected":""}>${s}</option>`).join("")}</select>
       <label>rule_set (JSON)</label><textarea name="rule_set">${esc(JSON.stringify(m.rule_set||{}, null, 2))}</textarea>
       <p><button class="btn primary" type="submit">Save</button></p></form>`);
}
```

- [ ] **Step 3: Write `functions/admin/api/merchant-upsert.js`**

```js
// functions/admin/api/merchant-upsert.js — POST /admin/api/merchant-upsert
import { requireAdmin, csrfFor, postToN8n } from "../../_shared/admin-auth.js";

const seeOther = (loc, msg) => new Response(null, { status: 303, headers: { Location: loc + (msg?"?m="+encodeURIComponent(msg):""), "Cache-Control":"no-store" } });
const forbid = (m) => new Response(m, { status: 403, headers: { "Cache-Control":"no-store", "Content-Type":"text/plain" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbid("forbidden");
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return forbid("bad origin");
  const form = await request.formData();
  if (String(form.get("csrf")||"") !== (await csrfFor(env, admin.email))) return forbid("bad csrf");
  const payload = {
    slug: String(form.get("slug")||""), display_name: String(form.get("display_name")||""),
    contact_email: String(form.get("contact_email")||""), dropoff_address: String(form.get("dropoff_address")||""),
    dropoff_hours: String(form.get("dropoff_hours")||""), calcom_event_url: String(form.get("calcom_event_url")||""),
    brand_color: String(form.get("brand_color")||""), status: String(form.get("status")||"active"),
    rule_set: String(form.get("rule_set")||"{}"), operator_email: admin.email,
  };
  let res;
  try { res = await postToN8n(env, "admin/merchant-upsert", payload, 10000); }
  catch (e) { return seeOther("/admin/merchant/"+(payload.slug||"new"), "save failed"); }
  if (!res || !res.ok) return seeOther("/admin/merchant/"+(payload.slug||"new"), (res&&res.error)||"invalid");
  return seeOther("/admin/merchants", "saved "+payload.slug);
}
```

- [ ] **Step 4: Test** (dev server)
```powershell
($m=(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/merchants).Content) -match 'New merchant'  # True
((Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/merchant/demo-pass).Content) -match 'rule_set'  # True
# upsert round-trip via the form's csrf:
$page=(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/merchant/demo-pass).Content
$csrf=([regex]'name="csrf" value="([^"]+)"').Match($page).Groups[1].Value
$body="csrf=$csrf&slug=demo-pass&display_name=Demo+Pass+Thrift&contact_email=store-demo@example.com&dropoff_address=123+Test+St&dropoff_hours=Tue-Sat&calcom_event_url=&brand_color=%236a40c9&status=active&rule_set=" + [uri]::EscapeDataString('{"brand_allowlist":[],"categories_accepted":["denim","jackets"],"condition_floor":"fair"}')
(Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:8788/admin/api/merchant-upsert -Headers @{ "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body $body -MaximumRedirection 0 -SkipHttpErrorCheck).StatusCode  # 303
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT accepted_categories FROM merchants WHERE slug='demo-pass';"  # {denim,jackets}
```
Expected: list + edit form render; save → 303 + projections regenerated.

- [ ] **Step 5: Commit**
```bash
git add functions/admin/merchants.js functions/admin/merchant/[slug].js functions/admin/api/merchant-upsert.js
git commit -m "feat(admin): merchant list + edit + upsert (projection regen)"
```

---

## Task 14: Pages — calibration view

**Files:** Create `functions/admin/calibration.js`

- [ ] **Step 1: Write `functions/admin/calibration.js`**

```js
// functions/admin/calibration.js — GET /admin/calibration
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let c = {};
  try { const r = await postToN8n(env, "admin/calibration", {}, 8000); c = (r && r.calibration) || {}; } catch (_) {}
  const dc = c.decision_counts || {};
  const stat = (l,v) => `<div class="stat"><b>${esc(v)}</b><span class="muted">${esc(l)}</span></div>`;
  const pm = (c.per_merchant||[]).map(x=>`<tr><td>${esc(x.slug)}</td><td>${esc(x.received)}</td><td>${esc(x.approved)}</td></tr>`).join("");
  const tu = (c.token_usage||[]).map(x=>`<tr><td>${esc(x.day)}</td><td>${esc(x.model)}</td><td>${esc(x.count)}</td></tr>`).join("");
  return html("Calibration",
    `<div class="card">${stat("AI agreement",(c.ai_agreement_pct??0)+"%")}${stat("Avg confidence",c.avg_confidence??"n/a")}${stat("Received (7d)",c.received_week??0)}
       ${stat("PASS",dc.PASS??0)}${stat("BORDERLINE",dc.BORDERLINE??0)}${stat("FAIL",dc.FAIL??0)}</div>
     <div class="card"><h3>Per merchant</h3><table><thead><tr><th>Merchant</th><th>Received</th><th>Approved</th></tr></thead><tbody>${pm||'<tr><td colspan=3 class=muted>none</td></tr>'}</tbody></table></div>
     <div class="card"><h3>Gemini usage (14d)</h3><table><thead><tr><th>Day</th><th>Model</th><th>Calls</th></tr></thead><tbody>${tu||'<tr><td colspan=3 class=muted>none</td></tr>'}</tbody></table></div>`);
}
```

- [ ] **Step 2: Test**
```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/calibration).Content -match 'AI agreement'  # True
```

- [ ] **Step 3: Commit**
```bash
git add functions/admin/calibration.js
git commit -m "feat(admin): AI calibration view"
```

---

## Task 15: Pages — audit log viewer

**Files:** Create `functions/admin/audit.js`

- [ ] **Step 1: Write `functions/admin/audit.js`**

```js
// functions/admin/audit.js — GET /admin/audit?event_type=
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  const u = new URL(request.url);
  const event_type = u.searchParams.get("event_type") || "";
  let events = [];
  try { const r = await postToN8n(env, "admin/audit", { event_type, limit: 200 }, 8000); events = (r && r.events) || []; } catch (_) {}
  const rows = events.map(e => `<tr><td class="muted">${esc(e.created_at)}</td><td>${esc(e.event_type)}</td>
    <td>${esc(e.decision||"")}</td><td>${esc(e.submission_id?String(e.submission_id).slice(0,8):"")}</td>
    <td class="muted">${esc(JSON.stringify(e.payload||{}).slice(0,120))}</td></tr>`).join("");
  return html("Audit",
    `<form class="filters card" method="GET"><div><label>Event type</label><input name="event_type" value="${esc(event_type)}" placeholder="operator_resolved / agent_output"></div><div><button class="btn primary">Filter</button></div></form>
     <div class="card"><table><thead><tr><th>When</th><th>Event</th><th>Decision</th><th>Sub</th><th>Payload</th></tr></thead><tbody>${rows||'<tr><td colspan=5 class=muted>none</td></tr>'}</tbody></table></div>`);
}
```

- [ ] **Step 2: Test**
```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/audit).Content -match 'Event'  # True
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/admin/audit?event_type=operator_resolved").Content -match 'operator_resolved'  # True (from Task 5/12 actions)
```

- [ ] **Step 3: Commit**
```bash
git add functions/admin/audit.js
git commit -m "feat(admin): audit log viewer"
```

---

## Task 16: End-to-end + adversarial verification + docs

**Files:** none (verification); then docs.

- [ ] **Step 1: Auth gating — without dev bypass → 403**

Temporarily run a second dev instance without the bypass, OR comment `ADMIN_DEV_BYPASS` in `.dev.vars` and restart wrangler:
```powershell
# with ADMIN_DEV_BYPASS unset/false and no CF Access header:
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin -SkipHttpErrorCheck).StatusCode            # 403
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/submissions -SkipHttpErrorCheck).StatusCode # 403
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/admin/calibration -SkipHttpErrorCheck).StatusCode # 403
```
Expected: all 403. Restore `ADMIN_DEV_BYPASS=true` afterward.

- [ ] **Step 2: Full operator flow (dev bypass on)** — re-arm `6864bbdf` to `ai_borderline`, open `/admin/queue`, click **Send to merchant** → verify DB `merchant_review` + 2 live tokens + a Mailpit merchant email + an `operator_resolved` audit row visible at `/admin/audit`.

- [ ] **Step 3: Adversarial** — bad CSRF on `/admin/api/resolve` and `/admin/api/merchant-upsert` → 403; cross-origin POST → 403; `admin/submission` with a random UUID → 404 page; `admin/merchant-upsert` with bad slug → stays on form with error.

- [ ] **Step 4: Confirm all 8 admin workflows active**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node n8n-api.mjs GET /workflows 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.data||[]).filter(w=>w.name.startsWith('WF-A')).map(w=>w.name+'='+w.active).sort().join('\n'))})"
```
Expected: WF-A1…WF-A8 all `active=true`.

- [ ] **Step 5: Update docs** — append an "Admin Dashboard — DONE" section to `~/.claude/plans/transient-soaring-key.md` (workflow IDs, `/admin/*` routes, CF Access env, the dev-bypass note) and update the `tagtorack-architecture` memory.

- [ ] **Step 6: Final commit**
```bash
git add -A ops/n8n docs
git commit -m "docs(admin): record admin dashboard completion + workflow IDs"
```

---

## Self-review notes (spec coverage)

- **Auth (CF Access + JWT verify + allowlist + dev bypass)** → Task 1 (`admin-auth.js`). ✓
- **Submissions explorer + detail** → Tasks 2,3 (webhooks) + 11 (pages). ✓
- **Operator queue + 4 actions (reuse decide core)** → Tasks 4,5 (webhooks) + 12 (pages). ✓
- **Merchant management + projection regen** → Tasks 6,7 (webhooks) + 13 (pages). ✓
- **AI calibration** → Task 8 + 14. ✓
- **Audit log** → Task 9 + 15. ✓
- **No new tables; operator actions audited to audit_log** → Tasks 5,7 SQL. ✓
- **Routing / `/admin/*` / assets / env** → Task 1. ✓
- **Security:** CF Access verify (T1), CSRF+Origin (T12,T13), CSP+no-store (T10 helpers used everywhere), input validation (T5,T7), operator-email audit (T5,T7). ✓
- **Testing incl dev-bypass, seeded data, adversarial 403s** → each task + Task 16. ✓

## Out of scope (per spec)
Offers/credit-ledger views (Phase F); the lead/email/SMS operator pipeline; multi-admin roles; real-time updates; bulk actions; `admin.tagtorack.com` subdomain.
