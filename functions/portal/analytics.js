// functions/portal/analytics.js — GET /portal/analytics
import { requireSession, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const page = (b) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"><div class="wrap">${b}</div>`;
const html = (b) => new Response(page(b), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });
const stat = (label, val) => `<div class="stat"><b>${esc(val)}</b><span class="muted">${esc(label)}</span></div>`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  let st = {};
  try { const r = await postToN8n(env, "merchant/stats", { merchant_id: session.merchant_id }, 8000); st = (r && r.stats) || {}; }
  catch (_) { return html(`<p><a href="/portal">← Queue</a></p><p class="muted">Couldn't load analytics.</p>`); }

  return html(
    `<div class="top"><h1>Analytics</h1><span><a href="/portal">← Queue</a> · <a href="/portal/history">History</a> · <a href="/portal/settings">Settings</a> · <a href="/portal/logout">Sign out</a></span></div>
     <div class="card">
       ${stat("Pending review", st.pending ?? 0)}
       ${stat("Approved (7d)", st.approved_week ?? 0)}
       ${stat("Rejected (7d)", st.rejected_week ?? 0)}
       ${stat("Received (7d)", st.received_week ?? 0)}
       ${stat("AI agreement", (st.ai_agreement_pct ?? 0) + "%")}
       ${stat("Approved resale value", "$" + (st.approved_resale_value ?? 0))}
     </div>`);
}
