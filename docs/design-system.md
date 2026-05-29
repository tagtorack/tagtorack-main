# Design System — Tag to Rack

Warm boutique resale × precise AI tooling. Cream/clay neutrals, a single violet
AI/action accent, grotesk display + mono spec labels.

## Color tokens (`:root` in `assets/css/styles.css`)

### Warm neutrals
| Token         | Value     | Use                          |
|---------------|-----------|------------------------------|
| `--bg`        | `#f6f1e9` | Page background (warm cream)  |
| `--bg-2`      | `#efe7d9` | Alternating section bg        |
| `--surface`   | `#fffdf8` | Cards                         |
| `--surface-2` | `#faf6ee` | Nested cards / fields         |
| `--ink`       | `#211c18` | Primary text (warm near‑black)|
| `--ink-soft`  | `#6c6357` | Body / secondary text         |
| `--ink-faint` | `#9a9082` | Captions, placeholders        |
| `--line`      | `#e4dac8` | Hairline borders              |

### Accents
| Token          | Value     | Use                                  |
|----------------|-----------|--------------------------------------|
| `--violet`     | `#6a40c9` | Primary CTA, AI signal, links        |
| `--violet-ink` | `#4d2a9c` | Violet text on light                 |
| `--violet-soft`| `#efe9fb` | Tinted surfaces / trust strip        |
| `--clay`       | `#b06a4f` | Warm secondary, sparing use          |

### Dark + status
| Token        | Value     | Use                       |
|--------------|-----------|---------------------------|
| `--espresso` | `#211c18` | Footer / dark sections     |
| `--ok`       | `#3f7d54` | "Consign / good" status    |
| `--warn`     | `#b07a2e` | "Review flaw" status       |
| `--stop`     | `#b04a3f` | "Pass / reject" status     |

## Typography

| Role      | Font           | Notes                                  |
|-----------|----------------|----------------------------------------|
| Display   | Space Grotesk  | Headlines, buttons, brand. `-0.02em`.  |
| Body      | Hanken Grotesk | Paragraphs, UI. 17px base, 1.6 line.   |
| Mono      | Space Mono     | Eyebrows, tags, spec labels, data.     |

- `.eyebrow` — mono uppercase kicker with a violet tick.
- `.mono` — uppercase mono label.
- `h1` clamps `2.6 → 4.6rem`; `h2` `2 → 3.1rem`.

## Core components (classes)

- `.btn` + `.btn-primary` / `.btn-ghost` / `.btn-dark` / `.btn-lg` — pill buttons.
- `.chip` (+ `.violet .ok .warn .stop`) — tag chips, the brand motif.
- `.card` (+ `.card-pad-lg`) — soft rounded surface, 22px radius.
- `.trust-strip` — violet pill reinforcing "AI recommends, manager approves."
- `.ph` — striped image placeholder with mono caption.
- `.reveal` (+ `.d1 .d2 .d3`) — scroll‑in animation, JS‑toggled `.in`.
- Layout: `.wrap`, `section`, `.section-head`, `.grid` + `.cols-2/3/4`.

## Geometry

Radii `10 / 16 / 22 / 30px`. Three shadow tiers (`--shadow-sm/​/lg`). Max content
width `1180px`, fluid gutter `clamp(20px, 5vw, 56px)`.

## Principles

1. Reference tokens, never raw hex.
2. Violet is reserved for AI + action — don't dilute it.
3. Mono = "the tag." Use it for data and labels, not body copy.
4. Every AI output gets a recommendation framing + approval control.
