// ops/n8n/build-m-decide.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Verify ownership + state, flip status, invalidate tokens. Always one row.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sub AS (
  SELECT s.id, s.status, left(s.id::text,8) AS short_id,
         m.display_name AS merchant_name, m.calcom_event_url,
         se.email AS seller_email, se.name AS seller_name,
         se.phone AS seller_phone, se.sms_consent, se.sms_opted_out_at
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
       (SELECT calcom_event_url FROM sub) AS calcom_event_url,
       (SELECT seller_phone FROM sub) AS seller_phone,
       (SELECT sms_consent FROM sub) AS sms_consent,
       (SELECT sms_opted_out_at FROM sub) AS sms_opted_out_at;
`.trim();

const notify = `
const r = $json;
if (!r.found) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
if (!r.new_status) {
  // already decided (not in merchant_review) — idempotent no-op, no email
  return [{ json: { statusCode: 200, body: { ok:true, status: r.prev_status, already: true } } }];
}
// approve -> notify the seller (email + opt-in SMS) with the Cal.com drop-off link
if (r.new_status === 'merchant_approved') {
  const cal = r.calcom_event_url || ($env.CALCOM_BOOKING_URL || '');

  // --- Email (Cal.com drop-off link), gated on TT_AUTOSEND_ENABLED ---
  const emailEnabled = String($env.TT_AUTOSEND_ENABLED || '').toLowerCase() === 'true';
  if (emailEnabled) {
    const transport = ($env.EMAIL_TRANSPORT || 'mailpit').toLowerCase();
    const from = $env.FROM_EMAIL || 'submissions@tagtorack.com';
    const fromAddr = from.includes('<') ? (from.match(/<([^>]+)>/) || [,from])[1] : from;
    const subject = (r.merchant_name || 'The store') + ' approved your item (' + r.short_id + ')';
    const html = '<div style="font-family:sans-serif;max-width:520px"><h2>Good news, ' + (r.seller_name || 'there') + '</h2>' +
      '<p>' + (r.merchant_name || 'The store') + ' approved your item. Book a drop-off time:</p>' +
      '<p><a href="' + cal + '">Schedule your drop-off</a></p></div>';
    try {
      if (transport === 'resend') {
        await this.helpers.httpRequest({ method:'POST', url:'https://api.resend.com/emails',
          headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + $env.RESEND_API_KEY },
          body:{ from:'Tag to Rack <' + fromAddr + '>', to:[r.seller_email], subject, html }, json:true });
      } else {
        await this.helpers.httpRequest({ method:'POST', url:'http://mailpit:8025/api/v1/send',
          headers:{ 'Content-Type':'application/json' },
          body:{ From:{ Email: fromAddr, Name:'Tag to Rack' }, To:[{ Email: r.seller_email }], Subject: subject, HTML: html }, json:true });
      }
    } catch (e) { /* best effort */ }
  }

  // --- SMS (opt-in, flag-gated), parallel to email. Sends only when:
  //     TT_SMS_ENABLED=true AND seller consented AND not opted out AND a usable
  //     phone is present. STOP/opt-out is enforced via sms_opted_out_at. ---
  const smsEnabled = String($env.TT_SMS_ENABLED || '').toLowerCase() === 'true';
  // Normalize to E.164 (US default): strip non-digits, prepend +1 for 10-digit numbers.
  let toNum = String(r.seller_phone || '').replace(/[^0-9]/g, '');
  if (toNum.length === 10) toNum = '1' + toNum;
  toNum = toNum ? '+' + toNum : '';
  if (smsEnabled && r.sms_consent && !r.sms_opted_out_at && toNum.length >= 12) {
    const sid = $env.TWILIO_ACCOUNT_SID || '';
    const tok = $env.TWILIO_AUTH_TOKEN || '';
    const msgSvc = $env.TWILIO_MESSAGING_SERVICE_SID || '';
    const fromNum = $env.TWILIO_FROM_NUMBER || '';
    const smsBody = (r.merchant_name || 'The store') + ' approved your item! Book a drop-off: ' + cal + ' Reply STOP to opt out.';
    if (sid && tok && (msgSvc || fromNum)) {
      try {
        const form = new URLSearchParams();
        form.append('To', toNum);
        if (msgSvc) form.append('MessagingServiceSid', msgSvc); else form.append('From', fromNum);
        form.append('Body', smsBody);
        await this.helpers.httpRequest({ method:'POST',
          url:'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json',
          headers:{ 'Content-Type':'application/x-www-form-urlencoded',
            'Authorization':'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') },
          body: form.toString() });
      } catch (e) { /* best effort */ }
    }
  }
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
