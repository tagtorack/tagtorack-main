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

  // Seller link + QR (existing merchants only) — for handing a store its intake
  // link/sign during onboarding. Reuses the generic /portal/assets share scripts.
  const origin = new URL(request.url).origin;
  const sellerLink = `${origin}/submit/m/${m.slug}`;
  const shareCard = isNew ? "" : `<div class="card" style="display:flex;flex-wrap:wrap;gap:24px;align-items:center">
      <div style="flex:1;min-width:260px">
        <h2 style="margin:0 0 4px">Seller link &amp; QR</h2>
        <p class="muted">Hand this to the store during onboarding — sellers submit items here. Copy the link or download the QR for a "scan to sell" sign.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <input id="share-link" readonly value="${esc(sellerLink)}" aria-label="Seller link" style="flex:1;min-width:240px;font-family:var(--mono);font-size:13px">
          <button class="btn primary" type="button" id="copy-link" data-link="${esc(sellerLink)}">Copy link</button>
        </div>
        <p id="copy-msg" class="muted" role="status" style="min-height:18px;margin:8px 0 0"></p>
      </div>
      <div style="text-align:center">
        <div id="qr" data-link="${esc(sellerLink)}" style="width:172px;height:172px;display:grid;place-items:center;background:#fff;border:1px solid var(--line);border-radius:16px;padding:10px"></div>
        <a class="btn ghost" id="qr-download" download="${esc(m.slug)}-tagtorack-qr.svg" style="margin-top:10px;font-size:13px;padding:8px 14px">Download QR</a>
      </div>
    </div>`;
  const scripts = isNew ? "" : `<script src="/portal/assets/qrcode.js" defer></script><script src="/portal/assets/share.js" defer></script>`;
  return html(isNew?"New merchant":"Edit "+esc(m.slug),
    `<p><a href="/admin/merchants">← Merchants</a></p>${shareCard}
     <form class="card" method="POST" action="/admin/api/merchant-upsert">
       <input type="hidden" name="csrf" value="${esc(csrf)}">
       ${f("slug","Slug",m.slug)}${f("display_name","Display name",m.display_name)}${f("contact_email","Contact email",m.contact_email)}
       ${f("dropoff_address","Drop-off address",m.dropoff_address)}${f("dropoff_hours","Drop-off hours",m.dropoff_hours)}
       ${f("calcom_event_url","Cal.com URL",m.calcom_event_url||"")}${f("brand_color","Brand color",m.brand_color)}
       <label>Status</label><select name="status">${["active","paused","archived"].map(s=>`<option${s===m.status?" selected":""}>${s}</option>`).join("")}</select>
       <label>rule_set (JSON)</label><textarea name="rule_set">${esc(JSON.stringify(m.rule_set||{}, null, 2))}</textarea>
       <p><button class="btn primary" type="submit">Save</button></p></form>${scripts}`);
}
