// functions/_shared/admin-auth.js
// Cloudflare Access JWT verification (RS256 via Web Crypto) + operator allowlist,
// with a fenced local-dev bypass. CSRF + CSP helpers for the admin dashboard.
import { postToN8n } from "./n8n-fanout.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToString = (s) => dec.decode(b64urlToBytes(s));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Per-isolate JWKS cache (1h TTL).
let _jwks = { keys: [], at: 0 };
async function getJwks(teamDomain) {
  const now = Date.now();
  if (_jwks.keys.length && now - _jwks.at < 3600000) return _jwks.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("jwks_fetch_failed_" + res.status);
  const data = await res.json();
  _jwks = { keys: data.keys || [], at: now };
  return _jwks.keys;
}

async function verifyAccessJwt(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try { header = JSON.parse(b64urlToString(h)); payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!env.CF_ACCESS_AUD || !aud.includes(env.CF_ACCESS_AUD)) return null;
  let jwks;
  try { jwks = await getJwks(env.CF_ACCESS_TEAM_DOMAIN); } catch { return null; }
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), enc.encode(`${h}.${p}`));
  return ok ? payload : null;
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) { try { return decodeURIComponent(v.join("=")); } catch { return null; } }
  }
  return null;
}

// Returns { email } for an authorized operator, or null.
export async function requireAdmin(request, env) {
  if (env.ADMIN_DEV_BYPASS === "true") {
    const first = (env.ADMIN_EMAILS || "dev@local").split(",")[0].trim();
    return { email: first || "dev@local", dev: true };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || getCookie(request, "CF_Authorization");
  if (!token) return null;
  const payload = await verifyAccessJwt(token, env);
  if (!payload || !payload.email) return null;
  const allow = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length || !allow.includes(String(payload.email).toLowerCase())) return null;
  return { email: payload.email };
}

// CSRF token bound to the operator email (reuses PORTAL_SESSION_SECRET).
export async function csrfFor(env, email) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.PORTAL_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode("admin-csrf:" + email))).slice(0, 32);
}

export const ADMIN_CSP =
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: https://*.r2.cloudflarestorage.com; connect-src 'self'; " +
  "form-action 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'";

export { postToN8n };
