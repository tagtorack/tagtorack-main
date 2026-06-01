// functions/submit/status.js — GET /submit/status?s=<token>  (public; token is the auth)
import { postToN8n } from "../_shared/n8n-fanout.js";
import { verifyStatusToken } from "../_shared/status-token.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'";
const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><link rel="stylesheet" href="/assets/css/styles.css"><meta name="robots" content="noindex">` +
  `<style>.track{display:flex;gap:8px;margin:16px 0}.dot{flex:1;text-align:center;padding:8px;border-radius:8px;background:#eee;color:#888;font-size:13px}.dot.on{background:#6a40c9;color:#fff}.shot{width:96px;height:96px;object-fit:cover;border-radius:8px;margin:4px}</style></head>` +
  `<body><main style="max-width:560px;margin:40px auto;padding:0 20px;font-family:system-ui,sans-serif">${body}</main></body></html>`;
const html = (title, body, status = 200) =>
  new Response(shell(title, body), { status, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store", "Content-Security-Policy": CSP } });

const invalidPage = () => html("Status link", `<h1>This link is invalid or expired</h1>
  <p>Please use the status link in your most recent Tag to Rack email, or reply to that email and we'll help.</p>`, 404);

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get("s") || "";
  const submission_id = await verifyStatusToken(env, token);
  if (!submission_id) return invalidPage();

  let data;
  try { data = await postToN8n(env, "submit/status", { submission_id }, 8000); }
  catch (_) { return html("Status", `<h1>We couldn't load your status</h1><p>Please refresh in a moment.</p>`, 502); }
  if (!data || !data.ok) return invalidPage();

  const m = data.merchant || {}, it = data.item || {}, stage = data.stage || {};
  const steps = [["received","Received"],["in_review","In review"],["decided","Decision"]];
  const dots = steps.map((_, i) => `<div class="dot${(stage.step||1) > i ? " on" : ""}">${esc(steps[i][1])}</div>`).join("");
  const photos = (data.photos||[]).map(p => `<img class="shot" src="${esc(p.url)}" alt="${esc(p.role)}">`).join("");
  const dropoff = data.calcom_url ? `<p><a class="btn btn-primary" href="${esc(data.calcom_url)}">Schedule your drop-off</a></p>` : "";
  const itemLine = [it.brand, it.category, it.size].filter(Boolean).map(esc).join(" · ");
  return html(`Status — ${esc(m.display_name||"Tag to Rack")}`,
    `<p style="color:${/^#[0-9a-fA-F]{6}$/.test(m.brand_color||"")?esc(m.brand_color):"#6a40c9"};font-weight:700">${esc(m.display_name||"Tag to Rack")}</p>
     <h1>${esc(stage.label||"Status")}</h1>
     <div class="track">${dots}</div>
     <p>${esc(stage.message||"")}</p>
     ${dropoff}
     <div>${photos}</div>
     <p style="color:#888;font-size:13px">Submission ${esc(data.short_id||"")} · ${itemLine}</p>
     <p style="color:#888;font-size:12px">Questions? Reply to your confirmation email.</p>`);
}
