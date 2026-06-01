// functions/submit/api/finalize.js
// POST /submit/api/finalize
// Body: { submission_id }
//
// Marks the submission as 'received' and fires WF-Submission-Received in n8n
// (which kicks off the Gemini Pro vision review pipeline).
//
// Returns: { ok: true, short_id }

import { postToN8n, json, isAllowedOrigin, isJsonContentType } from "../../_shared/n8n-fanout.js";
import { mintStatusToken } from "../../_shared/status-token.js";

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isAllowedOrigin(request)) return json(403, { ok: false, error: "bad_origin" });
  if (!isJsonContentType(request)) {
    return json(415, { ok: false, error: "unsupported_media_type" });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json(400, { ok: false, error: "bad_json" });
  }

  if (!body.submission_id || typeof body.submission_id !== "string") {
    return json(400, { ok: false, error: "missing_submission_id" });
  }

  // Finalize MUST be synchronous from the seller's perspective — they need
  // the confirmation screen with the short_id. n8n validates that every
  // declared photo has a byte_size now, flips status to 'received', and
  // emits the signal that triggers WF-Submission-Received (which is itself
  // fire-and-forget on the n8n side).
  let resp;
  try {
    resp = await postToN8n(
      env,
      "submit/finalize",
      { submission_id: body.submission_id },
      8000,
    );
  } catch (e) {
    if (e.status === 404) return json(404, { ok: false, error: "submission_not_found" });
    if (e.status === 409) return json(409, { ok: false, error: "photos_incomplete" });
    if (e.status === 503) return json(503, { ok: false, error: "service_unavailable" });
    console.error("submit/finalize n8n call failed", String(e), e.body || "");
    return json(502, { ok: false, error: "upstream_failed" });
  }

  let status_token = "";
  try { status_token = await mintStatusToken(env, body.submission_id); } catch (_) {}
  return json(200, {
    ok: true,
    short_id: (resp && resp.short_id) || body.submission_id.slice(0, 8),
    status_token,
  });
}
