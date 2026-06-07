// ops/n8n/build-contact-lead.mjs
// Builds WF-LEAD contact-capture -> writes workflows/WF-LEAD-contact.json
//
// Webhook POST contact/lead { name, store, email, phone, contact_pref, notes }
//   -> upsert into the leads table (so website demo requests become a real CRM
//      list and show up in the morning brief).
//
// Called fire-and-forget from functions/api/contact.js via postToN8nFireAndForget,
// so it never blocks or breaks the existing Resend email path.
//
// Deploy:
//   node ops/n8n/build-contact-lead.mjs
//   node ops/n8n/n8n-api.mjs POST /workflows ops/n8n/workflows/WF-LEAD-contact.json
//   node ops/n8n/n8n-api.mjs POST /workflows/<id>/activate
import { writeFileSync } from "node:fs";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

// Validate + shape into a single payload object (flow embedded for the SQL guard).
const shapeCode = `
const b = ($json.body) || {};
const clip = (s) => (typeof s === 'string' ? s.slice(0, 2000).trim() : '');
const email = clip(b.email).toLowerCase();
const name = clip(b.name);
const store = clip(b.store);
const okEmail = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
if (!okEmail || !name || !store) {
  return [{ json: { statusCode: 400, body: { ok: false, error: 'missing_fields' }, payload: { flow: 'bad' } } }];
}
let pref = clip(b.contact_pref).toLowerCase();
if (!['email','text','either'].includes(pref)) pref = 'email';
const payload = { flow: 'ok', email, name, store, phone: clip(b.phone), contact_pref: pref, notes: clip(b.notes) };
return [{ json: { statusCode: 200, body: { ok: true }, payload } }];
`.trim();

// Single jsonb param ($1). Inserts only when flow='ok'; upserts on the unique email.
const insertSql = `
WITH inp AS (SELECT $1::jsonb AS d)
INSERT INTO leads (email, name, store, phone, contact_pref, notes, source, status)
SELECT d->>'email', d->>'name', d->>'store', NULLIF(d->>'phone',''),
       d->>'contact_pref', NULLIF(d->>'notes',''), 'web_form', 'new'
FROM inp
WHERE (d->>'flow') = 'ok'
ON CONFLICT (email) DO UPDATE SET
  name         = EXCLUDED.name,
  store        = EXCLUDED.store,
  phone        = COALESCE(EXCLUDED.phone, leads.phone),
  contact_pref = EXCLUDED.contact_pref,
  notes        = COALESCE(EXCLUDED.notes, leads.notes),
  last_activity_at = NOW()
RETURNING id, (xmax = 0) AS inserted;
`.trim();

const wf = {
  name: "WF-LEAD contact-capture",
  nodes: [
    { parameters: { httpMethod: "POST", path: "contact/lead", responseMode: "responseNode", options: {} },
      id: "lead-wh", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [-220, 0], webhookId: "contact-lead-wh" },
    { parameters: { jsCode: shapeCode },
      id: "lead-shape", name: "Shape", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0] },
    { parameters: { operation: "executeQuery", query: insertSql,
        options: { queryReplacement: "={{ JSON.stringify($json.payload || { flow: 'bad' }) }}" } },
      id: "lead-insert", name: "Insert lead", type: "n8n-nodes-base.postgres", typeVersion: 2.5, position: [220, 0],
      credentials: { postgres: PG_CRED }, alwaysOutputData: true },
    { parameters: { respondWith: "json", responseBody: "={{ $('Shape').first().json.body }}",
        options: { responseCode: "={{ $('Shape').first().json.statusCode }}" } },
      id: "lead-respond", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [440, 0] },
  ],
  connections: {
    Webhook: { main: [[{ node: "Shape", type: "main", index: 0 }]] },
    Shape: { main: [[{ node: "Insert lead", type: "main", index: 0 }]] },
    "Insert lead": { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1" },
};

writeFileSync(new URL("./workflows/WF-LEAD-contact.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote workflows/WF-LEAD-contact.json (" + JSON.stringify(wf).length + " bytes)");
