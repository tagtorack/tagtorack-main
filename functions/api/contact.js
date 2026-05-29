// functions/api/contact.js
// Sends the contact form to email via Resend (authenticated API — reliable from
// Cloudflare Workers, unlike free form-relay services that block datacenter IPs).
// Hardened: method+origin+content-type checks, honeypot, size caps, timeouts.
// Required env: RESEND_API_KEY, RECIPIENT_EMAIL. Optional: FROM_EMAIL.

const MAX_FIELD = 2000;
const MAX_TOTAL = 6000;
const FETCH_TIMEOUT_MS = 8000;

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && !(u.hostname === "localhost" || u.hostname === "127.0.0.1")) return false;
    if (u.hostname === "tagtorack.pages.dev") return true;
    if (u.hostname.endsWith(".tagtorack.pages.dev")) return true;
    if (u.hostname === "tagtorack.com" || u.hostname === "www.tagtorack.com") return true;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    return false;
  } catch { return false; }
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const clip = (s) => (typeof s === "string" ? s.slice(0, MAX_FIELD) : "");

const fetchWithTimeout = async (url, init, ms) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally { clearTimeout(t); }
};

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.includes("application/json")) return json(415, { ok: false, error: "unsupported_media_type" });

  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) return json(403, { ok: false, error: "bad_origin" });

  let data;
  try { data = await request.json(); } catch { return json(400, { ok: false, error: "bad_json" }); }
  if (!data || typeof data !== "object") return json(400, { ok: false, error: "bad_body" });

  // Honeypot — drop silently with fake success
  if (data.website) return json(200, { ok: true, email: false, sms: false });

  const name = clip(data.name).trim();
  const store = clip(data.store).trim();
  const email = clip(data.email).trim();
  const phone = clip(data.phone).trim();
  const pref = clip(data.contact_pref).trim() || "email";
  const notes = clip(data.notes).trim();

  if (!name || !store || !isEmail(email)) return json(400, { ok: false, error: "missing_fields" });
  if (name.length + store.length + email.length + phone.length + notes.length > MAX_TOTAL) {
    return json(413, { ok: false, error: "payload_too_large" });
  }

  const RECIPIENT_EMAIL = env.RECIPIENT_EMAIL;
  // Env var names are case-sensitive; accept the canonical name and the
  // mixed-case "Resend_API_Key" that was set in the dashboard.
  const RESEND_API_KEY = env.RESEND_API_KEY || env.Resend_API_Key;
  const FROM = env.FROM_EMAIL || "Tag to Rack <noreply@tagtorack.com>";

  if (!RECIPIENT_EMAIL || !RESEND_API_KEY) {
    console.error("contact: missing RECIPIENT_EMAIL or RESEND_API_KEY");
    return json(500, { ok: false, error: "server_misconfigured" });
  }

  // Build the notification email. Escape user input before embedding in HTML.
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const row = (k, v) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#666;">${k}</td><td style="padding:4px 0;"><strong>${esc(v)}</strong></td></tr>`;
  const html = `<h2 style="font-family:sans-serif;">New demo request — Tag to Rack</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;">
      ${row("Name", name)}
      ${row("Store", store)}
      ${row("Email", email)}
      ${row("Phone", phone || "(not provided)")}
      ${row("Preferred contact", pref)}
      ${row("Notes", notes || "(none)")}
    </table>`;

  // Send via Resend's authenticated API (works reliably from the Worker).
  let emailOk = false;
  try {
    const r = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: [RECIPIENT_EMAIL],
          reply_to: email,
          subject: `Tag to Rack — demo request from ${name} (${store})`,
          html,
        }),
      },
      FETCH_TIMEOUT_MS,
    );
    emailOk = r.ok; // Resend returns 200 + { id } on success
    if (!emailOk) console.error("contact: resend non-2xx", r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.error("contact: resend threw", String(e));
  }

  if (!emailOk) return json(502, { ok: false, error: "email_send_failed" });
  return json(200, { ok: true, email: emailOk });
}
