# TagtoRack — SEO Plan

_Created 2026-06-27. Owner: growth. Companion to the technical changes shipped alongside this doc
(robots.txt, JSON-LD, sitemap lastmod). Method references the COO skills
`content-and-keyword-strategy`, `answer-engine-optimization-aeo`, and `landing-page-and-conversion`._

## 1. Positioning & audience

- **Product (as positioned on `main` today):** **Pre-screened consignment sourcing** for resale
  stores. Local sellers photograph clothing against the store's buying rules; Tag to Rack pre-screens
  every item so the store only reviews pieces worth its time; a manager approves, and approved sellers
  are invited to drop off. AI recommends, human approves.
- **Buyer (who we want to rank for):** owners/managers of **independent resale, consignment, and
  thrift clothing stores** — B2B SaaS, not the end consumer. This shapes every keyword: we target
  *store-operator* intent ("how to source inventory for my consignment shop", "consignment
  inventory/sourcing software"), not shopper intent ("thrift stores near me").
- **Primary conversion:** book a pilot / contact. Secondary: pricing view, portal signup.

## 2. Keyword strategy (by search intent)

Run the full pass with `content-and-keyword-strategy`; this is the seed map.

**Commercial / bottom-funnel (money pages — optimize existing pages):**
- consignment store software / consignment inventory software
- consignment sourcing software / resale sourcing platform
- consignment intake software, item intake app for resale
- AI clothing tagging / AI resale pricing tool
→ Map to: `/` (primary), `/features`, `/value-add`, `/pricing`, `/how-it-works`.

**Informational / top-of-funnel (new content — blog/guides):**
- how to start / run a consignment store
- consignment store inventory management (best practices)
- how to source inventory for a resale boutique
- how to price used clothing for resale
- consignment vs. buy-outright; consignment split percentages
- reducing intake time / shrink at the buy counter

**Comparison / alternative (high-intent, mid-funnel):**
- "[competitor] alternative" pages (ConsignPro / Ricochet / SimpleConsign alternative)
- best consignment software for small stores (round-up we author + earn placement in)

**Branded:** tag to rack / tagtorack — own the SERP + sitelinks (Organization schema shipped today).

## 3. Content / blog program

Stand up a `/blog` (or `/guides`) section — there is **none today**, the single biggest organic gap.
Topic-cluster model:
- **Pillar:** "The complete guide to running a consignment store" → links to cluster posts.
- **Cluster posts (first 6, monthly):** starting a consignment store · inventory management · sourcing
  local inventory · pricing used clothing · intake workflow & shrink · consignor relationships & splits.
  Each ends with a soft CTA to book a pilot.
- **Comparison posts:** one per major competitor + a round-up.
- Brief each post with `content-and-keyword-strategy` (search-intent + outline + internal links).

## 4. On-page (per money page)

Already solid (titles, meta descriptions, canonical, OG/Twitter). Tighten:
- One H1 per page containing the target term; descriptive H2s mirroring sub-intents.
- Internal links from blog → money pages with descriptive anchors.
- Descriptive `alt` text on screenshots/hero images.
- Titles ≤ ~60 chars, descriptions ≤ ~155 — audit current pages against this.
- Use `landing-page-and-conversion` to keep money pages converting, not just ranking.

## 5. Answer-Engine Optimization (AEO)

Per `answer-engine-optimization-aeo` — get cited by AI Overviews / ChatGPT / Perplexity:
- FAQ section + `FAQPage` schema on `/pricing` (shipped today); extend to `/` and `/how-it-works` by
  adding visible FAQ copy first, then schema.
- Quotable, entity-clear definitions ("What is consignment sourcing software?") near the top of pages.
- `SoftwareApplication` + `Organization` schema (shipped) so engines model TagtoRack as a distinct product.

## 6. Technical SEO

Shipped with this doc: `robots.txt` (+ sitemap reference), `Organization`/`WebSite`/`SoftwareApplication`
JSON-LD (index), `FAQPage` JSON-LD (pricing), `<lastmod>` in `sitemap.xml`. Remaining:
- [ ] Verify the domain in **Google Search Console** + Bing Webmaster Tools; submit `sitemap.xml`.
- [ ] Confirm clean-URL canonicalization (no `/page` vs `/page.html` duplication; Cloudflare `_redirects` 301s one way).
- [ ] Core Web Vitals pass (static + Cloudflare baseline is good; verify in PSI).
- [ ] Add blog URLs to the sitemap as content ships.

## 7. Measurement

- **Search Console** = source of truth for impressions/clicks/queries/position.
- Tie organic sessions → pilot bookings via the existing analytics stack (`lead-funnel-umami-listmonk`).
- Monthly review: top queries, pages gaining/losing position, new keywords to brief.

## 8. Phased roadmap

1. **Now:** robots.txt, JSON-LD, sitemap lastmod ✅. Verify GSC, submit sitemap.
2. **Weeks 1–2:** keyword map (`content-and-keyword-strategy`), on-page tightening of money pages, FAQ copy + schema on `/` and `/how-it-works`.
3. **Weeks 3–8:** stand up `/blog`, publish pillar + first 3 cluster posts, internal-link to money pages.
4. **Ongoing:** 1 post/week or 2/month, 1 competitor-comparison/month, monthly GSC review + content refresh.

## 9. Notes

- `local-seo-for-service-businesses` and `marketplace-seo-etsy-pinterest` skills are **not** for
  tagtorack.com (B2B SaaS) — they're relevant as *advice for TagtoRack's customers* (helping a shop
  rank locally), a possible content/value-add angle.
- Paid search and outbound (the reshaped OpenClaw acquire mission) are complementary channels.
