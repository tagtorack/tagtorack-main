# Merchant Portal v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a passwordless-login merchant portal at `/portal/*` where a store sees its pending-review queue (photos + AI decision/notes), approves/rejects submissions, and views an analytics summary.

**Architecture:** Server-rendered Cloudflare Pages Functions under `functions/portal/`; all data access via new HMAC-signed n8n `merchant/*` webhooks → Postgres (the app's existing invariant — Pages never touches Postgres directly). Session = a stateless HMAC-signed cookie. The `merchant/decide` webhook is the shared decision core that Phase D's WF-6 (email magic-link) will later reuse.

**Tech Stack:** Cloudflare Pages Functions (Web Crypto, `env.ASSETS`, KV `TT_SUBMIT_RL`), n8n 1.74.1 (webhook/postgres 2.5/code 2/respondToWebhook 1.1; `this.helpers.httpRequest`; `require('crypto')`), Postgres (`tagtorack_app`), Mailpit (dev) / Resend (prod).

**Verification model:** This repo has no unit-test harness; Phases B/C were verified by live integration tests against the running stack. Each task below is verified the same way: build/deploy via the `ops/n8n` REST scripts, exercise via `ops/n8n/post-webhook.mjs` + psql + the Mailpit API, and run Pages Functions via `wrangler pages dev`. Read `~/.claude/plans/transient-soaring-key.md` (BUILD PLAYBOOK) first — it has the n8n REST pattern, working node versions, and the Code-node sandbox gotchas (`this.helpers.httpRequest`, no `fetch`/`$helpers`; strip dotenv ` #` comments; pro→flash; PowerShell-not-Bash for API calls due to MSYS path mangling).

**Branch:** `feature/merchant-portal` (already checked out). Commit after each task.

**Key test fixtures (already in the dev DB from Phase C):** merchant `demo-pass` (contact_email `store-demo@example.com`, id `255e6d84-f2b8-4549-9754-514839841a84`) has submission `6864bbdf-84a4-4531-9634-872043f515bd` in `merchant_review` with real R2 photos and a `submission_decisions` row. Postgres creds: `docker exec -e PGPASSWORD=<ops/.env PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app`. n8n Postgres credential id: `GZJQdHGNtdLI18IW`.

---

## File structure

**New — database:**
- `ops/initdb/05-portal-schema.sql` — `merchant_login_tokens` table (fresh installs).

**New — n8n build tooling + workflows:**
- `ops/n8n/wf-lib.mjs` — shared helpers (`webhookNode`, `pgNode`, `codeNode`, `respondNode`, `r2PresignSnippet`) extracted from the WF-2..5 pattern. DRY.
- `ops/n8n/build-m-login-request.mjs` → `workflows/WF-M1-merchant-login-request.json`
- `ops/n8n/build-m-login-consume.mjs` → `workflows/WF-M2-merchant-login-consume.json`
- `ops/n8n/build-m-queue.mjs` → `workflows/WF-M3-merchant-queue.json`
- `ops/n8n/build-m-decide.mjs` → `workflows/WF-M4-merchant-decide.json`
- `ops/n8n/build-m-stats.mjs` → `workflows/WF-M5-merchant-stats.json`

**New — Pages Functions + assets:**
- `functions/_shared/portal-session.js` — cookie sign/verify, `requireSession`, CSRF token, `callN8n` wrapper (reuses `n8n-fanout.js`).
- `functions/portal/index.js` — GET: login page (no session) or queue (session).
- `functions/portal/api/login-request.js` — POST email → n8n.
- `functions/portal/auth.js` — GET `?t=` → consume → set cookie → redirect.
- `functions/portal/logout.js` — GET → clear cookie.
- `functions/portal/submission/[id].js` — GET detail page.
- `functions/portal/api/decide.js` — POST approve/reject (session + CSRF).
- `functions/portal/analytics.js` — GET stats page.
- `portal/assets/portal.css` — static stylesheet (served at `/portal/assets/portal.css`).

**Modified:**
- `_routes.json` — add `/portal/*` to `include`, `/portal/assets/*` to `exclude`.
- `.dev.vars` (repo root) — add `PORTAL_SESSION_SECRET` (local dev; prod value set in the Cloudflare dashboard).

---

## Task 1: Database — merchant_login_tokens

**Files:**
- Create: `ops/initdb/05-portal-schema.sql`

- [ ] **Step 1: Write the schema file**

Create `ops/initdb/05-portal-schema.sql`:

```sql
-- 05-portal-schema.sql — Merchant Portal (passwordless login tokens).
-- Additive to 03-submit-schema.sql. Each initdb file is its own psql session.
\connect tagtorack_app

CREATE TABLE IF NOT EXISTS merchant_login_tokens (
  token_hash   TEXT PRIMARY KEY,                 -- sha256(raw); raw token never stored
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

- [ ] **Step 2: Apply it to the running dev DB** (initdb only runs on a fresh volume)

Run (PowerShell):
```powershell
Get-Content "C:\AI\Business Owners\TagtoRack\ops\initdb\05-portal-schema.sql" -Raw | docker exec -i -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app
```
Expected: `CREATE TABLE` / `CREATE INDEX` (or `NOTICE ... already exists` on re-run — idempotent).

- [ ] **Step 3: Verify the table exists**

Run:
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "\d merchant_login_tokens"
```
Expected: table description listing `token_hash`, `merchant_id`, `expires_at`, `used_at`, `used_ip`, `created_at`.

- [ ] **Step 4: Commit**
```bash
git add ops/initdb/05-portal-schema.sql
git commit -m "feat(portal): add merchant_login_tokens schema"
```

---

## Task 2: n8n build helper library (wf-lib.mjs)

Extract the repeated build/deploy scaffolding (proven in `build-wf5.mjs`) into one module so the five `merchant/*` build scripts stay DRY.

**Files:**
- Create: `ops/n8n/wf-lib.mjs`

- [ ] **Step 1: Write wf-lib.mjs**

```js
// ops/n8n/wf-lib.mjs — shared n8n workflow-builder helpers (n8n 1.74.1).
export const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

export const webhookNode = (id, name, path, x = -200) => ({
  parameters: { httpMethod: "POST", path, responseMode: "responseNode", options: {} },
  id, name, type: "n8n-nodes-base.webhook", typeVersion: 2, position: [x, 0], webhookId: path.replace(/\//g, "-") + "-wh",
});
export const codeNode = (id, name, jsCode, x) => ({
  parameters: { jsCode }, id, name, type: "n8n-nodes-base.code", typeVersion: 2, position: [x, 0],
});
export const pgNode = (id, name, query, queryReplacement, x) => ({
  parameters: { operation: "executeQuery", query, options: { queryReplacement } },
  id, name, type: "n8n-nodes-base.postgres", typeVersion: 2.5, position: [x, 0],
  credentials: { postgres: PG_CRED }, alwaysOutputData: true,
});
export const respondNode = (id, name, x) => ({
  parameters: { respondWith: "json", responseBody: "={{ $json.body }}", options: { responseCode: "={{ $json.statusCode }}" } },
  id, name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [x, 0],
});
// Linear connections from an ordered node-name list.
export const linearConnections = (names) => {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: "main", index: 0 }]] };
  return c;
};
// R2 SigV4 GET presign — Code-node snippet (require('crypto')); reused by queue.
// Returns a JS source string defining `presignGet(r2key, expiresSec)`.
export const r2PresignSnippet = () => `
function presignGet(r2key, expiresSec) {
  const crypto = require('crypto');
  const acct=$env.R2_ACCOUNT_ID, ak=$env.R2_ACCESS_KEY_ID, sk=$env.R2_SECRET_ACCESS_KEY, bucket=$env.R2_BUCKET;
  const host = acct + '.r2.cloudflarestorage.com';
  const amzDate = new Date().toISOString().replace(/[-:]|\\.\\d{3}/g,'');
  const day = amzDate.slice(0,8);
  const scope = day + '/auto/s3/aws4_request';
  const enc = (s)=>encodeURIComponent(s).replace(/[!'()*]/g,(c)=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  const sha = (s)=>crypto.createHash('sha256').update(s).digest('hex');
  const hmac = (k,m)=>crypto.createHmac('sha256',k).update(m).digest();
  const uri = '/'+enc(bucket)+'/'+r2key.split('/').map(enc).join('/');
  const q = { 'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':ak+'/'+scope,'X-Amz-Date':amzDate,'X-Amz-Expires':String(expiresSec),'X-Amz-SignedHeaders':'host' };
  const qs = Object.keys(q).sort().map(k=>enc(k)+'='+enc(q[k])).join('&');
  const creq = ['GET',uri,qs,'host:'+host+'\\n','host','UNSIGNED-PAYLOAD'].join('\\n');
  const sts = ['AWS4-HMAC-SHA256',amzDate,scope,sha(creq)].join('\\n');
  let k=hmac('AWS4'+sk,day); k=hmac(k,'auto'); k=hmac(k,'s3'); k=hmac(k,'aws4_request');
  return 'https://'+host+uri+'?'+qs+'&X-Amz-Signature='+hmac(k,sts).toString('hex');
}`;
```

- [ ] **Step 2: Sanity-check it imports**

Run:
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node -e "import('./wf-lib.mjs').then(m=>console.log(Object.keys(m).join(',')))"
```
Expected: `PG_CRED,webhookNode,codeNode,pgNode,respondNode,linearConnections,r2PresignSnippet`

- [ ] **Step 3: Commit**
```bash
git add ops/n8n/wf-lib.mjs
git commit -m "feat(portal): n8n build-helper library (DRY scaffolding)"
```

---

## Task 3: WF-M1 merchant/login-request

Mints a single-use login token and emails the magic link. Always returns `{ok:true}` (anti-enumeration).

**Files:**
- Create: `ops/n8n/build-m-login-request.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-login-request.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Prep: normalize email, generate raw token + sha256 hash (n8n owns hashing).
const prep = `
const crypto = require('crypto');
const email = String(($json.body && $json.body.email) || '').trim().toLowerCase();
const raw = crypto.randomBytes(32).toString('hex');
const token_hash = crypto.createHash('sha256').update(raw).digest('hex');
return [{ json: { email, raw, token_hash } }];
`.trim();

// PG: look up active merchant by contact_email; mint token only if found.
// Always returns exactly one row.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
m AS (SELECT id, contact_email, display_name FROM merchants
      WHERE contact_email = (SELECT d->>'email' FROM inp) AND status='active' LIMIT 1),
ins AS (
  INSERT INTO merchant_login_tokens (token_hash, merchant_id, expires_at)
  SELECT (SELECT d->>'token_hash' FROM inp), m.id, NOW() + INTERVAL '15 minutes' FROM m
  RETURNING merchant_id
)
SELECT (SELECT count(*) FROM m) > 0 AS found,
       (SELECT contact_email FROM m) AS email,
       (SELECT display_name FROM m) AS display_name;
`.trim();

// Send: if found, email the magic link. Always respond {ok:true}.
const send = `
const pg = $json;                       // { found, email, display_name }
const raw = $('Prep').first().json.raw;
const base = ($env.SUBMIT_PUBLIC_BASE || 'https://tagtorack.com').replace(/\\/$/, '');
const link = base + '/portal/auth?t=' + raw;
const enabled = String($env.TT_AUTOSEND_ENABLED || '').toLowerCase() === 'true';
if (pg.found && enabled) {
  const transport = ($env.EMAIL_TRANSPORT || 'mailpit').toLowerCase();
  const from = $env.FROM_EMAIL || 'submissions@tagtorack.com';
  const subject = 'Your Tag to Rack portal sign-in link';
  const html = '<div style="font-family:sans-serif;max-width:520px"><h2>Sign in to Tag to Rack</h2>' +
    '<p>Click to sign in to your store portal. This link expires in 15 minutes and can be used once.</p>' +
    '<p><a href="' + link + '">Sign in to ' + (pg.display_name || 'your portal') + '</a></p>' +
    '<p style="color:#888;font-size:12px">If you did not request this, ignore this email.</p></div>';
  try {
    if (transport === 'resend') {
      await this.helpers.httpRequest({ method:'POST', url:'https://api.resend.com/emails',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + $env.RESEND_API_KEY },
        body:{ from: 'Tag to Rack <' + from + '>', to:[pg.email], subject, html }, json:true });
    } else {
      await this.helpers.httpRequest({ method:'POST', url:'http://mailpit:8025/api/v1/send',
        headers:{ 'Content-Type':'application/json' },
        body:{ From:{ Email: from, Name:'Tag to Rack' }, To:[{ Email: pg.email }], Subject: subject, HTML: html }, json:true });
    }
  } catch (e) { /* swallow — never reveal send status to the caller */ }
}
return [{ json: { statusCode: 200, body: { ok: true } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/login-request"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Mint token", sql, "={{ JSON.stringify({ email: $json.email, token_hash: $json.token_hash }) }}", 220),
  codeNode("send", "Send", send, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-M1 merchant-login-request", nodes,
  connections: linearConnections(["Webhook","Prep","Mint token","Send","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M1-merchant-login-request.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M1");
```

- [ ] **Step 2: Build + deploy + activate**

Run:
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node build-m-login-request.mjs
$id = node n8n-api.mjs POST /workflows workflows/WF-M1-merchant-login-request.json 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))"
node n8n-api.mjs POST /workflows/$id/activate 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('active='+JSON.parse(d).active))"
Write-Output "WF-M1 id=$id"
```
Expected: `active=true`. Record the id.

- [ ] **Step 3: Test — known merchant mints + emails a token**

Run:
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{"email":"store-demo@example.com"}' | Out-File -Encoding ascii _m_login.json
node post-webhook.mjs merchant/login-request _m_login.json
```
Expected: `HTTP 200` / `{"ok":true}`.

Verify token row + email:
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT left(token_hash,12), merchant_id, expires_at>NOW() AS valid, used_at IS NULL AS unused FROM merchant_login_tokens ORDER BY created_at DESC LIMIT 1;"
(Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/messages").Content | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const m=(j.messages||[]).find(x=>x.Subject.includes('sign-in'));console.log(m?'login email -> '+JSON.stringify(m.To.map(t=>t.Address)):'NO login email')})"
```
Expected: one valid/unused token for the demo-pass merchant_id; a `sign-in` email to `store-demo@example.com`.

- [ ] **Step 4: Test — unknown email returns ok:true and mints nothing**

Run:
```powershell
'{"email":"nobody@nowhere.test"}' | Out-File -Encoding ascii _m_login_x.json
node post-webhook.mjs merchant/login-request _m_login_x.json
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "SELECT count(*) FROM merchant_login_tokens WHERE created_at > NOW()-INTERVAL '1 minute';"
```
Expected: `HTTP 200 {"ok":true}`, and the count does **not** increase beyond the Step-3 token (anti-enumeration: no new row).

- [ ] **Step 5: Commit**
```bash
git add ops/n8n/build-m-login-request.mjs ops/n8n/workflows/WF-M1-merchant-login-request.json
git commit -m "feat(portal): WF-M1 merchant/login-request (mint + email magic link)"
```

---

## Task 4: WF-M2 merchant/login-consume

Validates a raw login token (single-use, unexpired) and returns the merchant identity.

**Files:**
- Create: `ops/n8n/build-m-login-consume.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-login-consume.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections } from "./wf-lib.mjs";

const prep = `
const crypto = require('crypto');
const raw = String(($json.body && $json.body.token) || '');
const ip = String(($json.body && $json.body.ip) || '');
const token_hash = raw ? crypto.createHash('sha256').update(raw).digest('hex') : '';
return [{ json: { token_hash, ip } }];
`.trim();

// Consume: mark used only if currently unused & unexpired. Always one row.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
t AS (
  UPDATE merchant_login_tokens SET used_at = NOW(), used_ip = NULLIF((SELECT d->>'ip' FROM inp),'')::inet
  WHERE token_hash = (SELECT d->>'token_hash' FROM inp) AND used_at IS NULL AND expires_at > NOW()
  RETURNING merchant_id
)
SELECT (SELECT count(*) FROM t) > 0 AS ok,
       m.id::text AS merchant_id, m.slug, m.display_name
FROM (SELECT 1) x
LEFT JOIN merchants m ON m.id = (SELECT merchant_id FROM t);
`.trim();

const shape = `
const r = $json;
if (!r.ok || !r.merchant_id) return [{ json: { statusCode: 401, body: { ok:false, error:'invalid_token' } } }];
return [{ json: { statusCode: 200, body: { ok:true, merchant_id: r.merchant_id, slug: r.slug, display_name: r.display_name } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/login-consume"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Consume token", sql, "={{ JSON.stringify({ token_hash: $json.token_hash, ip: $json.ip }) }}", 220),
  codeNode("shape", "Shape", shape, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-M2 merchant-login-consume", nodes,
  connections: linearConnections(["Webhook","Prep","Consume token","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M2-merchant-login-consume.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M2");
```

- [ ] **Step 2: Build + deploy + activate** (same commands as Task 3 Step 2, substituting `build-m-login-consume.mjs` and `workflows/WF-M2-merchant-login-consume.json`).

Expected: `active=true`.

- [ ] **Step 3: Test — mint a fresh token, then consume it twice**

Run:
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
# mint a fresh token and read the raw value straight from the DB is NOT possible (only hash stored),
# so mint, then grab the raw link from the Mailpit email:
'{"email":"store-demo@example.com"}' | Out-File -Encoding ascii _m_login.json
node post-webhook.mjs merchant/login-request _m_login.json | Out-Null
$raw = ((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/messages").Content | ConvertFrom-Json).messages | Where-Object {$_.Subject -like '*sign-in*'} | Select-Object -First 1 | ForEach-Object { $mid=$_.ID; (((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/message/$mid").Content | ConvertFrom-Json).HTML -replace '(?s).*portal/auth\?t=([0-9a-f]+).*','$1') }
"{`"token`":`"$raw`",`"ip`":`"1.2.3.4`"}" | Out-File -Encoding ascii _m_consume.json
Write-Output "=== first consume (expect 200 + merchant_id) ==="; node post-webhook.mjs merchant/login-consume _m_consume.json
Write-Output "=== second consume (expect 401 invalid_token) ==="; node post-webhook.mjs merchant/login-consume _m_consume.json
```
Expected: first → `200` with `merchant_id` = `255e6d84-…`, slug `demo-pass`; second → `401 {"ok":false,"error":"invalid_token"}`.

- [ ] **Step 4: Test — garbage token → 401**
```powershell
'{"token":"deadbeef","ip":""}' | Out-File -Encoding ascii _m_consume_x.json
node post-webhook.mjs merchant/login-consume _m_consume_x.json
```
Expected: `401 {"ok":false,"error":"invalid_token"}`.

- [ ] **Step 5: Commit**
```bash
git add ops/n8n/build-m-login-consume.mjs ops/n8n/workflows/WF-M2-merchant-login-consume.json
git commit -m "feat(portal): WF-M2 merchant/login-consume (single-use token validation)"
```

---

## Task 5: WF-M3 merchant/queue

Returns the merchant's `merchant_review` submissions, each with its latest AI decision and presigned 24h photo URLs.

**Files:**
- Create: `ops/n8n/build-m-queue.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-queue.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

// One row per pending submission, with latest decision + photo r2_keys.
const sql = `
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id,
  s.item_description, s.declared_brand, s.declared_category, s.declared_size,
  s.declared_condition, s.asking_price_usd, s.submitted_at,
  d.decision, d.confidence, d.brand_detected, d.estimated_retail_usd, d.estimated_resale_usd,
  d.pass_reasons, d.borderline_reasons, d.fail_reasons, d.internal_note,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb)
   FROM submission_photos p WHERE p.submission_id = s.id) AS photos
FROM seller_submissions s
LEFT JOIN LATERAL (
  SELECT * FROM submission_decisions sd WHERE sd.submission_id = s.id ORDER BY created_at DESC LIMIT 1
) d ON true
WHERE s.merchant_id = NULLIF($1::jsonb->>'merchant_id','')::uuid AND s.status = 'merchant_review'
ORDER BY s.submitted_at;
`.trim();

// Presign each photo (24h GET) and assemble the response array.
const presign = `
${r2PresignSnippet()}
const rows = $input.all().map(i => i.json).filter(r => r && r.submission_id);
const out = rows.map(r => ({
  ...r,
  photos: (r.photos || []).map(p => ({ role: p.role, ord: p.ord, url: presignGet(p.r2_key, 86400) })),
}));
return [{ json: { statusCode: 200, body: { ok: true, submissions: out } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/queue"),
  pgNode("pg", "Load queue", sql, "={{ JSON.stringify({ merchant_id: $json.body.merchant_id }) }}", 0),
  codeNode("presign", "Presign", presign, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M3 merchant-queue", nodes,
  connections: linearConnections(["Webhook","Load queue","Presign","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M3-merchant-queue.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M3");
```

Note: `Load queue` has `alwaysOutputData:true` (from `pgNode`); on zero rows the Presign node's `$input.all()` is empty and returns `{ submissions: [] }`.

- [ ] **Step 2: Build + deploy + activate** (Task 3 Step 2 commands, `build-m-queue.mjs` / `WF-M3-merchant-queue.json`). Expected `active=true`.

- [ ] **Step 3: Test — demo-pass queue returns the pending submission with photo URLs**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84"}' | Out-File -Encoding ascii _m_queue.json
node post-webhook.mjs merchant/queue _m_queue.json
```
Expected: `200`, `submissions` contains `6864bbdf…` with a `decision` and `photos[].url` values like `https://<acct>.r2.cloudflarestorage.com/...X-Amz-Signature=...`.

(Note: if `6864bbdf` was already approved in a prior decide test, re-arm it: `UPDATE seller_submissions SET status='merchant_review', merchant_decided_at=NULL WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';`)

- [ ] **Step 4: Verify a presigned URL actually fetches the image**
```powershell
$u = (node post-webhook.mjs merchant/queue _m_queue.json | Select-String 'r2.cloudflarestorage.com').Matches.Value
# extract first url:
$json = (node post-webhook.mjs merchant/queue _m_queue.json | Select-Object -Last 1 | ConvertFrom-Json)
$first = $json.submissions[0].photos[0].url
(Invoke-WebRequest -UseBasicParsing $first).StatusCode
```
Expected: `200` (the image bytes load).

- [ ] **Step 5: Commit**
```bash
git add ops/n8n/build-m-queue.mjs ops/n8n/workflows/WF-M3-merchant-queue.json
git commit -m "feat(portal): WF-M3 merchant/queue (pending submissions + presigned photos)"
```

---

## Task 6: WF-M4 merchant/decide (shared decision core)

Applies an approve/reject to a submission the merchant owns; idempotent; invalidates decision_tokens; emails the seller the Cal.com link on approve. This is the core Phase D's WF-6 will reuse.

**Files:**
- Create: `ops/n8n/build-m-decide.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-decide.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Verify ownership + state, flip status, invalidate tokens. Always one row.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sub AS (
  SELECT s.id, s.status, left(s.id::text,8) AS short_id,
         m.display_name AS merchant_name, m.calcom_event_url,
         se.email AS seller_email, se.name AS seller_name
  FROM seller_submissions s
  JOIN merchants m ON m.id = s.merchant_id
  JOIN sellers se ON se.id = s.seller_id
  WHERE s.id = NULLIF((SELECT d->>'submission_id' FROM inp),'')::uuid
    AND s.merchant_id = NULLIF((SELECT d->>'merchant_id' FROM inp),'')::uuid
  LIMIT 1
),
upd AS (
  UPDATE seller_submissions
    SET status = CASE WHEN (SELECT d->>'action' FROM inp)='approve' THEN 'merchant_approved' ELSE 'merchant_rejected' END,
        merchant_decided_at = NOW()
  WHERE id = (SELECT id FROM sub) AND status = 'merchant_review'
    AND (SELECT d->>'action' FROM inp) IN ('approve','reject')
  RETURNING id, status
),
invtok AS (
  UPDATE decision_tokens SET used_at = NOW()
  WHERE submission_id = (SELECT id FROM sub) AND used_at IS NULL AND (SELECT id FROM upd) IS NOT NULL
  RETURNING token_hash
)
SELECT (SELECT id FROM sub) IS NOT NULL AS found,
       (SELECT status FROM sub) AS prev_status,
       (SELECT status FROM upd) AS new_status,
       (SELECT count(*) FROM invtok) AS tokens_invalidated,
       (SELECT short_id FROM sub) AS short_id,
       (SELECT seller_email FROM sub) AS seller_email,
       (SELECT seller_name FROM sub) AS seller_name,
       (SELECT merchant_name FROM sub) AS merchant_name,
       (SELECT calcom_event_url FROM sub) AS calcom_event_url;
`.trim();

const notify = `
const r = $json;
const action = String(($('Webhook').first().json.body || {}).action || '');
if (!r.found) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
if (!r.new_status) {
  // already decided (not in merchant_review) — idempotent no-op, no email
  return [{ json: { statusCode: 200, body: { ok:true, status: r.prev_status, already: true } } }];
}
// approve -> email seller the Cal.com drop-off link
const enabled = String($env.TT_AUTOSEND_ENABLED || '').toLowerCase() === 'true';
if (r.new_status === 'merchant_approved' && enabled) {
  const transport = ($env.EMAIL_TRANSPORT || 'mailpit').toLowerCase();
  const from = $env.FROM_EMAIL || 'submissions@tagtorack.com';
  const cal = r.calcom_event_url || ($env.CALCOM_BOOKING_URL || '');
  const subject = (r.merchant_name || 'The store') + ' approved your item (' + r.short_id + ')';
  const html = '<div style="font-family:sans-serif;max-width:520px"><h2>Good news, ' + (r.seller_name || 'there') + '</h2>' +
    '<p>' + (r.merchant_name || 'The store') + ' approved your item. Book a drop-off time:</p>' +
    '<p><a href="' + cal + '">Schedule your drop-off</a></p></div>';
  try {
    if (transport === 'resend') {
      await this.helpers.httpRequest({ method:'POST', url:'https://api.resend.com/emails',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + $env.RESEND_API_KEY },
        body:{ from:'Tag to Rack <' + from + '>', to:[r.seller_email], subject, html }, json:true });
    } else {
      await this.helpers.httpRequest({ method:'POST', url:'http://mailpit:8025/api/v1/send',
        headers:{ 'Content-Type':'application/json' },
        body:{ From:{ Email: from, Name:'Tag to Rack' }, To:[{ Email: r.seller_email }], Subject: subject, HTML: html }, json:true });
    }
  } catch (e) { /* best effort */ }
}
return [{ json: { statusCode: 200, body: { ok:true, status: r.new_status, tokens_invalidated: r.tokens_invalidated } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/decide"),
  pgNode("pg", "Decide", sql, "={{ JSON.stringify({ submission_id: $json.body.submission_id, merchant_id: $json.body.merchant_id, action: $json.body.action }) }}", 0),
  codeNode("notify", "Notify", notify, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M4 merchant-decide", nodes,
  connections: linearConnections(["Webhook","Decide","Notify","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M4-merchant-decide.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M4");
```

- [ ] **Step 2: Build + deploy + activate** (Task 3 Step 2 commands). Expected `active=true`.

- [ ] **Step 3: Test — cross-merchant attempt is rejected (404)**

Re-arm the fixture first, then try to decide it as the WRONG merchant (`test-thrift` id `66e66420-…`):
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "UPDATE seller_submissions SET status='merchant_review', merchant_decided_at=NULL WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';" | Out-Null
'{"submission_id":"6864bbdf-84a4-4531-9634-872043f515bd","merchant_id":"66e66420-e873-49fa-8c1c-34dfb1ef8da9","action":"approve"}' | Out-File -Encoding ascii _m_decide_x.json
node post-webhook.mjs merchant/decide _m_decide_x.json
```
Expected: `404 {"ok":false,"error":"not_found"}` (ownership check) and status still `merchant_review`.

- [ ] **Step 4: Test — correct merchant approves → status flips, seller emailed, tokens invalidated**
```powershell
'{"submission_id":"6864bbdf-84a4-4531-9634-872043f515bd","merchant_id":"255e6d84-f2b8-4549-9754-514839841a84","action":"approve"}' | Out-File -Encoding ascii _m_decide.json
node post-webhook.mjs merchant/decide _m_decide.json
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT status FROM seller_submissions WHERE id='6864bbdf-84a4-4531-9634-872043f515bd'; SELECT count(*) FILTER (WHERE used_at IS NULL) AS unused_tokens FROM decision_tokens WHERE submission_id='6864bbdf-84a4-4531-9634-872043f515bd';"
```
Expected: response `200 {"ok":true,"status":"merchant_approved",...}`; DB status `merchant_approved`; `unused_tokens = 0`; a Mailpit email "approved your item" to the seller with a Cal.com link.

- [ ] **Step 5: Test — idempotent re-decide (already approved)**
```powershell
node post-webhook.mjs merchant/decide _m_decide.json
```
Expected: `200 {"ok":true,"status":"merchant_approved","already":true}` and **no** second seller email.

- [ ] **Step 6: Commit**
```bash
git add ops/n8n/build-m-decide.mjs ops/n8n/workflows/WF-M4-merchant-decide.json
git commit -m "feat(portal): WF-M4 merchant/decide (shared decision core)"
```

---

## Task 7: WF-M5 merchant/stats

Analytics summary scoped to the merchant.

**Files:**
- Create: `ops/n8n/build-m-stats.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-m-stats.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
mid AS (SELECT NULLIF((SELECT d->>'merchant_id' FROM inp),'')::uuid AS id)
SELECT
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND status='merchant_review') AS pending,
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND status='merchant_approved' AND merchant_decided_at > NOW()-INTERVAL '7 days') AS approved_week,
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND status='merchant_rejected' AND merchant_decided_at > NOW()-INTERVAL '7 days') AS rejected_week,
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND submitted_at > NOW()-INTERVAL '7 days') AS received_week,
  (SELECT coalesce(round(100.0 * count(*) FILTER (WHERE s.status='merchant_approved') / NULLIF(count(*),0)), 0)
     FROM seller_submissions s
     JOIN LATERAL (SELECT decision FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE s.merchant_id=(SELECT id FROM mid) AND d.decision='PASS' AND s.status IN ('merchant_approved','merchant_rejected')) AS ai_agreement_pct,
  (SELECT coalesce(sum(d.estimated_resale_usd),0)
     FROM seller_submissions s
     JOIN LATERAL (SELECT estimated_resale_usd FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE s.merchant_id=(SELECT id FROM mid) AND s.status='merchant_approved') AS approved_resale_value;
`.trim();

const shape = `return [{ json: { statusCode: 200, body: { ok:true, stats: $json } } }];`;

const nodes = [
  webhookNode("w", "Webhook", "merchant/stats"),
  pgNode("pg", "Stats", sql, "={{ JSON.stringify({ merchant_id: $json.body.merchant_id }) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M5 merchant-stats", nodes,
  connections: linearConnections(["Webhook","Stats","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M5-merchant-stats.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M5");
```

- [ ] **Step 2: Build + deploy + activate** (Task 3 Step 2 commands). Expected `active=true`.

- [ ] **Step 3: Test**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"
'{"merchant_id":"255e6d84-f2b8-4549-9754-514839841a84"}' | Out-File -Encoding ascii _m_stats.json
node post-webhook.mjs merchant/stats _m_stats.json
```
Expected: `200` with a `stats` object containing numeric `pending`, `approved_week`, `rejected_week`, `received_week`, `ai_agreement_pct`, `approved_resale_value`.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-m-stats.mjs ops/n8n/workflows/WF-M5-merchant-stats.json
git commit -m "feat(portal): WF-M5 merchant/stats (analytics summary)"
```

---

## Task 8: Pages session module + routing + env

**Files:**
- Create: `functions/_shared/portal-session.js`
- Modify: `_routes.json`
- Modify: `.dev.vars` (repo root)
- Create: `portal/assets/portal.css`

- [ ] **Step 1: Write `functions/_shared/portal-session.js`**

```js
// functions/_shared/portal-session.js
// Stateless HMAC-signed session cookie + CSRF helper for the merchant portal.
// Web Crypto only (Cloudflare Pages Functions runtime).
import { postToN8n } from "./n8n-fanout.js";

const enc = new TextEncoder();
const COOKIE = "tt_portal_session";
const TTL = 604800; // 7 days

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(enc.encode(s));
const fromB64url = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export async function signSession(env, { merchant_id, slug }) {
  const payload = b64urlStr(JSON.stringify({ merchant_id, slug, exp: Math.floor(Date.now() / 1000) + TTL }));
  return `${payload}.${await hmac(env.PORTAL_SESSION_SECRET, payload)}`;
}

export async function verifySession(env, value) {
  if (!value || value.indexOf(".") < 0) return null;
  const [payload, sig] = value.split(".");
  if (!sig || sig !== (await hmac(env.PORTAL_SESSION_SECRET, payload))) return null;
  let data;
  try { data = JSON.parse(fromB64url(payload)); } catch { return null; }
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data; // { merchant_id, slug, exp }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function requireSession(request, env) {
  return await verifySession(env, getCookie(request, COOKIE));
}

export function setCookieHeader(value) {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=${TTL}`;
}
export function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=0`;
}

// CSRF token bound to the session value (stateless): HMAC of the cookie value.
export async function csrfFor(env, sessionValue) {
  return (await hmac(env.PORTAL_SESSION_SECRET, "csrf:" + sessionValue)).slice(0, 32);
}

// Shared CSP for portal Function responses (allows R2 image hosts).
export const PORTAL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self'; " +
  "form-action 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'";

// Thin n8n caller (re-exported for portal handlers).
export { postToN8n };
```

- [ ] **Step 2: Add the portal routes to `_routes.json`**

Replace the file with:
```json
{
  "version": 1,
  "include": ["/api/*", "/submit/*", "/portal/*"],
  "exclude": [
    "/submit/portal",
    "/submit/portal.html",
    "/submit/privacy.html",
    "/submit/assets/*",
    "/portal/assets/*"
  ]
}
```

- [ ] **Step 3: Add the session secret to `.dev.vars`**

Append to the repo-root `.dev.vars` (gitignored):
```
PORTAL_SESSION_SECRET=dev-portal-secret-change-me-0123456789abcdef
```
(Production: set `PORTAL_SESSION_SECRET` to a fresh 32+ byte random value in the Cloudflare dashboard → tag-to-rack → Settings → Functions → Environment variables.)

- [ ] **Step 4: Create `portal/assets/portal.css`** (minimal, no framework)

```css
:root { --violet: #6a40c9; --ink: #1a1a2e; --soft: #6b7280; --line: #e5e7eb; }
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; color: var(--ink); margin: 0; background: #faf9fc; }
.wrap { max-width: 880px; margin: 0 auto; padding: 24px 20px; }
.top { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 14px 0; }
.row { display: flex; gap: 16px; }
.thumb { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; background: #eee; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge.PASS { background: #e7f6ec; color: #1a7f37; }
.badge.BORDERLINE { background: #fff4e5; color: #b25e00; }
.badge.FAIL { background: #fde8e8; color: #b42318; }
.btn { border: 0; border-radius: 8px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
.btn.approve { background: var(--violet); color: #fff; }
.btn.reject { background: #fff; color: #b42318; border: 1px solid #f0c2bd; }
.muted { color: var(--soft); font-size: 14px; }
input[type=email] { padding: 10px; border: 1px solid var(--line); border-radius: 8px; width: 100%; }
.stat { display: inline-block; min-width: 140px; margin: 8px 16px 8px 0; }
.stat b { display: block; font-size: 24px; }
```

- [ ] **Step 5: Verify the module imports (no syntax errors)**
```powershell
cd "C:\AI\Business Owners\TagtoRack"; node --check functions/_shared/portal-session.js
```
Expected: no output (exit 0).

- [ ] **Step 6: Commit**
```bash
git add functions/_shared/portal-session.js _routes.json portal/assets/portal.css
git commit -m "feat(portal): session module, routing, CSP, styles"
```
(Do not commit `.dev.vars` — it is gitignored.)

---

## Task 9: Login page + login-request endpoint

**Files:**
- Create: `functions/portal/index.js`
- Create: `functions/portal/api/login-request.js`

- [ ] **Step 1: Write `functions/portal/index.js`** (login view now; queue view added in Task 11)

```js
// functions/portal/index.js — GET /portal
import { requireSession, PORTAL_CSP } from "../_shared/portal-session.js";

const page = (bodyHtml) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — Store Portal</title><link rel="stylesheet" href="/portal/assets/portal.css">` +
  `<meta name="robots" content="noindex"></head><body><div class="wrap">${bodyHtml}</div></body></html>`;

const html = (s, init = {}) =>
  new Response(page(s), {
    status: init.status || 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP },
  });

const loginView = () =>
  `<div class="top"><h1>Store Portal</h1></div>
   <div class="card"><h2>Sign in</h2>
   <p class="muted">Enter your store's email. We'll send a one-time sign-in link.</p>
   <form id="f"><input type="email" name="email" placeholder="store@example.com" required>
   <p><button class="btn approve" type="submit">Send sign-in link</button></p></form>
   <p id="msg" class="muted"></p></div>
   <script src="/portal/assets/login.js"></script>`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return html(loginView());
  // Queue view is implemented in Task 11; placeholder until then.
  return html(`<div class="top"><h1>Queue</h1><a href="/portal/logout">Sign out</a></div><p class="muted">Queue loads here.</p>`);
}
```

- [ ] **Step 2: Create `portal/assets/login.js`** (static; posts the email)

```js
// portal/assets/login.js
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  const msg = document.getElementById("msg");
  msg.textContent = "Sending…";
  try {
    await fetch("/portal/api/login-request", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    });
  } catch (_) {}
  msg.textContent = "If that email is registered, a sign-in link is on its way. Check your inbox.";
});
```

- [ ] **Step 3: Write `functions/portal/api/login-request.js`**

```js
// functions/portal/api/login-request.js — POST /portal/api/login-request
import { postToN8n } from "../../_shared/n8n-fanout.js";
import { checkAndIncrement, sha256Hex } from "../../_shared/ratelimit.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false }); }
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200, { ok: true }); // never leak

  // Rate-limit by IP + email (degrades open). 5 / hour each.
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const kv = env.TT_SUBMIT_RL;
  const ipKey = `portal-login:ip:${await sha256Hex(ip)}`;
  const emKey = `portal-login:em:${await sha256Hex(email)}`;
  const a = await checkAndIncrement(kv, ipKey, 5, { windowSec: 3600 });
  const b = await checkAndIncrement(kv, emKey, 5, { windowSec: 3600 });
  if (!a.allowed || !b.allowed) return json(200, { ok: true }); // throttle silently

  try { await postToN8n(env, "merchant/login-request", { email }, 5000); } catch (_) {}
  return json(200, { ok: true });
}
```

- [ ] **Step 4: Run Pages dev + test the login page renders and posts**

Start dev server (separate terminal): `npx wrangler pages dev . --port 8788` (it reads `.dev.vars` and `wrangler.jsonc`).

Then:
```powershell
# page renders
(Invoke-WebRequest -UseBasicParsing http://localhost:8788/portal).Content.Substring(0,80)
# login-request reaches n8n + Mailpit
$h = @{ "Content-Type"="application/json" }
Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:8788/portal/api/login-request -Headers $h -Body '{"email":"store-demo@example.com"}' | Select-Object -Expand StatusCode
(Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/messages").Content | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.messages||[]).some(m=>m.Subject.includes('sign-in'))?'login email present':'NO email')})"
```
Expected: page HTML starts with `<!doctype html>`; POST returns `200`; a `sign-in` email is present in Mailpit.

Note: requires `INTAKE_WEBHOOK_BASE=http://localhost:5678/webhook` in `.dev.vars` (already set per the playbook).

- [ ] **Step 5: Commit**
```bash
git add functions/portal/index.js functions/portal/api/login-request.js portal/assets/login.js
git commit -m "feat(portal): login page + login-request endpoint (rate-limited, anti-enumeration)"
```

---

## Task 10: Auth consume (set cookie) + logout

**Files:**
- Create: `functions/portal/auth.js`
- Create: `functions/portal/logout.js`

- [ ] **Step 1: Write `functions/portal/auth.js`**

```js
// functions/portal/auth.js — GET /portal/auth?t=<raw>
import { postToN8n } from "../_shared/n8n-fanout.js";
import { signSession, setCookieHeader, PORTAL_CSP } from "../_shared/portal-session.js";

const errPage = (msg) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/portal/assets/portal.css">` +
    `<div class="wrap"><div class="card"><h2>Sign-in link invalid</h2><p class="muted">${msg}</p>` +
    `<p><a href="/portal">Back to sign in</a></p></div></div>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PORTAL_CSP } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get("t") || "";
  if (!token) return errPage("Missing token.");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  let resp;
  try { resp = await postToN8n(env, "merchant/login-consume", { token, ip }, 5000); }
  catch { return errPage("This link has expired or was already used. Request a new one."); }
  if (!resp || !resp.ok || !resp.merchant_id) return errPage("This link has expired or was already used. Request a new one.");

  const cookie = await signSession(env, { merchant_id: resp.merchant_id, slug: resp.slug });
  return new Response(null, { status: 302, headers: { Location: "/portal", "Set-Cookie": setCookieHeader(cookie) } });
}
```

- [ ] **Step 2: Write `functions/portal/logout.js`**

```js
// functions/portal/logout.js — GET /portal/logout
import { clearCookieHeader } from "../_shared/portal-session.js";
export async function onRequestGet() {
  return new Response(null, { status: 302, headers: { Location: "/portal", "Set-Cookie": clearCookieHeader() } });
}
```

- [ ] **Step 3: Test the full login round-trip** (Pages dev running)

```powershell
# 1) request a link
$h=@{ "Content-Type"="application/json" }
Invoke-WebRequest -UseBasicParsing -Method POST http://localhost:8788/portal/api/login-request -Headers $h -Body '{"email":"store-demo@example.com"}' | Out-Null
# 2) pull the raw token from Mailpit
$raw = ((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/messages").Content | ConvertFrom-Json).messages | Where-Object {$_.Subject -like '*sign-in*'} | Select-Object -First 1 | ForEach-Object { $mid=$_.ID; (((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/message/$mid").Content | ConvertFrom-Json).HTML -replace '(?s).*portal/auth\?t=([0-9a-f]+).*','$1') }
# 3) hit /portal/auth and capture the Set-Cookie + redirect
$r = Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/auth?t=$raw" -MaximumRedirection 0 -ErrorAction SilentlyContinue
Write-Output ("status=" + $r.StatusCode + " location=" + $r.Headers.Location + " setcookie=" + ($r.Headers['Set-Cookie'] -join ''))
```
Expected: `status=302 location=/portal setcookie=tt_portal_session=…; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=604800`.

- [ ] **Step 4: Negative test — reused token shows the error page**
```powershell
$r2 = Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/auth?t=$raw" -MaximumRedirection 0 -ErrorAction SilentlyContinue
$r2.StatusCode
```
Expected: `401` (token already consumed).

- [ ] **Step 5: Commit**
```bash
git add functions/portal/auth.js functions/portal/logout.js
git commit -m "feat(portal): magic-link consume sets session cookie; logout"
```

---

## Task 11: Queue view

Render the pending queue for a signed-in merchant, with a CSRF token for the decide form.

**Files:**
- Modify: `functions/portal/index.js`

- [ ] **Step 1: Replace `functions/portal/index.js` with the full queue-rendering version**

```js
// functions/portal/index.js — GET /portal
import { requireSession, getCookie, csrfFor, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (b) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — Store Portal</title><link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap">${b}</div></body></html>`;
const html = (b, status = 200) =>
  new Response(page(b), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });

const loginView = () =>
  `<div class="top"><h1>Store Portal</h1></div><div class="card"><h2>Sign in</h2>
   <p class="muted">Enter your store's email. We'll send a one-time sign-in link.</p>
   <form id="f"><input type="email" name="email" placeholder="store@example.com" required>
   <p><button class="btn approve" type="submit">Send sign-in link</button></p></form>
   <p id="msg" class="muted"></p></div><script src="/portal/assets/login.js"></script>`;

const card = (s, csrf) => {
  const dec = s.decision || "—";
  const thumb = (s.photos && s.photos[0] && s.photos[0].url) || "";
  return `<div class="card"><div class="row">
    <img class="thumb" src="${esc(thumb)}" alt="submission photo">
    <div style="flex:1">
      <div><span class="badge ${esc(dec)}">${esc(dec)}</span> <span class="muted">conf ${esc(s.confidence)}</span></div>
      <p><b>${esc(s.declared_brand || "")} ${esc(s.item_description || "")}</b></p>
      <p class="muted">${esc(s.declared_category || "")} · ${esc(s.declared_condition || "")} · est. resale ${s.estimated_resale_usd != null ? "$" + esc(s.estimated_resale_usd) : "n/a"}</p>
      <p class="muted">${esc((s.internal_note || "").slice(0, 160))}</p>
      <form method="POST" action="/portal/api/decide" style="display:inline">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(s.submission_id)}">
        <button class="btn approve" name="action" value="approve">Approve</button>
        <button class="btn reject" name="action" value="reject">Reject</button>
      </form>
      <a class="muted" href="/portal/submission/${esc(s.submission_id)}" style="margin-left:10px">Details</a>
    </div></div></div>`;
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return html(loginView());

  let subs = [];
  try {
    const r = await postToN8n(env, "merchant/queue", { merchant_id: session.merchant_id }, 8000);
    subs = (r && r.submissions) || [];
  } catch (_) { return html(`<div class="top"><h1>${esc(session.slug)}</h1><a href="/portal/logout">Sign out</a></div><p class="muted">Couldn't load the queue. Refresh to retry.</p>`); }

  const csrf = await csrfFor(env, getCookie(request, "tt_portal_session"));
  const head = `<div class="top"><h1>${esc(session.slug)} — Queue (${subs.length})</h1>
    <span><a href="/portal/analytics">Analytics</a> · <a href="/portal/logout">Sign out</a></span></div>`;
  const list = subs.length ? subs.map((s) => card(s, csrf)).join("") : `<div class="card"><p class="muted">No submissions awaiting review.</p></div>`;
  return html(head + list);
}
```

- [ ] **Step 2: Test — signed-in queue shows the pending submission**

Re-arm the fixture, then load `/portal` with the session cookie obtained in Task 10 (capture it into `$cookie` first):
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "UPDATE seller_submissions SET status='merchant_review', merchant_decided_at=NULL WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';" | Out-Null
# obtain a fresh cookie (repeat Task 10 steps 1-3) and store as $cookie, then:
$page = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal" -Headers @{ Cookie = $cookie }).Content
($page -match 'Queue \(\d+\)'); ($page -match '6864bbdf' -or $page -match 'Approve')
```
Expected: both `True` — the queue header shows a count and the card with Approve/Reject renders.

- [ ] **Step 3: Commit**
```bash
git add functions/portal/index.js
git commit -m "feat(portal): queue view with AI verdict cards + CSRF token"
```

---

## Task 12: Decide endpoint (session + CSRF + Origin)

**Files:**
- Create: `functions/portal/api/decide.js`

- [ ] **Step 1: Write `functions/portal/api/decide.js`**

```js
// functions/portal/api/decide.js — POST /portal/api/decide  (form post)
import { requireSession, getCookie, csrfFor, postToN8n } from "../../_shared/portal-session.js";

const seeOther = (loc, msg) =>
  new Response(null, { status: 303, headers: { Location: loc + (msg ? "?m=" + encodeURIComponent(msg) : "") } });

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return seeOther("/portal");

  // CSRF: same-origin + token bound to the session cookie.
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  if (origin && new URL(origin).host !== url.host) return new Response("bad origin", { status: 403 });

  const form = await request.formData();
  const csrf = String(form.get("csrf") || "");
  const expected = await csrfFor(env, getCookie(request, "tt_portal_session"));
  if (csrf !== expected) return new Response("bad csrf", { status: 403 });

  const submission_id = String(form.get("submission_id") || "");
  const action = String(form.get("action") || "");
  if (!/^[0-9a-fA-F-]{36}$/.test(submission_id) || !["approve", "reject"].includes(action)) return seeOther("/portal", "Invalid request");

  try {
    await postToN8n(env, "merchant/decide", { merchant_id: session.merchant_id, submission_id, action }, 8000);
  } catch (_) { return seeOther("/portal", "Action failed, try again"); }
  return seeOther("/portal", action === "approve" ? "Approved" : "Rejected");
}
```

- [ ] **Step 2: Test — approve from the portal flips status + emails seller**

Re-arm the fixture; obtain a cookie + the matching CSRF token (the CSRF equals `csrfFor(cookieValue)` — read it from the rendered queue page's hidden input), then POST:
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "UPDATE seller_submissions SET status='merchant_review', merchant_decided_at=NULL WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';" | Out-Null
# scrape csrf from the queue page:
$page = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal" -Headers @{ Cookie = $cookie }).Content
$csrf = ([regex]'name="csrf" value="([^"]+)"').Match($page).Groups[1].Value
$body = "csrf=$csrf&submission_id=6864bbdf-84a4-4531-9634-872043f515bd&action=approve"
$r = Invoke-WebRequest -UseBasicParsing -Method POST "http://localhost:8788/portal/api/decide" -Headers @{ Cookie=$cookie; "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body $body -MaximumRedirection 0 -ErrorAction SilentlyContinue
$r.StatusCode
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT status FROM seller_submissions WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';"
```
Expected: `303` redirect; DB status `merchant_approved`; a Mailpit "approved your item" email to the seller.

- [ ] **Step 3: Negative test — wrong/empty CSRF → 403**
```powershell
$bad = "csrf=wrong&submission_id=6864bbdf-84a4-4531-9634-872043f515bd&action=approve"
(Invoke-WebRequest -UseBasicParsing -Method POST "http://localhost:8788/portal/api/decide" -Headers @{ Cookie=$cookie; "Content-Type"="application/x-www-form-urlencoded"; Origin="http://localhost:8788" } -Body $bad -MaximumRedirection 0 -ErrorAction SilentlyContinue).StatusCode
```
Expected: `403`.

- [ ] **Step 4: Commit**
```bash
git add functions/portal/api/decide.js
git commit -m "feat(portal): decide endpoint (session + CSRF + origin check)"
```

---

## Task 13: Submission detail page

**Files:**
- Create: `functions/portal/submission/[id].js`

- [ ] **Step 1: Write `functions/portal/submission/[id].js`**

```js
// functions/portal/submission/[id].js — GET /portal/submission/<id>
import { requireSession, getCookie, csrfFor, postToN8n, PORTAL_CSP } from "../../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (b) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"><div class="wrap">${b}</div>`;
const html = (b, status = 200) =>
  new Response(page(b), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  // Reuse the queue webhook and find this submission (keeps n8n surface small).
  let s = null;
  try {
    const r = await postToN8n(env, "merchant/queue", { merchant_id: session.merchant_id }, 8000);
    s = ((r && r.submissions) || []).find((x) => x.submission_id === params.id) || null;
  } catch (_) {}
  if (!s) return html(`<p><a href="/portal">← Queue</a></p><div class="card"><p class="muted">Not found in your pending queue (it may already be decided).</p></div>`);

  const csrf = await csrfFor(env, getCookie(request, "tt_portal_session"));
  const photos = (s.photos || []).map((p) => `<img class="thumb" style="width:160px;height:200px" src="${esc(p.url)}" alt="${esc(p.role)}">`).join(" ");
  const reasons = [].concat(s.pass_reasons || [], s.borderline_reasons || [], s.fail_reasons || []).map((x) => `<li>${esc(x)}</li>`).join("");
  return html(
    `<p><a href="/portal">← Queue</a></p>
     <div class="card"><div><span class="badge ${esc(s.decision)}">${esc(s.decision)}</span> <span class="muted">conf ${esc(s.confidence)}</span></div>
     <h2>${esc(s.declared_brand || "")} ${esc(s.item_description || "")}</h2>
     <p class="muted">${esc(s.declared_category || "")} · ${esc(s.declared_condition || "")} · asking ${s.asking_price_usd != null ? "$" + esc(s.asking_price_usd) : "n/a"} · est. resale ${s.estimated_resale_usd != null ? "$" + esc(s.estimated_resale_usd) : "n/a"}</p>
     <div class="row" style="flex-wrap:wrap">${photos}</div>
     <h3>AI reasons</h3><ul>${reasons}</ul>
     <p class="muted">${esc(s.internal_note || "")}</p>
     <form method="POST" action="/portal/api/decide">
       <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(s.submission_id)}">
       <button class="btn approve" name="action" value="approve">Approve</button>
       <button class="btn reject" name="action" value="reject">Reject</button>
     </form></div>`);
}
```

- [ ] **Step 2: Test** (Pages dev, with `$cookie`; re-arm fixture)
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -At -c "UPDATE seller_submissions SET status='merchant_review', merchant_decided_at=NULL WHERE id='6864bbdf-84a4-4531-9634-872043f515bd';" | Out-Null
$d = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/submission/6864bbdf-84a4-4531-9634-872043f515bd" -Headers @{ Cookie=$cookie }).Content
($d -match 'AI reasons'); ($d -match 'r2.cloudflarestorage.com')
```
Expected: both `True` (reasons section + presigned photo URLs render).

- [ ] **Step 3: Commit**
```bash
git add functions/portal/submission/[id].js
git commit -m "feat(portal): submission detail page"
```

---

## Task 14: Analytics page

**Files:**
- Create: `functions/portal/analytics.js`

- [ ] **Step 1: Write `functions/portal/analytics.js`**

```js
// functions/portal/analytics.js — GET /portal/analytics
import { requireSession, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const page = (b) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"><div class="wrap">${b}</div>`;
const html = (b) => new Response(page(b), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });
const stat = (label, val) => `<div class="stat"><b>${esc(val)}</b><span class="muted">${esc(label)}</span></div>`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  let st = {};
  try { const r = await postToN8n(env, "merchant/stats", { merchant_id: session.merchant_id }, 8000); st = (r && r.stats) || {}; }
  catch (_) { return html(`<p><a href="/portal">← Queue</a></p><p class="muted">Couldn't load analytics.</p>`); }

  return html(
    `<div class="top"><h1>Analytics</h1><a href="/portal">← Queue</a></div>
     <div class="card">
       ${stat("Pending review", st.pending ?? 0)}
       ${stat("Approved (7d)", st.approved_week ?? 0)}
       ${stat("Rejected (7d)", st.rejected_week ?? 0)}
       ${stat("Received (7d)", st.received_week ?? 0)}
       ${stat("AI agreement", (st.ai_agreement_pct ?? 0) + "%")}
       ${stat("Approved resale value", "$" + (st.approved_resale_value ?? 0))}
     </div>`);
}
```

- [ ] **Step 2: Test**
```powershell
$a = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal/analytics" -Headers @{ Cookie=$cookie }).Content
($a -match 'AI agreement'); ($a -match 'Approved resale value')
```
Expected: both `True`.

- [ ] **Step 3: Commit**
```bash
git add functions/portal/analytics.js
git commit -m "feat(portal): analytics summary page"
```

---

## Task 15: End-to-end verification + adversarial pass

**Files:** none (verification only).

- [ ] **Step 1: Full happy-path E2E** (Pages dev + Mailpit + clean fixture)

Re-arm `6864bbdf` to `merchant_review`. Then, in a browser (or scripted): visit `http://localhost:8788/portal` → enter `store-demo@example.com` → open the Mailpit message (`http://localhost:8025`) → click the sign-in link → land on the queue → confirm the card shows the AI badge + photo → click **Approve**.

Verify:
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT status, merchant_decided_at IS NOT NULL AS decided FROM seller_submissions WHERE id='6864bbdf-84a4-4531-9634-872043f515bd'; SELECT count(*) FILTER (WHERE used_at IS NULL) AS unused FROM decision_tokens WHERE submission_id='6864bbdf-84a4-4531-9634-872043f515bd';"
```
Expected: `merchant_approved`, `decided=t`, `unused=0`; the seller "approved your item" email present in Mailpit with the Cal.com link.

- [ ] **Step 2: Adversarial — tampered cookie rejected**
```powershell
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/portal" -Headers @{ Cookie = "tt_portal_session=eyJhbGc.tampered" }).Content -match 'Sign in'
```
Expected: `True` (invalid cookie → login view, not the queue).

- [ ] **Step 3: Adversarial — expired login token** (already covered in Task 10 Step 4) and **cross-merchant decide** (Task 6 Step 3). Confirm both still hold. No new code.

- [ ] **Step 4: Confirm all five merchant workflows are active**
```powershell
cd "C:\AI\Business Owners\TagtoRack\ops\n8n"; node n8n-api.mjs GET /workflows 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.data||[]).filter(w=>w.name.startsWith('WF-M')).map(w=>w.name+' active='+w.active).sort().join('\n'))})"
```
Expected: WF-M1…WF-M5 all `active=true`.

- [ ] **Step 5: Update docs**

Append a "Merchant Portal — DONE" section to `~/.claude/plans/transient-soaring-key.md` (workflow IDs, the `/portal/*` routes, `PORTAL_SESSION_SECRET`, the `merchant/decide` shared-core note for Phase D WF-6), and update the `tagtorack-architecture` memory.

- [ ] **Step 6: Final commit**
```bash
git add -A ops/n8n docs
git commit -m "docs(portal): record merchant portal completion + workflow IDs"
```

---

## Self-review notes (coverage check)

- **Spec auth flow** → Tasks 3,4 (n8n) + 9,10 (Pages) + 8 (session). ✓
- **One login per store** → login-request looks up `merchants.contact_email`; no user table. ✓
- **Queue + photos** → Task 5 (presigned URLs) + Task 11 (render). ✓
- **Approve/reject + shared core** → Task 6 (`merchant/decide`) + Task 12 (endpoint). ✓
- **Analytics** → Task 7 + Task 14. ✓
- **DB table** → Task 1. ✓
- **Routing / `/portal/*` / assets** → Task 8. ✓
- **Security:** anti-enumeration (Task 3,9), rate-limit (Task 9), CSRF + Origin (Task 12), CSP (Task 8 `PORTAL_CSP`, applied in 9/11/13/14), token hashing + single-use + expiry (Task 3,4), cookie flags (Task 8). ✓
- **Decision unification with Phase D WF-6** → noted on `merchant/decide`; WF-6 (token path) is out of scope for this plan and will call the same core. ✓

## Out of scope (per spec)
Multi-user/staff; submission history+search; counter-offer/offers ledger (Phase F); merchant rule_set editing; the `portal.tagtorack.com` subdomain; HMAC verification on the n8n webhooks (deferred app-wide).
