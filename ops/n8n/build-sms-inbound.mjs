// ops/n8n/build-sms-inbound.mjs
// WF-S2 sms/inbound — Twilio inbound SMS handler for STOP/START opt-out.
// Twilio POSTs application/x-www-form-urlencoded (From, Body, ...). We mirror the
// opt-out state into sellers.sms_opted_out_at so the WF-M4 send-gate also respects
// it. Pair this with Twilio Advanced Opt-Out (carrier-compliant auto-replies); this
// workflow returns empty TwiML so it does not double-reply.
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, linearConnections } from "./wf-lib.mjs";

// Classify the inbound keyword and normalize the sender to a US 10-digit key.
const classify = `
const b = $json.body || {};
const raw = String(b.Body || '').trim().toUpperCase();
const STOP  = ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'];
const START = ['START','UNSTOP','YES'];
let action = 'none';
if (STOP.includes(raw)) action = 'stop';
else if (START.includes(raw)) action = 'start';
const last10 = String(b.From || '').replace(/[^0-9]/g, '').slice(-10);
return [{ json: { action, last10 } }];
`.trim();

// STOP -> stamp opt-out; START -> clear it. Applies to EVERY seller row sharing
// that phone (opt-out is per-person, and sellers has one row per merchant+email).
const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
UPDATE sellers
   SET sms_opted_out_at = CASE WHEN (SELECT d->>'action' FROM inp) = 'stop' THEN NOW() ELSE NULL END
 WHERE (SELECT d->>'action' FROM inp) IN ('stop','start')
   AND length(COALESCE((SELECT d->>'last10' FROM inp), '')) = 10
   AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = (SELECT d->>'last10' FROM inp)
RETURNING id;
`.trim();

// Twilio expects TwiML. Return an empty <Response/> (no double-reply when Advanced
// Opt-Out is handling the carrier-mandated confirmations).
const respondXml = {
  parameters: {
    respondWith: "text",
    responseBody: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    options: { responseCode: 200, responseHeaders: { entries: [{ name: "Content-Type", value: "text/xml" }] } },
  },
  id: "rxml", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [440, 0],
};

const nodes = [
  webhookNode("w", "Webhook", "sms/inbound"),
  codeNode("classify", "Classify", classify, 0),
  pgNode("apply", "Apply opt-out", sql, "={{ JSON.stringify({ action: $json.action, last10: $json.last10 }) }}", 220),
  respondXml,
];
const wf = { name: "WF-S2 sms-inbound", nodes,
  connections: linearConnections(["Webhook", "Classify", "Apply opt-out", "Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-S2-sms-inbound.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-S2");
