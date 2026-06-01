// functions/admin/api/resolve.js — POST /admin/api/resolve
import { requireAdmin, csrfFor, postToN8n } from "../../_shared/admin-auth.js";

const seeOther = (msg) => new Response(null, { status: 303, headers: { Location: "/admin/queue" + (msg ? "?m="+encodeURIComponent(msg) : ""), "Cache-Control":"no-store" } });
const forbid = (m) => new Response(m, { status: 403, headers: { "Cache-Control":"no-store", "Content-Type":"text/plain" } });

export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return forbid("forbidden");
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return forbid("bad origin");
  const form = await request.formData();
  if (String(form.get("csrf")||"") !== (await csrfFor(env, admin.email))) return forbid("bad csrf");
  const submission_id = String(form.get("submission_id")||"");
  const action = String(form.get("action")||"");
  if (!/^[0-9a-fA-F-]{36}$/.test(submission_id) || !["send_to_merchant","approve","reject","requeue"].includes(action)) return seeOther("invalid");
  try { await postToN8n(env, "admin/resolve", { submission_id, action, operator_email: admin.email }, 10000); }
  catch (_) { return seeOther("action failed"); }
  return seeOther(action+" done");
}
