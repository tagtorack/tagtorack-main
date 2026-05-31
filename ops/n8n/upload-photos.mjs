// Phase C test fixture: create a demo-pass submission, download real clothing
// photos from Wikimedia Commons, presign-PUT them into R2 under the submission's
// keys, then run photo-complete x3 + finalize. Prints the submission_id.
//
// Reuses functions/_shared/r2-sign.js (Web Crypto works under Node global crypto).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { presignR2Url } from "../../functions/_shared/r2-sign.js";

const opsEnv = resolve(process.cwd(), "..", ".env");
const env = {};
for (const line of readFileSync(opsEnv, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\s+#.*$/, "").trim(); // strip dotenv inline comments
}
const R2 = {
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
};
const WEBHOOK = "http://localhost:5678/webhook";
const SLUG = "demo-pass";

const post = async (path, body) => {
  const r = await fetch(`${WEBHOOK}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// 1) Find 3 real clothing JPEGs on Wikimedia Commons.
const UA = "TagtoRack-PhaseC-Test/1.0 (contact@tagtorack.com)";
async function commonsImages(query, n) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=900&format=json`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const j = await r.json();
  const pages = Object.values(j?.query?.pages || {});
  const out = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (ii && ii.mime === "image/jpeg" && ii.thumburl) out.push(ii.thumburl);
    if (out.length >= n) break;
  }
  return out;
}

// intitle: constrains results to files literally named with the term — far
// better relevance than free-text search (which returned arcade games / cars).
const queries = ["intitle:jeans", "intitle:\"denim jacket\"", "intitle:t-shirt"];
const roles = ["front", "back", "tag"];
const picks = [];
for (let i = 0; i < queries.length; i++) {
  let imgs = await commonsImages(queries[i], 5);
  if (!imgs.length) imgs = await commonsImages("intitle:clothing", 5);
  if (!imgs.length) throw new Error("no commons image for: " + queries[i]);
  picks.push({ role: roles[i], ord: i + 1, url: imgs[0] });
}
console.log("photos chosen:");
picks.forEach((p) => console.log(`  ${p.role}-${p.ord}: ${p.url}`));

// 2) Create the submission via WF-2.
const email = `phasec-${process.argv[2] || "1"}@example.com`;
const start = await post("submit/start", {
  merchant_slug: SLUG,
  item: { item_type: "denim", brand: "Levi's", size: "M", asking_price_usd: 40, declared_condition: "good", notes: "classic denim, light wear" },
  contact: { name: "Phase C Seller", email, phone: "555-0123", zip: "60601", consent_marketing: false },
  photo_declarations: picks.map((p) => ({ role: p.role, ord: p.ord, content_type: "image/jpeg", byte_size: 100000 })),
  user_agent: "PhaseC/1.0", ip_country: "US", ip_hash: "phasec-" + (process.argv[2] || "1"),
});
if (start.status !== 200 || !start.json?.submission_id) throw new Error("start failed: " + JSON.stringify(start));
const sid = start.json.submission_id;
console.log("submission_id =", sid);

// 3) Download each image, presign-PUT into R2, then WF-3 photo-complete.
const ts = 1780240000000;
for (const p of picks) {
  const imgRes = await fetch(p.url, { headers: { "User-Agent": UA } });
  if (!imgRes.ok) throw new Error("download failed " + p.url + " " + imgRes.status);
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const r2_key = `${SLUG}/${sid}/${p.role}-${p.ord}-${ts + p.ord}.jpg`;
  const putUrl = await presignR2Url({
    ...R2, key: r2_key, method: "PUT", expiresSec: 300,
    signedHeaders: { "content-type": "image/jpeg" },
  });
  const put = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: bytes });
  if (!put.ok) throw new Error(`R2 PUT failed ${put.status} ${await put.text().catch(()=>"" )}`);
  const pc = await post("submit/photo-complete", {
    submission_id: sid, r2_key, content_type: "image/jpeg", byte_size: bytes.length,
    width: 900, height: 1200, client_stripped_exif: true,
  });
  console.log(`  uploaded ${p.role}-${p.ord} (${bytes.length} bytes) -> R2 ok=${put.ok}, photo-complete ${pc.status}`);
}

// 4) Finalize.
const fin = await post("submit/finalize", { submission_id: sid });
console.log("finalize:", fin.status, JSON.stringify(fin.json));
if (fin.status !== 200) throw new Error("finalize failed");
console.log("\\nREADY  SID=" + sid);
