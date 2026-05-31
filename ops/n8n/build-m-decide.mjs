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
