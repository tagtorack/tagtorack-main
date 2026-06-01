// functions/admin/api/export-csv.js — GET /admin/api/export-csv?status=&q=
// (Route has NO file extension: Cloudflare Pages serves any path containing a
//  ".csv"-style extension as a static asset BEFORE the Functions router runs.
//  The downloaded file is still named *.csv via Content-Disposition below.)
// Streams the (filtered) cross-merchant submissions as a CSV download.
// Reuses the admin/submissions webhook so it honors the exact same filters.
import { requireAdmin, postToN8n } from "../../_shared/admin-auth.js";

// RFC-4180 cell: wrap in quotes if it contains comma, quote, or newline; double internal quotes.
const cell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const COLUMNS = [
  ["short_id", "Short ID"],
  ["submission_id", "Submission ID"],
  ["status", "Status"],
  ["decision", "AI Decision"],
  ["confidence", "Confidence"],
  ["merchant_slug", "Merchant"],
  ["merchant_name", "Merchant Name"],
  ["seller_email", "Seller Email"],
  ["declared_brand", "Brand"],
  ["item_description", "Item"],
  ["submitted_at", "Submitted At"],
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });

  const u = new URL(request.url);
  const status = u.searchParams.get("status") || "";
  const q = u.searchParams.get("q") || "";

  let subs = [];
  try {
    const r = await postToN8n(env, "admin/submissions", { status, q, limit: 10000 }, 15000);
    subs = (r && r.submissions) || [];
  } catch (_) {
    return new Response("export_failed: could not load submissions", { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const header = COLUMNS.map((c) => cell(c[1])).join(",");
  const lines = subs.map((s) => COLUMNS.map((c) => cell(s[c[0]])).join(","));
  // Lead with a UTF-8 BOM so Excel opens accented characters correctly.
  const csv = "﻿" + [header, ...lines].join("\r\n") + "\r\n";

  const today = new Date().toISOString().slice(0, 10);
  const suffix = status ? `-${status}` : "";
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ttr-submissions${suffix}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
