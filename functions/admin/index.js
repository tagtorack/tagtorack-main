// functions/admin/index.js — GET /admin
import { requireAdmin, postToN8n, ADMIN_CSP } from "../_shared/admin-auth.js";

export const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
export const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>TtR Admin — ${esc(title)}</title><link rel="stylesheet" href="/admin/assets/admin.css"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap"><div class="top"><strong>Tag to Rack — Admin</strong>` +
  `<nav><a href="/admin">Home</a><a href="/admin/queue">Queue</a><a href="/admin/submissions">Submissions</a>` +
  `<a href="/admin/merchants">Merchants</a><a href="/admin/calibration">Calibration</a><a href="/admin/audit">Audit</a></nav></div>${body}` +
  `<script src="/admin/assets/admin.js" defer></script></div></body></html>`;
export const html = (title, body, status = 200) =>
  new Response(page(title, body), { status, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": ADMIN_CSP } });
export const forbidden = () => new Response("Forbidden", { status: 403, headers: { "Cache-Control":"no-store" } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbidden();
  let q = {}, cal = {};
  try { q = (await postToN8n(env, "admin/queue", {}, 8000)) || {}; } catch (_) {}
  try { cal = (await postToN8n(env, "admin/calibration", {}, 8000)) || {}; } catch (_) {}
  const queueN = (q.queue || []).length;
  const c = cal.calibration || {};
  const stat = (l, v) => `<div class="stat"><b>${esc(v)}</b><span class="muted">${esc(l)}</span></div>`;
  return html("Home",
    `<p class="muted">Signed in as ${esc(admin.email)}${admin.dev ? " (dev bypass)" : ""}</p>
     <div class="card">${stat("Operator queue", queueN)}${stat("Received (7d)", c.received_week ?? 0)}${stat("AI agreement", (c.ai_agreement_pct ?? 0)+"%")}${stat("Avg confidence", c.avg_confidence ?? "n/a")}</div>
     <div class="card"><a class="btn primary" href="/admin/queue">Work the queue (${queueN})</a></div>`);
}
