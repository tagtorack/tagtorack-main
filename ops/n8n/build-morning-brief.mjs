// ops/n8n/build-morning-brief.mjs
// Builds WF-MB Morning Brief -> writes workflows/WF-MB-morning-brief.json
//
// A self-contained daily operations email for contact@tagtorack.com:
//   Schedule (08:00 America/Denver) -> Postgres metrics -> site health + compose -> Resend send.
//
// Runs entirely inside the local n8n (open-source) stack, so it can read the
// Postgres pipeline data the cloud cannot reach, and sends through the same
// Resend transport the rest of the app already uses.
//
// Deploy (from repo root, on the machine running n8n):
//   node ops/n8n/build-morning-brief.mjs
//   node ops/n8n/n8n-api.mjs POST /workflows ops/n8n/workflows/WF-MB-morning-brief.json
//   node ops/n8n/n8n-api.mjs POST /workflows/<id>/activate
//
// Required n8n env (already used by WF-5): RESEND_API_KEY, FROM_EMAIL, EMAIL_TRANSPORT=resend.
// Optional: MORNING_BRIEF_TO (default contact@tagtorack.com), SITE_BASE (default https://tagtorack.com).
import { writeFileSync } from "node:fs";

const PG_CRED = { id: "GZJQdHGNtdLI18IW", name: "Postgres account" };

// ---------- Node 1: Schedule trigger (08:00 America/Denver via workflow tz) ----------
const cron = {
  parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 8 * * *" }] } },
  id: "mb-cron", name: "Every morning 08:00", type: "n8n-nodes-base.scheduleTrigger",
  typeVersion: 1.2, position: [-220, 0],
};

// ---------- Node 2: Postgres metrics (single row of counts) ----------
const metricsSql = `
SELECT
  (SELECT count(*) FROM seller_submissions WHERE submitted_at > now() - interval '24 hours')::int                 AS new_24h,
  (SELECT count(*) FROM seller_submissions WHERE status='ai_borderline')::int                                     AS q_borderline,
  (SELECT count(*) FROM seller_submissions WHERE status='merchant_review')::int                                   AS q_merchant_review,
  (SELECT count(*) FROM seller_submissions WHERE status IN ('received','ai_reviewing'))::int                       AS q_processing,
  (SELECT count(*) FROM seller_submissions WHERE status='pending_uploads')::int                                   AS q_pending_uploads,
  (SELECT count(*) FROM seller_submissions WHERE status='dropoff_scheduled')::int                                 AS q_dropoff_scheduled,
  (SELECT count(*) FROM seller_submissions
     WHERE status NOT IN ('completed','expired','withdrawn','deleted','merchant_rejected','ai_failed')
       AND expires_at < now() + interval '48 hours')::int                                                         AS expiring_48h,
  (SELECT count(*) FROM merchants)::int                                                                            AS merchants_total,
  (SELECT count(*) FROM sellers)::int                                                                              AS sellers_total,
  (SELECT count(*) FROM sellers WHERE first_seen_at > now() - interval '24 hours')::int                           AS new_sellers_24h,
  (SELECT count(*) FROM submission_decisions WHERE created_at > now() - interval '24 hours' AND decision='PASS')::int       AS ai_pass_24h,
  (SELECT count(*) FROM submission_decisions WHERE created_at > now() - interval '24 hours' AND decision='FAIL')::int       AS ai_fail_24h,
  (SELECT count(*) FROM submission_decisions WHERE created_at > now() - interval '24 hours' AND decision='BORDERLINE')::int AS ai_borderline_24h,
  (SELECT coalesce(sum(d.estimated_resale_usd),0) FROM submission_decisions d
     JOIN seller_submissions s ON s.id = d.submission_id
     WHERE s.status IN ('merchant_approved','dropoff_scheduled','completed')
       AND d.created_at > now() - interval '7 days')::numeric                                                      AS approved_resale_7d,
  (SELECT count(*) FROM dropoff_bookings WHERE start_at > now() AND status='confirmed')::int                       AS upcoming_dropoffs,
  (SELECT coalesce(request_count,0) FROM gemini_usage WHERE day=current_date AND model='pro')::int                 AS gemini_pro_today,
  (SELECT coalesce(request_count,0) FROM gemini_usage WHERE day=current_date AND model='flash')::int               AS gemini_flash_today;
`.trim();

const metrics = {
  parameters: { operation: "executeQuery", query: metricsSql, options: {} },
  id: "mb-metrics", name: "Metrics", type: "n8n-nodes-base.postgres", typeVersion: 2.5,
  position: [0, 0], credentials: { postgres: PG_CRED }, alwaysOutputData: true,
};

// ---------- Node 3: Health-check + compose email ----------
const composeCode = `
const m = $('Metrics').first().json || {};
const base = ($env.SITE_BASE || 'https://tagtorack.com').replace(/\\/$/, '');
const n = (v) => Number(v || 0);

// ---- production health checks (n8n can reach the public internet) ----
const checks = [
  { label: 'Home',            path: '/' },
  { label: 'How it works',    path: '/how-it-works' },
  { label: 'Features',        path: '/features' },
  { label: 'Pricing',         path: '/pricing' },
  { label: 'Demo',            path: '/demo' },
  { label: 'Contact',         path: '/contact' },
  { label: 'Seller submit',   path: '/submit' },
  { label: 'Merchant portal', path: '/portal' },
  { label: 'Admin',           path: '/admin' },
];
const up = [], degraded = [], down = [];
for (const c of checks) {
  let status = 0;
  try {
    const r = await this.helpers.httpRequest({ method: 'GET', url: base + c.path, returnFullResponse: true, timeout: 12000 });
    status = r.statusCode || 200;
  } catch (e) {
    status = e.statusCode || e.httpCode || (e.response && e.response.statusCode) || 0;
  }
  const row = { ...c, status };
  // 2xx/3xx = up; 401/403 = secured-and-up (portal/admin); 0 or 5xx = down; other 4xx = degraded
  if ((status >= 200 && status < 400) || status === 401 || status === 403) up.push(row);
  else if (status === 0 || status >= 500) down.push(row);
  else degraded.push(row);
}

// ---- code & deploy (GitHub API; main auto-deploys to prod via Cloudflare Pages) ----
const ghRepo = $env.GITHUB_REPO || 'tagtorack/tagtorack-main';
const ghTok = $env.GITHUB_TOKEN || $env.GH_TOKEN || '';
let dev = { ok: false, err: '' };
if (ghTok) {
  try {
    const hdr = { 'Authorization': 'Bearer ' + ghTok, 'Accept': 'application/vnd.github+json', 'User-Agent': 'tagtorack-morning-brief' };
    const commits = await this.helpers.httpRequest({ method: 'GET', url: 'https://api.github.com/repos/' + ghRepo + '/commits?sha=main&per_page=20', headers: hdr, json: true, timeout: 12000 });
    const prs = await this.helpers.httpRequest({ method: 'GET', url: 'https://api.github.com/repos/' + ghRepo + '/pulls?state=open&per_page=10', headers: hdr, json: true, timeout: 12000 });
    const top = (commits && commits[0]) || {};
    const since = Date.now() - 24 * 3600 * 1000;
    const commits24 = (commits || []).filter(c => c.commit && new Date(c.commit.author.date).getTime() > since).length;
    const ageH = top.commit ? Math.round((Date.now() - new Date(top.commit.author.date).getTime()) / 3600000) : null;
    dev = { ok: true,
      lastMsg: top.commit ? String(top.commit.message).split('\\n')[0] : '(none)',
      lastAuthor: top.commit ? top.commit.author.name : '',
      lastAgeH: ageH, commits24,
      openPRs: (prs || []).length, prTitles: (prs || []).slice(0, 3).map(p => '#' + p.number + ' ' + p.title) };
  } catch (e) { dev = { ok: false, err: String(e.statusCode || e).slice(0, 120) }; }
}

// ---- recommendations (rule-based) ----
const recs = [];
if (down.length)     recs.push('Investigate: ' + down.map(d => d.label + ' (' + (d.status||'no response') + ')').join(', ') + ' not responding.');
if (degraded.length) recs.push('Check: ' + degraded.map(d => d.label + ' (' + d.status + ')').join(', ') + ' returned an unexpected status.');
if (n(m.q_borderline) > 0)      recs.push(n(m.q_borderline) + ' submission(s) in YOUR review queue (AI borderline) — clear them in /admin.');
if (n(m.expiring_48h) > 0)      recs.push(n(m.expiring_48h) + ' submission(s) expire within 48h — act before they auto-expire.');
if (n(m.q_merchant_review) > 0) recs.push(n(m.q_merchant_review) + ' item(s) waiting on merchants to approve/reject — a nudge may help.');
if (n(m.q_pending_uploads) > 3) recs.push(n(m.q_pending_uploads) + ' submissions stuck awaiting photos — consider a reminder to those sellers.');
if (n(m.q_processing) > 0)      recs.push(n(m.q_processing) + ' submission(s) mid-AI-review — should clear on their own; flag if still here tomorrow.');
if (n(m.new_24h) === 0)         recs.push('No new submissions in 24h — top of funnel is quiet. Consider re-sharing merchant seller links.');
if (dev.ok && dev.openPRs > 0)  recs.push(dev.openPRs + ' open pull request(s) awaiting review/merge.');
if (dev.ok && dev.lastAgeH != null && dev.lastAgeH < 3) recs.push('Code shipped to main ' + dev.lastAgeH + 'h ago — main auto-deploys, so confirm the live site looks right (health above).');
if (!recs.length)               recs.push('Nothing needs action — pipeline and site are healthy. Good morning.');

// ---- compose HTML ----
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday:'long', month:'long', day:'numeric', year:'numeric' });
const money = (v) => '$' + Number(n(v)).toLocaleString('en-US', { maximumFractionDigits: 0 });
const siteLine = down.length ? (down.length + ' page(s) DOWN') : (degraded.length ? (degraded.length + ' page(s) degraded') : 'All systems up');
const standLine = siteLine + ' · ' + n(m.new_24h) + ' new submission(s) overnight · ' +
  (n(m.q_borderline) + n(m.q_merchant_review) + n(m.expiring_48h)) + ' item(s) need attention';

const stat = (label, val) =>
  '<td style="padding:8px 14px;border:1px solid #eee;border-radius:8px;text-align:center">' +
  '<div style="font-size:20px;font-weight:700;color:#111">' + esc(val) + '</div>' +
  '<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em">' + esc(label) + '</div></td>';
const statRow = (cells) => '<table cellspacing="6" cellpadding="0" style="border-collapse:separate;margin:6px 0"><tr>' + cells.join('') + '</tr></table>';
const section = (title) => '<h3 style="margin:22px 0 6px;font-size:14px;color:#111;border-bottom:2px solid #6d5efc;display:inline-block;padding-bottom:2px">' + esc(title) + '</h3>';
const li = (s) => '<li style="margin:4px 0;color:#333">' + s + '</li>';
const checkLine = (rows, color, mark) => rows.length
  ? rows.map(r => '<span style="display:inline-block;margin:2px 10px 2px 0;color:' + color + '">' + mark + ' ' + esc(r.label) + ' <span style="color:#aaa">(' + (r.status||'—') + ')</span></span>').join('')
  : '<span style="color:#aaa">none</span>';

const html =
  '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">' +
  '<div style="background:#111;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">' +
    '<div style="font-size:18px;font-weight:700">Tag to Rack — Morning Brief</div>' +
    '<div style="font-size:13px;color:#bbb">' + esc(today) + '</div>' +
  '</div>' +
  '<div style="border:1px solid #eee;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px">' +

  '<p style="font-size:15px;margin:0 0 4px"><b>Where things stand:</b> ' + esc(standLine) + '</p>' +

  section('Needs your attention') +
  '<ul style="margin:6px 0;padding-left:18px">' +
    li('<b>' + n(m.q_borderline) + '</b> in your review queue (AI borderline)') +
    li('<b>' + n(m.q_merchant_review) + '</b> waiting on merchants to approve/reject') +
    li('<b>' + n(m.expiring_48h) + '</b> expiring within 48h') +
    li('<b>' + n(m.q_pending_uploads) + '</b> awaiting seller photos · <b>' + n(m.q_processing) + '</b> mid-AI-review') +
    li('<b>' + n(m.upcoming_dropoffs) + '</b> drop-off(s) booked ahead') +
  '</ul>' +

  section('Last 24 hours') +
  statRow([ stat('New subs', n(m.new_24h)), stat('New sellers', n(m.new_sellers_24h)), stat('AI pass', n(m.ai_pass_24h)), stat('AI fail', n(m.ai_fail_24h)), stat('AI borderline', n(m.ai_borderline_24h)) ]) +

  section('Business at a glance') +
  statRow([ stat('Merchants', n(m.merchants_total)), stat('Sellers', n(m.sellers_total)), stat('Approved resale 7d', money(m.approved_resale_7d)), stat('Gemini pro/flash today', n(m.gemini_pro_today) + '/' + n(m.gemini_flash_today)) ]) +

  section('Code & deploy') +
  (dev.ok
    ? '<p style="margin:6px 0;font-size:13px">Last commit on <b>main</b>: ' + esc(dev.lastMsg) +
        ' <span style="color:#aaa">— ' + esc(dev.lastAuthor) + (dev.lastAgeH != null ? (', ' + dev.lastAgeH + 'h ago') : '') + '</span><br>' +
        esc(dev.commits24) + ' commit(s) in 24h &middot; <b>' + esc(dev.openPRs) + '</b> open PR(s)' +
        (dev.prTitles && dev.prTitles.length ? '<br><span style="color:#888">' + dev.prTitles.map(esc).join('<br>') + '</span>' : '') +
        '<br><span style="color:#aaa">main auto-deploys to production via Cloudflare Pages.</span></p>'
    : '<p style="margin:6px 0;font-size:13px;color:#aaa">GitHub status unavailable' + (dev.err ? (' (' + esc(dev.err) + ')') : ' — set GITHUB_TOKEN in n8n') + '</p>') +

  section('Working') + '<p style="margin:6px 0;font-size:13px">' + checkLine(up, '#1a8f3c', '&#10003;') + '</p>' +
  section('Broken / degraded') + '<p style="margin:6px 0;font-size:13px">' + checkLine(down.concat(degraded), '#c0392b', '&#10007;') + '</p>' +

  section('Recommendations') + '<ul style="margin:6px 0;padding-left:18px">' + recs.map(li).join('') + '</ul>' +

  '<hr style="border:none;border-top:1px solid #eee;margin:18px 0 8px">' +
  '<p style="font-size:11px;color:#999;margin:0">Generated by the local n8n morning-brief workflow. Pipeline figures are live from Postgres; site status is checked against ' + esc(base) + '. ' +
  'Reply-to is unmonitored. To change the schedule, edit WF-MB in n8n.</p>' +
  '</div></div>';

const subjectBits = [];
if (down.length) subjectBits.push(down.length + ' DOWN');
if (n(m.q_borderline) + n(m.expiring_48h) > 0) subjectBits.push((n(m.q_borderline) + n(m.expiring_48h)) + ' to action');
if (n(m.new_24h) > 0) subjectBits.push(n(m.new_24h) + ' new');
const subject = 'Tag to Rack Morning Brief — ' + today + (subjectBits.length ? ' (' + subjectBits.join(', ') + ')' : '');

const to = $env.MORNING_BRIEF_TO || 'contact@tagtorack.com';
const fromEmail = $env.FROM_EMAIL || 'Tag to Rack <noreply@tagtorack.com>';
return [{ json: { emails: [{ to, subject, html }], fromEmail } }];
`.trim();

const compose = {
  parameters: { jsCode: composeCode }, id: "mb-compose", name: "Health + compose",
  type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0],
};

// ---------- Node 4: Send (Resend in prod, Mailpit in dev) ----------
const sendCode = `
const proc = $('Health + compose').first().json;
const transport = ($env.EMAIL_TRANSPORT || 'mailpit').toLowerCase();
const from = proc.fromEmail || 'Tag to Rack <noreply@tagtorack.com>';
const fromAddr = from.includes('<') ? (from.match(/<([^>]+)>/) || [, from])[1] : from;
let sent = 0; const errors = [];

for (const e of (proc.emails || [])) {
  try {
    if (transport === 'resend') {
      await this.helpers.httpRequest({ method: 'POST', url: 'https://api.resend.com/emails',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $env.RESEND_API_KEY },
        body: { from: 'Tag to Rack <' + fromAddr + '>', to: [e.to], subject: e.subject, html: e.html }, json: true });
    } else {
      await this.helpers.httpRequest({ method: 'POST', url: 'http://mailpit:8025/api/v1/send',
        headers: { 'Content-Type': 'application/json' },
        body: { From: { Email: fromAddr, Name: 'Tag to Rack' }, To: [{ Email: e.to }], Subject: e.subject, HTML: e.html }, json: true });
    }
    sent++;
  } catch (err) { errors.push(String(err).slice(0, 200)); }
}
return [{ json: { sent, errors, transport } }];
`.trim();

const send = {
  parameters: { jsCode: sendCode }, id: "mb-send", name: "Send brief",
  type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 0],
};

const wf = {
  name: "WF-MB morning-brief",
  nodes: [cron, metrics, compose, send],
  connections: {
    "Every morning 08:00": { main: [[{ node: "Metrics", type: "main", index: 0 }]] },
    "Metrics": { main: [[{ node: "Health + compose", type: "main", index: 0 }]] },
    "Health + compose": { main: [[{ node: "Send brief", type: "main", index: 0 }]] },
  },
  settings: { timezone: "America/Denver", executionOrder: "v1" },
};

writeFileSync(new URL("./workflows/WF-MB-morning-brief.json", import.meta.url), JSON.stringify(wf, null, 2));
console.log("wrote workflows/WF-MB-morning-brief.json (" + JSON.stringify(wf).length + " bytes)");
