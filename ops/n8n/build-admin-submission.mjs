// ops/n8n/build-admin-submission.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sid AS (SELECT NULLIF(inp.d->>'submission_id','')::uuid AS id FROM inp)
SELECT
  to_jsonb(s.*) AS submission,
  jsonb_build_object('slug',m.slug,'display_name',m.display_name,'contact_email',m.contact_email,'calcom_event_url',m.calcom_event_url) AS merchant,
  jsonb_build_object('email',se.email,'name',se.name,'zip',se.zip) AS seller,
  (SELECT to_jsonb(d2.*) FROM submission_decisions d2 WHERE d2.submission_id=s.id ORDER BY created_at DESC LIMIT 1) AS decision,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb) FROM submission_photos p WHERE p.submission_id=s.id) AS photos,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('event_type',a.event_type,'decision',a.decision,'confidence',a.confidence,'payload',a.payload,'created_at',a.created_at) ORDER BY a.created_at DESC),'[]'::jsonb) FROM audit_log a WHERE a.submission_id=s.id) AS history
FROM seller_submissions s
JOIN merchants m ON m.id=s.merchant_id
JOIN sellers se ON se.id=s.seller_id
WHERE s.id=(SELECT id FROM sid);
`.trim();

const shape = `
${r2PresignSnippet()}
const rows = $input.all().map(i=>i.json).filter(r=>r && r.submission);
if (!rows.length) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const r = rows[0];
const photos = (r.photos||[]).map(p=>({ role:p.role, ord:p.ord, url: presignGet(p.r2_key, 86400) }));
return [{ json: { statusCode: 200, body: { ok:true, submission:r.submission, merchant:r.merchant, seller:r.seller, decision:r.decision, photos, history:r.history } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/submission"),
  pgNode("pg", "Load", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-A2 admin-submission", nodes, connections: linearConnections(["Webhook","Load","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A2-admin-submission.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A2");
