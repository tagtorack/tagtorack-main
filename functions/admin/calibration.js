// functions/admin/calibration.js — GET /admin/calibration
import { requireAdmin, postToN8n } from "../_shared/admin-auth.js";
import { esc, html, forbidden } from "./index.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let c = {};
  try { const r = await postToN8n(env, "admin/calibration", {}, 8000); c = (r && r.calibration) || {}; } catch (_) {}
  const dc = c.decision_counts || {};
  const stat = (l,v) => `<div class="stat"><b>${esc(v)}</b><span class="muted">${esc(l)}</span></div>`;
  const pm = (c.per_merchant||[]).map(x=>`<tr><td>${esc(x.slug)}</td><td>${esc(x.received)}</td><td>${esc(x.approved)}</td></tr>`).join("");
  const tu = (c.token_usage||[]).map(x=>`<tr><td>${esc(x.day)}</td><td>${esc(x.model)}</td><td>${esc(x.count)}</td></tr>`).join("");
  return html("Calibration",
    `<div class="card">${stat("AI agreement",(c.ai_agreement_pct??0)+"%")}${stat("Avg confidence",c.avg_confidence??"n/a")}${stat("Received (7d)",c.received_week??0)}
       ${stat("PASS",dc.PASS??0)}${stat("BORDERLINE",dc.BORDERLINE??0)}${stat("FAIL",dc.FAIL??0)}</div>
     <div class="card"><h3>Per merchant</h3><table><thead><tr><th>Merchant</th><th>Received</th><th>Approved</th></tr></thead><tbody>${pm||'<tr><td colspan=3 class=muted>none</td></tr>'}</tbody></table></div>
     <div class="card"><h3>Gemini usage (14d)</h3><table><thead><tr><th>Day</th><th>Model</th><th>Calls</th></tr></thead><tbody>${tu||'<tr><td colspan=3 class=muted>none</td></tr>'}</tbody></table></div>`);
}
