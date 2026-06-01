// ops/n8n/build-admin-queue.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

const sql = `
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id, s.status, s.submitted_at,
       s.declared_brand, s.item_description,
       m.slug AS merchant_slug, m.display_name AS merchant_name, se.email AS seller_email,
       dec.decision, dec.confidence, dec.borderline_reasons, dec.fail_reasons, dec.internal_note,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb) FROM submission_photos p WHERE p.submission_id=s.id) AS photos
FROM seller_submissions s
JOIN merchants m ON m.id=s.merchant_id
JOIN sellers se ON se.id=s.seller_id
LEFT JOIN LATERAL (SELECT * FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) dec ON true
WHERE s.status IN ('ai_borderline','ai_failed')
   OR (s.status='ai_reviewing' AND s.submitted_at < NOW() - INTERVAL '10 minutes')
ORDER BY s.submitted_at;
`.trim();

const shape = `
${r2PresignSnippet()}
const rows = $input.all().map(i=>i.json).filter(r=>r && r.submission_id);
const out = rows.map(r => ({ ...r, photos: (r.photos||[]).map(p=>({ role:p.role, ord:p.ord, url: presignGet(p.r2_key, 86400) })) }));
return [{ json: { statusCode: 200, body: { ok:true, queue: out } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/queue"),
  pgNode("pg", "Queue", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A3 admin-queue", nodes, connections: linearConnections(["Webhook","Queue","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A3-admin-queue.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A3");
