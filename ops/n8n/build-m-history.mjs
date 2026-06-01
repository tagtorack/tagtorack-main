// ops/n8n/build-m-history.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Merchant's decided submissions (any terminal state — AI-declined, merchant
// approved/rejected, drop-off scheduled, completed), filterable by status + q.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id, s.status,
       s.declared_brand, s.item_description, s.submitted_at, s.merchant_decided_at,
       dec.decision, dec.confidence, dec.estimated_resale_usd
FROM seller_submissions s
LEFT JOIN LATERAL (SELECT decision, confidence, estimated_resale_usd FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) dec ON true,
     inp
WHERE s.merchant_id = NULLIF(inp.d->>'merchant_id','')::uuid
  AND s.status IN ('ai_failed','merchant_rejected','merchant_approved','dropoff_scheduled','completed')
  AND (NULLIF(inp.d->>'status','') IS NULL OR s.status = inp.d->>'status')
  AND (NULLIF(inp.d->>'q','') IS NULL
       OR left(s.id::text,8) ILIKE '%'||(inp.d->>'q')||'%'
       OR coalesce(s.declared_brand,'') ILIKE '%'||(inp.d->>'q')||'%'
       OR coalesce(s.item_description,'') ILIKE '%'||(inp.d->>'q')||'%')
ORDER BY coalesce(s.merchant_decided_at, s.ai_reviewed_at, s.submitted_at) DESC
LIMIT (SELECT LEAST(coalesce(NULLIF(d->>'limit','')::int,500),5000) FROM inp);
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.submission_id);
return [{ json: { statusCode: 200, body: { ok:true, submissions: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/history"),
  pgNode("pg", "History", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M8 merchant-history", nodes, connections: linearConnections(["Webhook","History","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M8-merchant-history.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M8");
