// ops/n8n/build-admin-merchant-upsert.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Prep: validate slug + condition_floor + rule_set JSON.
const prep = `
const b = $json.body || {};
let rule_set = b.rule_set;
if (typeof rule_set === 'string') { try { rule_set = JSON.parse(rule_set); } catch { return [{ json: { payload:{ valid:false, error:'bad_rule_set_json' } } }]; } }
rule_set = rule_set || {};
const slug = String(b.slug||'').trim().toLowerCase();
const floor = String(rule_set.condition_floor||'good');
const okSlug = /^[a-z0-9-]{2,64}$/.test(slug);
const okFloor = ['new_with_tags','excellent','good','fair'].includes(floor);
const valid = okSlug && okFloor && b.display_name && b.contact_email && b.dropoff_address;
return [{ json: { payload: {
  valid, error: valid ? null : (!okSlug?'bad_slug':!okFloor?'bad_condition_floor':'missing_fields'),
  slug, display_name: b.display_name||'', contact_email: b.contact_email||'', dropoff_address: b.dropoff_address||'',
  dropoff_hours: b.dropoff_hours||'Tue\\u2013Sat, 11am\\u20136pm', calcom_event_url: b.calcom_event_url||null,
  brand_color: /^#[0-9A-Fa-f]{6}$/.test(String(b.brand_color||'')) ? b.brand_color : '#6a40c9',
  public_intro: b.public_intro||'', status: ['active','paused','archived'].includes(b.status)?b.status:'active',
  rule_set, operator_email: b.operator_email||''
} } }];
`.trim();

const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
v AS (SELECT (d->>'valid')::boolean AS valid, d FROM inp),
up AS (
  INSERT INTO merchants (slug, display_name, contact_email, dropoff_address, dropoff_hours, calcom_event_url,
    brand_color, public_intro, status, rule_set,
    accepted_categories, brand_allowlist, brand_blocklist, condition_floor, updated_at)
  SELECT d->>'slug', d->>'display_name', d->>'contact_email', d->>'dropoff_address', d->>'dropoff_hours',
    NULLIF(d->>'calcom_event_url',''), d->>'brand_color', d->>'public_intro', d->>'status', d->'rule_set',
    ARRAY(SELECT jsonb_array_elements_text(coalesce(d->'rule_set'->'categories_accepted','[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(d->'rule_set'->'brand_allowlist','[]'::jsonb))),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(d->'rule_set'->'brand_blocklist','[]'::jsonb))),
    coalesce(d->'rule_set'->>'condition_floor','good'), NOW()
  FROM v WHERE v.valid
  ON CONFLICT (slug) DO UPDATE SET
    display_name=EXCLUDED.display_name, contact_email=EXCLUDED.contact_email, dropoff_address=EXCLUDED.dropoff_address,
    dropoff_hours=EXCLUDED.dropoff_hours, calcom_event_url=EXCLUDED.calcom_event_url, brand_color=EXCLUDED.brand_color,
    public_intro=EXCLUDED.public_intro, status=EXCLUDED.status, rule_set=EXCLUDED.rule_set,
    accepted_categories=EXCLUDED.accepted_categories, brand_allowlist=EXCLUDED.brand_allowlist,
    brand_blocklist=EXCLUDED.brand_blocklist, condition_floor=EXCLUDED.condition_floor, updated_at=NOW()
  RETURNING id, slug
),
aud AS (
  INSERT INTO audit_log (agent_run_id, event_type, payload)
  SELECT gen_random_uuid(), 'operator_merchant_upsert', jsonb_build_object('operator',(SELECT d->>'operator_email' FROM inp),'slug',(SELECT slug FROM up))
  WHERE (SELECT id FROM up) IS NOT NULL RETURNING id
)
SELECT (SELECT (d->>'valid')::boolean FROM inp) AS valid, (SELECT d->>'error' FROM inp) AS error, (SELECT slug FROM up) AS slug;
`.trim();

const shape = `
const r=$json;
if (!r.valid) return [{ json: { statusCode: 400, body: { ok:false, error: r.error||'invalid' } } }];
return [{ json: { statusCode: 200, body: { ok:true, slug: r.slug } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "admin/merchant-upsert"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Upsert", sql, "={{ JSON.stringify($json.payload) }}", 220),
  codeNode("shape", "Shape", shape, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-A6 admin-merchant-upsert", nodes, connections: linearConnections(["Webhook","Prep","Upsert","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-A6-admin-merchant-upsert.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-A6");
