// functions/portal/index.js — GET /portal
import { requireSession, PORTAL_CSP } from "../_shared/portal-session.js";

const page = (bodyHtml) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Tag to Rack — Store Portal</title><link rel="stylesheet" href="/portal/assets/portal.css">` +
  `<meta name="robots" content="noindex"></head><body><div class="wrap">${bodyHtml}</div></body></html>`;

const html = (s, init = {}) =>
  new Response(page(s), {
    status: init.status || 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP },
  });

const loginView = () =>
  `<div class="top"><h1>Store Portal</h1></div>
   <div class="card"><h2>Sign in</h2>
   <p class="muted">Enter your store's email. We'll send a one-time sign-in link.</p>
   <form id="f"><input type="email" name="email" placeholder="store@example.com" required>
   <p><button class="btn approve" type="submit">Send sign-in link</button></p></form>
   <p id="msg" class="muted"></p></div>
   <script src="/portal/assets/login.js"></script>`;

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return html(loginView());
  // Queue view is implemented in Task 11; placeholder until then.
  return html(`<div class="top"><h1>Queue</h1><a href="/portal/logout">Sign out</a></div><p class="muted">Queue loads here.</p>`);
}
