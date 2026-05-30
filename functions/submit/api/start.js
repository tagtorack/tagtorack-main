// functions/submit/api/start.js
// POST /submit/api/start
// Body: { merchant_slug, item, contact, photo_declarations[], turnstile_token, honeypot }
//
// Responsibilities (per Phase 12 §12.9 plan):
//   1. Origin allowlist
//   2. Turnstile verify
//   3. Honeypot drop
//   4. Rate limit per IP + per merchant
//   5. Fanout to n8n submit/start → n8n inserts seller_submissions row,
//      submission_photos rows in 'pending_uploads' status, returns
//      { submission_id, short_id, merchant_id }
//   6. Generate R2 signed PUT URLs for each declared photo, return to client
//   7. On Postgres duplicate (23505 → fingerprint dedupe), return 409
//
// Returns: { submission_id, short_id, upload_urls: [{role, ord, r2_key, put_url, max_bytes}, ...] }

import { postToN8n, json, isAllowedOrigin, isJsonContentType } from "../../_shared/n8n-fanout.js";
import { checkAndIncrement, decrement, sha256Hex, verifyTurnstile } from "../../_shared/ratelimit.js";
import { presignUploadUrls } from "../../_shared/r2-sign.js";

const ALLOWED_ROLES = new Set(["front", "back", "tag", "flaw"]);
const ALLOWED_CONDITIONS = new Set(["new_with_tags", "excellent", "good", "fair"]);
const MAX_BYTES_PER_PHOTO = 8 * 1024 * 1024;
const MAX_PHOTOS = 6;

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

  // 1. Honeypot — silently succeed on bot fill (return a fake submission_id
  //    so the bot doesn't learn it triggered defenses).
  if (body.honeypot && body.honeypot.length > 0) {
    return json(200, {
      submission_id: "00000000-0000-0000-0000-000000000000",
      short_id: "blocked0",
      upload_urls: [],
    });
  }

  // 2. Shape validation
  const slug = String(body.merchant_slug || "").trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]{2,64}$/.test(slug)) {
    return json(400, { ok: false, error: "bad_merchant_slug" });
  }
  const item = body.item || {};
  const contact = body.contact || {};
  const photos = Array.isArray(body.photo_declarations) ? body.photo_declarations : [];

  if (!item.item_type || typeof item.item_type !== "string") {
    return json(400, { ok: false, error: "missing_item_type" });
  }
  if (!ALLOWED_CONDITIONS.has(String(item.declared_condition || ""))) {
    return json(400, { ok: false, error: "bad_condition" });
  }
  if (!contact.name || !contact.email) {
    return json(400, { ok: false, error: "missing_contact" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email))) {
    return json(400, { ok: false, error: "bad_email" });
  }
  if (photos.length < 3 || photos.length > MAX_PHOTOS) {
    return json(400, { ok: false, error: "bad_photo_count" });
  }
  for (const p of photos) {
    if (!p || !ALLOWED_ROLES.has(p.role)) return json(400, { ok: false, error: "bad_photo_role" });
    if (typeof p.byte_size !== "number" || p.byte_size <= 0 || p.byte_size > MAX_BYTES_PER_PHOTO) {
      return json(400, { ok: false, error: "photo_too_large" });
    }
  }

  // 3. Turnstile (skipped silently if no TURNSTILE_SECRET configured — local dev)
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const tsOk = await verifyTurnstile(env, body.turnstile_token, ip);
  if (!tsOk) return json(403, { ok: false, error: "turnstile_failed" });

  // 4. Rate limit. IP bucket: 5/24h. Merchant bucket: 50/24h.
  const ipHash = await sha256Hex(ip + (env.RL_SALT || "ttsubmit"));
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ipBucket = `ip:${ipHash}`;
  const merchantBucket = `merchant:${slug}:${today}`;

  const kv = env.TT_SUBMIT_RL;
  const ipRl = await checkAndIncrement(kv, ipBucket, 5);
  if (!ipRl.allowed) return json(429, { ok: false, error: "ip_rate_limited" });
  const mRl = await checkAndIncrement(kv, merchantBucket, 50);
  if (!mRl.allowed) {
    await decrement(kv, ipBucket);
    return json(429, { ok: false, error: "merchant_rate_limited" });
  }

  // 5. Fanout to n8n. n8n handles: merchant slug lookup → seller upsert →
  //    seller_submission INSERT in 'pending_uploads' → submission_photos rows.
  let n8nResp;
  try {
    n8nResp = await postToN8n(env, "submit/start", {
      merchant_slug: slug,
      item,
      contact,
      photo_declarations: photos.map((p) => ({
        role: p.role,
        ord: p.ord || 1,
        content_type: p.content_type || "image/jpeg",
        byte_size: p.byte_size,
        width: p.width || null,
        height: p.height || null,
      })),
      user_agent: request.headers.get("User-Agent") || "",
      ip_country: request.cf?.country || "",
      ip_hash: ipHash,
    });
  } catch (e) {
    // Roll back the rate-limit counters since the submission didn't take.
    await decrement(kv, ipBucket);
    await decrement(kv, merchantBucket);
    if (e.status === 409) return json(409, { ok: false, error: "duplicate_submission" });
    if (e.status === 404) return json(404, { ok: false, error: "merchant_not_found" });
    if (e.status === 503 || (e.message || "").indexOf("n8n_not_configured") >= 0) {
      return json(503, { ok: false, error: "service_unavailable" });
    }
    console.error("submit/start n8n call failed", String(e), e.body || "");
    return json(502, { ok: false, error: "upstream_failed" });
  }

  if (!n8nResp || !n8nResp.submission_id) {
    await decrement(kv, ipBucket);
    await decrement(kv, merchantBucket);
    return json(502, { ok: false, error: "bad_upstream_response" });
  }

  // 6. Sign R2 PUT URLs for each declared photo.
  let upload_urls = [];
  if (env.R2_ACCESS_KEY_ID && env.R2_ACCOUNT_ID) {
    try {
      upload_urls = await presignUploadUrls(env, slug, n8nResp.submission_id, photos);
    } catch (e) {
      console.error("R2 presign failed", String(e));
      return json(503, { ok: false, error: "storage_unavailable" });
    }
  } else {
    console.error("R2 env not configured");
    return json(503, { ok: false, error: "storage_not_configured" });
  }

  return json(200, {
    submission_id: n8nResp.submission_id,
    short_id: n8nResp.short_id || n8nResp.submission_id.slice(0, 8),
    upload_urls,
  });
}
