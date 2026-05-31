// ops/n8n/build-m-queue.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

// One row per pending submission, with latest decision + photo r2_keys.
const sql = `
SELECT s.id::text AS submission_id, left(s.id::text,8) AS short_id,
  s.item_description, s.declared_brand, s.declared_category, s.declared_size,
  s.declared_condition, s.asking_price_usd, s.submitted_at,
  d.decision, d.confidence, d.brand_detected, d.estimated_retail_usd, d.estimated_resale_usd,
  d.pass_reasons, d.borderline_reasons, d.fail_reasons, d.internal_note,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb)
   FROM submission_photos p WHERE p.submission_id = s.id) AS photos
FROM seller_submissions s
LEFT JOIN LATERAL (
  SELECT * FROM submission_decisions sd WHERE sd.submission_id = s.id ORDER BY created_at DESC LIMIT 1
) d ON true
WHERE s.merchant_id = NULLIF($1::jsonb->>'merchant_id','')::uuid AND s.status = 'merchant_review'
ORDER BY s.submitted_at;
`.trim();

// Presign each photo (24h GET) and assemble the response array.
const presign = `
${r2PresignSnippet()}
const rows = $input.all().map(i => i.json).filter(r => r && r.submission_id);
const out = rows.map(r => ({
  ...r,
  photos: (r.photos || []).map(p => ({ role: p.role, ord: p.ord, url: presignGet(p.r2_key, 86400) })),
}));
return [{ json: { statusCode: 200, body: { ok: true, submissions: out } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/queue"),
  pgNode("pg", "Load queue", sql, "={{ JSON.stringify({ merchant_id: $json.body.merchant_id }) }}", 0),
  codeNode("presign", "Presign", presign, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M3 merchant-queue", nodes,
  connections: linearConnections(["Webhook","Load queue","Presign","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M3-merchant-queue.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M3");
