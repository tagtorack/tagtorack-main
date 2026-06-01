// functions/portal/history.js — GET /portal/history?status=&q=
import { requireSession, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const page = (b) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — History</title><link rel="stylesheet" href="/portal/assets/portal.css"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap">${b}</div></body></html>`;
const html = (b) => new Response(page(b), { headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": PORTAL_CSP } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";
  let subs = [];
  try { const r = await postToN8n(env, "merchant/history", { merchant_id: session.merchant_id, status, q }, 8000); subs = (r && r.submissions) || []; }
  catch (_) { return html(`<p><a href="/portal">← Queue</a></p><p class="muted">Couldn't load history. Refresh to retry.</p>`); }

  const opts = [["","All decisions"],["merchant_approved","Approved"],["merchant_rejected","Rejected"]]
    .map(([v,l]) => `<option value="${v}"${v===status?" selected":""}>${l}</option>`).join("");
  const expQs = new URLSearchParams({ ...(status?{status}:{}) , ...(q?{q}:{}) }).toString();
  const rows = subs.map(s => `<tr>
    <td><a href="/portal/submission/${esc(s.submission_id)}">${esc(s.short_id)}</a></td>
    <td>${s.status === "merchant_approved" ? "Approved" : "Rejected"}</td>
    <td><span class="badge ${esc(s.decision||"")}">${esc(s.decision||"—")}</span> <span class="muted">${esc(s.confidence ?? "")}</span></td>
    <td>${esc(s.declared_brand||"")} ${esc((s.item_description||"").slice(0,40))}</td>
    <td>${s.estimated_resale_usd != null ? "$"+esc(s.estimated_resale_usd) : "n/a"}</td>
    <td class="muted">${esc(String(s.merchant_decided_at||"").slice(0,10))}</td></tr>`).join("");
  return html(
    `<div class="top"><h1>${esc(session.slug)} — History</h1>
       <span><a href="/portal">← Queue</a> · <a href="/portal/settings">Settings</a> · <a href="/portal/logout">Sign out</a></span></div>
     <form class="filters card" method="GET">
       <div><label>Decision</label><select name="status">${opts}</select></div>
       <div><label>Search</label><input name="q" value="${esc(q)}" placeholder="short id / brand / item"></div>
       <div><button class="btn approve" type="submit">Filter</button></div>
       <div style="margin-left:auto"><a class="btn" href="/portal/api/export-csv${expQs?("?"+esc(expQs)):""}">Export CSV</a></div>
     </form>
     <div class="card"><p class="muted">${subs.length} decided</p>
       <table><thead><tr><th>ID</th><th>Decision</th><th>AI</th><th>Item</th><th>Est. resale</th><th>Date</th></tr></thead>
       <tbody>${rows || '<tr><td colspan=6 class=muted>No decided submissions yet.</td></tr>'}</tbody></table></div>`);
}
