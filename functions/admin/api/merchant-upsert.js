// functions/admin/api/merchant-upsert.js — POST /admin/api/merchant-upsert
import { requireAdmin, csrfFor, postToN8n } from "../../_shared/admin-auth.js";

const seeOther = (loc, msg) => new Response(null, { status: 303, headers: { Location: loc + (msg?"?m="+encodeURIComponent(msg):""), "Cache-Control":"no-store" } });
const forbid = (m) => new Response(m, { status: 403, headers: { "Cache-Control":"no-store", "Content-Type":"text/plain" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbid("forbidden");
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return forbid("bad origin");
  const form = await request.formData();
  if (String(form.get("csrf")||"") !== (await csrfFor(env, admin.email))) return forbid("bad csrf");
  const payload = {
    slug: String(form.get("slug")||""), display_name: String(form.get("display_name")||""),
    contact_email: String(form.get("contact_email")||""), dropoff_address: String(form.get("dropoff_address")||""),
    dropoff_hours: String(form.get("dropoff_hours")||""), calcom_event_url: String(form.get("calcom_event_url")||""),
    brand_color: String(form.get("brand_color")||""), status: String(form.get("status")||"active"),
    rule_set: String(form.get("rule_set")||"{}"), operator_email: admin.email,
  };
  let res;
  try { res = await postToN8n(env, "admin/merchant-upsert", payload, 10000); }
  catch (e) { return seeOther("/admin/merchant/"+(payload.slug||"new"), "save failed"); }
  if (!res || !res.ok) return seeOther("/admin/merchant/"+(payload.slug||"new"), (res&&res.error)||"invalid");
  return seeOther("/admin/merchants", "saved "+payload.slug);
}
