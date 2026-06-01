// functions/admin/submissions.js — GET /admin/submissions?status=&merchant_id=&q=
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

const STATUSES = ["pending_uploads","received","ai_reviewing","merchant_review","ai_borderline","ai_failed","merchant_approved","merchant_rejected","dropoff_scheduled","completed","expired","withdrawn","deleted"];

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";
  let subs = [];
  try { const r = await postToN8n(env, "admin/submissions", { status, q, limit: 100 }, 8000); subs = (r && r.submissions) || []; } catch (_) {}
  const opts = ['<option value="">all statuses</option>'].concat(STATUSES.map(s => `<option value="${s}"${s===status?" selected":""}>${s}</option>`)).join("");
  const rows = subs.map(s => `<tr>
    <td><a href="/admin/submission/${esc(s.submission_id)}">${esc(s.short_id)}</a></td>
    <td><span class="badge ${esc(s.decision||"")}">${esc(s.decision||"—")}</span></td>
    <td>${esc(s.status)}</td><td>${esc(s.merchant_slug)}</td><td>${esc(s.seller_email)}</td>
    <td>${esc(s.declared_brand||"")} ${esc((s.item_description||"").slice(0,40))}</td></tr>`).join("");
  return html("Submissions",
    `<form class="filters card" method="GET">
       <div><label>Status</label><select name="status">${opts}</select></div>
       <div><label>Search</label><input name="q" value="${esc(q)}" placeholder="short id / email / brand"></div>
       <div><button class="btn primary" type="submit">Filter</button></div></form>
     <div class="card"><p class="muted">${subs.length} result(s)</p>
       <table><thead><tr><th>ID</th><th>AI</th><th>Status</th><th>Merchant</th><th>Seller</th><th>Item</th></tr></thead><tbody>${rows||'<tr><td colspan=6 class=muted>none</td></tr>'}</tbody></table></div>`);
}
