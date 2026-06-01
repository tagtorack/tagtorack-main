// functions/portal/api/export-csv.js — GET /portal/api/export-csv?status=&q=
// Extensionless route (Pages serves *.csv paths as static assets before Functions).
import { requireSession, postToN8n } from "../../_shared/portal-session.js";

const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
const COLUMNS = [
  ["short_id","Short ID"],["submission_id","Submission ID"],["status","Status"],
  ["decision","AI Decision"],["confidence","Confidence"],["declared_brand","Brand"],
  ["item_description","Item"],["estimated_resale_usd","Est Resale USD"],
  ["submitted_at","Submitted At"],["merchant_decided_at","Decided At"],
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await requireSession(request, env);
  if (!session) return new Response("Forbidden", { status: 403, headers: { "Cache-Control":"no-store" } });
  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";

  let subs = [];
  try { const r = await postToN8n(env, "merchant/history", { merchant_id: session.merchant_id, status, q, limit: 10000 }, 15000); subs = (r && r.submissions) || []; }
  catch (_) { return new Response("export_failed", { status: 502, headers: { "Cache-Control":"no-store" } }); }

  const header = COLUMNS.map(c => cell(c[1])).join(",");
  const lines = subs.map(s => COLUMNS.map(c => cell(s[c[0]])).join(","));
  const csv = "﻿" + [header, ...lines].join("\r\n") + "\r\n";
  const today = new Date().toISOString().slice(0,10);
  const slug = (session.slug || "store").replace(/[^a-z0-9-]/gi, "");
  return new Response(csv, { status: 200, headers: {
    "Content-Type":"text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${slug}-submissions-${today}.csv"`,
    "Cache-Control":"no-store",
  }});
}
