// functions/submit/api/photo-complete.js
// POST /submit/api/photo-complete
// Called by the seller's browser after each R2 PUT succeeds.
// Body: { submission_id, r2_key, content_type, byte_size, width, height, client_stripped_exif }
//
// Just fanouts to n8n which updates the submission_photos row's metadata
// (byte_size, dimensions, exif_stripped_at). No state stored at the edge.

import { postToN8nFireAndForget, json, isAllowedOrigin, isJsonContentType } from "../../_shared/n8n-fanout.js";

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

  if (!body.submission_id || !body.r2_key) {
    return json(400, { ok: false, error: "missing_fields" });
  }
  if (typeof body.byte_size !== "number" || body.byte_size <= 0) {
    return json(400, { ok: false, error: "bad_byte_size" });
  }

  // Fire-and-forget — the seller's browser doesn't need to block on this. If
  // n8n is briefly down, we still return 200 and the next /finalize call will
  // bring the row in. The cost of a missed photo-complete is a stale
  // submission_photos row that gets reconciled at finalize.
  context.waitUntil(
    postToN8nFireAndForget(env, "submit/photo-complete", {
      submission_id: body.submission_id,
      r2_key: body.r2_key,
      content_type: body.content_type || "image/jpeg",
      byte_size: body.byte_size,
      width: body.width || null,
      height: body.height || null,
      client_stripped_exif: !!body.client_stripped_exif,
    }),
  );

  return json(200, { ok: true });
}
