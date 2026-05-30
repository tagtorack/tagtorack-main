// functions/_shared/n8n-fanout.js
// HMAC-signed fanout to the self-hosted n8n stack. Mirrors the inline pattern
// in functions/api/contact.js; centralized here so every new Pages Function
// in functions/submit/api/* uses the same signing + timeout behavior.
//
// Required env on the Pages project:
//   INTAKE_WEBHOOK_BASE     e.g. "https://n8n.tagtorack.com/webhook"
//   INTAKE_WEBHOOK_SECRET   shared with ops/.env INTAKE_WEBHOOK_SECRET (HMAC key)

export const DEFAULT_TIMEOUT_MS = 5000;

export const fetchWithTimeout = async (url, init, ms = DEFAULT_TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
};

export const hmacSha256Hex = async (key, message) => {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// POST {payload} to n8n's webhook URL at INTAKE_WEBHOOK_BASE/<hookPath>, signed
// with X-TTR-Timestamp + X-TTR-Signature headers. Returns the parsed JSON body
// on 2xx, throws Error on non-2xx (so callers can surface the right HTTP status
// back to the seller). Use postToN8nFireAndForget for the "don't care" path.
export const postToN8n = async (env, hookPath, payload, timeoutMs = 8000) => {
  if (!env.INTAKE_WEBHOOK_BASE || !env.INTAKE_WEBHOOK_SECRET) {
    const err = new Error("n8n_not_configured");
    err.status = 503;
    throw err;
  }
  const url = `${env.INTAKE_WEBHOOK_BASE.replace(/\/$/, "")}/${hookPath.replace(/^\//, "")}`;
  const body = JSON.stringify(payload);
  const ts = Date.now().toString();
  const sig = await hmacSha256Hex(env.INTAKE_WEBHOOK_SECRET, `${ts}.${body}`);
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TTR-Timestamp": ts,
        "X-TTR-Signature": `sha256=${sig}`,
      },
      body,
    },
    timeoutMs,
  );
  if (!res.ok) {
    const err = new Error(`n8n_${res.status}`);
    err.status = res.status;
    err.body = await res.text().catch(() => "");
    throw err;
  }
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
};

// Fire-and-forget version. Never throws. Returns boolean ok. Use inside
// context.waitUntil() when the user response should not block on n8n.
export const postToN8nFireAndForget = async (env, hookPath, payload, timeoutMs = 3000) => {
  try {
    await postToN8n(env, hookPath, payload, timeoutMs);
    return true;
  } catch (e) {
    console.error(`postToN8nFireAndForget ${hookPath} failed`, String(e));
    return false;
  }
};

// JSON response helper shared with submit handlers.
export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

// Origin allowlist used by every submit API. Add new dev/preview hosts here.
const ALLOWED_ORIGINS = new Set([
  "https://submit.tagtorack.com",
  "https://tagtorack.com",
  "https://www.tagtorack.com",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
]);
export const isAllowedOrigin = (request) => {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // same-origin / no Origin header
  return ALLOWED_ORIGINS.has(origin);
};

// Exact application/json check — ignores params like "; charset=utf-8" but
// rejects look-alikes ("application/jsonp", "text/json") that indexOf allows.
export const isJsonContentType = (request) => {
  const ct = (request.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return ct === "application/json";
};
