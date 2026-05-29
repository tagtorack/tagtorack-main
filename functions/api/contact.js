// functions/api/contact.js
// Relays contact form to email (FormSubmit) and SMS (TextBelt + optional gateway).
// Hardened: method+origin+content-type checks, honeypot, size caps, timeouts.

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
  const RECIPIENT_PHONE = (env.RECIPIENT_PHONE || "").replace(/\D/g, "");
  const RECIPIENT_SMS_GATEWAY = (env.RECIPIENT_SMS_GATEWAY || "").trim();

  if (!RECIPIENT_EMAIL) {
    console.error("contact: RECIPIENT_EMAIL not set");
    return json(500, { ok: false, error: "server_misconfigured" });
  }

  // 1) Email via FormSubmit.
  // NOTE: We use FormSubmit's STANDARD endpoint (form-encoded), NOT the /ajax/
  // one. The AJAX endpoint requires a browser Referer/Origin header — but those
  // are "forbidden headers" that the Cloudflare Workers runtime silently strips,
  // so AJAX always fails server-side ("open through a web server" error). The
  // standard endpoint accepts server-side POSTs without a Referer.
  const fsForm = new URLSearchParams();
  fsForm.set("name", name);
  fsForm.set("store", store);
  fsForm.set("email", email);
  fsForm.set("phone", phone || "(not provided)");
  fsForm.set("preferred_contact", pref);
  fsForm.set("notes", notes || "(none)");
  fsForm.set("_subject", `Tag to Rack — demo request from ${name} (${store})`);
  fsForm.set("_replyto", email);
  fsForm.set("_template", "table");
  fsForm.set("_captcha", "false");
  if (RECIPIENT_SMS_GATEWAY) fsForm.set("_cc", RECIPIENT_SMS_GATEWAY);

  let emailOk = false;
  let fsDebug = { status: 0, snippet: "" };
  try {
    const r = await fetchWithTimeout(
      `https://formsubmit.co/${encodeURIComponent(RECIPIENT_EMAIL)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; TagToRackContact/1.0)",
        },
        body: fsForm.toString(),
      },
      FETCH_TIMEOUT_MS,
    );
    const text = await r.text().catch(() => "");
    fsDebug = { status: r.status, snippet: text.slice(0, 200) };
    if (r.ok) {
      // A 200 that still contains an "Activate Form" page means the recipient
      // address isn't confirmed yet — treat that as a failure, not a false success.
      emailOk = !/needs activation|activate (your )?form/i.test(text);
      if (!emailOk) console.error("contact: formsubmit recipient not activated");
    } else {
      console.error("contact: formsubmit non-2xx", r.status);
    }
  } catch (e) {
    fsDebug = { status: -1, snippet: String(e).slice(0, 200) };
    console.error("contact: formsubmit threw", String(e));
  }

  // 2) Best-effort SMS via TextBelt
  let smsOk = false;
  if (RECIPIENT_PHONE) {
    const e164 = RECIPIENT_PHONE.length === 10 ? `1${RECIPIENT_PHONE}` : RECIPIENT_PHONE;
    const smsBody = `Tag to Rack: demo request from ${name} (${store}). Reply via email: ${email}`;
    try {
      const r = await fetchWithTimeout(
        "https://textbelt.com/text",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ phone: e164, message: smsBody, key: "textbelt" }).toString(),
        },
        FETCH_TIMEOUT_MS,
      );
      const result = await r.json().catch(() => ({}));
      smsOk = !!result.success;
      if (!smsOk) console.warn("contact: textbelt failed", JSON.stringify(result));
    } catch (e) {
      console.warn("contact: textbelt threw", String(e));
    }
  }

  if (!emailOk) return json(502, { ok: false, error: "email_send_failed", debug: fsDebug });
  return json(200, { ok: true, email: emailOk, sms: smsOk });
}
