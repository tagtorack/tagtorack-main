// functions/_shared/portal-session.js
// Stateless HMAC-signed session cookie + CSRF helper for the merchant portal.
// Web Crypto only (Cloudflare Pages Functions runtime).
import { postToN8n } from "./n8n-fanout.js";

const enc = new TextEncoder();
const COOKIE = "tt_portal_session";
const TTL = 604800; // 7 days

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(enc.encode(s));
const fromB64url = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export async function signSession(env, { merchant_id, slug }) {
  const payload = b64urlStr(JSON.stringify({ merchant_id, slug, exp: Math.floor(Date.now() / 1000) + TTL }));
  return `${payload}.${await hmac(env.PORTAL_SESSION_SECRET, payload)}`;
}

export async function verifySession(env, value) {
  if (!value || value.indexOf(".") < 0) return null;
  const [payload, sig] = value.split(".");
  if (!sig || sig !== (await hmac(env.PORTAL_SESSION_SECRET, payload))) return null;
  let data;
  try { data = JSON.parse(fromB64url(payload)); } catch { return null; }
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data; // { merchant_id, slug, exp }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      // Malformed %-sequences must not 500 the page — treat as no cookie.
      try { return decodeURIComponent(v.join("=")); } catch { return null; }
    }
  }
  return null;
}

export async function requireSession(request, env) {
  return await verifySession(env, getCookie(request, COOKIE));
}

export function setCookieHeader(value) {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=${TTL}`;
}
export function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=0`;
}

// CSRF token bound to the session value (stateless): HMAC of the cookie value.
export async function csrfFor(env, sessionValue) {
  return (await hmac(env.PORTAL_SESSION_SECRET, "csrf:" + sessionValue)).slice(0, 32);
}

// Shared CSP for portal Function responses (allows R2 image hosts).
export const PORTAL_CSP =
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self'; " +
  "form-action 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'";

// Thin n8n caller (re-exported for portal handlers).
export { postToN8n };
