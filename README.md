# Tag to Rack

**AI intake, pricing, and listing support for resale clothing stores.**

Tag to Rack helps resale, consignment, and thrift staff intake inventory faster and more
consistently. Staff photograph an item (front / back / tag); the AI drafts a structured
intake card — brand, category, size, color, condition, possible flaws, a pricing range, a
buy / pass / consign suggestion, and POS‑ready listing text. **The AI only recommends — a
store manager approves every final decision.**

This repository is the early‑stage marketing site + (planned) operating dashboard. Built
with an open‑source, dependency‑light stack: hand‑written HTML, CSS, and vanilla JS. No
build step required — open any `.html` file in a browser.

---

## Folder structure

```
tag-to-rack/
├── index.html              # Home
├── how-it-works.html       # How it works
├── features.html           # Features
├── pricing.html            # Pricing
├── demo.html               # Interactive AI intake demo
├── contact.html            # Contact / Book a pilot
├── privacy.html            # Privacy / Data policy
├── terms.html              # Terms / Disclaimers
│
├── assets/
│   ├── css/
│   │   └── styles.css      # Shared design system (tokens, type, components)
│   ├── js/
│   │   └── site.js         # Nav, scroll reveals, animated intake demo
│   └── img/                # Image placeholders / brand assets
│
└── docs/
    ├── design-system.md    # Colors, type, components reference
    ├── sitemap.md          # Pages, routes, nav model
    ├── content.md          # Copywriting source of truth
    └── roadmap.md          # Build phases (marketing → dashboard)
```

## Conventions

- **No framework, no build.** Every page is plain HTML linking `assets/css/styles.css`
  and `assets/js/site.js` with root‑relative paths.
- **Shared shell.** The `<header>` and `<footer>` markup is duplicated per page so each
  file is self‑contained and directly editable.
- **Design tokens** live as CSS custom properties in `styles.css` — never hard‑code a hex
  value in a page; reference the token.
- **Trust first.** Anywhere the AI produces output, label it a *recommendation* and show
  the manager‑approval affordance.

## Stack

| Concern        | Choice                          |
|----------------|---------------------------------|
| Markup         | Hand‑written HTML5              |
| Styling        | CSS custom properties, Grid/Flex|
| Interactivity  | Vanilla JS (no dependencies)   |
| Fonts          | Space Grotesk · Hanken Grotesk · Space Mono (Google Fonts) |
| Hosting        | Any static host                |

All open source / free tier.

---

## Backend & Operations

The site is more than static pages — it ships **Cloudflare Pages Functions** (`functions/`) and a
self-hosted **n8n + Postgres** automation stack (`ops/`).

**Pages Functions (`functions/`)**
- `api/contact.js` — contact / "book a pilot" form → Resend email.
- `submit/[[slug]].js` — server-renders the per-merchant photo-submission portal (`/submit/m/<slug>`).
- `submit/api/*` — the submit flow: `start` (reserve + presigned R2 upload URLs), `photo-complete`,
  `finalize`, `merchant` (lookup), `delete` (right-to-delete).
- `_shared/` — HMAC-signed fanout to n8n (`n8n-fanout.js`), R2 SigV4 presigning (`r2-sign.js`),
  KV rate limiting + Turnstile (`ratelimit.js`).
- Secrets live in repo-root `.dev.vars` (local) and the Cloudflare dashboard (prod); KV namespace
  `TT_SUBMIT_RL` is bound in `wrangler.jsonc` + the dashboard.

**Ops stack (`ops/`)**
- `docker-compose.yml` — Postgres 16 + n8n (+ Mailpit in the `dev` profile). Secrets in `ops/.env`.
- `initdb/*.sql` — schema: `02-app-schema.sql` (lead/email operator system) and
  `03-submit-schema.sql` (merchants, sellers, submissions, photos, AI decisions, decision tokens,
  drop-off bookings).
- `n8n/prompts/*.md` — system prompts for the AI workflows (submission vision review, operators).
- `backup.ps1` — nightly `pg_dump` of both databases with 30-day rotation.

**Submit data-flow:** browser → `submit/api/start` → (HMAC) n8n `submit/start` → Postgres →
presigned R2 PUT → `photo-complete` → `finalize` → n8n vision review (Gemini) → merchant decision →
drop-off booking. The n8n workflows that implement this live in the n8n instance (`ops/n8n/workflows/`).
