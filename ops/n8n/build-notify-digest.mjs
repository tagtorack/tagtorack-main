// ops/n8n/build-notify-digest.mjs
// Builds WF-ND approval-digest -> writes workflows/WF-ND-notify-digest.json
//
// Every 10 minutes: find sellers with merchant-approved items that have NOT yet
// been notified, whose newest approval is older than the quiet window
// (TT_NOTIFY_QUIET_MIN, default 30 min — i.e. the manager's review session has
// likely ended). Send ONE email per seller listing all their approved items with
// a single drop-off CTA, then mark them notified.
//
// Pair with env TT_DIGEST_NOTIFY=true, which silences the old per-item approval
// emails in WF-M4 (portal decide) and WF-A4 (admin resolve). Rejection emails
// are unchanged. Requires migration ops/initdb/06-notify-digest.sql.
import { writeFileSync } from "node:fs";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

const cron = {
  parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 10 }] } },
  id: "nd-cron", name: "Every 10 min", type: "n8n-nodes-base.scheduleTrigger",
  typeVersion: 1.2, position: [-220, 0],
};

const batchSql = `
WITH inp AS (SELECT $1::jsonb AS d),
q AS (
  SELECT s.seller_id, s.merchant_id,
         se.email AS seller_email, se.name AS seller_name,
         m.display_name AS merchant_name, m.calcom_event_url,
         jsonb_agg(jsonb_build_object(
           'id', s.id, 'short_id', left(s.id::text, 8),
           'brand', coalesce(s.declared_brand, ''), 'descr', s.item_description
         ) ORDER BY s.merchant_decided_at) AS items,
         max(s.merchant_decided_at) AS newest
  FROM seller_submissions s
  JOIN sellers se ON se.id = s.seller_id
  JOIN merchants m ON m.id = s.merchant_id
  WHERE s.status = 'merchant_approved' AND s.approval_notified_at IS NULL
  GROUP BY s.seller_id, s.merchant_id, se.email, se.name, m.display_name, m.calcom_event_url
)
SELECT * FROM q
WHERE newest < now() - make_interval(mins => coalesce((SELECT (d->>'quiet')::int FROM inp), 30));
`.trim();

const batches = {
  parameters: { operation: "executeQuery", query: batchSql,
    options: { queryReplacement: "={{ JSON.stringify({ quiet: Number($env.TT_NOTIFY_QUIET_MIN || 30) }) }}" } },
  id: "nd-batches", name: "Batches", type: "n8n-nodes-base.postgres", typeVersion: 2.5,
  position: [0, 0], credentials: { postgres: PG_CRED }, alwaysOutputData: true,
};

const sendCode = `
const rows = $input.all().map(x => x.json).filter(r => r && r.seller_email);
const transport = ($env.EMAIL_TRANSPORT || 'mailpit').toLowerCase();
const from = $env.FROM_EMAIL || 'submissions@tagtorack.com';
const fromAddr = from.includes('<') ? (from.match(/<([^>]+)>/) || [, from])[1] : from;
const ids = []; let sent = 0; const errors = [];

for (const r of rows) {
  const items = Array.isArray(r.items) ? r.items : [];
  if (!items.length) continue;
  const cal = r.calcom_event_url || ($env.CALCOM_BOOKING_URL || '');
  const store = r.merchant_name || 'The store';
  const n = items.length;
  const subject = store + ' approved ' + (n === 1 ? 'your item' : n + ' of your items') + ' — book one drop-off';
  const lis = items.map(it =>
    '<li style="margin:6px 0">' + (it.brand ? '<b>' + it.brand + '</b> — ' : '') + (it.descr || 'Item') +
    ' <span style="color:#999;font-size:12px">(' + it.short_id + ')</span></li>').join('');
  const html =
    '<div style="font-family:sans-serif;max-width:560px">' +
    '<h2>Good news, ' + (r.seller_name || 'there') + '!</h2>' +
    '<p>' + store + ' approved ' + (n === 1 ? 'this item' : 'these ' + n + ' items') + ':</p>' +
    '<ul style="padding-left:18px">' + lis + '</ul>' +
    '<p>Bring ' + (n === 1 ? 'it' : 'them all') + ' in one trip — book a single drop-off time:</p>' +
    '<p><a href="' + cal + '" style="display:inline-block;background:#6a40c9;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Schedule your drop-off</a></p>' +
    '<hr><p style="color:#888;font-size:12px">Tag to Rack</p></div>';
  try {
    if (transport === 'resend') {
      await this.helpers.httpRequest({ method: 'POST', url: 'https://api.resend.com/emails',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $env.RESEND_API_KEY },
        body: { from: 'Tag to Rack <' + fromAddr + '>', to: [r.seller_email], subject, html }, json: true });
    } else {
      await this.helpers.httpRequest({ method: 'POST', url: 'http://mailpit:8025/api/v1/send',
        headers: { 'Content-Type': 'application/json' },
        body: { From: { Email: fromAddr, Name: 'Tag to Rack' }, To: [{ Email: r.seller_email }], Subject: subject, HTML: html }, json: true });
    }
    sent++;
    for (const it of items) ids.push(it.id);
  } catch (e) { errors.push(String(e).slice(0, 150)); }
}
return [{ json: { ids, sent, errors } }];
`.trim();

const send = {
  parameters: { jsCode: sendCode }, id: "nd-send", name: "Send digests",
  type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0],
};

const markSql = `
UPDATE seller_submissions
   SET approval_notified_at = NOW()
 WHERE id IN (SELECT (jsonb_array_elements_text($1::jsonb))::uuid)
RETURNING id;
`.trim();

const mark = {
  parameters: { operation: "executeQuery", query: markSql,
    options: { queryReplacement: "={{ JSON.stringify($json.ids || []) }}" } },
  id: "nd-mark", name: "Mark notified", type: "n8n-nodes-base.postgres", typeVersion: 2.5,
  position: [440, 0], credentials: { postgres: PG_CRED }, alwaysOutputData: true,
};

const wf = {
  name: "WF-ND approval-digest",
  nodes: [cron, batches, send, mark],
  connections: {
    "Every 10 min": { main: [[{ node: "Batches", type: "main", index: 0 }]] },
    "Batches": { main: [[{ node: "Send digests", type: "main", index: 0 }]] },
    "Send digests": { main: [[{ node: "Mark notified", type: "main", index: 0 }]] },
  },
  settings: { timezone: "America/Denver", executionOrder: "v1" },
};

writeFileSync(new URL("./workflows/WF-ND-notify-digest.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote workflows/WF-ND-notify-digest.json (" + JSON.stringify(wf).length + " bytes)");
