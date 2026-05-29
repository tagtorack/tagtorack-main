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
