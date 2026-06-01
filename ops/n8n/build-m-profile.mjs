// ops/n8n/build-m-profile.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT m.id::text AS merchant_id, m.slug, m.display_name, m.rule_set
FROM merchants m, inp
WHERE m.id = NULLIF(inp.d->>'merchant_id','')::uuid
LIMIT 1;
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.merchant_id);
if (!rows.length) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const r = rows[0];
return [{ json: { statusCode: 200, body: { ok:true, slug:r.slug, display_name:r.display_name, rule_set:r.rule_set||{} } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/profile"),
  pgNode("pg", "Load", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M6 merchant-profile", nodes, connections: linearConnections(["Webhook","Load","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M6-merchant-profile.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M6");
