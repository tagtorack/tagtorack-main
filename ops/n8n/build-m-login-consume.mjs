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
