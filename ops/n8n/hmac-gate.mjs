// ops/n8n/hmac-gate.mjs
// Shared definition of the inbound-HMAC verification gate for n8n webhook
// workflows, plus a pure injector that splices the gate between a workflow's
// Webhook node and its downstream node(s).
//
// WHY: the Pages Functions sign every n8n call (functions/_shared/n8n-fanout.js)
// with X-TTR-Timestamp + X-TTR-Signature = sha256(secret, `${ts}.${body}`), but
// no workflow ever verified that signature — so the public webhook host accepted
// unauthenticated requests and leaked admin/seller data. This gate closes that.
//
// The gate is a Code node placed immediately after the Webhook node. On a valid
// signature it passes the original webhook item through unchanged (so downstream
// expressions like `$json.body` still resolve). On a missing/forged/stale
// signature it throws -> n8n rejects the request (no data returned).

export const GATE_NODE_NAME = "Verify Signature";

// n8n Code node body (typeVersion 2, "run once for all items"). Uses the builtin
// `crypto` module (NODE_FUNCTION_ALLOW_BUILTIN=crypto in the n8n container) and
// $env.INTAKE_WEBHOOK_SECRET (set in ops/.env / the n8n container env).
export const GATE_JS = `
const crypto = require('crypto');
const secret = $env.INTAKE_WEBHOOK_SECRET || '';
const item = ($input.first() && $input.first().json) || {};
const h = item.headers || {};
const sig = String(h['x-ttr-signature'] || '');
const ts = String(h['x-ttr-timestamp'] || '');
const body = item.body;
// Reproduce exactly what the Pages function signed: JSON.stringify(payload).
// n8n parses the JSON body into an object preserving key order, so re-stringify
// is byte-identical for compact JSON. If a string slipped through, sign as-is.
const raw = (typeof body === 'string') ? body : JSON.stringify(body == null ? {} : body);
let ok = false;
if (secret && sig && /^[0-9]+$/.test(ts)) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  const fresh = Math.abs(Date.now() - Number(ts)) < 300000; // 5 min replay window
  ok = a.length === b.length && crypto.timingSafeEqual(a, b) && fresh;
}
if (!ok) { throw new Error('unauthorized'); }
return $input.all();
`.trim();

export const gateNode = (position = [-40, 0]) => ({
  parameters: { jsCode: GATE_JS },
  id: "verify-sig",
  name: GATE_NODE_NAME,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position,
});

// Find the (single) webhook trigger node in a workflow object.
export const findWebhookNode = (wf) =>
  (wf.nodes || []).find((n) => n.type === "n8n-nodes-base.webhook");

// Pure transform: returns a NEW workflow object with the gate spliced in after
// the Webhook node. Idempotent (no-op if the gate already exists). Rewires the
// webhook's outgoing connections to flow Webhook -> Verify -> (former targets).
export const injectGate = (wf) => {
  const out = JSON.parse(JSON.stringify(wf));
  out.nodes = out.nodes || [];
  out.connections = out.connections || {};
  if (out.nodes.some((n) => n.name === GATE_NODE_NAME)) return out; // already gated
  const webhook = findWebhookNode(out);
  if (!webhook) return out; // nothing to gate (cron/internal)
  const wname = webhook.name;
  const pos = Array.isArray(webhook.position) ? webhook.position : [-200, 0];
  const node = gateNode([pos[0] + 160, pos[1]]);
  // capture the webhook's current downstream, then point it at the gate
  const downstream = (out.connections[wname] && out.connections[wname].main) || [];
  out.connections[node.name] = { main: downstream };
  out.connections[wname] = { main: [[{ node: node.name, type: "main", index: 0 }]] };
  out.nodes.push(node);
  return out;
};
