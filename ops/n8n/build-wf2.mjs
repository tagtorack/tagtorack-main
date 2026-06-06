// Builds WF-2 submit/start workflow JSON → writes wf2.json (create body).
// Run: node build-wf2.mjs   then: node n8n-api.mjs POST /workflows wf2.json
import { writeFileSync } from "node:fs";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

const prepCode = `
const b = $json.body || {};
const item = b.item || {};
const contact = b.contact || {};
const parts = [item.brand, item.item_type, item.size]
  .map((x) => (x == null ? "" : String(x).trim()))
  .filter(Boolean);
const item_description = parts.join(" ").trim() || String(item.item_type || "item");
const ap = item.asking_price_usd;
return [{ json: { payload: {
  merchant_slug: String(b.merchant_slug || "").trim().toLowerCase(),
  email: contact.email || "",
  name: contact.name || "",
  phone: contact.phone || null,
  zip: contact.zip || null,
  consent_marketing: !!contact.consent_marketing,
  sms_consent: !!contact.sms_consent,
  item_description,
  declared_brand: item.brand || null,
  declared_category: item.item_type || null,
  declared_size: item.size || null,
  declared_condition: item.declared_condition || null,
  asking_price_usd: (ap === null || ap === undefined || ap === "") ? null : String(ap),
  notes: item.notes || null,
  user_agent: b.user_agent || "",
  ip_country: b.ip_country || "",
  ip_hash: b.ip_hash || "",
} } }];
`.trim();

const sql = `
WITH input AS (SELECT $1::jsonb AS d),
m AS (
  SELECT id AS merchant_id FROM merchants
  WHERE slug = (SELECT d->>'merchant_slug' FROM input) AND status = 'active' LIMIT 1
),
s AS (
  INSERT INTO sellers (merchant_id, email, name, phone, zip, consent_marketing, sms_consent)
  SELECT m.merchant_id,
         (SELECT d->>'email' FROM input),
         (SELECT d->>'name' FROM input),
         (SELECT d->>'phone' FROM input),
         (SELECT d->>'zip' FROM input),
         COALESCE((SELECT (d->>'consent_marketing')::boolean FROM input), false),
         COALESCE((SELECT (d->>'sms_consent')::boolean FROM input), false)
  FROM m
  ON CONFLICT (merchant_id, email) DO UPDATE
    SET name = EXCLUDED.name,
        phone = COALESCE(EXCLUDED.phone, sellers.phone),
        zip = COALESCE(EXCLUDED.zip, sellers.zip),
        sms_consent = EXCLUDED.sms_consent,
        last_activity_at = NOW()
  RETURNING id AS seller_id, merchant_id
),
ins AS (
  INSERT INTO seller_submissions
    (merchant_id, seller_id, item_description, declared_brand, declared_category,
     declared_size, declared_condition, asking_price_usd, notes, fingerprint,
     user_agent, ip_country, ip_hash)
  SELECT s.merchant_id, s.seller_id,
         i.d->>'item_description',
         i.d->>'declared_brand',
         i.d->>'declared_category',
         i.d->>'declared_size',
         i.d->>'declared_condition',
         NULLIF(i.d->>'asking_price_usd','')::numeric,
         i.d->>'notes',
         encode(digest(s.seller_id::text || lower(trim(i.d->>'item_description')), 'sha256'),'hex'),
         i.d->>'user_agent',
         i.d->>'ip_country',
         i.d->>'ip_hash'
  FROM s, input i
  ON CONFLICT (seller_id, fingerprint)
    WHERE status NOT IN ('expired','withdrawn','merchant_rejected','ai_failed','deleted')
    DO NOTHING
  RETURNING id, seller_id, merchant_id
)
SELECT
  EXISTS(SELECT 1 FROM m) AS merchant_found,
  (SELECT id::text FROM ins) AS submission_id,
  (SELECT left(id::text,8) FROM ins) AS short_id,
  (SELECT merchant_id::text FROM ins) AS merchant_id;
`.trim();

const shapeCode = `
const r = $json || {};
let statusCode, body;
if (!r.merchant_found) { statusCode = 404; body = { ok: false, error: "merchant_not_found" }; }
else if (!r.submission_id) { statusCode = 409; body = { ok: false, error: "duplicate_submission" }; }
else { statusCode = 200; body = { submission_id: r.submission_id, short_id: r.short_id, merchant_id: r.merchant_id }; }
return [{ json: { statusCode, body } }];
`.trim();

const wf = {
  name: "WF-2 submit-start",
  nodes: [
    {
      parameters: { httpMethod: "POST", path: "submit/start", responseMode: "responseNode", options: {} },
      id: "w2", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2,
      position: [0, 0], webhookId: "submit-start-wh",
    },
    {
      parameters: { jsCode: prepCode },
      id: "prep", name: "Prep", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0],
    },
    {
      parameters: {
        operation: "executeQuery", query: sql,
        options: { queryReplacement: "={{ JSON.stringify($json.payload) }}" },
      },
      id: "pg2", name: "Insert submission", type: "n8n-nodes-base.postgres", typeVersion: 2.5,
      position: [440, 0], credentials: { postgres: PG_CRED }, alwaysOutputData: true,
    },
    {
      parameters: { jsCode: shapeCode },
      id: "shape", name: "Shape", type: "n8n-nodes-base.code", typeVersion: 2, position: [660, 0],
    },
    {
      parameters: {
        respondWith: "json",
        responseBody: "={{ $json.body }}",
        options: { responseCode: "={{ $json.statusCode }}" },
      },
      id: "r2", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1,
      position: [880, 0],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: "Prep", type: "main", index: 0 }]] },
    Prep: { main: [[{ node: "Insert submission", type: "main", index: 0 }]] },
    "Insert submission": { main: [[{ node: "Shape", type: "main", index: 0 }]] },
    Shape: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
  settings: {},
};

writeFileSync(new URL("./wf2.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote wf2.json");
