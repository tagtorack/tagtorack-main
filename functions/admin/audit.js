// functions/admin/audit.js — GET /admin/audit?event_type=
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  const u = new URL(request.url);
  const event_type = u.searchParams.get("event_type") || "";
  let events = [];
  try { const r = await postToN8n(env, "admin/audit", { event_type, limit: 200 }, 8000); events = (r && r.events) || []; } catch (_) {}
  const rows = events.map(e => `<tr><td class="muted">${esc(e.created_at)}</td><td>${esc(e.event_type)}</td>
    <td>${esc(e.decision||"")}</td><td>${esc(e.submission_id?String(e.submission_id).slice(0,8):"")}</td>
    <td class="muted">${esc(JSON.stringify(e.payload||{}).slice(0,120))}</td></tr>`).join("");
  return html("Audit",
    `<form class="filters card" method="GET"><div><label>Event type</label><input name="event_type" value="${esc(event_type)}" placeholder="operator_resolved / agent_output"></div><div><button class="btn primary">Filter</button></div></form>
     <div class="card"><table><thead><tr><th>When</th><th>Event</th><th>Decision</th><th>Sub</th><th>Payload</th></tr></thead><tbody>${rows||'<tr><td colspan=5 class=muted>none</td></tr>'}</tbody></table></div>`);
}
