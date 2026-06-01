// ops/n8n/build-m-profile-update.mjs
import { writeFileSync } from "node:fs";
import { webhookNode, pgNode, codeNode, respondNode, linearConnections } from "./wf-lib.mjs";

// Prep: validate merchant_id + condition_floor + rule_set JSON. rule_set arrives
// as an OBJECT (assembled by the Pages layer) or a JSON string; normalize.
const prep = `
const b = $json.body || {};
const mid = String(b.merchant_id || '');
const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(mid);
let rule_set = b.rule_set;
if (typeof rule_set === 'string') { try { rule_set = JSON.parse(rule_set); } catch { return [{ json:{ payload:{ valid:false, error:'bad_rule_set_json' } } }]; } }
rule_set = rule_set || {};
const floor = String(rule_set.condition_floor || 'good');
const okFloor = ['new_with_tags','excellent','good','fair'].includes(floor);
const valid = !!(isUuid && okFloor);
return [{ json: { payload: {
  valid, error: valid ? null : (!isUuid ? 'bad_merchant_id' : 'bad_condition_floor'),
  merchant_id: mid, rule_set, operator_email: String(b.operator_email || '')
} } }];
`.trim();

// UPDATE keyed on merchant_id (rules only). Regenerate projection columns from
// rule_set (same logic as admin merchant-upsert). Write audit_log row. One row out.
const sql = `
WITH inp AS (SELECT $1::jsonb AS d),
upd AS (
  UPDATE merchants SET
    rule_set = (SELECT d->'rule_set' FROM inp),
    accepted_categories = ARRAY(SELECT jsonb_array_elements_text(coalesce((SELECT d->'rule_set'->'categories_accepted' FROM inp),'[]'::jsonb))),
    brand_allowlist     = ARRAY(SELECT jsonb_array_elements_text(coalesce((SELECT d->'rule_set'->'brand_allowlist' FROM inp),'[]'::jsonb))),
    brand_blocklist     = ARRAY(SELECT jsonb_array_elements_text(coalesce((SELECT d->'rule_set'->'brand_blocklist' FROM inp),'[]'::jsonb))),
    condition_floor     = coalesce((SELECT d->'rule_set'->>'condition_floor' FROM inp),'good'),
    updated_at = NOW()
  WHERE id = NULLIF((SELECT d->>'merchant_id' FROM inp),'')::uuid
    AND (SELECT (d->>'valid')::boolean FROM inp)
  RETURNING id, slug
),
aud AS (
  INSERT INTO audit_log (agent_run_id, event_type, payload)
  SELECT gen_random_uuid(), 'merchant_rules_updated',
         jsonb_build_object('merchant', (SELECT d->>'operator_email' FROM inp), 'slug', (SELECT slug FROM upd), 'rule_set', (SELECT d->'rule_set' FROM inp))
  WHERE (SELECT id FROM upd) IS NOT NULL
  RETURNING id
)
SELECT (SELECT (d->>'valid')::boolean FROM inp) AS valid,
       (SELECT d->>'error' FROM inp) AS error,
       (SELECT slug FROM upd) AS slug,
       (SELECT id FROM upd) IS NOT NULL AS updated;
`.trim();

const shape = `
const r = $json || {};
if (!r.valid) return [{ json: { statusCode: 400, body: { ok:false, error: r.error||'invalid' } } }];
if (!r.updated) return [{ json: { statusCode: 404, body: { ok:false, error:'not_found' } } }];
return [{ json: { statusCode: 200, body: { ok:true, slug: r.slug } } }];
`.trim();

const nodes = [
  webhookNode("w", "Webhook", "merchant/profile-update"),
  codeNode("prep", "Prep", prep, 0),
  pgNode("pg", "Update", sql, "={{ JSON.stringify($json.payload) }}", 220),
  codeNode("shape", "Shape", shape, 440),
  respondNode("r", "Respond", 660),
];
const wf = { name: "WF-M7 merchant-profile-update", nodes, connections: linearConnections(["Webhook","Prep","Update","Shape","Respond"]), settings: {} };
writeFileSync(new URL("./workflows/WF-M7-merchant-profile-update.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote WF-M7");
