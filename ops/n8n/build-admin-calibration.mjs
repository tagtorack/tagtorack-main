// ops/n8n/build-admin-calibration.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

const sql = `
SELECT
  (SELECT jsonb_object_agg(decision, n) FROM (SELECT decision, count(*) n FROM submission_decisions GROUP BY decision) x) AS decision_counts,
  (SELECT coalesce(round(100.0*count(*) FILTER (WHERE s.status='merchant_approved')/NULLIF(count(*),0)),0)
     FROM seller_submissions s JOIN LATERAL (SELECT decision FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) d ON true
     WHERE d.decision='PASS' AND s.status IN ('merchant_approved','merchant_rejected')) AS ai_agreement_pct,
  (SELECT round(avg(confidence),2) FROM submission_decisions) AS avg_confidence,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('day',day,'model',model,'count',request_count) ORDER BY day DESC),'[]'::jsonb)
     FROM gemini_usage WHERE day > current_date - INTERVAL '14 days') AS token_usage,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('slug',slug,'received',received,'approved',approved) ORDER BY received DESC),'[]'::jsonb)
     FROM (SELECT m.slug,
                  count(s.*) AS received,
                  count(s.*) FILTER (WHERE s.status='merchant_approved') AS approved
           FROM merchants m LEFT JOIN seller_submissions s ON s.merchant_id=m.id GROUP BY m.slug) pm) AS per_merchant,
  (SELECT count(*) FROM seller_submissions WHERE submitted_at > NOW()-INTERVAL '7 days') AS received_week;
`.trim();

const shape = `return [{ json: { statusCode: 200, body: { ok:true, calibration: $json } } }];`;

const nodes = [
  webhookNode("w", "Webhook", "admin/calibration"),
  pgNode("pg", "Calc", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A7 admin-calibration", nodes, connections: linearConnections(["Webhook","Calc","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A7-admin-calibration.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A7");
