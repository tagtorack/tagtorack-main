// functions/portal/api/decide.js — POST /portal/api/decide  (form post)
import { requireSession, getCookie, csrfFor, postToN8n } from "../../_shared/portal-session.js";

const seeOther = (loc, msg) =>
  new Response(null, { status: 303, headers: { Location: loc + (msg ? "?m=" + encodeURIComponent(msg) : "") } });

const forbidden = (msg) =>
  new Response(msg, {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return seeOther("/portal");

  // CSRF: same-origin + token bound to the session cookie.
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  if (origin && new URL(origin).host !== url.host) return forbidden("bad origin");

  const form = await request.formData();
  const csrf = String(form.get("csrf") || "");
  const expected = await csrfFor(env, getCookie(request, "tt_portal_session"));
  if (csrf !== expected) return forbidden("bad csrf");

  const submission_id = String(form.get("submission_id") || "");
  const action = String(form.get("action") || "");
  if (!/^[0-9a-fA-F-]{36}$/.test(submission_id) || !["approve", "reject"].includes(action)) return seeOther("/portal", "Invalid request");

  try {
    await postToN8n(env, "merchant/decide", { merchant_id: session.merchant_id, submission_id, action }, 8000);
  } catch (_) { return seeOther("/portal", "Action failed, try again"); }
  return seeOther("/portal", action === "approve" ? "Approved" : "Rejected");
}
