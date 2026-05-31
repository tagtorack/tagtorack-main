// ops/n8n/build-m-stats.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, codeNode, pgNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
mid AS (SELECT NULLIF((SELECT d->>'merchant_id' FROM inp),'')::uuid AS id)
SELECT
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND status='merchant_review') AS pending,
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND status='merchant_approved' AND merchant_decided_at > NOW()-INTERVAL '7 days') AS approved_week,
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND status='merchant_rejected' AND merchant_decided_at > NOW()-INTERVAL '7 days') AS rejected_week,
  (SELECT count(*) FROM seller_submissions WHERE merchant_id=(SELECT id FROM mid) AND submitted_at > NOW()-INTERVAL '7 days') AS received_week,
  (SELECT coalesce(round(100.0 * count(*) FILTER (WHERE s.status='merchant_approved') / NULLIF(count(*),0)), 0)
     FROM seller_submissions s
     JOIN LATERAL (SELECT decision FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE s.merchant_id=(SELECT id FROM mid) AND d.decision='PASS' AND s.status IN ('merchant_approved','merchant_rejected')) AS ai_agreement_pct,
  (SELECT coalesce(sum(d.estimated_resale_usd),0)
     FROM seller_submissions s
     JOIN LATERAL (SELECT estimated_resale_usd FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE s.merchant_id=(SELECT id FROM mid) AND s.status='merchant_approved') AS approved_resale_value;
`.trim();

const shape = `return [{ json: { statusCode: 200, body: { ok:true, stats: $json } } }];`;

const nodes = [
  webhookNode("w", "Webhook", "merchant/stats"),
  pgNode("pg", "Stats", sql, "={{ JSON.stringify({ merchant_id: $json.body.merchant_id }) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-M5 merchant-stats", nodes,
  connections: linearConnections(["Webhook","Stats","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M5-merchant-stats.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M5");
