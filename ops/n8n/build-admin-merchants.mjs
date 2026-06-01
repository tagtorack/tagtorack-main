// ops/n8n/build-admin-merchants.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d)
SELECT m.id::text AS merchant_id, m.slug, m.display_name, m.contact_email, m.dropoff_address,
       m.dropoff_hours, m.calcom_event_url, m.brand_color, m.public_intro, m.status, m.rule_set,
       (SELECT count(*) FROM seller_submissions s WHERE s.merchant_id=m.id) AS total_submissions,
       (SELECT count(*) FROM seller_submissions s WHERE s.merchant_id=m.id AND s.status='merchant_review') AS pending
FROM merchants m, inp
WHERE (NULLIF(inp.d->>'slug','') IS NULL OR m.slug = inp.d->>'slug')
ORDER BY m.display_name;
`.trim();

const shape = `
const rows = $input.all().map(i=>i.json).filter(r=>r && r.merchant_id);
return [{ json: { statusCode: 200, body: { ok:true, merchants: rows } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/merchants"),
  pgNode("pg", "List", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A5 admin-merchants", nodes, connections: linearConnections(["Webhook","List","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A5-admin-merchants.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A5");
