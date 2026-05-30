// functions/submit/api/delete.js
// POST /submit/api/delete
// Body: { submission_id, seller_email, confirm: true }
//
// Right-to-delete endpoint. The seller_email + submission_id pair acts as
// authentication (defense against typo'd IDs and casual snooping; not a
// security-grade auth — for adversarial deletes a future Phase 13 should
// add an email-confirmation magic link). n8n cascades the delete through
// seller_submissions → submission_photos → submission_decisions →
// decision_tokens, and re-tags the R2 objects for 24h purge.

import { postToN8n, json, isAllowedOrigin, isJsonContentType } from "../../_shared/n8n-fanout.js";

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

  if (!body.submission_id || !body.seller_email || body.confirm !== true) {
    return json(400, { ok: false, error: "missing_fields" });
  }
  // Normalize once so validation and the value sent to n8n agree (the DB column
  // is CITEXT, but keep the edge consistent).
  const sellerEmail = String(body.seller_email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sellerEmail)) {
    return json(400, { ok: false, error: "bad_email" });
  }

  let resp;
  try {
    resp = await postToN8n(
      env,
      "submit/delete",
      {
        submission_id: body.submission_id,
        seller_email: sellerEmail,
        requested_at: new Date().toISOString(),
        request_ip_country: request.cf?.country || "",
      },
      8000,
    );
  } catch (e) {
    if (e.status === 404) return json(404, { ok: false, error: "submission_not_found" });
    if (e.status === 403) return json(403, { ok: false, error: "email_mismatch" });
    if (e.status === 503) return json(503, { ok: false, error: "service_unavailable" });
    console.error("submit/delete n8n call failed", String(e), e.body || "");
    return json(502, { ok: false, error: "upstream_failed" });
  }

  return json(200, {
    ok: true,
    message:
      "Deletion request received. Your data will be removed from our systems within 24 hours, and your photos from storage within 24 hours after that.",
    deleted_rows: (resp && resp.deleted_rows) || null,
  });
}
