// Posts a JSON body to a local n8n production webhook and prints status + body.
// Optionally HMAC-signs like the Pages layer (X-TTR-Timestamp + X-TTR-Signature)
// when SIGN=1 and INTAKE_WEBHOOK_SECRET is set — n8n ignores them in Phase B.
// Usage: node post-webhook.mjs <hookPath> <bodyFile>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";

const [, , hookPath, bodyFile] = process.argv;
const body = readFileSync(resolve(process.cwd(), bodyFile), "utf8");
const url = `http://localhost:5678/webhook/${hookPath.replace(/^\//, "")}`;
const headers = { "Content-Type": "application/json", Accept: "application/json" };

if (process.env.SIGN === "1" && process.env.INTAKE_WEBHOOK_SECRET) {
  const ts = String(process.env.TS || "1");
  const sig = createHmac("sha256", process.env.INTAKE_WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
  headers["X-TTR-Timestamp"] = ts;
  headers["X-TTR-Signature"] = `sha256=${sig}`;
}

const res = await fetch(url, { method: "POST", headers, body });
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);
