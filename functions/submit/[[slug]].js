// functions/submit/[[slug]].js
// Catches every path under /submit/* on the Pages project. Routes:
//   /submit/                      → static redirect notice (no merchant slug given)
//   /submit/m/<slug>              → serve the upload portal with merchant data injected
//   /submit/privacy               → static privacy page (passed through)
//   /submit/assets/*              → static assets (passed through, excluded in _routes.json)
//   /submit/api/*                 → handled by sibling functions in submit/api/
//
// Anything else returns 404.

import { postToN8n, json } from "../_shared/n8n-fanout.js";

// Tags inside the index.html that get string-replaced.
const SUBSTITUTIONS = (m) => ({
  "{{merchant.slug}}": m.slug || "",
  "{{merchant.display_name}}": esc(m.display_name || "this store"),
  "{{merchant.public_intro}}": esc(m.public_intro || ""),
  "{{merchant.logo_url}}": m.logo_url || "/assets/img/logo-mark.svg",
  "{{merchant.brand_color}}": isHex(m.brand_color) ? m.brand_color : "#6a40c9",
});

const esc = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isHex = (s) => typeof s === "string" && /^#[0-9A-Fa-f]{6}$/.test(s);

export async function onRequestGet(context) {
  const { request, env, params, next } = context;
  const url = new URL(request.url);
  const segments = (params.slug || []).filter(Boolean);

  // Bare /submit/ → friendly notice. Sellers must come through a merchant link.
  if (segments.length === 0) {
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Tag to Rack Submit</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"></head><body><main style="max-width:520px;margin:60px auto;padding:0 20px;font-family:var(--body);"><h1 style="font-family:var(--display);">Pick a store first</h1><p style="color:var(--ink-soft);">The Tag to Rack Submit portal is per-store. Use the link the store gave you (it looks like <code>submit.tagtorack.com/m/&lt;store&gt;</code>) — or visit <a href="/" style="color:var(--violet-ink);">tagtorack.com</a> to learn more.</p></main></body></html>`,
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  // /submit/m/<slug> → server-render the portal HTML with substitutions
  if (segments[0] === "m" && segments[1]) {
    const slug = String(segments[1]).toLowerCase();

    // Defense-in-depth: never hand a malformed slug to the n8n lookup.
    if (!/^[a-z0-9-]{2,64}$/.test(slug)) {
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>Store not found</title><link rel="stylesheet" href="/assets/css/styles.css"></head><body><main style="max-width:520px;margin:60px auto;padding:0 20px;"><h1 style="font-family:var(--display);">That store link looks off.</h1><p style="color:var(--ink-soft);">Double-check the link the store gave you, or email <a href="mailto:submissions@tagtorack.com" style="color:var(--violet-ink);">submissions@tagtorack.com</a>.</p></main></body></html>`,
        { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    // Fetch merchant from n8n (which talks to Postgres). Soft-fail on lookup
    // errors with a generic merchant shell so a momentary n8n hiccup doesn't
    // 500 the seller — the portal JS will retry the merchant fetch.
    let merchant = { slug };
    try {
      const looked = await postToN8n(env, "merchant/lookup", { slug }, 3000);
      if (looked && looked.merchant) merchant = { ...merchant, ...looked.merchant };
      else if (looked && looked.ok === false) {
        // Unknown slug
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>Store not found</title><link rel="stylesheet" href="/assets/css/styles.css"></head><body><main style="max-width:520px;margin:60px auto;padding:0 20px;"><h1 style="font-family:var(--display);">We couldn't find that store.</h1><p style="color:var(--ink-soft);">Double-check the link the store gave you. If you still can't get through, email <a href="mailto:submissions@tagtorack.com" style="color:var(--violet-ink);">submissions@tagtorack.com</a>.</p></main></body></html>`,
          { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
    } catch (e) {
      console.error("merchant lookup failed", String(e));
      // Fall through with merchant = {slug} so the portal still loads;
      // submit.js will re-fetch /submit/api/merchant?slug=… on DOMContentLoaded.
    }

    // Pull the static index.html out of the Pages assets pipeline and substitute.
    let html;
    try {
      const assetUrl = new URL("/submit/index.html", url.origin);
      const assetReq = new Request(assetUrl.toString(), { method: "GET" });
      const res = await env.ASSETS.fetch(assetReq);
      if (!res.ok) throw new Error(`asset_${res.status}`);
      html = await res.text();
    } catch (e) {
      console.error("Failed to load submit/index.html asset", String(e));
      return new Response("Portal is temporarily unavailable. Please refresh.", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const subs = SUBSTITUTIONS(merchant);
    for (const [k, v] of Object.entries(subs)) {
      html = html.split(k).join(v);
    }
    // Turnstile site key (public; injected at render time)
    html = html.split("{{TURNSTILE_SITE_KEY}}").join(env.TURNSTILE_SITE_KEY || "");

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",  // merchant-dependent; never CDN-cached
        "X-Robots-Tag": "noindex",
        // The portal is a Function response, so the static _headers CSP does NOT
        // apply here — set it explicitly. Allows: Turnstile (script+frame+connect),
        // Google Fonts (style+font), R2 presigned PUT (connect) + any https merchant
        // logo (img). No inline JS is used (handlers live in submit.js), so script-src
        // stays strict. Inline <style>/style= need style-src 'unsafe-inline'.
        "Content-Security-Policy":
          "default-src 'self'; " +
          "script-src 'self' https://challenges.cloudflare.com; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data: https:; " +
          "connect-src 'self' https://*.r2.cloudflarestorage.com https://challenges.cloudflare.com; " +
          "frame-src https://challenges.cloudflare.com; " +
          "form-action 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'",
      },
    });
  }

  // /submit/privacy and /submit/assets/* are static — let Pages serve them.
  return next();
}
