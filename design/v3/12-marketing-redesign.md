# Marketing redesign — stadium night / matchday arc

Date: 2026-07-12
Status: approved in brainstorm (batches 1–3 + /scheduling merge), pending spec review
Branch: `feat/marketing-matchday`

## 1. Context and goals

The current home page is a generic SaaS stack: centered hero, emoji feature grid, use-case
cards, pricing teaser, purple CTA band. Nothing about it says "sports" and nothing invites
play. The founder's brief: modernize creatively around the product's subject (sports in
motion), keep it "simple and classic — not heavy animation, no load delay", put an
interactive format demo on the home page, add one or two product pages to the nav, and
maximize time-on-site so visitors get eager to onboard. Blog explicitly deferred.

Success criteria:

- A visitor can *play* (generate fixtures, drag a schedule) within one scroll and no signup.
- The page is visually unmistakable for any other SaaS site, while staying on brand
  (purple stays the anchor; Barlow Condensed already carries the public "courtside" look).
- No performance or accessibility regression: LCP stays text, CLS 0, WCAG 2.1 AA
  (the v3/11 bar), everything usable with `prefers-reduced-motion`.

## 2. Design identity ("stadium night" system)

Rejected on the way here: humanoid athlete SVG animation (reads cheap, "90s"), all-dark
page (reading fatigue), broadcast-package framing (fragile metaphor). Approved:

**Palette**

| Token | Hex | Use |
|---|---|---|
| night | `#150b36` | dark bookend background (deep) |
| night-2 | `#1d1145` | dark bookend background (lifted) |
| cream | `#f5f0e8` | display text on night |
| floodlight lime | `#a3e635` | CTAs on dark, ticker, pitch accents |
| brand purple | `#7c3aed` | light sections, links — unchanged product-side |
| light-violet / light-warm | `#f6f3ff` / `#fffdf7` | light middle section backgrounds |
| signal orange / live red | `#fb923c` / `#ef4444` | small accents only (live dot, clash flash) |

**Type.** Barlow Condensed (600/700, uppercase, tight leading) promoted from the public
courtside pages to the marketing display face — marketing and public product pages share
one voice. Geist stays for body. Tabular numerals wherever scores or prices appear.

**Illustration.** Chunky-outline equipment SVGs (~3px dark outline, flat fills — the
vetted "sticker" style): ball, bat, shuttle, chess knight, whistle. **No human figures
anywhere.**

**Motion rules.** CSS keyframes only — no animation library, no new dependencies.
Transform/opacity only. Hero vignette plays **once** on load; every scroll-triggered
animation plays **once** when entering the viewport (a single small IntersectionObserver
utility adds a class). Under `prefers-reduced-motion: reduce` everything renders in its
end state, static. Spring-flavored cubic-bezier easing (overshoot), never linear tweens.

## 3. Page architecture — "matchday arc"

Night → daylight → night. The page opens and closes floodlit; the middle is light for
readability. Section order:

1. **Hero** (night) — vignette + funnel
2. **LIVE ticker** (lime strip)
3. **The Draw** (light) — interactive configurator
4. *shuttle-arc motif divider*
5. **Matchday tools** (light) — three product-real animated cards + "Also in the kit" row
6. *chess-knight motif divider*
7. **Who plays here** (light) — three audience cards, restyled
8. **Playing this week** (light, collapses when empty)
9. **Floodlit finale** (night) — pricing ticket stubs + final CTA, one block
10. **Footer** (night)

## 4. Home page, section by section

### 4.1 Nav (`marketing-nav.tsx`, restyled with a `variant` prop)

- Links: **Formats** (existing `/formats`) · **Scheduling** (new page, §5) · **Pricing** ·
  **Use cases**. Auth actions unchanged (Log in / Start free; Dashboard when signed in).
- On the home page the nav starts transparent over the night hero (cream logo and links,
  lime Start free button) and switches to the solid light style once the hero scrolls out
  — same IntersectionObserver utility, one class toggle. All other marketing pages use the
  solid light variant permanently. One component, `variant: "night-scroll" | "light"`.

### 4.2 Hero (stadium night)

- Night gradient (`night-2 → night`) with two faint floodlight beams from the top corners
  (pure CSS radial gradients).
- Left column: eyebrow "Free for community clubs", condensed cream H1 ("Any sport. Live
  in minutes." — copy gets a final pass at build within this tone), one-line sub naming
  real sports ("Cricket, football, badminton, chess — any sport you run"),
  **`StartFunnelForm` restyled dark with lime submit — funnel logic untouched**, small
  trust footnote linking `/pricing`.
- Right column (stacks below on mobile, fixed-height box → CLS 0): the **object-relay
  vignette** — ball toss → chunky-outline cricket bat strikes (impact star burst +
  confetti pop) → ball rockets left → lands as the pulsing LIVE dot on a real scorebug
  chip. ~2.6s, plays once, then calm idle (dot pulse, 8s bat sway). Tiny replay button.
  Inline SVG ≤ ~8 KB. Under reduced motion: end state only (ball already on scorebug).
- `HeroFixtureDemo` is retired; the scorebug chip absorbs its job.

### 4.3 LIVE ticker

Lime strip directly under the hero: marquee of real `getDiscoveryLive()` fixtures
(replaces `LiveNowStrip`). Marquee pauses on hover/focus and is static under reduced
motion. When no live fixtures: the strip collapses (no fake content).

### 4.4 The Draw — interactive configurator

- Light section, second position — visitors play within one scroll.
- Controls: format segmented control (**League / Groups+Knockout / Knockout / Double
  elimination**), entrant stepper **4–16** (default 8), **Shuffle names** re-roll. The
  default draw renders immediately on scroll-into-view; no click needed to see the first
  result. (Brainstorm said Swiss here, but the engine has no static Swiss draw —
  `previewDivisionFixtures` returns an explanatory note because pairings depend on live
  results. A note is a dead tab in a play-first demo, so Double elimination — a real,
  impressive bracket — takes the fourth slot. Swiss stays fully supported in the product
  and the /formats gallery.)
- Engine: the same `previewDivisionFixtures` the division wizard uses
  (`src/server/usecases/stages.ts:660`, pure computation, no DB), exposed via a new
  unauthenticated **`POST /api/public/format-preview`**. The route maps each marketing
  format key to a canned `PreviewStageInput[]` graph (league = single league stage;
  groups+KO = group stage with top-N qualification feeding a knockout stage; knockout
  and double-elim = single bracket stage — the same shapes the wizard builds). Input
  validated (format enum, count 4–16), response cached per (format, count),
  IP rate-limited. Names are generated client-side (club-flavored generator); shuffle
  re-rolls names only, format/count changes redraw the structure.
- Rendering: a new **animated** renderer on the `PreviewPhase` data shape — group tables
  cascade in, the knockout bracket draws itself (stroke-dashoffset lines, nodes pop).
  The existing `FormatPreviewView` stays untouched for /help and the wizard.
- Fallback: if JS or the API fails, a static pre-rendered 8-entrant Groups+KO preview.
- CTA under the result: **"Make it real →"** into `/start` with sport/format/count
  prefilled via query params.

### 4.5 Matchday tools + Also in the kit

Three product-real animated cards (each plays once on view): **Live scoring** (mini
scorebug, score rolls odometer-style), **Scheduling board** (mini court-lane grid,
fixture blocks slide in — links to `/scheduling`), **Standings** (mini table, two rows
swap once). The remaining features (registration & fees, print/slideshow, roles,
security) become a compact **"Also in the kit"** row: chunky-outline icon + one-liner
each. The emoji `FEATURES` grid dies.

### 4.6 Motif dividers — exactly two on the whole page

Shuttle arcs across the divider entering Matchday tools; chess knight does one L-hop
entering Who plays here. Each < 1.2 s, once, on scroll. No other decorative motion.

### 4.7 Who plays here / Playing this week

Who plays here keeps its three audience cards (clubs & academies, one-day events,
schools & youth) restyled to the new system: chunky icons, condensed headings.
`ThisWeekSection` moves here as a light "Playing this week" strip; still collapses to
nothing when empty.

### 4.8 Floodlit finale (pricing + final CTA, one night block)

- Returns to the night palette: lime eyebrow, condensed cream headline ("Pick your
  season"), sub line.
- Three offers as **ticket stubs** — perforated tear edge with punched notches, rotated
  "ADMIT ONE" tab, tabular-num price, check list. Event Pass stub carries a lime glow
  (the wedge offer). Stubs fan in once on view.
- **Content renders from `lib/pricing-matrix.ts`** — the current teaser is hardcoded and
  drifts from /pricing; a unit test pins teaser ↔ matrix equality.
- CTA row in the same section: lime **"Start your tournament →"** → `/start` (funnel-first
  strategy stays), ghost "Create free account" secondary, "Compare plans in detail →"
  link. The separate purple-900 CTA section dies.

### 4.9 Footer (`marketing-footer.tsx`, restyled)

Night background, closing the arc. Four columns: **Product** (Formats, Scheduling,
Pricing, Live now → /discover) · **Who it's for** (three use-cases) · **Developers**
(API reference, guides, changelog) · **Legal** (privacy, terms, cookies). Base row:
© + condensed "ANY SPORT · LIVE IN MINUTES" tag.

## 5. `/scheduling` — the one new page

Light page on the matchday-arc system, built from the three approved directions as
layers ("attract mode" pattern):

1. **The board** (hero component, night slab on light page). On load it plays the
   scripted **matchday replay** once (~3 s): fixture chips fly onto court lanes, a clash
   flashes red, resolves to lime, "published". Then the tray appears — **"Your turn"** —
   and the same board becomes interactive: visitor drags fixtures onto courts, dropping
   two on one court fires real clash feedback, filling the board lights a **Publish**
   button that flips to a mini player-view of the public schedule + CTA
   **"Run your matchday →"** into `/start`. Touching the board during the replay skips
   straight to interactive. Clash logic is a small client-side rule (same concept the
   real board enforces), not a backend call.
2. **Order of play** rail as the capabilities section: a condensed time rail
   (08:40 build the board · 08:55 clash caught · 09:00 publish · 12:30 rain-delay
   reshuffle), each slot pairing one capability with a one-line how. Replaces generic
   capability cards.
3. Slim kit strip (print & noticeboard slideshow, scorer hand-off links) + closing CTA.

Mobile: tap-a-chip-then-tap-a-court placement instead of drag. Reduced motion: no
replay; the board arrives pre-filled minus one chip, still placeable. No new backend.

## 6. Retirements and moves

- Deleted: `HeroFixtureDemo` component, emoji `FEATURES` grid, sports-chips section
  (sports named in the hero sub line instead), standalone purple CTA section.
- Moved: `LiveNowStrip` → LIVE ticker (§4.3); `ThisWeekSection` → Playing this week (§4.7).
- Restyled in place: `marketing-nav.tsx`, `marketing-footer.tsx`, `StartFunnelForm`
  (dark variant — logic untouched).

## 7. Non-goals (this wave)

- No redesign of `/pricing`, `/use-cases/*`, `/formats`, `/discover`, `/developers`
  content — they inherit only the new nav and footer. Full consistency pass later.
- No blog, no `product_events` analytics (table doesn't exist), no DB migrations,
  no i18n changes, no new dependencies.

## 8. Technical design

**New**

- `POST /api/public/format-preview` — unauthenticated route. Zod-validates
  `{ format: "league" | "groups_knockout" | "knockout" | "swiss", entrants: 4–16 }`,
  calls `previewDivisionFixtures`, returns the `PreviewPhase[]` shape. In-memory cache
  keyed (format, entrants) — output is deterministic for a given input; names are
  client-side. IP rate limit reusing the existing limiter helper. No DB, no session.
- `components/marketing/` — new home sections live here: `hero-vignette.tsx`,
  `live-ticker.tsx`, `the-draw.tsx` (configurator + animated renderer),
  `matchday-tools.tsx`, `ticket-stubs.tsx`, `motif-divider.tsx`.
- `components/marketing/scheduling-board.tsx` — replay + interactive board for
  `/scheduling` (client component; pointer events with tap fallback).
- `lib/marketing/reveal.ts` — the IntersectionObserver once-on-view utility (adds a
  class; respects reduced motion by bailing out).
- `lib/marketing/club-names.ts` — deterministic club-flavored name generator (seeded so
  tests are stable; shuffle passes a new seed).
- `src/app/scheduling/page.tsx` + metadata.

**Changed**

- `src/app/page.tsx` — new section stack (server component; discovery fetches stay
  fail-soft).
- `marketing-nav.tsx` (variant prop), `marketing-footer.tsx` (night restyle + links),
  `StartFunnelForm` (dark style variant), `globals.css` (marketing tokens as CSS vars —
  namespaced `--mk-*`, so they can't collide with the public `--ps-*` theme layer).
- `.gitignore` — `.superpowers/` (already in working tree).

**Deleted**

- `components/hero-fixture-demo.tsx`.

**Fonts.** Barlow Condensed is already mounted for public pages via the org layout; the
marketing layout mounts the same `next/font` instance (no second font download path).

## 9. Accessibility and performance budget

- WCAG 2.1 AA: cream-on-night 15.4:1, lime-on-night 10.7:1, night-on-lime 10.7:1 — all
  pass; small orange/red accents never carry text. Focus visible on dark and light.
  Ticker pausable; configurator and scheduling board fully keyboard-operable (segmented
  control = radio group; board chips placeable via focus + arrow/enter as the tap
  fallback's keyboard twin). Axe suite stays clean.
- Motion: everything transform/opacity, once-only; zero animation under reduced motion.
- Perf: H1 remains LCP (vignette is aside, fixed-height); inline hero SVG ≤ ~8 KB; no
  new JS dependencies; configurator and board are the only client components added to
  the marketing surface. Target: Lighthouse mobile perf ≥ 90 on `/`.

## 10. Testing

- **Vitest**: format-preview route (accepts the four formats, rejects bad
  format/entrants, deterministic per input, rate-limit path); club-names generator
  (seed-stable); ticket stubs render exactly what `pricing-matrix.ts` says (drift
  test — fails if matrix changes without the teaser); reveal utility (adds class once).
- **Playwright e2e** (`apps/web` cwd — repo-root runs break storageState): home —
  default draw renders without interaction, format switch redraws, "Make it real →"
  lands on `/start` with params, funnel form submits as before; `/scheduling` — replay
  completes, chip placement works, double-booking shows clash, Publish appears when
  full; reduced-motion run renders end states.
- **Existing contracts kept**: funnel form e2e, discovery strips collapse-when-empty,
  nav auth states.
- **`scripts/smoke.ts`**: extend with `GET /` (200, contains The Draw section) and
  `POST /api/public/format-preview` (returns fixtures for groups+knockout/8).

## 11. Rollout

Branch `feat/marketing-matchday` → PR to main. No migrations, no env vars, no Stripe
changes, one new public API route. Verify before push: tsc + unit + e2e (house rule).
Playwright screenshots compared against the approved mocks
(`.superpowers/brainstorm/…/content/*.html`) as the visual reference.
