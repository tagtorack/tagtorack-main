// ops/n8n/build-submit-status.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections, r2PresignSnippet } from "./wf-lib.mjs";

// Select ONLY seller-safe fields. Note: seller_message comes from the latest decision row
// (it is the brand-safe, seller-facing message the vision prompt produces). We deliberately
// do NOT select confidence/internal_note/decision/brand_detected/reasons.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
sub AS (
  SELECT s.id, s.status, left(s.id::text,8) AS short_id,
         s.declared_brand, s.declared_category, s.declared_size, s.declared_condition, s.asking_price_usd,
         m.slug AS merchant_slug, m.display_name AS merchant_name, m.brand_color, m.calcom_event_url,
         (SELECT seller_message FROM submission_decisions sd WHERE sd.submission_id=s.id ORDER BY created_at DESC LIMIT 1) AS seller_message
  FROM seller_submissions s JOIN merchants m ON m.id=s.merchant_id
  WHERE s.id = NULLIF((SELECT d->>'submission_id' FROM inp),'')::uuid
  LIMIT 1
)
SELECT
  (SELECT count(*) FROM sub) > 0 AS found,
  to_jsonb(sub.*) AS sub,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('r2_key',p.r2_key,'role',p.role,'ord',p.ord) ORDER BY p.ord),'[]'::jsonb)
   FROM submission_photos p, sub WHERE p.submission_id = sub.id) AS photos
FROM sub;
`.trim();

const shape = `
${r2PresignSnippet()}
const rows = $input.all().map(i=>i.json).filter(r=>r && r.found);
if (!rows.length) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
const r = rows[0];
const s = r.sub || {};
const merchantName = s.merchant_name || 'the store';
const msg = (s.seller_message || '').replace(/\\{\\{\\s*merchant_name\\s*\\}\\}/g, merchantName);

// seller-safe stage mapping (single source of truth)
function stageFor(status) {
  switch (status) {
    case 'pending_uploads': return { key:'received', step:1, label:'Received', message:"We've got your photos — finishing up." };
    case 'received': case 'ai_reviewing': case 'merchant_review': case 'ai_borderline':
      return { key:'in_review', step:2, label:'In review', message:"We're reviewing your item. You'll hear back within 24 hours." };
    case 'merchant_approved': return { key:'approved', step:3, label:'Approved', message: msg || 'Good news — your item is a match. Schedule your drop-off below.', showDropoff:true };
    case 'dropoff_scheduled': return { key:'approved', step:3, label:'Drop-off booked', message:'Your drop-off is scheduled. See you then.' };
    case 'completed': return { key:'completed', step:3, label:'Completed', message:"Thanks — this item's all done." };
    case 'ai_failed': case 'merchant_rejected':
      return { key:'decided', step:3, label:'Decision made', message: msg || "Thanks for your submission. This isn't a match right now, but you're welcome to submit other items anytime." };
    default: return { key:'closed', step:3, label:'Closed', message:'This submission is no longer active.' };
  }
}
const stage = stageFor(s.status);
const photos = (r.photos||[]).map(p=>({ role:p.role, ord:p.ord, url: presignGet(p.r2_key, 86400) }));
return [{ json: { statusCode: 200, body: { ok:true,
  merchant: { slug: s.merchant_slug, display_name: merchantName, brand_color: s.brand_color },
  item: { brand: s.declared_brand, category: s.declared_category, size: s.declared_size, condition: s.declared_condition, asking_price_usd: s.asking_price_usd },
  short_id: s.short_id, stage, photos,
  calcom_url: stage.showDropoff ? (s.calcom_event_url || $env.CALCOM_BOOKING_URL || '') : null,
} } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "submit/status"),
  pgNode("pg", "Load", sql, "={{ JSON.stringify($json.body || {}) }}", 0),
  codeNode("shape", "Shape", shape, 220),
  respondNode("r", "Respond", 440),
];
const wf = { name: "WF-S1 submit-status", nodes, connections: linearConnections(["Webhook","Load","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-S1-submit-status.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-S1");
