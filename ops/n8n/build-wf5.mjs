// Builds WF-5 Submission-Received (the AI core) → writes wf5.json.
// Linear no-branch design (a `flow` flag threads through; single Respond),
// matching WF-2/3/4. Trigger: POST submit/process { submission_id }.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };
const SYSTEM_PROMPT = readFileSync(resolve(process.cwd(), "prompts", "submit-vision-system.md"), "utf8");

// ---------- Node 2: Claim (always returns exactly one row) ----------
const claimSql = `
WITH input AS (SELECT $1::jsonb AS d),
claimed AS (
  UPDATE seller_submissions SET status='ai_reviewing'
  WHERE id = NULLIF((SELECT d->>'submission_id' FROM input),'')::uuid AND status='received'
  RETURNING id, merchant_id, seller_id, item_description, declared_brand, declared_category,
            declared_size, declared_condition, asking_price_usd, notes
)
SELECT
  (SELECT count(*) FROM claimed) > 0 AS claimed,
  c.id AS submission_id, left(c.id::text,8) AS short_id, c.merchant_id, c.seller_id,
  c.item_description, c.declared_brand, c.declared_category, c.declared_size,
  c.declared_condition, c.asking_price_usd, c.notes,
  m.slug AS merchant_slug, m.display_name AS merchant_name, m.contact_email AS merchant_email,
  m.calcom_event_url, m.rule_set,
  se.email AS seller_email, se.name AS seller_name,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord,'content_type',p.content_type) ORDER BY p.ord),'[]'::jsonb)
   FROM submission_photos p WHERE p.submission_id = c.id) AS photos
FROM (SELECT 1) dummy
LEFT JOIN claimed c ON true
LEFT JOIN merchants m ON m.id = c.merchant_id
LEFT JOIN sellers se ON se.id = c.seller_id;
`.trim();

// ---------- Node 3: Gating (pick pro/flash/none/skip, increment usage) ----------
// Selection only — the usage counter is incremented in Persist for the model
// actually used (Vision may fall back pro->flash on a 429).
const gateSql = `
WITH inp AS (SELECT $1::jsonb AS d),
cur AS (
  SELECT
    coalesce((SELECT request_count FROM gemini_usage WHERE day=current_date AND model='pro'),0) AS pro_n,
    coalesce((SELECT request_count FROM gemini_usage WHERE day=current_date AND model='flash'),0) AS flash_n
)
SELECT CASE
  WHEN (SELECT (d->>'claimed')::boolean FROM inp) IS NOT TRUE THEN 'skip'
  WHEN (SELECT pro_n FROM cur) < (SELECT (d->>'pro_cap')::int FROM inp) THEN 'pro'
  WHEN (SELECT flash_n FROM cur) < (SELECT (d->>'flash_cap')::int FROM inp) THEN 'flash'
  ELSE 'none' END AS model;
`.trim();

// ---------- Node 4: Vision (R2 presign + fetch + base64 + Gemini) ----------
const visionCode = `
const crypto = require('crypto');
const claim = $('Claim').first().json;
const gate = $json;                       // { model, count }
const model = gate.model;

// skip: submission was not claimable (not 'received' / not found)
if (model === 'skip') {
  return [{ json: { flow: 'skip', statusCode: 409, body: { ok:false, error:'not_claimable' } } }];
}

// pro->flash fallback on error (free-tier pro often 429s). Attempt order:
const ATTEMPTS = model === 'pro' ? ['gemini-2.5-pro', 'gemini-2.5-flash'] : ['gemini-2.5-flash'];

// ---- R2 SigV4 GET presign ----
function presignGet(r2key, expiresSec) {
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
  const sig=hmac(k,sts).toString('hex');
  return 'https://'+host+uri+'?'+qs+'&X-Amz-Signature='+sig;
}

const RESPONSE_SCHEMA = ${JSON.stringify({
  type: "OBJECT",
  properties: {
    decision: { type: "STRING", enum: ["PASS", "FAIL", "BORDERLINE"] },
    confidence: { type: "NUMBER" },
    brand_detected: { type: "STRING", nullable: true },
    brand_confidence: { type: "NUMBER" },
    category_detected: { type: "STRING" },
    size_detected: { type: "STRING", nullable: true },
    condition_assessment: { type: "STRING", enum: ["new_with_tags", "excellent", "good", "fair", "poor"] },
    flaws_observed: { type: "ARRAY", items: { type: "STRING" } },
    estimated_retail_value_usd: { type: "NUMBER", nullable: true },
    estimated_resale_value_usd: { type: "NUMBER", nullable: true },
    rule_evaluation: { type: "OBJECT", properties: {
      brand_allowed: { type: "BOOLEAN" }, category_allowed: { type: "BOOLEAN" },
      condition_above_floor: { type: "BOOLEAN" },
      price_in_range: { type: "BOOLEAN", nullable: true }, seasonality_match: { type: "BOOLEAN", nullable: true } },
      required: ["brand_allowed","category_allowed","condition_above_floor","price_in_range","seasonality_match"] },
    pass_reasons: { type: "ARRAY", items: { type: "STRING" } },
    fail_reasons: { type: "ARRAY", items: { type: "STRING" } },
    borderline_reasons: { type: "ARRAY", items: { type: "STRING" } },
    seller_message: { type: "STRING" },
    internal_note: { type: "STRING" },
  },
  required: ["decision","confidence","brand_detected","brand_confidence","category_detected","size_detected","condition_assessment","flaws_observed","estimated_retail_value_usd","estimated_resale_value_usd","rule_evaluation","pass_reasons","fail_reasons","borderline_reasons","seller_message","internal_note"],
})};

const SYSTEM_PROMPT = ${JSON.stringify(SYSTEM_PROMPT)};

// capacity exhausted -> synthetic BORDERLINE, no Gemini call
if (model === 'none') {
  return [{ json: { flow:'decided', model_used:'none', model_short:'none', usage:{}, raw:{capacity:'exhausted'},
    decision: { decision:'BORDERLINE', confidence:0.0, brand_detected:null, brand_confidence:0,
      category_detected: claim.declared_category||'', size_detected: claim.declared_size||null,
      condition_assessment:'good', flaws_observed:[], estimated_retail_value_usd:null, estimated_resale_value_usd:null,
      rule_evaluation:{brand_allowed:true,category_allowed:true,condition_above_floor:true,price_in_range:null,seasonality_match:null},
      pass_reasons:[], fail_reasons:[], borderline_reasons:['Daily AI capacity reached — routed to human review'],
      seller_message:'Thanks for your submission. Our team is taking a closer look and will respond within 24 hours.',
      internal_note:'Gemini daily cap reached; auto-routed to BORDERLINE for human review.' },
    override_reason:'capacity_exhausted' } }];
}

// build description + photo parts
const ruleSet = claim.rule_set || {};
const descParts = [];
if (claim.item_description) descParts.push('Item: ' + claim.item_description + '.');
if (claim.declared_brand) descParts.push('Brand (seller-declared): ' + claim.declared_brand + '.');
if (claim.declared_size) descParts.push('Size: ' + claim.declared_size + '.');
if (claim.asking_price_usd != null) descParts.push('Asking price: $' + claim.asking_price_usd + '.');
if (claim.declared_condition) descParts.push('Seller condition: ' + claim.declared_condition + '.');
if (claim.notes) descParts.push('Notes: ' + claim.notes);
const description = descParts.join(' ');

const parts = [{ text: 'Merchant rule set:\\n' + JSON.stringify(ruleSet) + '\\n\\nSeller description:\\n' + description + '\\n\\nThe photos of the item follow as inline images.' }];
for (const p of (claim.photos || [])) {
  const url = presignGet(p.r2_key, 600);
  const ab = await this.helpers.httpRequest({ method:'GET', url, encoding:'arraybuffer' });
  const b64 = Buffer.from(ab).toString('base64');
  parts.push({ inline_data: { mime_type: p.content_type || 'image/jpeg', data: b64 } });
}

const reqBody = { systemInstruction:{ parts:[{ text: SYSTEM_PROMPT }] }, contents:[{ role:'user', parts }],
  generationConfig:{ responseMimeType:'application/json', responseSchema: RESPONSE_SCHEMA, temperature:0.2 } };

let decision, usage = {}, raw = {}, usedId = null, lastErr = null;
for (const mid of ATTEMPTS) {
  try {
    const r = await this.helpers.httpRequest({
      method:'POST',
      url:'https://generativelanguage.googleapis.com/v1beta/models/' + mid + ':generateContent',
      headers:{ 'Content-Type':'application/json', 'x-goog-api-key': $env.GEMINI_API_KEY },
      body: reqBody, json: true });
    const txt = (r.candidates && r.candidates[0] && r.candidates[0].content && r.candidates[0].content.parts || []).map(x=>x.text||'').join('');
    decision = JSON.parse(txt);
    raw = r; usage = r.usageMetadata || {}; usedId = mid;
    break;
  } catch (e) { lastErr = e; }
}
if (!usedId) {
  // every attempt failed -> BORDERLINE so the submission is never stuck
  return [{ json: { flow:'decided', model_used:'none', model_short:'none', usage:{}, raw: { error: String(lastErr) },
    decision: { decision:'BORDERLINE', confidence:0.0, brand_detected:null, brand_confidence:0,
      category_detected: claim.declared_category||'', size_detected: claim.declared_size||null,
      condition_assessment:'good', flaws_observed:[], estimated_retail_value_usd:null, estimated_resale_value_usd:null,
      rule_evaluation:{brand_allowed:true,category_allowed:true,condition_above_floor:true,price_in_range:null,seasonality_match:null},
      pass_reasons:[], fail_reasons:[], borderline_reasons:['AI review error — routed to human review'],
      seller_message:'Thanks for your submission. Our team is taking a closer look and will respond within 24 hours.',
      internal_note:'Gemini call failed: ' + String(lastErr).slice(0,200) },
    override_reason:'ai_error' } }];
}
const model_short = usedId.indexOf('pro') >= 0 ? 'pro' : 'flash';
return [{ json: { flow:'decided', model_used: usedId, model_short, usage, raw, decision, override_reason:null } }];
`.trim();

// ---------- Node 5: Process (overrides, status route, tokens, emails) ----------
const processCode = `
const crypto = require('crypto');
const v = $json;
if (v.flow === 'skip') return [{ json: { flow:'skip', statusCode: v.statusCode, body: v.body } }];

const claim = $('Claim').first().json;
let d = v.decision || {};
let override_reason = v.override_reason || null;

// safety override: a low-confidence PASS becomes BORDERLINE
let decision = d.decision;
if (decision === 'PASS' && Number(d.confidence) < 0.85) { decision = 'BORDERLINE'; override_reason = 'confidence_pass_to_borderline'; }
if (!['PASS','FAIL','BORDERLINE'].includes(decision)) { decision = 'BORDERLINE'; override_reason = override_reason || 'invalid_decision'; }

const status = decision === 'PASS' ? 'merchant_review' : decision === 'FAIL' ? 'ai_failed' : 'ai_borderline';
const usage = v.usage || {};
const base = ($env.SUBMIT_PUBLIC_BASE || 'https://tagtorack.com').replace(/\\/$/, '');

// mint approve/reject tokens on PASS
let tokens = [];
if (decision === 'PASS') {
  for (const action of ['approve','reject']) {
    const rawTok = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawTok).digest('hex');
    tokens.push({ action, hash, link: base + '/submit/decision?t=' + rawTok });
  }
}
const approveLink = (tokens.find(t=>t.action==='approve')||{}).link || '';
const rejectLink  = (tokens.find(t=>t.action==='reject')||{}).link || '';

// renamed value fields for the DB
const retail = d.estimated_retail_value_usd;
const resale = d.estimated_resale_value_usd;

const decision_row = {
  flow: 'decided',
  submission_id: claim.submission_id,
  merchant_id: claim.merchant_id,
  status,
  model: v.model_used || 'gemini-2.5-pro',
  model_short: v.model_short || 'none',
  decision,
  confidence: d.confidence != null ? d.confidence : 0,
  brand_detected: d.brand_detected || null,
  brand_confidence: d.brand_confidence != null ? d.brand_confidence : null,
  category_detected: d.category_detected || '',
  size_detected: d.size_detected || null,
  condition_assessment: d.condition_assessment || 'good',
  flaws_observed: d.flaws_observed || [],
  estimated_retail_usd: retail != null ? retail : null,
  estimated_resale_usd: resale != null ? resale : null,
  rule_evaluation: d.rule_evaluation || {},
  pass_reasons: d.pass_reasons || [],
  fail_reasons: d.fail_reasons || [],
  borderline_reasons: d.borderline_reasons || [],
  seller_message: d.seller_message || '',
  internal_note: d.internal_note || '',
  raw_response: v.raw || {},
  prompt_tokens: usage.promptTokenCount || 0,
  output_tokens: usage.candidatesTokenCount || 0,
  thoughts_tokens: usage.thoughtsTokenCount || 0,
  override_reason,
  tokens: tokens.map(t => ({ action: t.action, hash: t.hash })),
  audit_payload: { decision, confidence: d.confidence, model: v.model_used, override_reason },
};

// ---- build emails (seller always; merchant on PASS; operator on BORDERLINE) ----
const merchantName = claim.merchant_name || 'the store';
const sellerMsg = (d.seller_message || '').replace(/\\{\\{\\s*merchant_name\\s*\\}\\}/g, merchantName);
const fromEmail = $env.FROM_EMAIL || 'submissions@tagtorack.com';
const wrap = (title, bodyHtml) => '<div style="font-family:sans-serif;max-width:560px"><h2>' + title + '</h2>' + bodyHtml + '<hr><p style="color:#888;font-size:12px">Tag to Rack</p></div>';

// Status link token — base64url encoding MUST match functions/_shared/status-token.js
// (base64 -> +→-, /→_, strip =), signed over the raw submission_id with the shared secret.
const _crypto = require('crypto');
const _statusBase = ($env.SUBMIT_PUBLIC_BASE || 'https://tagtorack.com').replace(/\\/$/, '');
const _sid = claim.submission_id;
const _b64url = (b) => b.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const _encId = _b64url(Buffer.from(_sid, 'utf8').toString('base64'));
const _sig = _b64url(_crypto.createHmac('sha256', $env.PORTAL_SESSION_SECRET || '').update(_sid).digest('base64'));
const statusUrl = _statusBase + '/submit/status?s=' + _encId + '.' + _sig;

const emails = [];
// seller
emails.push({
  to: claim.seller_email, toName: claim.seller_name || '',
  subject: 'Your Tag to Rack submission (' + claim.short_id + ')',
  html: wrap('Hi ' + (claim.seller_name || 'there') + ',', '<p>' + sellerMsg + '</p><p><a href="' + statusUrl + '">Check your status</a></p>'),
  kind: 'seller',
});
if (decision === 'PASS') {
  const itemLine = [claim.declared_brand, claim.item_description].filter(Boolean).join(' — ');
  emails.push({
    to: claim.merchant_email, toName: merchantName,
    subject: 'New submission to review (' + claim.short_id + ')',
    html: wrap('New item for ' + merchantName,
      '<p><b>' + (itemLine || 'Item') + '</b></p>' +
      '<p>Condition: ' + (d.condition_assessment || 'n/a') + ' · Est. resale: ' + (resale != null ? '$' + resale : 'n/a') + '</p>' +
      '<p>AI notes: ' + (d.internal_note || '') + '</p>' +
      '<p><a href="' + approveLink + '">Approve</a> &nbsp;|&nbsp; <a href="' + rejectLink + '">Reject</a></p>'),
    kind: 'merchant',
  });
} else if (decision === 'BORDERLINE') {
  emails.push({
    to: $env.OPERATOR_ESCALATION_EMAIL || 'cmcelvain@pivothh.com', toName: 'Conner',
    subject: 'BORDERLINE submission needs review (' + claim.short_id + ')',
    html: wrap('Borderline submission ' + claim.short_id,
      '<p>Merchant: ' + merchantName + '</p><p>Reasons: ' + (d.borderline_reasons || []).join('; ') + '</p>' +
      '<p>Internal: ' + (d.internal_note || '') + '</p>'),
    kind: 'operator',
  });
}

return [{ json: {
  flow: 'decided',
  persist: decision_row,
  emails,
  fromEmail,
  statusCode: 200,
  body: { ok: true, decision, status, short_id: claim.short_id },
} }];
`.trim();

// ---------- Node 6: Persist (decision + status + audit + tokens) ----------
const persistSql = `
WITH inp AS (SELECT $1::jsonb AS d),
dec AS (
  INSERT INTO submission_decisions (submission_id, model, decision, confidence, brand_detected, brand_confidence,
    category_detected, size_detected, condition_assessment, flaws_observed, estimated_retail_usd, estimated_resale_usd,
    rule_evaluation, pass_reasons, fail_reasons, borderline_reasons, seller_message, internal_note, raw_response,
    prompt_tokens, output_tokens, thoughts_tokens, override_reason)
  SELECT (d->>'submission_id')::uuid, d->>'model', d->>'decision', (d->>'confidence')::numeric,
    d->>'brand_detected', NULLIF(d->>'brand_confidence','')::numeric, d->>'category_detected', d->>'size_detected',
    d->>'condition_assessment', coalesce(d->'flaws_observed','[]'::jsonb), NULLIF(d->>'estimated_retail_usd','')::numeric,
    NULLIF(d->>'estimated_resale_usd','')::numeric, coalesce(d->'rule_evaluation','{}'::jsonb),
    coalesce(d->'pass_reasons','[]'::jsonb), coalesce(d->'fail_reasons','[]'::jsonb), coalesce(d->'borderline_reasons','[]'::jsonb),
    d->>'seller_message', d->>'internal_note', coalesce(d->'raw_response','{}'::jsonb),
    coalesce((d->>'prompt_tokens')::int,0), coalesce((d->>'output_tokens')::int,0), coalesce((d->>'thoughts_tokens')::int,0),
    d->>'override_reason'
  FROM inp WHERE (d->>'flow')='decided'
  RETURNING id
),
upd AS (
  UPDATE seller_submissions SET status = (SELECT d->>'status' FROM inp), ai_reviewed_at = NOW()
  WHERE id = (SELECT (d->>'submission_id')::uuid FROM inp) AND (SELECT d->>'flow' FROM inp)='decided'
  RETURNING id
),
aud AS (
  INSERT INTO audit_log (agent_run_id, event_type, payload, confidence, decision, submission_id)
  SELECT gen_random_uuid(), 'agent_output', coalesce(d->'audit_payload','{}'::jsonb),
         NULLIF(d->>'confidence','')::numeric, d->>'decision', (d->>'submission_id')::uuid
  FROM inp WHERE (d->>'flow')='decided'
  RETURNING id
),
tok AS (
  INSERT INTO decision_tokens (token_hash, submission_id, merchant_id, action, expires_at)
  SELECT t->>'hash', (SELECT (d->>'submission_id')::uuid FROM inp), (SELECT (d->>'merchant_id')::uuid FROM inp),
         t->>'action', NOW() + INTERVAL '7 days'
  FROM inp, jsonb_array_elements(coalesce((SELECT d->'tokens' FROM inp),'[]'::jsonb)) t
  WHERE (SELECT d->>'flow' FROM inp)='decided'
  RETURNING token_hash
),
uinc AS (
  INSERT INTO gemini_usage(day, model, request_count)
  SELECT current_date, d->>'model_short', 1 FROM inp
  WHERE (d->>'flow')='decided' AND (d->>'model_short') IN ('pro','flash')
  ON CONFLICT (day,model) DO UPDATE SET request_count = gemini_usage.request_count + 1
  RETURNING model
)
SELECT (SELECT id::text FROM dec) AS decision_id, (SELECT count(*) FROM tok) AS tokens_minted, (SELECT model FROM uinc) AS usage_model;
`.trim();

// ---------- Node 7: Autosend (Mailpit in dev, Resend in prod) ----------
const autosendCode = `
const proc = $('Process').first().json;
if (proc.flow === 'skip') return [{ json: { statusCode: proc.statusCode, body: proc.body } }];

const enabled = String($env.TT_AUTOSEND_ENABLED || '').toLowerCase() === 'true';
const transport = ($env.EMAIL_TRANSPORT || 'mailpit').toLowerCase();
const from = proc.fromEmail || 'submissions@tagtorack.com';
const fromAddr = from.includes('<') ? (from.match(/<([^>]+)>/) || [,from])[1] : from;
let sent = 0, errors = [];

if (enabled) {
  for (const e of (proc.emails || [])) {
    try {
      if (transport === 'resend') {
        await this.helpers.httpRequest({ method:'POST', url:'https://api.resend.com/emails',
          headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + $env.RESEND_API_KEY },
          body:{ from: 'Tag to Rack <' + fromAddr + '>', to: [e.to], subject: e.subject, html: e.html }, json:true });
      } else {
        await this.helpers.httpRequest({ method:'POST', url:'http://mailpit:8025/api/v1/send',
          headers:{ 'Content-Type':'application/json' },
          body:{ From:{ Email: fromAddr, Name:'Tag to Rack' }, To:[{ Email: e.to, Name: e.toName||'' }], Subject: e.subject, HTML: e.html }, json:true });
      }
      sent++;
    } catch (err) { errors.push(e.kind + ':' + String(err)); }
  }
}

const body = Object.assign({}, proc.body, { emails_sent: sent });
if (errors.length) body.email_errors = errors;
return [{ json: { statusCode: proc.statusCode, body } }];
`.trim();

const code = (name, id, jsCode, x) => ({
  parameters: { jsCode }, id, name, type: "n8n-nodes-base.code", typeVersion: 2, position: [x, 0],
});
const pg = (name, id, query, replJson, x) => ({
  parameters: { operation: "executeQuery", query, options: { queryReplacement: replJson } },
  id, name, type: "n8n-nodes-base.postgres", typeVersion: 2.5, position: [x, 0],
  credentials: { postgres: PG_CRED }, alwaysOutputData: true,
});

const wf = {
  name: "WF-5 submission-received",
  nodes: [
    { parameters: { httpMethod: "POST", path: "submit/process", responseMode: "responseNode", options: {} },
      id: "w5", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [-200, 0], webhookId: "submit-process-wh" },
    pg("Claim", "claim", claimSql, "={{ JSON.stringify({ submission_id: $json.body.submission_id }) }}", 0),
    pg("Gating", "gate", gateSql, "={{ JSON.stringify({ claimed: $json.claimed, pro_cap: $env.TT_DAILY_PRO_CAP, flash_cap: $env.TT_DAILY_FLASH_CAP }) }}", 220),
    code("Vision", "vision", visionCode, 440),
    code("Process", "process", processCode, 660),
    pg("Persist", "persist", persistSql, "={{ JSON.stringify($json.persist || { flow: 'skip' }) }}", 880),
    code("Autosend", "autosend", autosendCode, 1100),
    { parameters: { respondWith: "json", responseBody: "={{ $json.body }}", options: { responseCode: "={{ $json.statusCode }}" } },
      id: "r5", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [1320, 0] },
  ],
  connections: {
    Webhook: { main: [[{ node: "Claim", type: "main", index: 0 }]] },
    Claim: { main: [[{ node: "Gating", type: "main", index: 0 }]] },
    Gating: { main: [[{ node: "Vision", type: "main", index: 0 }]] },
    Vision: { main: [[{ node: "Process", type: "main", index: 0 }]] },
    Process: { main: [[{ node: "Persist", type: "main", index: 0 }]] },
    Persist: { main: [[{ node: "Autosend", type: "main", index: 0 }]] },
    Autosend: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
  settings: {},
};

writeFileSync(new URL("./workflows/WF-5-submission-received.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote workflows/WF-5-submission-received.json (" + JSON.stringify(wf).length + " bytes)");
