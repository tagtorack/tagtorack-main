// ops/n8n/build-admin-audit.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT a.id::text AS id, a.event_type, a.decision, a.confidence, a.payload, a.created_at,
       a.submission_id::text AS submission_id
FROM audit_log a, inp
WHERE (NULLIF(inp.d->>'event_type','') IS NULL OR a.event_type = inp.d->>'event_type')
  AND (NULLIF(inp.d->>'submission_id','') IS NULL OR a.submission_id = (inp.d->>'submission_id')::uuid)
ORDER BY a.created_at DESC
LIMIT LEAST(coalesce(NULLIF(inp.d->>'limit','')::int,100),500)
OFFSET coalesce(NULLIF(inp.d->>'offset','')::int,0);
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.id);
return [{ json: { statusCode: 200, body: { ok:true, events: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/audit"),
  pgNode("pg", "Audit", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A8 admin-audit", nodes, connections: linearConnections(["Webhook","Audit","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A8-admin-audit.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A8");
