// functions/submit/api/merchant.js
// GET /submit/api/merchant?slug=…
// Returns the public merchant fields used by the portal JS to populate the
// category dropdown and brand datalist (fallback when [[slug]].js's server-side
// injection didn't run for some reason).
//
// Returns: { slug, display_name, public_intro, brand_color, logo_url,
//            accepted_categories: [...], brand_allowlist: [...] }
//
// Cached at the edge for 60 seconds (merchant rules don't change often).

import { postToN8n, json, isAllowedOrigin } from "../../_shared/n8n-fanout.js";

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isAllowedOrigin(request)) return json(403, { ok: false, error: "bad_origin" });

  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") || "").trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]{2,64}$/.test(slug)) {
    return json(400, { ok: false, error: "bad_slug" });
  }

  let resp;
  try {
    resp = await postToN8n(env, "merchant/lookup", { slug }, 3000);
  } catch (e) {
    if (e.status === 404) return json(404, { ok: false, error: "merchant_not_found" });
    if (e.status === 503) return json(503, { ok: false, error: "service_unavailable" });
    console.error("merchant/lookup n8n call failed", String(e));
    return json(502, { ok: false, error: "upstream_failed" });
  }

  if (!resp || !resp.merchant) {
    return json(404, { ok: false, error: "merchant_not_found" });
  }
  const m = resp.merchant;
  // Whitelist of fields safe to return to a browser. Don't leak rule_set
  // (contains internal thresholds), contact_email, etc.
  const safe = {
    slug: m.slug,
    display_name: m.display_name || "",
    public_intro: m.public_intro || "",
    brand_color: m.brand_color || "#6a40c9",
    logo_url: m.logo_url || null,
    accepted_categories: Array.isArray(m.accepted_categories) ? m.accepted_categories : [],
    brand_allowlist: Array.isArray(m.brand_allowlist) ? m.brand_allowlist : [],
  };
  return new Response(JSON.stringify(safe), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",  // 60s edge cache
    },
  });
}
