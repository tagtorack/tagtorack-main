// functions/admin/queue.js — GET /admin/queue
import { requireAdmin, postToN8n, csrfFor } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let items = [];
  try { const r = await postToN8n(env, "admin/queue", {}, 8000); items = (r && r.queue) || []; } catch (_) {}
  const csrf = await csrfFor(env, admin.email);
  const act = (id,a,label,cls) => `<form method="POST" action="/admin/api/resolve" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(id)}">
    <button class="btn ${cls}" name="action" value="${a}">${label}</button></form>`;
  const cards = items.map(s => {
    const thumb = (s.photos && s.photos[0] && s.photos[0].url) || "";
    const reasons = [].concat(s.borderline_reasons||[], s.fail_reasons||[]).map(x=>`<li>${esc(x)}</li>`).join("");
    return `<div class="card"><div style="display:flex;gap:14px">
      <img class="thumb" src="${esc(thumb)}" alt="">
      <div style="flex:1"><span class="badge ${esc(s.decision||"")}">${esc(s.decision||s.status)}</span> <span class="muted">${esc(s.status)} · ${esc(s.merchant_slug)} · conf ${esc(s.confidence??"n/a")}</span>
        <p><b>${esc(s.declared_brand||"")} ${esc(s.item_description||"")}</b></p>
        <ul class="muted">${reasons||"<li>—</li>"}</ul>
        ${act(s.submission_id,"send_to_merchant","Send to merchant","primary")}${act(s.submission_id,"approve","Approve","primary")}${act(s.submission_id,"reject","Reject","danger")}${act(s.submission_id,"requeue","Re-run AI","ghost")}
        <a class="muted" href="/admin/submission/${esc(s.submission_id)}" style="margin-left:8px">details</a></div></div></div>`;
  }).join("");
  return html("Queue", `<h2>Operator queue (${items.length})</h2>${cards||'<div class="card"><p class="muted">Nothing waiting.</p></div>'}`);
}
