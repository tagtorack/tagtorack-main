# Seller Status-Check + Submit-Another Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seller (a) open a tokenized link from their email and see a seller-safe status page, and (b) submit another item in one click without re-typing contact info.

**Architecture:** A new public Pages page `/submit/status?s=<token>` (stateless HMAC token over `submission_id`, same secret as the merchant portal) backed by a new seller-safe `submit/status` n8n webhook (WF-S1). The submit wizard's confirmation screen gains a status link and a JS-driven "Submit another" reset. **No DB schema changes.**

**Tech Stack:** Cloudflare Pages Functions (Web Crypto HMAC), n8n 1.74.1 (`wf-lib.mjs`; `require('crypto')`; **this.helpers.httpRequest** not fetch), Postgres (`tagtorack_app`), Mailpit (dev email). Vanilla JS in `submit/assets/submit.js`.

**Verification model:** No unit-test harness — live integration only. Build the webhook via the `ops/n8n` REST scripts, test with `post-webhook.mjs` + psql, run Pages via `wrangler pages dev`, read emails in Mailpit. **Read `~/.claude/plans/transient-soaring-key.md` (BUILD PLAYBOOK) first.** Gotchas baked in: build scripts write directly to `ops/n8n/workflows/<name>.json`; **PowerShell tool, not Bash**, for n8n API; `n8n-api.mjs` sends `Accept: application/json`; new Pages function files need an **mtime touch** to hot-reload; the status route is **`/submit/status` (no extension)** because Pages serves extensioned paths as static assets; n8n self-calls use `127.0.0.1`.

**Branch:** `feature/seller-status` (checked out). Commit after each task.

**Key fixtures:** merchant `demo-pass` (id `255e6d84-f2b8-4549-9754-514839841a84`, slug `demo-pass`). A submission to test against — create a fresh one with `node ops/n8n/upload-photos.mjs <n>` (run from `ops/n8n`), which leaves it auto-reviewed; note its `SID`. PG: `docker exec -e PGPASSWORD=<ops/.env PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app`. n8n PG cred id `GZJQdHGNtdLI18IW`.

**SECURITY:** The status page is PUBLIC — the HMAC token is the only authorization. The webhook returns ONLY seller-safe fields (no confidence, internal_note, raw decision label, brand_detected, reasons, token counts). A bad/edited token → friendly invalid page, no data.

---

## Task 0: Infra — shared token secret in n8n env

So n8n (WF-5 email) and Pages mint identical HMAC status tokens, both must use the same secret. Pages already has `PORTAL_SESSION_SECRET` in `.dev.vars`/dashboard. Add it to the n8n container env.

**Files:** Modify `ops/.env`, `ops/docker-compose.yml`

- [ ] **Step 1: Copy `PORTAL_SESSION_SECRET` into `ops/.env`** (no value printed)

Run (PowerShell) — reads the value from repo-root `.dev.vars` and appends to `ops/.env` if absent, printing only key names:
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack"
$dv = Get-Content .dev.vars | Where-Object { $_ -match '^\s*PORTAL_SESSION_SECRET\s*=' } | Select-Object -First 1
$val = ($dv -replace '^\s*PORTAL_SESSION_SECRET\s*=\s*','').Trim()
if (-not (Get-Content ops/.env | Where-Object { $_ -match '^\s*PORTAL_SESSION_SECRET\s*=' })) {
  Add-Content ops/.env "`n# Shared with Pages — used to mint seller status-link HMAC tokens (n8n + Pages must match).`nPORTAL_SESSION_SECRET=$val"
  Write-Output "appended PORTAL_SESSION_SECRET to ops/.env"
} else { Write-Output "ops/.env already has PORTAL_SESSION_SECRET" }
```

- [ ] **Step 2: Wire it into the n8n service in `ops/docker-compose.yml`**

Find the n8n `environment:` block (it already has `SUBMIT_PUBLIC_BASE: ${SUBMIT_PUBLIC_BASE}`). Add a line after it:
```yaml
      SUBMIT_PUBLIC_BASE: ${SUBMIT_PUBLIC_BASE}
      PORTAL_SESSION_SECRET: ${PORTAL_SESSION_SECRET}
```

- [ ] **Step 3: Recreate n8n + verify the var is present (no value)**
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack\ops"; docker compose up -d n8n
Start-Sleep 5
docker exec tt_n8n sh -c 'if [ -n "$PORTAL_SESSION_SECRET" ]; then echo PORTAL_SESSION_SECRET=SET; else echo MISSING; fi'
```
Expected: `PORTAL_SESSION_SECRET=SET`. Then wait for health: `docker ps --format "{{.Names}} {{.Status}}" | Select-String tt_n8n` → healthy. Confirm workflows survived: `cd n8n; node n8n-api.mjs GET /workflows 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log((JSON.parse(d).data||[]).filter(w=>w.active).length+' active'))"` → 26 active.

- [ ] **Step 4: Commit**
```bash
git add ops/docker-compose.yml
git commit -m "infra(n8n): add PORTAL_SESSION_SECRET to container env (shared status-token secret)"
```
(Do NOT commit `ops/.env` — gitignored.)

---

## Task 1: Status-token helper (Pages)

**Files:** Create `functions/_shared/status-token.js`

- [ ] **Step 1: Write `functions/_shared/status-token.js`**

```js
// functions/_shared/status-token.js
// Stateless seller status token: base64url(submission_id) + "." + base64url(HMAC-SHA256(submission_id, secret)).
// Same secret as the merchant portal (PORTAL_SESSION_SECRET) so n8n + Pages mint identical tokens.
// Web Crypto only (Cloudflare Pages runtime).
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const b64urlStr = (s) => b64url(enc.encode(s));
const fromB64url = (s) => { s = s.replace(/-/g,"+").replace(/_/g,"/"); return atob(s + "=".repeat((4 - s.length % 4) % 4)); };

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// Mint a token for a submission_id.
export async function mintStatusToken(env, submission_id) {
  const sig = await hmac(env.PORTAL_SESSION_SECRET, submission_id);
  return `${b64urlStr(submission_id)}.${sig}`;
}

// Verify a token; return the submission_id (string) or null.
export async function verifyStatusToken(env, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [encId, sig] = token.split(".");
  let submission_id;
  try { submission_id = fromB64url(encId); } catch { return null; }
  if (!/^[0-9a-fA-F-]{36}$/.test(submission_id)) return null;
  if (sig !== (await hmac(env.PORTAL_SESSION_SECRET, submission_id))) return null;
  return submission_id;
}
```

- [ ] **Step 2: Round-trip test** (Web Crypto works under Node global `crypto`)
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack"; node --check functions/_shared/status-token.js
@'
import { mintStatusToken, verifyStatusToken } from "./functions/_shared/status-token.js";
const env = { PORTAL_SESSION_SECRET: "test-secret-123" };
const sid = "6864bbdf-84a4-4531-9634-872043f515bd";
const t = await mintStatusToken(env, sid);
console.log("mint ok:", t.includes("."));
console.log("verify ok:", (await verifyStatusToken(env, t)) === sid);
console.log("tamper -> null:", (await verifyStatusToken(env, t.slice(0,-2)+"xy")) === null);
console.log("garbage -> null:", (await verifyStatusToken(env, "garbage")) === null);
console.log("wrong secret -> null:", (await verifyStatusToken({PORTAL_SESSION_SECRET:"other"}, t)) === null);
'@ | Out-File -Encoding ascii _st.mjs
node _st.mjs; Remove-Item _st.mjs
```
Expected: all five lines `true`.

- [ ] **Step 3: Commit**
```bash
git add functions/_shared/status-token.js
git commit -m "feat(submit): stateless HMAC status-token helper"
```

---

## Task 2: WF-S1 submit/status webhook (seller-safe projection)

**Files:** Create `ops/n8n/build-submit-status.mjs`

- [ ] **Step 1: Write the build script**

```js
// ops/n8n/build-submit-status.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

// Select ONLY seller-safe fields. Note: seller_message comes from the latest decision row
// (it is the brand-safe, seller-facing message the vision prompt produces). We deliberately
// do NOT select confidence/internal_note/decision/brand_detected/reasons.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sub AS (
  SELECT s.id, s.status, left(s.id::text,8) AS short_id,
         s.declared_brand, s.declared_category, s.declared_size, s.declared_condition, s.asking_price_usd,
         m.slug AS merchant_slug, m.display_name AS merchant_name, m.brand_color, m.calcom_event_url,
         (SELECT seller_message FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) AS seller_message
  FROM seller_submissions s JOIN merchants m ON m.id=s.merchant_id
  WHERE s.id = NULLIF((SELECT d->>'submission_id' FROM inp),'')::uuid
  LIMIT 1
)
SELECT
  (SELECT count(*) FROM sub) > 0 AS found,
  to_jsonb(sub.*) AS sub,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb)
   FROM submission_photos p, sub WHERE p.submission_id = sub.id) AS photos
FROM sub;
`.trim();

const shape = `
${r2PresignSnippet()}
const rows = $input.all().map(i=>i.json).filter(r=>r && r.found);
if (!rows.length) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const r = rows[0];
const s = r.sub || {};
const merchantName = s.merchant_name || 'the store';
const msg = (s.seller_message || '').replace(/\\{\\{\\s*merchant_name\\s*\\}\\}/g, merchantName);

// seller-safe stage mapping (single source of truth)
function stageFor(status) {
  switch (status) {
    case 'pending_uploads': return { key:'received', step:1, label:'Received', message:"We've got your photos — finishing up." };
    case 'received': case 'ai_reviewing': case 'merchant_review': case 'ai_borderline':
      return { key:'in_review', step:2, label:'In review', message:"We're reviewing your item. You'll hear back within 24 hours." };
    case 'merchant_approved': return { key:'approved', step:3, label:'Approved', message: msg || 'Good news — your item is a match. Schedule your drop-off below.', showDropoff:true };
    case 'dropoff_scheduled': return { key:'approved', step:3, label:'Drop-off booked', message:'Your drop-off is scheduled. See you then.' };
    case 'completed': return { key:'completed', step:3, label:'Completed', message:"Thanks — this item's all done." };
    case 'ai_failed': case 'merchant_rejected':
      return { key:'decided', step:3, label:'Decision made', message: msg || "Thanks for your submission. This isn't a match right now, but you're welcome to submit other items anytime." };
    default: return { key:'closed', step:3, label:'Closed', message:'This submission is no longer active.' };
  }
}
const stage = stageFor(s.status);
const photos = (r.photos||[]).map(p=>({ role:p.role, ord:p.ord, url: presignGet(p.r2_key, 86400) }));
return [{ json: { statusCode: 200, body: { ok:true,
  merchant: { slug: s.merchant_slug, display_name: merchantName, brand_color: s.brand_color },
  item: { brand: s.declared_brand, category: s.declared_category, size: s.declared_size, condition: s.declared_condition, asking_price_usd: s.asking_price_usd },
  short_id: s.short_id, stage, photos,
  calcom_url: stage.showDropoff ? (s.calcom_event_url || $env.CALCOM_BOOKING_URL || '') : null,
} } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "submit/status"),
  pgNode("pg", "Load", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-S1 submit-status", nodes, connections: linearConnections(["Webhook","Load","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-S1-submit-status.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-S1");
```

- [ ] **Step 2: Build + deploy + activate**
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack\ops\n8n"; node build-submit-status.mjs
$id = node n8n-api.mjs POST /workflows workflows/WF-S1-submit-status.json 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))"
node n8n-api.mjs POST /workflows/$id/activate 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('S1 active='+JSON.parse(d).active))"
```
Expected: `active=true`.

- [ ] **Step 3: Test each stage + assert unsafe fields absent**

Create a fresh reviewed submission, then probe + flip its status to exercise stages:
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack\ops\n8n"
$out = node upload-photos.mjs 20 2>&1; $SID = ($out | Select-String 'SID=(.+)').Matches.Groups[1].Value.Trim()
Write-Output "SID=$SID"
"{`"submission_id`":`"$SID`"}" | Out-File -Encoding ascii _s.json
Write-Output "=== current (likely merchant_review -> In review) ==="
node post-webhook.mjs submit/status _s.json
$PG="<PG_PASSWORD>"
foreach ($st in @("ai_reviewing","merchant_approved","ai_failed","completed","expired")) {
  docker exec -e PGPASSWORD=$PG tt_pg psql -U tagtorack -d tagtorack_app -At -c "UPDATE seller_submissions SET status='$st' WHERE id='$SID';" | Out-Null
  Write-Output "=== status=$st ==="
  node post-webhook.mjs submit/status _s.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d.split('\n').slice(1).join('\n'));const b=JSON.stringify(j);console.log('stage='+j.stage.label+' step='+j.stage.step+' dropoff='+!!j.calcom_url+' UNSAFE='+/(confidence|internal_note|brand_detected|\\\"decision\\\"|borderline_reasons|fail_reasons)/.test(b))})"
}
# bad id -> 404
'{"submission_id":"00000000-0000-0000-0000-0000000000aa"}' | Out-File -Encoding ascii _bad.json
node post-webhook.mjs submit/status _bad.json | Select-Object -First 1
```
Expected: each status maps to the right stage label/step (approved → step 3 + `dropoff=True`; ai_failed → "Decision made"; expired → "Closed"); **`UNSAFE=false` on every line**; bad id → HTTP 404. Re-run `upload-photos` leaves demo data; the manual status flips are on a throwaway submission.

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-submit-status.mjs ops/n8n/workflows/WF-S1-submit-status.json
git commit -m "feat(submit): WF-S1 submit/status (seller-safe status projection)"
```

---

## Task 3: Status page (public, token-authorized)

**Files:** Create `functions/submit/status.js`

- [ ] **Step 1: Write `functions/submit/status.js`**

```js
// functions/submit/status.js — GET /submit/status?s=<token>  (public; token is the auth)
import { postToN8n } from "../_shared/n8n-fanout.js";
import { verifyStatusToken } from "../_shared/status-token.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'";
const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><link rel="stylesheet" href="/assets/css/styles.css"><meta name="robots" content="noindex">` +
  `<style>.track{display:flex;gap:8px;margin:16px 0}.dot{flex:1;text-align:center;padding:8px;border-radius:8px;background:#eee;color:#888;font-size:13px}.dot.on{background:#6a40c9;color:#fff}.shot{width:96px;height:96px;object-fit:cover;border-radius:8px;margin:4px}</style></head>` +
  `<body><main style="max-width:560px;margin:40px auto;padding:0 20px;font-family:system-ui,sans-serif">${body}</main></body></html>`;
const html = (title, body, status = 200) =>
  new Response(shell(title, body), { status, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": CSP } });

const invalidPage = () => html("Status link", `<h1>This link is invalid or expired</h1>
  <p>Please use the status link in your most recent Tag to Rack email, or reply to that email and we'll help.</p>`, 404);

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get("s") || "";
  const submission_id = await verifyStatusToken(env, token);
  if (!submission_id) return invalidPage();

  let data;
  try { data = await postToN8n(env, "submit/status", { submission_id }, 8000); }
  catch (_) { return html("Status", `<h1>We couldn't load your status</h1><p>Please refresh in a moment.</p>`, 502); }
  if (!data || !data.ok) return invalidPage();

  const m = data.merchant || {}, it = data.item || {}, stage = data.stage || {};
  const steps = [["received","Received"],["in_review","In review"],["decided","Decision"]];
  // map the 3-dot tracker: step 1/2/3 lights up dots progressively
  const dots = steps.map((_, i) => `<div class="dot${(stage.step||1) > i ? " on" : ""}">${esc(steps[i][1])}</div>`).join("");
  const photos = (data.photos||[]).map(p => `<img class="shot" src="${esc(p.url)}" alt="${esc(p.role)}">`).join("");
  const dropoff = data.calcom_url ? `<p><a class="btn btn-primary" href="${esc(data.calcom_url)}">Schedule your drop-off</a></p>` : "";
  const itemLine = [it.brand, it.category, it.size].filter(Boolean).map(esc).join(" · ");
  return html(`Status — ${esc(m.display_name||"Tag to Rack")}`,
    `<p style="color:${/^#[0-9a-fA-F]{6}$/.test(m.brand_color||"")?esc(m.brand_color):"#6a40c9"};font-weight:700">${esc(m.display_name||"Tag to Rack")}</p>
     <h1>${esc(stage.label||"Status")}</h1>
     <div class="track">${dots}</div>
     <p>${esc(stage.message||"")}</p>
     ${dropoff}
     <div>${photos}</div>
     <p style="color:#888;font-size:13px">Submission ${esc(data.short_id||"")} · ${itemLine}</p>
     <p style="color:#888;font-size:12px">Questions? Reply to your confirmation email.</p>`);
}
```

- [ ] **Step 2: Test against the running dev server** (start wrangler if needed: `wrangler pages dev . --port 8788 --compatibility-date 2025-05-01`; new file → mtime touch)

Mint a token for the Task-2 SID using the helper, then load the page:
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack"
(Get-Item functions/submit/status.js).LastWriteTime = Get-Date; Start-Sleep 4
$SID = "<the SID from Task 2>"
$tok = node -e "import('./functions/_shared/status-token.js').then(async m=>{const fs=require('fs');const dv=fs.readFileSync('.dev.vars','utf8').split(/\r?\n/).find(l=>/^PORTAL_SESSION_SECRET=/.test(l)).split('=').slice(1).join('=').trim();console.log(await m.mintStatusToken({PORTAL_SESSION_SECRET:dv}, process.argv[1]))})" $SID
$p = (Invoke-WebRequest -UseBasicParsing "http://localhost:8788/submit/status?s=$tok").Content
($p -match 'class="track"'); ($p -match 'r2.cloudflarestorage.com'); ($p -match 'Submission')
# tamper -> invalid page (404)
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/submit/status?s=$($tok.Substring(0,$tok.Length-2))xy" -SkipHttpErrorCheck).StatusCode
# no token -> invalid page
(Invoke-WebRequest -UseBasicParsing "http://localhost:8788/submit/status" -SkipHttpErrorCheck).StatusCode
```
Expected: first three `True`; tamper → `404`; no-token → `404`.

- [ ] **Step 3: Commit**
```bash
git add functions/submit/status.js
git commit -m "feat(submit): public seller status page (token-authorized)"
```

---

## Task 4: finalize returns status_token

**Files:** Modify `functions/submit/api/finalize.js`

- [ ] **Step 1: Import the minter + return the token**

In `functions/submit/api/finalize.js`, add the import near the top (after the existing `postToN8n` import):
```js
import { mintStatusToken } from "../../_shared/status-token.js";
```

Replace the final return (currently):
```js
  return json(200, {
    ok: true,
    short_id: (resp && resp.short_id) || body.submission_id.slice(0, 8),
  });
```
with:
```js
  let status_token = "";
  try { status_token = await mintStatusToken(env, body.submission_id); } catch (_) {}
  return json(200, {
    ok: true,
    short_id: (resp && resp.short_id) || body.submission_id.slice(0, 8),
    status_token,
  });
```

- [ ] **Step 2: Test** — finalize a submission and confirm the response carries `status_token`.

Use a fresh submission's id (or any in `received`+ state) and call finalize directly (it's idempotent):
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack"
$SID = "<a submission id>"
$r = Invoke-WebRequest -UseBasicParsing -Method POST "http://localhost:8788/submit/api/finalize" -Headers @{ "Content-Type"="application/json" } -Body (@{ submission_id = $SID } | ConvertTo-Json) -SkipHttpErrorCheck
$j = $r.Content | ConvertFrom-Json
"has_token=$([bool]$j.status_token) short_id=$($j.short_id)"
```
Expected: `has_token=True`. (If finalize returns 409 photos_incomplete for that id, pick a submission that already has 3–6 photos.)

- [ ] **Step 3: Commit**
```bash
git add functions/submit/api/finalize.js
git commit -m "feat(submit): finalize returns status_token for the confirmation link"
```

---

## Task 5: Confirmation screen — status link + Submit-another reset

**Files:** Modify `submit/portal.html`, `submit/assets/submit.js`

- [ ] **Step 1: Add a status-link placeholder to the confirmation screen**

In `submit/portal.html`, inside `<section ... data-screen-name="confirmation" ...>`, after the `<p class="lead">…confirmation-id…</p>` line (~line 300), add:
```html
      <p class="muted" id="status-link-wrap" hidden>Track it anytime: <a id="status-link" href="#">check your status</a></p>
```
The existing "Submit another item" anchor (`id="submit-another"`, ~line 304) stays — Step 3 rewires it to an in-place reset.

- [ ] **Step 2: Render the status link on finalize**

In `submit/assets/submit.js`, in `doSubmit()` where finalize succeeds (the block that sets `#confirmation-id` from `fin.short_id`, ~line 504–509), after `cid.textContent = ...`, add:
```js
      if (fin.status_token) {
        const link = $("#status-link");
        const wrap = $("#status-link-wrap");
        if (link && wrap) { link.href = "/submit/status?s=" + encodeURIComponent(fin.status_token); wrap.hidden = false; }
      }
```
(Keep the existing `clearDraft(); setScreen("confirmation");` AFTER this — but see Step 3: we must preserve contact for Submit-another, so change `clearDraft()` to a contact-preserving reset.)

- [ ] **Step 3: Make "Submit another" reuse contact + reset to item-details**

Still in `submit.js`. First, replace the `clearDraft();` call in the finalize-success block with a helper that keeps contact:
```js
      resetForNextItem();   // was: clearDraft();
      setScreen("confirmation");
```
Then add this function (near `clearDraft`, ~line 93) — it preserves the contact block in the draft and clears item/photo state:
```js
  // After a successful submission: keep contact for "submit another", drop item+photos.
  function resetForNextItem() {
    const d = readDraft();
    writeDraft({ contact: d.contact || {}, item: {} });   // keep contact, clear item
    // clear in-memory photo state
    for (const k of Object.keys(photoBlobs)) delete photoBlobs[k];
    for (const k of Object.keys(photoMeta)) delete photoMeta[k];
  }
```
Finally, rewire the "Submit another item" button to reset the wizard in-place (no full reload) and jump to item-details. Replace the static anchor behavior by intercepting its click — add to `bindNav()` (or the main click handler) :
```js
    const another = e.target.closest("#submit-another");
    if (another) {
      e.preventDefault();
      // contact is already preserved in the draft by resetForNextItem(); just clear item fields in the DOM
      const itf = $("#item-form"); if (itf && typeof itf.reset === "function") itf.reset();
      // re-hydrate contact form from draft so it's ready when they reach the contact step
      const d = readDraft();
      if (d.contact) { const cf = $("#contact-form"); if (cf) { for (const [k,v] of Object.entries(d.contact)) { const el = cf.elements[k]; if (el && typeof v !== "object") { if (el.type === "checkbox") el.checked = !!v; else el.value = v; } } } }
      window.scrollTo(0, 0);
      setScreen("item-details");
      return;
    }
```
(Use the existing `readDraft`/`writeDraft`/`$`/`photoBlobs`/`photoMeta`/`setScreen` names already in `submit.js` — confirm exact names while editing; they appear around lines 18, 83–93, 112–116.)

- [ ] **Step 4: Test the round trip** (dev server; portal.html/submit.js are static assets — a hard refresh picks them up, no mtime touch needed for non-Function files, but restart wrangler if assets seem cached)

Open `http://localhost:8788/submit/m/demo-pass` in a browser. Complete a submission (3 photos). On the confirmation screen:
- the **"check your status"** link is visible and opens the status page for that submission;
- click **"Submit another item"** → lands on the **item-details** step, the **contact info is still remembered** (advance to the contact step to confirm name/email are pre-filled), and the **previous photos are gone**;
- finalize the second item → a second card appears in the merchant queue (auto-AI-trigger). Verify via:
```powershell
docker exec -e PGPASSWORD=<PG_PASSWORD> tt_pg psql -U tagtorack -d tagtorack_app -c "SELECT left(id::text,8), status, submitted_at FROM seller_submissions WHERE merchant_id='255e6d84-f2b8-4549-9754-514839841a84' ORDER BY submitted_at DESC LIMIT 3;"
```
Expected: two recent submissions from the same session, both progressing past `received`.

- [ ] **Step 5: Commit**
```bash
git add submit/portal.html submit/assets/submit.js
git commit -m "feat(submit): confirmation status link + Submit-another contact-preserving reset"
```

---

## Task 6: WF-5 seller email includes the status link

**Files:** Modify `ops/n8n/build-wf5.mjs`; redeploy WF-5

- [ ] **Step 1: Mint the token + append the link to the seller email**

In `ops/n8n/build-wf5.mjs`, in the Process node code (where emails are assembled), the seller email is pushed (~the `emails.push({ ... kind:'seller' })` block). The Process node has `claim.submission_id` and `$env`. Just above the seller `emails.push`, mint the token and build the URL:
```js
const crypto = require('crypto');
const statusBase = ($env.SUBMIT_PUBLIC_BASE || 'https://submit.tagtorack.com').replace(/\\/$/,'');
const _sid = claim.submission_id;
const _sig = crypto.createHmac('sha256', $env.PORTAL_SESSION_SECRET || '').update(_sid).digest('base64').replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const _encId = Buffer.from(_sid).toString('base64').replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const statusUrl = statusBase + '/submit/status?s=' + _encId + '.' + _sig;
```
Then change the seller email's `html` to append the link, i.e. replace:
```js
  html: wrap('Hi ' + (claim.seller_name || 'there') + ',', '<p>' + sellerMsg + '</p>'),
```
with:
```js
  html: wrap('Hi ' + (claim.seller_name || 'there') + ',', '<p>' + sellerMsg + '</p><p><a href="' + statusUrl + '">Check your status</a></p>'),
```
> The base64url encoding here MUST match `status-token.js` exactly: base64 → `+`→`-`, `/`→`_`, strip `=`. `Buffer.from(sid).toString('base64')` of the 36-char UUID string == `b64urlStr(submission_id)` in the helper. (Crypto require is already allowed: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.)

- [ ] **Step 2: Rebuild + redeploy WF-5** (build script writes the canonical path; WF-5 id `AQ3ruEuHhibMl2oH`)
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack\ops\n8n"; node build-wf5.mjs
node n8n-api.mjs PUT /workflows/AQ3ruEuHhibMl2oH workflows/WF-5-submission-received.json 2>$null | Out-Null
node n8n-api.mjs POST /workflows/AQ3ruEuHhibMl2oH/activate 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('WF-5 active='+JSON.parse(d).active))"
```
Expected: `active=true`.

- [ ] **Step 3: Test — the seller email contains a WORKING status link**

Fresh submission → WF-5 emails the seller → extract the link from Mailpit → confirm it loads the status page (the n8n-minted token must verify on the Pages side, proving the shared secret matches):
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack\ops\n8n"
$out = node upload-photos.mjs 21 2>&1; $SID = ($out | Select-String 'SID=(.+)').Matches.Groups[1].Value.Trim()
Start-Sleep 8   # let WF-5 finish + email
$msg = ((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/messages").Content | ConvertFrom-Json).messages | Where-Object { $_.Subject -like "*Tag to Rack submission*" } | Select-Object -First 1
$body = ((Invoke-WebRequest -UseBasicParsing "http://localhost:8025/api/v1/message/$($msg.ID)").Content | ConvertFrom-Json).HTML
$link = ([regex]'/submit/status\?s=([^"&]+)').Match($body).Value
Write-Output "email status link: $link"
(Invoke-WebRequest -UseBasicParsing ("http://localhost:8788" + $link)).StatusCode   # 200 -> n8n token verified by Pages
```
Expected: a `/submit/status?s=...` link is present; loading it on the Pages dev server returns `200` (the n8n-minted token verified — confirms the shared secret).

- [ ] **Step 4: Commit**
```bash
git add ops/n8n/build-wf5.mjs ops/n8n/workflows/WF-5-submission-received.json
git commit -m "feat(submit): WF-5 seller email includes status link"
```

---

## Task 7: End-to-end + cleanup + docs

**Files:** none (verification); then docs.

- [ ] **Step 1: Full seller journey** — at `http://localhost:8788/submit/m/demo-pass`: submit an item → confirmation shows the status link → open it (In review) → (in another tab, approve it via `/admin` or `merchant/decide`) → reload the status page → shows **Approved** + the **Schedule your drop-off** button. Then back on confirmation, **Submit another** → contact preserved → second item submitted.

- [ ] **Step 2: Security sweep**
  - Status page is reachable WITHOUT any cookie (public) — confirmed by Tasks 3/6 tests.
  - Tampered/garbage/no token → friendly 404 page, no data.
  - `submit/status` JSON contains NONE of: `confidence`, `internal_note`, `decision` (raw label), `brand_detected`, `*_reasons` — re-assert with a quick grep of a live response (Task 2 Step 3 already checks `UNSAFE=false`).

- [ ] **Step 3: Confirm WF-S1 active + WF-5 still active**
```powershell
Set-Location "C:\AI\Business Owners\TagtoRack\ops\n8n"; node n8n-api.mjs GET /workflows 2>$null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.data||[]).filter(w=>/WF-S1|submission-received/.test(w.name)).map(w=>w.name+'='+w.active).join('\n'))})"
```
Expected: `WF-S1 submit-status=true` and `WF-5 submission-received=true`.

- [ ] **Step 4: Stop wrangler, clean scratch `_*.json`/`_*.mjs`, confirm tree clean** (only intended files changed).

- [ ] **Step 5: Update docs** — append a "Seller Status + Submit-Another — DONE" note to `~/.claude/plans/transient-soaring-key.md` (WF-S1 id, the `/submit/status` route + token scheme, the n8n `PORTAL_SESSION_SECRET` addition, finalize's `status_token`) and update the `tagtorack-architecture` memory's seller section.

- [ ] **Step 6: Final commit**
```bash
git add -A ops/n8n docs
git commit -m "docs(submit): record seller status + submit-another completion"
```

---

## Self-review notes (spec coverage)

- **Stateless HMAC token (reuse PORTAL_SESSION_SECRET)** → Task 1 helper + Task 0 (n8n gets the secret). ✓
- **`submit/status` webhook, seller-safe only** → Task 2 (explicit field selection + `UNSAFE=false` assertion). ✓
- **Status→stage mapping** → Task 2 `stageFor()` (matches the spec table incl. merchant_review/ai_borderline both "In review"; ai_failed/merchant_rejected "Decision made"). ✓
- **Public token-authorized page + friendly invalid page** → Task 3. ✓
- **finalize returns status_token** → Task 4. ✓
- **Confirmation status link + Submit-another (keep contact, clear item/photos, → item-details)** → Task 5. ✓
- **WF-5 email status link (n8n mints matching token)** → Task 6 (base64url encoding matched to the helper). ✓
- **Each item still independent submit/start→finalize→WF-5** → unchanged; Task 5 Step 4 verifies a 2nd queue card. ✓
- **No DB schema change** → confirmed (only reads + presign). ✓

## Out of scope (per spec)
True multi-item batch upload; raising the 1–6 photo cap; status-page reschedule/cancel; relaxing the seller rate limit; seller login/account.
