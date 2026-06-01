// functions/portal/settings.js — GET /portal/settings (merchant edits their acceptance rules)
import { requireSession, getCookie, csrfFor, postToN8n, PORTAL_CSP } from "../_shared/portal-session.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const page = (b) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — Settings</title><link rel="stylesheet" href="/portal/assets/portal.css?v=1"><meta name="robots" content="noindex"></head>` +
  `<body><div class="wrap">${b}<script src="/portal/assets/chips.js" defer></script></div></body></html>`;
const html = (b) => new Response(page(b), { headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": PORTAL_CSP } });

const KNOWN_CATEGORIES = ["denim","jackets","outdoor-jackets","womens-tops","mens-tops","shirts","sweaters","dresses","pants","jeans","shoes","mens-boots","womens-boots"];

const chips = (name, arr) => {
  const items = (arr || []).map(v => `<span class="chip">${esc(v)}<button type="button" aria-label="remove">×</button></span>`).join("");
  return `<div class="chips" data-name="${name}">${items}<input class="chip-entry" type="text" placeholder="type and press Enter"></div>` +
         `<input type="hidden" name="${name}" value="${esc((arr||[]).join(","))}">`;
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { Location: "/portal" } });

  let rs = {};
  try { const r = await postToN8n(env, "merchant/profile", { merchant_id: session.merchant_id }, 8000); rs = (r && r.rule_set) || {}; }
  catch (_) { return html(`<p><a href="/portal">← Queue</a></p><p class="muted">Couldn't load settings. Refresh to retry.</p>`); }

  const csrf = await csrfFor(env, getCookie(request, "tt_portal_session"));
  const cats = rs.categories_accepted || [];
  const floor = rs.condition_floor || "good";
  const msg = new URL(request.url).searchParams.get("m");
  const quickAdd = KNOWN_CATEGORIES.map(c => `<button type="button" class="quick" data-target="categories_accepted" data-val="${esc(c)}">+${esc(c)}</button>`).join(" ");
  const floorOpts = ["new_with_tags","excellent","good","fair"].map(f => `<option value="${f}"${f===floor?" selected":""}>${f}</option>`).join("");

  return html(
    `<div class="top"><h1>${esc(session.slug)} — Settings</h1>
       <span><a href="/portal">← Queue</a> · <a href="/portal/history">History</a> · <a href="/portal/logout">Sign out</a></span></div>
     ${msg ? `<div class="card"><b>${esc(msg)}</b></div>` : ""}
     <form class="card" method="POST" action="/portal/api/settings">
       <input type="hidden" name="csrf" value="${esc(csrf)}">
       <p class="muted">These rules tell the AI what your store accepts. Changes apply to new submissions immediately.</p>
       <div class="field"><label>Accepted categories</label>${chips("categories_accepted", cats)}
         <div style="margin-top:6px">${quickAdd}</div></div>
       <div class="field"><label>Brand allowlist (brands you want)</label>${chips("brand_allowlist", rs.brand_allowlist)}</div>
       <div class="field"><label>Brand blocklist (brands to auto-reject)</label>${chips("brand_blocklist", rs.brand_blocklist)}</div>
       <div class="field"><label>Banned keywords</label>${chips("banned_keywords", rs.banned_keywords)}</div>
       <div class="field"><label>Minimum condition</label><select name="condition_floor">${floorOpts}</select></div>
       <div class="field"><label>Price range (USD, optional)</label>
         <input type="number" name="price_floor_usd" placeholder="min" value="${esc(rs.price_floor_usd ?? "")}" style="width:120px">
         <input type="number" name="price_ceiling_usd" placeholder="max" value="${esc(rs.price_ceiling_usd ?? "")}" style="width:120px"></div>
       <div class="field"><label>Notes for the AI</label>
         <textarea name="merchant_notes" rows="3" style="width:100%">${esc(rs.merchant_notes || "")}</textarea></div>
       <p><button class="btn approve" type="submit">Save rules</button></p>
     </form>`);
}
