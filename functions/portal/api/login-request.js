// functions/portal/api/login-request.js — POST /portal/api/login-request
import { postToN8n } from "../../_shared/n8n-fanout.js";
import { checkAndIncrement, sha256Hex } from "../../_shared/ratelimit.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false }); }
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200, { ok: true }); // never leak

  // Rate-limit by IP + email (degrades open). 5 / hour each.
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const kv = env.TT_SUBMIT_RL;
  const ipKey = `portal-login:ip:${await sha256Hex(ip)}`;
  const emKey = `portal-login:em:${await sha256Hex(email)}`;
  const a = await checkAndIncrement(kv, ipKey, 5, { windowSec: 3600 });
  const b = await checkAndIncrement(kv, emKey, 5, { windowSec: 3600 });
  if (!a.allowed || !b.allowed) return json(200, { ok: true }); // throttle silently

  try { await postToN8n(env, "merchant/login-request", { email }, 5000); } catch (_) {}
  return json(200, { ok: true });
}
