// functions/admin/merchant/[slug].js — GET /admin/merchant/<slug>  (or /new)
import { requireAdmin, postToN8n, csrfFor } from "../../_shared/admin-auth.js";
import { esc, html, forbidden } from "../index.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  const isNew = params.slug === "new";
  let m = { slug:"", display_name:"", contact_email:"", dropoff_address:"", dropoff_hours:"", calcom_event_url:"", brand_color:"#6a40c9", public_intro:"", status:"active", rule_set:{} };
  if (!isNew) {
    try { const r = await postToN8n(env, "admin/merchants", { slug: params.slug }, 8000); if (r && r.merchants && r.merchants[0]) m = r.merchants[0]; } catch (_) {}
  }
  const csrf = await csrfFor(env, admin.email);
  const f = (name,label,val) => `<label>${label}</label><input name="${name}" value="${esc(val)}" ${name==="slug"&&!isNew?"readonly":""}>`;
  return html(isNew?"New merchant":"Edit "+esc(m.slug),
    `<p><a href="/admin/merchants">← Merchants</a></p>
     <form class="card" method="POST" action="/admin/api/merchant-upsert">
       <input type="hidden" name="csrf" value="${esc(csrf)}">
       ${f("slug","Slug",m.slug)}${f("display_name","Display name",m.display_name)}${f("contact_email","Contact email",m.contact_email)}
       ${f("dropoff_address","Drop-off address",m.dropoff_address)}${f("dropoff_hours","Drop-off hours",m.dropoff_hours)}
       ${f("calcom_event_url","Cal.com URL",m.calcom_event_url||"")}${f("brand_color","Brand color",m.brand_color)}
       <label>Status</label><select name="status">${["active","paused","archived"].map(s=>`<option${s===m.status?" selected":""}>${s}</option>`).join("")}</select>
       <label>rule_set (JSON)</label><textarea name="rule_set">${esc(JSON.stringify(m.rule_set||{}, null, 2))}</textarea>
       <p><button class="btn primary" type="submit">Save</button></p></form>`);
}
