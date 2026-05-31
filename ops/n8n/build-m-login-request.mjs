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
