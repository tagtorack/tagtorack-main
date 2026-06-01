// functions/portal/index.js — GET /portal
import { requireSession, getCookie, csrfFor, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (b) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — Store Portal</title><link rel="stylesheet" href="/portal/assets/portal.css?v=1"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap">${b}</div></body></html>`;
const html = (b, status = 200) =>
  new Response(page(b), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });

const loginView = () =>
  `<div class="top"><h1>Store Portal</h1></div><div class="card"><h2>Sign in</h2>
   <p class="muted">Enter your store's email. We'll send a one-time sign-in link.</p>
   <form id="f"><input type="email" name="email" placeholder="store@example.com" required>
   <p><button class="btn approve" type="submit">Send sign-in link</button></p></form>
   <p id="msg" class="muted"></p></div><script src="/portal/assets/login.js"></script>`;

const card = (s, csrf) => {
  const dec = s.decision || "—";
  const thumb = (s.photos && s.photos[0] && s.photos[0].url) || "";
  return `<div class="card"><div class="row">
    <img class="thumb" src="${esc(thumb)}" alt="submission photo">
    <div style="flex:1">
      <div><span class="badge ${esc(dec)}">${esc(dec)}</span> <span class="muted">conf ${esc(s.confidence)}</span></div>
      <p><b>${esc(s.declared_brand || "")} ${esc(s.item_description || "")}</b></p>
      <p class="muted">${esc(s.declared_category || "")} · ${esc(s.declared_condition || "")} · est. resale ${s.estimated_resale_usd != null ? "$" + esc(s.estimated_resale_usd) : "n/a"}</p>
      <p class="muted">${esc((s.internal_note || "").slice(0, 160))}</p>
      <form method="POST" action="/portal/api/decide" style="display:inline">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(s.submission_id)}">
        <button class="btn approve" name="action" value="approve">Approve</button>
        <button class="btn reject" name="action" value="reject">Reject</button>
      </form>
      <a class="muted" href="/portal/submission/${esc(s.submission_id)}" style="margin-left:10px">Details</a>
    </div></div></div>`;
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return html(loginView());

  let subs = [];
  try {
    const r = await postToN8n(env, "merchant/queue", { merchant_id: session.merchant_id }, 8000);
    subs = (r && r.submissions) || [];
  } catch (_) { return html(`<div class="top"><h1>${esc(session.slug)}</h1><a href="/portal/logout">Sign out</a></div><p class="muted">Couldn't load the queue. Refresh to retry.</p>`); }

  const csrf = await csrfFor(env, getCookie(request, "tt_portal_session"));
  const head = `<div class="top"><h1>${esc(session.slug)} — Queue (${subs.length})</h1>
    <span><a href="/portal/history">History</a> · <a href="/portal/settings">Settings</a> · <a href="/portal/analytics">Analytics</a> · <a href="/portal/logout">Sign out</a></span></div>`;
  const list = subs.length ? subs.map((s) => card(s, csrf)).join("") : `<div class="card"><p class="muted">No submissions awaiting review.</p></div>`;
  return html(head + list);
}
