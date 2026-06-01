// functions/admin/submission/[id].js — GET /admin/submission/<id>
import { requireAdmin, postToN8n, csrfFor } from "../../_shared/admin-auth.js";
import { esc, html, forbidden } from "../index.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let data = null;
  try { data = await postToN8n(env, "admin/submission", { submission_id: params.id }, 8000); } catch (_) {}
  if (!data || !data.ok) return html("Submission", `<p><a href="/admin/submissions">← Submissions</a></p><div class="card"><p class="muted">Not found.</p></div>`, 404);
  const csrf = await csrfFor(env, admin.email);
  const s = data.submission || {}, d = data.decision || {};
  const photos = (data.photos||[]).map(p => `<img class="thumb" style="width:140px;height:180px" src="${esc(p.url)}" alt="${esc(p.role)}">`).join(" ");
  const reasons = [].concat(d.pass_reasons||[], d.borderline_reasons||[], d.fail_reasons||[]).map(x=>`<li>${esc(x)}</li>`).join("");
  const hist = (data.history||[]).map(h=>`<li class="muted">${esc(h.created_at)} — ${esc(h.event_type)} ${esc(h.decision||"")}</li>`).join("");
  const act = (a, label, cls) => `<form method="POST" action="/admin/api/resolve" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(params.id)}">
    <button class="btn ${cls}" name="action" value="${a}">${label}</button></form>`;
  return html("Submission "+esc(s.id?String(s.id).slice(0,8):""),
    `<p><a href="/admin/submissions">← Submissions</a></p>
     <div class="card"><span class="badge ${esc(d.decision||"")}">${esc(d.decision||"—")}</span> <span class="muted">conf ${esc(d.confidence??"n/a")}</span>
       <h2>${esc(s.declared_brand||"")} ${esc(s.item_description||"")}</h2>
       <p class="muted">${esc(s.status)} · ${esc((data.merchant||{}).display_name||"")} · seller ${esc((data.seller||{}).email||"")}</p>
       <div>${photos}</div>
       <h3>AI reasons</h3><ul>${reasons||"<li class=muted>none</li>"}</ul>
       <p class="muted">${esc(d.internal_note||"")}</p>
       <h3>Operator actions</h3>
       ${act("send_to_merchant","Send to merchant","primary")}${act("approve","Approve","primary")}${act("reject","Reject","danger")}${act("requeue","Re-run AI","ghost")}
       <h3>History</h3><ul>${hist||"<li class=muted>none</li>"}</ul></div>`);
}
