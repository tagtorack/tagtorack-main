// functions/portal/submission/[id].js — GET /portal/submission/<id>
import { requireSession, getCookie, csrfFor, postToN8n, PORTAL_CSP } from "../../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (b) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<link rel="stylesheet" href="/portal/assets/portal.css?v=1"><meta name="robots" content="noindex"><div class="wrap">${b}</div>`;
const html = (b, status = 200) =>
  new Response(page(b), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  // Reuse the queue webhook and find this submission (keeps n8n surface small).
  let s = null;
  try {
    const r = await postToN8n(env, "merchant/queue", { merchant_id: session.merchant_id }, 8000);
    s = ((r && r.submissions) || []).find((x) => x.submission_id === params.id) || null;
  } catch (_) {}
  if (!s) return html(`<p><a href="/portal">← Queue</a></p><div class="card"><p class="muted">Not found in your pending queue (it may already be decided).</p></div>`);

  const csrf = await csrfFor(env, getCookie(request, "tt_portal_session"));
  const photos = (s.photos || []).map((p) => `<img class="thumb" style="width:160px;height:200px" src="${esc(p.url)}" alt="${esc(p.role)}">`).join(" ");
  const reasons = [].concat(s.pass_reasons || [], s.borderline_reasons || [], s.fail_reasons || []).map((x) => `<li>${esc(x)}</li>`).join("");
  return html(
    `<p><a href="/portal">← Queue</a></p>
     <div class="card"><div><span class="badge ${esc(s.decision)}">${esc(s.decision)}</span> <span class="muted">conf ${esc(s.confidence)}</span></div>
     <h2>${esc(s.declared_brand || "")} ${esc(s.item_description || "")}</h2>
     <p class="muted">${esc(s.declared_category || "")} · ${esc(s.declared_condition || "")} · asking ${s.asking_price_usd != null ? "$" + esc(s.asking_price_usd) : "n/a"} · est. resale ${s.estimated_resale_usd != null ? "$" + esc(s.estimated_resale_usd) : "n/a"}</p>
     <div class="row" style="flex-wrap:wrap">${photos}</div>
     <h3>AI reasons</h3><ul>${reasons}</ul>
     <p class="muted">${esc(s.internal_note || "")}</p>
     <form method="POST" action="/portal/api/decide">
       <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="submission_id" value="${esc(s.submission_id)}">
       <button class="btn approve" name="action" value="approve">Approve</button>
       <button class="btn reject" name="action" value="reject">Reject</button>
     </form></div>`);
}
