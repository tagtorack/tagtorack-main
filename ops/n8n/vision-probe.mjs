// Standalone validation of the WF-5 vision step: presign GET (node crypto SigV4)
// -> fetch bytes -> base64 -> Gemini generateContent w/ responseSchema.
// Mirrors the code that will be ported into the WF-5 "Vision" Code node.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac, createHash } from "node:crypto";

const env = {};
for (const line of readFileSync(resolve(process.cwd(), "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
}

// ---- R2 SigV4 presign (GET) using node:crypto ----
function presignR2Get(r2key, expiresSec = 600) {
  const acct = env.R2_ACCOUNT_ID, ak = env.R2_ACCESS_KEY_ID, sk = env.R2_SECRET_ACCESS_KEY, bucket = env.R2_BUCKET;
  const host = `${acct}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const hmac = (k, m) => createHmac("sha256", k).update(m).digest();
  const canonicalUri = "/" + enc(bucket) + "/" + r2key.split("/").map(enc).join("/");
  const q = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${ak}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "host",
  };
  const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonicalReq = ["GET", canonicalUri, qs, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonicalReq)].join("\n");
  let k = hmac("AWS4" + sk, day); k = hmac(k, "auto"); k = hmac(k, "s3"); k = hmac(k, "aws4_request");
  const sig = hmac(k, sts).toString("hex");
  return `https://${host}${canonicalUri}?${qs}&X-Amz-Signature=${sig}`;
}

// ---- fixture: submission 6864bbdf (demo-pass), 3 real photos ----
const sid = "6864bbdf-84a4-4531-9634-872043f515bd";
const ts = 1780240000000;
// PASS test: coherent single item (the clean jeans product shot) across slots,
// no unverifiable brand claim. Toggle with arg3=coherent.
const coherent = process.argv[3] === "coherent";
const photos = coherent ? [
  { role: "front", r2_key: `demo-pass/${sid}/front-1-${ts + 1}.jpg`, mime: "image/jpeg" },
] : [
  { role: "front", r2_key: `demo-pass/${sid}/front-1-${ts + 1}.jpg`, mime: "image/jpeg" },
  { role: "back", r2_key: `demo-pass/${sid}/back-2-${ts + 2}.jpg`, mime: "image/jpeg" },
  { role: "tag", r2_key: `demo-pass/${sid}/tag-3-${ts + 3}.jpg`, mime: "image/jpeg" },
];
const ruleSet = { brand_allowlist: [], brand_blocklist: [], categories_accepted: ["outdoor-jackets", "denim", "jackets", "jeans", "mens-tops", "womens-tops", "shirts", "sweaters", "dresses", "pants", "shoes"], condition_floor: "fair", banned_keywords: [], merchant_notes: "Permissive demo merchant for pipeline testing." };
const description = coherent
  ? "Item: blue denim jeans. Size M. Asking price: $40. Seller condition: good. Notes: classic five-pocket jeans, light wear."
  : "Item: denim. Brand (seller-declared): Levi's. Size: M. Asking price: $40. Seller condition: good. Notes: classic denim, light wear.";

const systemPrompt = readFileSync(resolve(process.cwd(), "prompts", "submit-vision-system.md"), "utf8");

const responseSchema = {
  type: "OBJECT",
  properties: {
    decision: { type: "STRING", enum: ["PASS", "FAIL", "BORDERLINE"] },
    confidence: { type: "NUMBER" },
    brand_detected: { type: "STRING", nullable: true },
    brand_confidence: { type: "NUMBER" },
    category_detected: { type: "STRING" },
    size_detected: { type: "STRING", nullable: true },
    condition_assessment: { type: "STRING", enum: ["new_with_tags", "excellent", "good", "fair", "poor"] },
    flaws_observed: { type: "ARRAY", items: { type: "STRING" } },
    estimated_retail_value_usd: { type: "NUMBER", nullable: true },
    estimated_resale_value_usd: { type: "NUMBER", nullable: true },
    rule_evaluation: {
      type: "OBJECT",
      properties: {
        brand_allowed: { type: "BOOLEAN" }, category_allowed: { type: "BOOLEAN" },
        condition_above_floor: { type: "BOOLEAN" },
        price_in_range: { type: "BOOLEAN", nullable: true },
        seasonality_match: { type: "BOOLEAN", nullable: true },
      },
      required: ["brand_allowed", "category_allowed", "condition_above_floor", "price_in_range", "seasonality_match"],
    },
    pass_reasons: { type: "ARRAY", items: { type: "STRING" } },
    fail_reasons: { type: "ARRAY", items: { type: "STRING" } },
    borderline_reasons: { type: "ARRAY", items: { type: "STRING" } },
    seller_message: { type: "STRING" },
    internal_note: { type: "STRING" },
  },
  required: ["decision", "confidence", "brand_detected", "brand_confidence", "category_detected", "size_detected", "condition_assessment", "flaws_observed", "estimated_retail_value_usd", "estimated_resale_value_usd", "rule_evaluation", "pass_reasons", "fail_reasons", "borderline_reasons", "seller_message", "internal_note"],
};

// "branded" mode: coherent Levi's set pulled straight from Commons (front +
// rear-detail showing the red tab/leather patch) against test-thrift's rules.
const branded = process.argv[3] === "branded";
const UA = "TagtoRack-PhaseC-Test/1.0 (contact@tagtorack.com)";
const brandedPhotos = [
  "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d7/Levis_Jeans_%283849532157%29.jpg/960px-Levis_Jeans_%283849532157%29.jpg",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/Levis_501_rear_detail.jpg/960px-Levis_501_rear_detail.jpg",
];
const brandedRules = { brand_allowlist: ["Patagonia", "Levi's"], brand_blocklist: [], categories_accepted: ["outdoor-jackets", "denim"], condition_floor: "good", banned_keywords: [] };
const brandedDesc = "Item: Levi's 501 jeans. Brand: Levi's. Size: 32. Asking price: $40. Seller condition: good. Notes: classic 501, light wear, red tab and leather patch intact.";

const useRules = branded ? brandedRules : ruleSet;
const useDesc = branded ? brandedDesc : description;
const parts = [{ text: `Merchant rule set:\n${JSON.stringify(useRules)}\n\nSeller description:\n${useDesc}\n\nThe photos of the item follow as inline images.` }];
if (branded) {
  for (const url of brandedPhotos) {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`commons GET -> ${r.status}`);
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
    console.log(`  fetched ${url.split("/").pop().slice(0, 30)} (${b64.length} b64)`);
  }
} else {
  for (const p of photos) {
    const url = presignR2Get(p.r2_key);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`R2 GET ${p.r2_key} -> ${r.status}`);
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    parts.push({ inline_data: { mime_type: p.mime, data: b64 } });
    console.log(`  fetched ${p.role} (${b64.length} b64 chars)`);
  }
}

const body = {
  systemInstruction: { parts: [{ text: systemPrompt }] },
  contents: [{ role: "user", parts }],
  generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.2 },
};

const model = process.argv[2] || "gemini-2.5-flash";
console.log("calling", model, "...");
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": env_GEMINI() },
  body: JSON.stringify(body),
});
function env_GEMINI() {
  // read GEMINI_API_KEY from ops/.env (already parsed into env)
  return env.GEMINI_API_KEY;
}
const j = await res.json();
console.log("HTTP", res.status);
if (!res.ok) { console.log(JSON.stringify(j).slice(0, 600)); process.exit(1); }
const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
console.log("usage:", JSON.stringify(j.usageMetadata));
console.log("decision JSON:\n", text);
try { const d = JSON.parse(text); console.log("\\nparsed OK. decision=" + d.decision + " confidence=" + d.confidence); }
catch (e) { console.log("PARSE FAIL", e.message); }
