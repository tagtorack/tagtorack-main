// Builds WF-4 submit/finalize → writes wf4.json (create body).
import { writeFileSync } from "node:fs";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

const prepCode = `
const b = $json.body || {};
const sid = String(b.submission_id || "");
const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sid);
return [{ json: { payload: { submission_id: isUuid ? sid : "" } } }];
`.trim();

// Single CTE: look up submission, count photos, conditionally flip
// pending_uploads -> received only when 3-6 photos. Always returns one row.
const sql = `
WITH input AS (SELECT $1::jsonb AS d),
sub AS (
  SELECT id, status, left(id::text, 8) AS short_id
  FROM seller_submissions
  WHERE id = NULLIF((SELECT d->>'submission_id' FROM input), '')::uuid
  LIMIT 1
),
cnt AS (
  SELECT COALESCE(
    (SELECT count(*) FROM submission_photos WHERE submission_id = (SELECT id FROM sub)), 0
  ) AS n
),
upd AS (
  UPDATE seller_submissions SET status = 'received'
  WHERE id = (SELECT id FROM sub)
    AND status = 'pending_uploads'
    AND (SELECT n FROM cnt) BETWEEN 3 AND 6
  RETURNING id
)
SELECT
  (SELECT id FROM sub) IS NOT NULL AS found,
  (SELECT short_id FROM sub)       AS short_id,
  (SELECT status FROM sub)         AS prev_status,
  (SELECT n FROM cnt)              AS photo_count,
  (SELECT id FROM upd) IS NOT NULL AS updated;
`.trim();

const shapeCode = `
const r = $json || {};
const n = Number(r.photo_count || 0);
if (!r.found) return [{ json: { statusCode: 404, body: { ok: false, error: "submission_not_found" } } }];
if (n < 3 || n > 6) return [{ json: { statusCode: 409, body: { ok: false, error: "photos_incomplete", photo_count: n } } }];
return [{ json: { statusCode: 200, body: { ok: true, short_id: r.short_id } } }];
`.trim();

// Fire WF-5 (submit/process) only on a FRESH finalize (status actually flipped
// pending_uploads->received, i.e. updated=true). Runs AFTER Respond, so the
// seller's confirmation isn't blocked by the ~10s Gemini review. Re-finalize
// (updated=false) does not re-trigger. Errors are swallowed (best-effort).
const triggerCode = `
const fin = $('Finalize submission').first().json || {};
const sid = ($('Webhook').first().json.body || {}).submission_id;
if (fin.updated === true && sid) {
  try {
    await this.helpers.httpRequest({ method: 'POST', url: 'http://127.0.0.1:5678/webhook/submit/process',
      headers: { 'Content-Type': 'application/json' }, body: { submission_id: sid }, json: true });
  } catch (e) { /* best-effort; WF-5 runs to completion independently even if this connection times out */ }
}
return [{ json: { triggered: fin.updated === true } }];
`.trim();

const wf = {
  name: "WF-4 submit-finalize",
  nodes: [
    {
      parameters: { httpMethod: "POST", path: "submit/finalize", responseMode: "responseNode", options: {} },
      id: "w4", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2,
      position: [0, 0], webhookId: "submit-finalize-wh",
    },
    {
      parameters: { jsCode: prepCode },
      id: "prep", name: "Prep", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0],
    },
    {
      parameters: {
        operation: "executeQuery", query: sql,
        options: { queryReplacement: "={{ JSON.stringify($json.payload) }}" },
      },
      id: "pg4", name: "Finalize submission", type: "n8n-nodes-base.postgres", typeVersion: 2.5,
      position: [440, 0], credentials: { postgres: PG_CRED }, alwaysOutputData: true,
    },
    {
      parameters: { jsCode: shapeCode },
      id: "shape", name: "Shape", type: "n8n-nodes-base.code", typeVersion: 2, position: [660, 0],
    },
    {
      parameters: {
        respondWith: "json",
        responseBody: "={{ $json.body }}",
        options: { responseCode: "={{ $json.statusCode }}" },
      },
      id: "r4", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1,
      position: [880, 0],
    },
    {
      parameters: { jsCode: triggerCode },
      id: "trig", name: "Trigger AI", type: "n8n-nodes-base.code", typeVersion: 2, position: [1100, 0],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: "Prep", type: "main", index: 0 }]] },
    Prep: { main: [[{ node: "Finalize submission", type: "main", index: 0 }]] },
    "Finalize submission": { main: [[{ node: "Shape", type: "main", index: 0 }]] },
    Shape: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
    Respond: { main: [[{ node: "Trigger AI", type: "main", index: 0 }]] },
  },
  settings: {},
};

writeFileSync(new URL("./workflows/WF-4-submit-finalize.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote workflows/WF-4-submit-finalize.json (" + JSON.stringify(wf).length + " bytes)");
