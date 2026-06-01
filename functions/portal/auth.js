// functions/portal/auth.js — GET /portal/auth?t=<raw>
import { postToN8n, signSession, setCookieHeader, PORTAL_CSP } from "../_shared/portal-session.js";

const errPage = (msg) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/portal/assets/portal.css?v=1">` +
    `<div class="wrap"><div class="card"><h2>Sign-in link invalid</h2><p class="muted">${msg}</p>` +
    `<p><a href="/portal">Back to sign in</a></p></div></div>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PORTAL_CSP } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get("t") || "";
  if (!token) return errPage("Missing token.");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  let resp;
  try { resp = await postToN8n(env, "merchant/login-consume", { token, ip }, 5000); }
  catch { return errPage("This link has expired or was already used. Request a new one."); }
  if (!resp || !resp.ok || !resp.merchant_id) return errPage("This link has expired or was already used. Request a new one.");

  const cookie = await signSession(env, { merchant_id: resp.merchant_id, slug: resp.slug });
  return new Response(null, { status: 302, headers: { Location: "/portal", "Set-Cookie": setCookieHeader(cookie) } });
}
