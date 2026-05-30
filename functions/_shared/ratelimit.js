// functions/_shared/ratelimit.js
// KV-backed sliding-window rate limiter for the submit portal.
// Degrades open on KV failure — a broken KV must not deny legitimate sellers.
//
// Required binding on the Pages project (Settings → Functions → KV bindings):
//   TT_SUBMIT_RL   namespace "tagtorack-submit-rl"
//
// Buckets:
//   ip:<sha256-hex-of-ip>         max 5 / 24h
//   merchant:<uuid>:<YYYYMMDD>    max 50 / 24h

const DAY_SECONDS = 86400;

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Atomically check-and-increment a counter.
 * @param {KVNamespace|undefined} kv
 * @param {string} bucketKey
 * @param {number} limit
 * @param {object} [opts]
 * @param {number} [opts.windowSec=DAY_SECONDS]
 * @returns {Promise<{allowed: boolean, count: number, degraded: boolean}>}
 */
export async function checkAndIncrement(kv, bucketKey, limit, opts = {}) {
  if (!kv) return { allowed: true, count: 0, degraded: true };
  const windowSec = opts.windowSec || DAY_SECONDS;
  let count = 0;
  try {
    const raw = await kv.get(bucketKey);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch (e) {
    console.error("ratelimit: KV read failed", String(e));
    return { allowed: true, count: 0, degraded: true };
  }
  if (count >= limit) return { allowed: false, count, degraded: false };
  try {
    await kv.put(bucketKey, String(count + 1), { expirationTtl: windowSec });
  } catch (e) {
    console.error("ratelimit: KV write failed", String(e));
    return { allowed: true, count, degraded: true };
  }
  return { allowed: true, count: count + 1, degraded: false };
}

// Decrement (best-effort) — used by /start to roll back the counter when the
// downstream n8n call fails. Pure best-effort; ignores all errors.
export async function decrement(kv, bucketKey) {
  if (!kv) return;
  try {
    const raw = await kv.get(bucketKey);
    const cur = raw ? parseInt(raw, 10) || 0 : 0;
    if (cur <= 0) return;
    await kv.put(bucketKey, String(cur - 1), { expirationTtl: DAY_SECONDS });
  } catch (e) {
    // swallow
  }
}

// Convenience: verify Turnstile token server-side. Returns boolean.
// Cloudflare returns { success: bool, ... }.
export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) {
    console.warn("Turnstile not configured — degrading open");
    return true;
  }
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    if (!res.ok) return false;
    const body = await res.json();
    return body.success === true;
  } catch (e) {
    console.error("Turnstile verify failed", String(e));
    return false;
  }
}
