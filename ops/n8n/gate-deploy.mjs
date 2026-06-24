// ops/n8n/gate-deploy.mjs — deploy the inbound-HMAC gate to the n8n webhooks.
//
// Phases (argv[2]): fetch | canary | rollout | verify | rollback
//   fetch    GET every workflow, back it up under .gate-backup/, list targets.
//   canary   gate ONLY merchant/lookup; assert unsigned is denied AND a real
//            signed request (via the prod Pages function) still succeeds.
//            Auto-rolls-back merchant/lookup if the signed path breaks.
//   rollout  gate every remaining target endpoint (idempotent).
//   verify   probe every target unsigned (expect denied) + one signed sanity.
//   rollback restore every backed-up workflow verbatim.
//
// Reads the n8n API key from .mcp.json (kept off the command line). API base
// defaults to prod; override with N8N_GATE_BASE.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { injectGate, findWebhookNode, GATE_NODE_NAME } from "./hmac-gate.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "..", "..");
const KEY = JSON.parse(readFileSync(resolve(repoRoot, ".mcp.json"), "utf8")).mcpServers["n8n-mcp"].env.N8N_API_KEY;
const BASE = process.env.N8N_GATE_BASE || "https://n8n.tagtorack.com/api/v1";
const WEBHOOK_BASE = (process.env.N8N_GATE_BASE ? process.env.N8N_GATE_BASE.replace(/\/api\/v1.*/, "") : "https://n8n.tagtorack.com") + "/webhook";
const PAGES_BASE = process.env.TTR_PAGES_BASE || "https://tagtorack.com";
const BACKUP = resolve(__dir, ".gate-backup");
const H = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", Accept: "application/json" };

// Endpoints the Pages functions sign -> safe to gate. Excludes sms/inbound
// (Twilio-signed) and submit/process (internal n8n->n8n call).
const TARGET_PATHS = new Set([
  "submit/start", "submit/photo-complete", "submit/finalize", "submit/status",
  "merchant/lookup", "merchant/login-request", "merchant/login-consume", "merchant/queue",
  "merchant/decide", "merchant/stats", "merchant/history", "merchant/profile", "merchant/profile-update",
  "admin/submissions", "admin/submission", "admin/queue", "admin/resolve", "admin/merchants",
  "admin/merchant-upsert", "admin/calibration", "admin/audit", "contact/lead",
]);

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
};
const clean = (wf) => ({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} });
const safe = (s) => s.replace(/[^a-z0-9._-]/gi, "_");
const webhookPath = (wf) => { const w = findWebhookNode(wf); return w && w.parameters && w.parameters.path; };
const isGated = (wf) => (wf.nodes || []).some((n) => n.name === GATE_NODE_NAME);

const listAll = async () => { const l = await api("GET", "/workflows?limit=250"); return (l && (l.data || l)) || []; };
const getWf = async (id) => api("GET", `/workflows/${id}`);
const putWf = async (id, wf) => { await api("PUT", `/workflows/${id}`, clean(wf)); try { await api("POST", `/workflows/${id}/activate`); } catch {} };

const targets = (all) => all.filter((w) => { const p = webhookPath(w); return p && TARGET_PATHS.has(p); });

async function fetchAll() {
  mkdirSync(BACKUP, { recursive: true });
  const all = await listAll();
  console.log(`Fetched ${all.length} workflows. Backing up to ${BACKUP}`);
  for (const w of all) {
    const full = await getWf(w.id);
    writeFileSync(resolve(BACKUP, safe(w.name) + ".json"), JSON.stringify(full, null, 2));
  }
  console.log("\nTargets to gate:");
  for (const w of targets(all)) console.log(`  ${webhookPath(w).padEnd(24)} ${isGated(w) ? "[already gated]" : ""} id=${w.id} active=${w.active}  "${w.name}"`);
  const skipped = all.filter((w) => { const p = webhookPath(w); return p && !TARGET_PATHS.has(p); });
  console.log("\nWebhook workflows NOT gated (by design):");
  for (const w of skipped) console.log(`  ${webhookPath(w).padEnd(24)} "${w.name}"`);
}

const unsignedProbe = async (path) => {
  try {
    const r = await fetch(`${WEBHOOK_BASE}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return r.status;
  } catch (e) { return "ERR " + e.message; }
};
const signedSanity = async () => {
  const r = await fetch(`${PAGES_BASE}/submit/api/merchant?slug=test-thrift&_=${Math.floor(performance.now())}`, { headers: { "Cache-Control": "no-cache" } });
  const j = await r.json().catch(() => null);
  // /submit/api/merchant returns the merchant fields flat (not wrapped in {merchant}).
  const m = j && (j.merchant || j);
  return { status: r.status, ok: !!(m && m.display_name), name: m && m.display_name };
};

async function canary() {
  const all = await listAll();
  const wf = targets(all).find((w) => webhookPath(w) === "merchant/lookup");
  if (!wf) throw new Error("merchant/lookup workflow not found");
  const original = await getWf(wf.id);
  if (!existsSync(resolve(BACKUP, safe(wf.name) + ".json"))) { mkdirSync(BACKUP, { recursive: true }); writeFileSync(resolve(BACKUP, safe(wf.name) + ".json"), JSON.stringify(original, null, 2)); }
  console.log("Canary: gating merchant/lookup...");
  await putWf(wf.id, injectGate(original));
  await new Promise((r) => setTimeout(r, 1500)); // let n8n re-register the webhook
  const unsigned = await unsignedProbe("merchant/lookup");
  const signed = await signedSanity();
  console.log(`  unsigned merchant/lookup -> ${unsigned}  (expect NOT 200)`);
  console.log(`  signed via Pages /submit/api/merchant -> ${signed.status} ok=${signed.ok} name="${signed.name}"  (expect 200 + Test Thrift Co)`);
  const denied = unsigned !== 200;
  const legitOk = signed.status === 200 && signed.ok;
  if (legitOk && denied) { console.log("\n✓ CANARY PASS — unsigned denied, signed still works. Secret matches. Safe to roll out."); return; }
  if (!legitOk) {
    console.log("\n✗ CANARY FAIL — signed path broke. Rolling back merchant/lookup...");
    await putWf(wf.id, original);
    const after = await signedSanity();
    console.log(`  rollback signed check -> ${after.status} ok=${after.ok}`);
    process.exit(2);
  }
  console.log("\n✗ CANARY FAIL — unsigned NOT denied (still 200). Gate not effective. Investigate.");
  process.exit(3);
}

async function rollout() {
  const all = await listAll();
  const tg = targets(all);
  console.log(`Rolling out gate to ${tg.length} targets...`);
  for (const w of tg) {
    const p = webhookPath(w);
    const full = await getWf(w.id);
    if (isGated(full)) { console.log(`  ${p.padEnd(24)} already gated, skip`); continue; }
    await putWf(w.id, injectGate(full));
    console.log(`  ${p.padEnd(24)} gated ✓`);
  }
  console.log("Rollout complete.");
}

async function verify() {
  const all = await listAll();
  const tg = targets(all);
  console.log("Unsigned probes (expect NONE = 200):");
  let leaks = 0;
  for (const w of tg) {
    const p = webhookPath(w);
    const s = await unsignedProbe(p);
    const bad = s === 200;
    if (bad) leaks++;
    console.log(`  ${String(s).padEnd(5)} ${bad ? "LEAK <-- " : "denied  "} ${p}`);
  }
  const signed = await signedSanity();
  console.log(`\nSigned sanity (Pages /submit/api/merchant): ${signed.status} ok=${signed.ok} name="${signed.name}" (expect 200 + Test Thrift Co)`);
  console.log(leaks === 0 ? `\n✓ All ${tg.length} endpoints reject unauthenticated requests.` : `\n✗ ${leaks} endpoint(s) still leaking.`);
}

async function rollback() {
  if (!existsSync(BACKUP)) throw new Error("no backup dir");
  const all = await listAll();
  const byName = new Map(all.map((w) => [w.name, w.id]));
  for (const f of readdirSync(BACKUP)) {
    const wf = JSON.parse(readFileSync(resolve(BACKUP, f), "utf8"));
    const id = byName.get(wf.name);
    if (!id) { console.log(`  ? ${wf.name} not found live, skip`); continue; }
    if (!TARGET_PATHS.has(webhookPath(wf) || "")) continue; // only restore targets
    await putWf(id, wf);
    console.log(`  restored ${wf.name}`);
  }
  console.log("Rollback complete.");
}

const phase = process.argv[2];
const fns = { fetch: fetchAll, canary, rollout, verify, rollback };
if (!fns[phase]) { console.error("usage: node gate-deploy.mjs fetch|canary|rollout|verify|rollback"); process.exit(1); }
fns[phase]().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
