#!/usr/bin/env node
// ops/n8n/sms-probe.mjs — prove Twilio SMS delivery before flipping TT_SMS_ENABLED.
// Reads TWILIO_* from ops/.env (no dotenv dependency) and sends one test message.
// NEVER prints the auth token.
//
// Usage:
//   node sms-probe.mjs +15551234567 ["custom message"]
//
// Exit 0 on Twilio-accepted (queued/sent); prints the message SID + status.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "..", ".env");

function loadEnv(p) {
  const out = {};
  let txt = "";
  try { txt = readFileSync(p, "utf8"); } catch { return out; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(envPath);
const sid = env.TWILIO_ACCOUNT_SID || "";
const tok = env.TWILIO_AUTH_TOKEN || "";
const msgSvc = env.TWILIO_MESSAGING_SERVICE_SID || "";
const fromNum = env.TWILIO_FROM_NUMBER || "";

const to = process.argv[2];
const bodyText = process.argv[3] || "Tag to Rack SMS probe — if you got this, drop-off texts are working. Reply STOP to opt out.";

if (!to || !/^\+\d{8,15}$/.test(to)) {
  console.error("Usage: node sms-probe.mjs +15551234567 [\"message\"]   (To must be E.164, e.g. +15551234567)");
  process.exit(2);
}
if (!sid || !tok) { console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in ops/.env"); process.exit(2); }
if (!msgSvc && !fromNum) { console.error("Set TWILIO_MESSAGING_SERVICE_SID (preferred for 10DLC) or TWILIO_FROM_NUMBER in ops/.env"); process.exit(2); }

const form = new URLSearchParams();
form.append("To", to);
if (msgSvc) form.append("MessagingServiceSid", msgSvc); else form.append("From", fromNum);
form.append("Body", bodyText);

const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
  },
  body: form.toString(),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Twilio HTTP ${res.status} — code ${data.code || "?"}: ${data.message || "unknown error"}`);
  if (data.more_info) console.error(data.more_info);
  process.exit(1);
}
console.log(`OK — SID ${data.sid}, status=${data.status}, to=${data.to}, via=${msgSvc ? "MessagingService" : fromNum}`);
console.log("Watch delivery: Twilio Console → Monitor → Messaging logs (status should reach 'delivered').");
