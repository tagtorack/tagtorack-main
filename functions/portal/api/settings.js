// functions/portal/api/settings.js — POST /portal/api/settings
import { requireSession, getCookie, csrfFor, postToN8n } from "../../_shared/portal-session.js";

const seeOther = (msg) => new Response(null, { status: 303, headers: { Location: "/portal/settings" + (msg ? "?m="+encodeURIComponent(msg) : ""), "Cache-Control":"no-store" } });
const forbid = (m) => new Response(m, { status: 403, headers: { "Cache-Control":"no-store", "Content-Type":"text/plain", "X-Content-Type-Options":"nosniff" } });

// "a, b ,b, c" -> ["a","b","c"] (trim, drop empties, case-insensitive dedupe)
const toList = (raw) => {
  const seen = new Set(), out = [];
  for (const part of String(raw || "").split(",")) {
    const v = part.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
};
const numOrUndef = (raw) => { const n = parseFloat(String(raw || "").trim()); return Number.isFinite(n) ? n : undefined; };

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return seeOther();
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return forbid("bad origin");
  const form = await request.formData();
  if (String(form.get("csrf")||"") !== (await csrfFor(env, getCookie(request, "tt_portal_session")))) return forbid("bad csrf");

  const floor = String(form.get("condition_floor") || "good");
  if (!["new_with_tags","excellent","good","fair"].includes(floor)) return seeOther("Invalid condition");

  const rule_set = {
    categories_accepted: toList(form.get("categories_accepted")),
    brand_allowlist: toList(form.get("brand_allowlist")),
    brand_blocklist: toList(form.get("brand_blocklist")),
    banned_keywords: toList(form.get("banned_keywords")),
    condition_floor: floor,
    merchant_notes: String(form.get("merchant_notes") || "").slice(0, 2000),
  };
  const pf = numOrUndef(form.get("price_floor_usd"));
  const pc = numOrUndef(form.get("price_ceiling_usd"));
  if (pf !== undefined) rule_set.price_floor_usd = pf;
  if (pc !== undefined) rule_set.price_ceiling_usd = pc;

  // merchant_id ALWAYS from the session — never the form.
  try {
    const r = await postToN8n(env, "merchant/profile-update",
      { merchant_id: session.merchant_id, rule_set, operator_email: session.email || session.slug }, 10000);
    if (!r || !r.ok) return seeOther((r && r.error) || "Save failed");
  } catch (_) { return seeOther("Save failed, try again"); }
  return seeOther("Saved");
}
