// End-to-end Phase B intake test: start -> photo-complete x3 -> finalize.
// Hits the live local n8n production webhooks, mirroring the Pages fanout shape.
const BASE = "http://localhost:5678/webhook";
const post = async (path, body) => {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};
const must = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

// unique email so the dedupe index doesn't trip across reruns
const tag = "e2e-" + process.argv[2];
const email = `${tag}@example.com`;

console.log("1) submit/start");
const start = await post("submit/start", {
  merchant_slug: "test-thrift",
  item: { item_type: "womens_dresses", brand: "Reformation", size: "S", asking_price_usd: 80, declared_condition: "excellent", notes: "tiny snag" },
  contact: { name: "E2E Seller", email, phone: "555-0199", zip: "60622", consent_marketing: false },
  photo_declarations: [
    { role: "front", ord: 1, content_type: "image/jpeg", byte_size: 130000 },
    { role: "back", ord: 2, content_type: "image/jpeg", byte_size: 120000 },
    { role: "tag", ord: 3, content_type: "image/jpeg", byte_size: 70000 },
  ],
  user_agent: "E2E/1.0", ip_country: "US", ip_hash: tag,
});
console.log("   ->", start.status, JSON.stringify(start.json));
must(start.status === 200 && start.json.submission_id, "start should return 200 + submission_id");
const sid = start.json.submission_id;
must(start.json.short_id === sid.slice(0, 8), "short_id should be left(id,8)");

console.log("2) submit/photo-complete x3");
for (const [role, ord, bytes] of [["front", 1, 130000], ["back", 2, 120000], ["tag", 3, 70000]]) {
  const r = await post("submit/photo-complete", {
    submission_id: sid,
    r2_key: `test-thrift/${sid}/${role}-${ord}-${1730001000000 + ord}.jpg`,
    content_type: "image/jpeg", byte_size: bytes, width: 800, height: 1000, client_stripped_exif: true,
  });
  console.log(`   ${role}-${ord} ->`, r.status, JSON.stringify(r.json));
  must(r.status === 200 && r.json.ok, `photo-complete ${role} should 200`);
}

console.log("3) submit/finalize");
const fin = await post("submit/finalize", { submission_id: sid });
console.log("   ->", fin.status, JSON.stringify(fin.json));
must(fin.status === 200 && fin.json.short_id === sid.slice(0, 8), "finalize should 200 + short_id");

console.log("\\nPASS — submission", sid, "should now be status=received with 3 photos");
console.log("SID=" + sid);
