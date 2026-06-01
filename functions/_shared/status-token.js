// functions/_shared/status-token.js
// Stateless seller status token: base64url(submission_id) + "." + base64url(HMAC-SHA256(submission_id, secret)).
// Same secret as the merchant portal (PORTAL_SESSION_SECRET) so n8n + Pages mint identical tokens.
// Web Crypto only (Cloudflare Pages runtime).
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const b64urlStr = (s) => b64url(enc.encode(s));
const fromB64url = (s) => { s = s.replace(/-/g,"+").replace(/_/g,"/"); return atob(s + "=".repeat((4 - s.length % 4) % 4)); };

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// Mint a token for a submission_id.
export async function mintStatusToken(env, submission_id) {
  const sig = await hmac(env.PORTAL_SESSION_SECRET, submission_id);
  return `${b64urlStr(submission_id)}.${sig}`;
}

// Verify a token; return the submission_id (string) or null.
export async function verifyStatusToken(env, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [encId, sig] = token.split(".");
  let submission_id;
  try { submission_id = fromB64url(encId); } catch { return null; }
  if (!/^[0-9a-fA-F-]{36}$/.test(submission_id)) return null;
  if (sig !== (await hmac(env.PORTAL_SESSION_SECRET, submission_id))) return null;
  return submission_id;
}
