// Builds WF-3 submit/photo-complete → writes wf3.json (create body).
import { writeFileSync } from "node:fs";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

// Parse role/ord from r2_key ({slug}/{sub}/{role}-{ord}-{ts}.{ext}) and validate.
const prepCode = `
const b = $json.body || {};
const key = String(b.r2_key || "");
const base = key.split("/").pop() || "";
const m = base.match(/^([a-z]+)-(\\d+)-/);
const role = m ? m[1] : "";
const ord = m ? parseInt(m[2], 10) : 0;
const sid = String(b.submission_id || "");
const byteSize = typeof b.byte_size === "number" ? b.byte_size : parseInt(b.byte_size, 10) || 0;
const valid =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sid) &&
  key.length > 0 &&
  ["front", "back", "tag", "flaw"].includes(role) &&
  ord >= 1 && ord <= 6 &&
  byteSize > 0;
return [{ json: { payload: {
  submission_id: sid,
  r2_key: key,
  role,
  ord,
  content_type: b.content_type || "image/jpeg",
  byte_size: byteSize,
  width: b.width == null ? null : b.width,
  height: b.height == null ? null : b.height,
  client_stripped_exif: !!b.client_stripped_exif,
  valid,
} } }];
`.trim();

const sql = `
WITH input AS (SELECT $1::jsonb AS d),
ins AS (
  INSERT INTO submission_photos
    (submission_id, role, ord, r2_key, cdn_url, content_type, byte_size, width_px, height_px, exif_stripped_at)
  SELECT (d->>'submission_id')::uuid,
         d->>'role',
         (d->>'ord')::smallint,
         d->>'r2_key',
         '',
         d->>'content_type',
         (d->>'byte_size')::int,
         NULLIF(d->>'width','')::int,
         NULLIF(d->>'height','')::int,
         CASE WHEN (d->>'client_stripped_exif')::boolean THEN NOW() ELSE NULL END
  FROM input
  WHERE (d->>'valid')::boolean
  ON CONFLICT (submission_id, role, ord) DO UPDATE
    SET r2_key = EXCLUDED.r2_key,
        content_type = EXCLUDED.content_type,
        byte_size = EXCLUDED.byte_size,
        width_px = COALESCE(EXCLUDED.width_px, submission_photos.width_px),
        height_px = COALESCE(EXCLUDED.height_px, submission_photos.height_px),
        exif_stripped_at = COALESCE(EXCLUDED.exif_stripped_at, submission_photos.exif_stripped_at),
        uploaded_at = NOW()
  RETURNING id
)
SELECT (SELECT (d->>'valid')::boolean FROM input) AS valid,
       (SELECT id::text FROM ins) AS photo_id;
`.trim();

const shapeCode = `
const r = $json || {};
if (!r.valid) return [{ json: { statusCode: 400, body: { ok: false, error: "bad_photo" } } }];
return [{ json: { statusCode: 200, body: { ok: true, photo_id: r.photo_id || null } } }];
`.trim();

const wf = {
  name: "WF-3 submit-photo-complete",
  nodes: [
    {
      parameters: { httpMethod: "POST", path: "submit/photo-complete", responseMode: "responseNode", options: {} },
      id: "w3", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2,
      position: [0, 0], webhookId: "submit-photo-complete-wh",
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
      id: "pg3", name: "Upsert photo", type: "n8n-nodes-base.postgres", typeVersion: 2.5,
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
      id: "r3", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1,
      position: [880, 0],
    },
  ],
  connections: {
    Webhook: { main: [[{ node: "Prep", type: "main", index: 0 }]] },
    Prep: { main: [[{ node: "Upsert photo", type: "main", index: 0 }]] },
    "Upsert photo": { main: [[{ node: "Shape", type: "main", index: 0 }]] },
    Shape: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
  settings: {},
};

writeFileSync(new URL("./wf3.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote wf3.json");
