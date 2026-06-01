// ops/n8n/build-admin-submissions.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id, s.status, s.submitted_at,
       s.declared_brand, s.item_description,
       m.slug AS merchant_slug, m.display_name AS merchant_name,
       se.email AS seller_email,
       dec.decision, dec.confidence
FROM seller_submissions s
JOIN merchants m ON m.id = s.merchant_id
JOIN sellers se ON se.id = s.seller_id
LEFT JOIN LATERAL (SELECT decision, confidence FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) dec ON true,
     inp
WHERE (NULLIF(inp.d->>'status','') IS NULL OR s.status = inp.d->>'status')
  AND (NULLIF(inp.d->>'merchant_id','') IS NULL OR s.merchant_id = (inp.d->>'merchant_id')::uuid)
  AND (NULLIF(inp.d->>'q','') IS NULL
       OR left(s.id::text,8) ILIKE '%'||(inp.d->>'q')||'%'
       OR se.email ILIKE '%'||(inp.d->>'q')||'%'
       OR coalesce(s.declared_brand,'') ILIKE '%'||(inp.d->>'q')||'%')
ORDER BY s.submitted_at DESC
LIMIT LEAST(coalesce(NULLIF(inp.d->>'limit','')::int,50),200)
OFFSET coalesce(NULLIF(inp.d->>'offset','')::int,0);
`.trim();

const shape = `
const rows = $input.all().map(i => i.json).filter(r => r && r.submission_id);
return [{ json: { statusCode: 200, body: { ok: true, submissions: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/submissions"),
  pgNode("pg", "List", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A1 admin-submissions", nodes, connections: linearConnections(["Webhook","List","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A1-admin-submissions.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A1");
