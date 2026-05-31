// functions/portal/logout.js — GET /portal/logout
import { clearCookieHeader } from "../_shared/portal-session.js";
export async function onRequestGet() {
  return new Response(null, { status: 302, headers: { Location: "/portal", "Set-Cookie": clearCookieHeader() } });
}
