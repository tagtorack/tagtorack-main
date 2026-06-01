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
