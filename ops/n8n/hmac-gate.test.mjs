// Unit test for the HMAC gate's n8n Code-node logic + the injector.
// Runs the ACTUAL GATE_JS in a simulated n8n Code-node environment, signing
// inputs with the SAME algorithm functions/_shared/n8n-fanout.js uses.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { GATE_JS, injectGate, GATE_NODE_NAME } from "./hmac-gate.mjs";

const nodeRequire = createRequire(import.meta.url);

const SECRET = "test-secret-abc123";

// Mirror of n8n-fanout.js hmacSha256Hex + header shape.
const pagesSign = (secret, ts, bodyStr) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${bodyStr}`).digest("hex");

// Simulate an n8n webhook item: { body (parsed), headers (lowercased) }.
const makeItem = (payload, { secret = SECRET, ts = Date.now(), tamperSig = null, dropSig = false } = {}) => {
  const bodyStr = JSON.stringify(payload);                 // what Pages sends on the wire
  const parsed = JSON.parse(bodyStr);                       // what n8n hands the Code node
  const sig = tamperSig || pagesSign(secret, ts, bodyStr);
  const headers = { "content-type": "application/json", "x-ttr-timestamp": String(ts) };
  if (!dropSig) headers["x-ttr-signature"] = sig;
  return { json: { body: parsed, headers, query: {}, params: {} } };
};

// Run GATE_JS exactly as n8n would: $input.first()/.all(), $env, require.
const runGate = (item, env = { INTAKE_WEBHOOK_SECRET: SECRET }) => {
  const $input = { first: () => item, all: () => [item] };
  const fn = new Function("$input", "$env", "require", GATE_JS);
  return fn($input, env, (m) => nodeRequire(m));
};

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name); } };
const throws = (name, fn) => { try { fn(); fail++; console.log("  FAIL", name, "(did not throw)"); } catch { pass++; console.log("  PASS", name); } };

const PAYLOAD = {
  merchant_slug: "test-thrift",
  item: { item_type: "womens_dresses", brand: "Reformation", size: "S", asking_price_usd: 80, declared_condition: "excellent", notes: "tiny snag" },
  contact: { name: "E2E Seller", email: "x@example.com", phone: "555-0199", zip: "60622", consent_marketing: false },
  photo_declarations: [{ role: "front", ord: 1, content_type: "image/jpeg", byte_size: 130000 }],
};

console.log("HMAC gate logic:");
// 1. valid signature passes and returns the item unchanged
const validItem = makeItem(PAYLOAD);
let result;
ok("valid signature passes", (() => { result = runGate(validItem); return Array.isArray(result) && result.length === 1; })());
ok("passes item through unchanged (body intact)", result[0].json.body.merchant_slug === "test-thrift");

// 2. round-trip: re-stringify == original signed bytes (the core correctness assumption)
ok("JSON re-stringify is byte-identical", JSON.stringify(JSON.parse(JSON.stringify(PAYLOAD))) === JSON.stringify(PAYLOAD));

// 3. tampered body -> reject
throws("tampered body rejected", () => {
  const it = makeItem(PAYLOAD);
  it.json.body.item.asking_price_usd = 5; // attacker mutates after signing
  runGate(it);
});
// 4. wrong secret on verifier side -> reject
throws("wrong verifier secret rejected", () => runGate(makeItem(PAYLOAD), { INTAKE_WEBHOOK_SECRET: "different" }));
// 5. forged signature -> reject
throws("forged signature rejected", () => runGate(makeItem(PAYLOAD, { tamperSig: "sha256=deadbeef" })));
// 6. missing signature -> reject
throws("missing signature rejected", () => runGate(makeItem(PAYLOAD, { dropSig: true })));
// 7. stale timestamp (replay) -> reject
throws("stale timestamp rejected", () => runGate(makeItem(PAYLOAD, { ts: Date.now() - 10 * 60 * 1000 })));
// 8. empty/no secret in env -> reject (fail closed)
throws("no env secret fails closed", () => runGate(makeItem(PAYLOAD), { INTAKE_WEBHOOK_SECRET: "" }));

console.log("\nInjector:");
const wf = {
  name: "WF-X",
  nodes: [
    { id: "w", name: "Webhook", type: "n8n-nodes-base.webhook", position: [-200, 0], parameters: {} },
    { id: "pg", name: "List", type: "n8n-nodes-base.postgres", position: [0, 0], parameters: {} },
    { id: "r", name: "Respond", type: "n8n-nodes-base.respondToWebhook", position: [220, 0], parameters: {} },
  ],
  connections: {
    Webhook: { main: [[{ node: "List", type: "main", index: 0 }]] },
    List: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
};
const g = injectGate(wf);
ok("gate node added", g.nodes.some((n) => n.name === GATE_NODE_NAME));
ok("webhook -> gate", g.connections.Webhook.main[0][0].node === GATE_NODE_NAME);
ok("gate -> former target (List)", g.connections[GATE_NODE_NAME].main[0][0].node === "List");
ok("downstream List->Respond preserved", g.connections.List.main[0][0].node === "Respond");
ok("idempotent (no double-gate)", (() => { const g2 = injectGate(g); return g2.nodes.filter((n) => n.name === GATE_NODE_NAME).length === 1; })());
ok("original wf untouched (pure)", !wf.nodes.some((n) => n.name === GATE_NODE_NAME));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
