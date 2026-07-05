# 06 — Marketing Site & Home Page

## 1. Goal

A fast, SEO-strong public presence that converts visitors to trials and supports an
Enterprise "book a demo" motion — plus public tournament pages that act as an acquisition
flywheel.

## 2. Current state

- `src/app/page.tsx` is the app landing (authenticated-first). No dedicated marketing site,
  pricing page, docs, blog, or status page.
- Public-ish surfaces exist: `/tournaments/[id]/slideshow`, `/tournaments/[id]/print`.

## 3. Structure: marketing vs app

Use Next.js **route groups** in the same project initially (shared design system, simplest),
with an option to split later:

```
src/app/
  (marketing)/            # public, statically rendered, cached at CDN
    page.tsx              # home
    pricing/page.tsx
    features/...
    use-cases/...
    blog/...              # MDX
    docs/...              # help center (or external)
    legal/{privacy,terms,dpa}/page.tsx
    status/page.tsx       # or link to external status provider
  (app)/                  # authenticated product (existing pages move here)
    dashboard, settings, tournaments, orgs, ...
  t/[slug]/page.tsx       # PUBLIC tournament pages (acquisition flywheel)
```

- **Rendering:** marketing pages `export const dynamic = 'force-static'` + ISR; cache at CDN.
- **Separation:** marketing has no auth dependency; app pages keep current auth gating.

## 4. Home page sections

1. **Hero** — headline "Run any tournament, any sport, in minutes." Subhead on multi-format
   engine. **Primary CTA:** *Start free* → signup. **Secondary:** *Book a demo* (Enterprise).
   Visual: animated live bracket/scoreboard (real component, sample data).
2. **Logo strip / social proof** — customer logos, "X tournaments run", sports supported.
3. **Interactive format showcase** — pick sport + format (Swiss, knockout, round-robin,
   stepladder) and render a real sample bracket from the engine. This is the differentiator.
4. **Feature grid** — live scoring, multi-sport, brackets & standings, exports, team
   management, public pages/slideshow, branding.
5. **Use cases** — Clubs & academies / Schools / Corporate events / Federations & leagues
   (each links to a dedicated page targeting that segment + keywords).
6. **Pricing teaser** → full pricing page.
7. **Trust** — security & compliance badges (SOC 2 "in progress"/done, GDPR), uptime link.
8. **Testimonials / case studies.**
9. **Final CTA** + footer (docs, status, changelog, legal, social, careers).

## 5. Pricing page

- Tier cards from doc 01 matrix; monthly/annual toggle (annual discount).
- Per-feature comparison table (the entitlement matrix, humanized).
- FAQ (billing, trial, cancellation, data ownership).
- CTAs: Pro/Business → Checkout (doc 05); Enterprise → demo/contact form.

## 6. Public tournament pages (`/t/[slug]`) — the flywheel

- Read-only, shareable, **cacheable** view of a tournament: bracket, standings, schedule,
  results, optional live updates (realtime entitlement).
- **Branding/entitlement-aware:** Free shows tasteful "Powered by Seazn Club"; paid removes it;
  Business+ supports custom domain; Enterprise white-label (doc 01 `public_pages`).
- **SEO:** SSR/ISR, Open Graph image (auto-generated bracket/score card via `@vercel/og` or
  worker), structured data (`SportsEvent` schema.org), unique titles/descriptions.
- **Privacy:** organizer toggles public/private; private = noindex + auth required.
- Every shared event → inbound traffic → "Create your own" CTA.

## 7. SEO & content

- Per-page metadata via Next `generateMetadata`; canonical URLs; sitemap.xml + robots.
- **Blog/guides (MDX):** format explainers, sport-specific how-tos, templates — target
  long-tail keywords ("how to run a Swiss tournament", "padel americano format").
- Open Graph / Twitter cards for all shareable surfaces.
- Performance is SEO: static + CDN, image optimization, minimal JS on marketing routes.

## 8. Conversion instrumentation

- Analytics on marketing + public pages (privacy-friendly, cookie-consented): page views,
  CTA clicks, signup starts/completes, public-page → signup attribution.
- A/B test hero copy and CTA (LATER; via flagging in doc 02).
- Feed metrics defined in doc 01 §8.

## 9. Supporting pages

- **Docs / help center:** in-app MDX or external (e.g. a docs platform). Searchable.
- **Status page:** external provider or `/status` reading uptime checks (doc 07).
- **Changelog:** product updates (also good SEO + retention).
- **Legal:** Privacy, Terms, DPA, sub-processors, cookie policy (ties to doc 04 GDPR).
- **Contact / demo:** form → CRM; routes Enterprise leads to sales.

## 10. Design system

**Locked (2026-07):** Keep **Tailwind CSS v4** as the styling layer, but the UI should
**look and behave like [shadcn/ui](https://ui.shadcn.com/)** — neutral surfaces, subtle
borders, compact density, Radix-grade accessibility. We do **not** adopt a separate CSS
framework; shadcn components are copied into the repo and themed with our tokens.

### Stack

- **Tailwind v4** — `@import "tailwindcss"` + `@theme inline` in `globals.css` (already in
  place). No `tailwind.config.js`.
- **shadcn/ui** — init with the **New York** style when the UI redesign starts
  (`npx shadcn@latest init` in `apps/web`). Components live in `components/ui/`; we own
  the code.
- **Radix UI** — primitives via shadcn (Dialog, DropdownMenu, Select, Tabs, …).
- **`cn()` + CVA** — class merging and variant props on shared components.
- **Lucide** — icon set (already a dependency).

### Visual direction

Match shadcn defaults unless brand requires otherwise:

- White/neutral cards with `border` + light shadow, not heavy purple gradients.
- Primary actions: solid `primary` button; secondary: `outline` / `ghost`.
- Form controls: consistent height, focus ring, label + error text pattern.
- Tables: clean header row, row hover, aligned numerics for standings.
- Dialogs/sheets replace the custom `Modal` + `.modal-overlay` utilities.

Map Seazn brand onto shadcn CSS variables (`--primary`, `--ring`, `--muted`, …) in
`globals.css`. Org-level Pro branding (logo, banner, sponsor row) layers on top — it does
not replace the app shell design system.

### Migration (when redesign starts)

1. Init shadcn + base theme tokens in `apps/web`.
2. Add core primitives: `button`, `input`, `label`, `card`, `dialog`, `table`, `select`,
   `tabs`, `dropdown-menu`, `badge`, `sonner`.
3. Migrate screens incrementally (auth → shell → admin → live → public dashboard →
   marketing). Retire `.btn` / `.card` / `.input` globals only when nothing references
   them.
4. **Engine docs stay UX-only** — page structure and flows live in `engine/` (e.g. doc 09,
   12); visual styling lives here.

### Quality bar

- Accessibility: WCAG 2.1 AA — semantic landmarks, focus states, color contrast, keyboard
  nav, reduced-motion for animated hero. shadcn/Radix covers most focus-trap and ARIA
  patterns; verify custom tournament views separately.
- Responsive/mobile-first; dark mode `LATER` (`next-themes` + shadcn `.dark` tokens).

## 11. Acceptance criteria

- Marketing route group renders statically, cached at CDN, no auth dependency.
- Home, pricing, ≥3 use-case pages, legal pages live.
- Public tournament pages SSR/ISR with OG images, schema.org, entitlement-aware branding,
  public/private toggle.
- Sitemap, robots, metadata, analytics with consent in place.
- Lighthouse: performance & SEO ≥ 90 on marketing routes.

## 12. Open questions / decisions

1. Marketing in-repo route group (recommended) vs separate site/repo?
2. Docs: in-app MDX vs external docs platform?
3. Status page: build vs external provider?
4. Are Free public pages indexable (SEO upside) or noindex by default?
