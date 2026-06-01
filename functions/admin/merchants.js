// functions/admin/merchants.js — GET /admin/merchants
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let ms = [];
  try { const r = await postToN8n(env, "admin/merchants", {}, 8000); ms = (r && r.merchants) || []; } catch (_) {}
  const rows = ms.map(m => `<tr><td><a href="/admin/merchant/${esc(m.slug)}">${esc(m.slug)}</a></td>
    <td>${esc(m.display_name)}</td><td>${esc(m.contact_email)}</td><td>${esc(m.status)}</td>
    <td>${esc(m.pending)}</td><td>${esc(m.total_submissions)}</td></tr>`).join("");
  return html("Merchants",
    `<div class="card"><a class="btn primary" href="/admin/merchant/new">+ New merchant</a></div>
     <div class="card"><table><thead><tr><th>Slug</th><th>Name</th><th>Email</th><th>Status</th><th>Pending</th><th>Total</th></tr></thead>
       <tbody>${rows||'<tr><td colspan=6 class=muted>none</td></tr>'}</tbody></table></div>`);
}
