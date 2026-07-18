# v16 — League operations: discipline, news, referee feedback, team-scale pricing

**Theme:** the LeagueRepublic gap analysis (2026-07-18) showed we beat LR on
every scoring/scheduling/payments axis but lose on four league-operations
surfaces: player suspensions, an org news channel, referee marks/reports, and
a price that scales with league size. v16 closes all four. Custom domains
(gap #1) is already specced separately (Pro Plus spec 2) and is NOT in this
wave. Site-builder-lite and SMS result entry are explicitly deferred/rejected.

## The one-line product bet

> A league secretary running 100 teams does three things every Monday that we
> don't help with today: process suspensions, post the weekend's results, and
> chase referee feedback. Give them all three — and charge the 300-team league
> more than the 10-team club without adding a single SKU.

## Specs in this wave

| # | Spec | One-liner | Migration (draft #) |
|---|------|-----------|---------------------|
| 1 | [SPEC-1 Discipline & suspensions](SPEC-1-discipline-suspensions.md) | Card events fold into a disciplinary ledger; configurable per-division thresholds auto-raise pending suspensions; organiser confirms; banned players flagged everywhere | V291 |
| 2 | [SPEC-2 Org news & share cards](SPEC-2-news-social.md) | Org news feed with composer + public tab + OG share cards; system auto-drafts result/round posts the organiser publishes with one tap | V292 |
| 3 | [SPEC-3 Official marks & match reports](SPEC-3-official-marks-reports.md) | Organiser rates each assignment (org-private); officials file match reports whose incidents feed SPEC-1 | V293 |
| 4 | [SPEC-4 Team-scale pricing dimension](SPEC-4-team-scale-pricing.md) — **DEFERRED 2026-07-18** | Org-wide active-team quota: community 32 / Pro 100 / Pro Plus unlimited. Spec approved-in-principle but pulled from this build wave by user decision; revisit after 1–3 ship | (V294 draft, unused) |

## Design decisions (locked in brainstorming, 2026-07-18)

| # | Decision |
|---|----------|
| D1 | **Suspension rules are configurable thresholds** per division with sport defaults prefilled — not fixed packs, not manual-only. Auto-raised suspensions land `pending`; an organiser confirms/edits/waives. Manual bans always possible. |
| D2 | **No engine changes for discipline.** Cards already live in the `score_events` ledger; the fold happens in the web tier (recompute-on-read, `player_stat_snapshots` pattern). One additive, optional `discipline` descriptor on the sport-module interface maps event types → card records. |
| D3 | **News = posts + auto-drafts + share images. No social-platform APIs.** Facebook/X auto-posting (app review, per-org OAuth, token refresh) is rejected; a share-ready OG/PNG card + the existing share-bar covers the job. |
| D4 | **Marks are organiser-entered and org-private.** Aggregates visible in that org's console; the official sees only their own running average (never per-assignment marks or authors). NOT surfaced on the public/cross-org directory in v16. |
| D5 | **Match reports are official-entered and free** (V284 principle: the officiating portal never requires Pro). Marks entry is Pro (`officials.marks`). |
| D6 | **Team scale = the Pro→Plus differentiator.** New quota key `teams.active.max`: community 32, event_pass 32, pro 100, pro_plus unlimited. No size bands, no metered billing, no new Stripe prices. Existing orgs over a cap get grandfathered via `org_entitlement_overrides` (V270 precedent). **DEFERRED 2026-07-18: spec kept, build pulled from this wave by user decision.** |
| D7 | **Discipline module is Pro** (`discipline.enforced`, pro + pro_plus). Cards themselves are already Pro (v6 "cards-are-Pro"), so a free tier could never feed the rules anyway; one gate, no half-free manual ledger. |
| D8 | **Enforcement is soft everywhere.** Suspensions flag and warn (badges, pad warnings, public list) — they never hard-block scoring, because there is no per-fixture lineup entity to block against. Revisit after the clubs & teams redesign lands squad selection. |
| D9 | Migration numbers V291–V294 are **drafts**: renumber to the next free V at build time (V286→V290 renumber lesson — a lower-numbered file that seeds the same key must run first). Each spec's DDL ships in its own migration so specs can ship as independent PRs in any order — except SPEC-3's report→suspension bridge, which soft-depends on SPEC-1's table. |

## Design direction (wave-wide)

Every new surface extends the existing **courtside / stadium-night** system —
`--ps-*` tokens + `public-theme.ts` on public pages, `.app-*` tokens in the
console, Barlow Condensed display type, scorebug vernacular, lime pitch-line
+ red-ball brand accents. No new palettes, no new type families. What v16
adds is *vocabulary*, one signature element per surface:

- **News** — a result post IS a scorebug: kind-colored eyebrow, scoreline in
  huge condensed tabular numerals; the feed reads as a night-mode matchday
  programme, not a blog.
- **Discipline** — the referee's cards are the palette: literal card glyphs
  (tilted rounded-rect swatches, yellow/red) lead every row; served progress
  is match pips, never a percent bar.
- **Marks** — rating entry as five scoreboard-digit tap targets; the average
  renders as a scorebug badge.
- **Scale meter** — active-team usage as a stadium-capacity gauge on the
  billing page.

Each spec carries its own "Design direction" section with the details.
Modern-polish bar applies (memory: frontend-design always): visible keyboard
focus, `prefers-reduced-motion` respected, `.input`/`.label` form defaults —
and significant UI must be **screenshot-verified** before a prompt is called
done.

**Mobile UX is an acceptance criterion for EVERY new surface in this wave**
— organisers run matchdays from phones, officials file reports from the car
park. Concretely, per surface: design mobile-first (390×844 is the primary
viewport, desktop is the enhancement); touch targets ≥ 44px; no
horizontal-scroll layouts except tables in their own scroll container;
screenshot-verify BOTH viewports; and extend the mobile e2e project wherever
a flow differs from desktop (score-pad mobile precedent from the floodlit
wave — mind its e2e concurrency gotcha).

## Cross-spec dependencies

```
SPEC-1  ─ independent
SPEC-2  ─ independent
SPEC-3  ─ standalone EXCEPT the incident→suspension bridge, which activates
          only if discipline tables exist (guard: feature check + table probe
          at usecase level; ships dark if SPEC-1 not merged yet)
SPEC-4  ─ DEFERRED (independent when revived; pure entitlement matrix + checks)
```

Build order: **1 → 3 → 2** (3 lands after 1 so the report→suspension bridge
ships live; 2 is the biggest UI surface and closes the wave).

## Build order & prompts

Strictly sequential within a spec (server → UI); specs in 1 → 3 → 2 order.

- [PROMPT-78 — Discipline: model, card fold, detection, API](prompts/PROMPT-78-discipline-model-and-api.md) — V291 + engine `discipline` descriptor + `discipline.ts` + routes. Server only.
- [PROMPT-79 — Discipline: console, pad, public & /me surfaces](prompts/PROMPT-79-discipline-console-and-public-ui.md) — rules editor, panel, chips, pad banner, public strip, /me, emails + i18n/help/smoke closing.
- [PROMPT-80 — Marks & reports: model, usecases, API](prompts/PROMPT-80-marks-reports-model-and-api.md) — V293 + marks (Pro) + reports (free, cross-org rail) + report→suspension bridge.
- [PROMPT-81 — Marks & reports: console + portal UI](prompts/PROMPT-81-marks-reports-ui.md) — scoreboard-digit tiles, summary block, report form/drawer, /me CTA, email + closing passes.
- [PROMPT-82 — News: model, auto-drafts, API](prompts/PROMPT-82-news-model-and-autodrafts.md) — V292 + `org_posts` + draft templates + decided-seam triggers.
- [PROMPT-83 — News: console tab, public pages, OG & story cards](prompts/PROMPT-83-news-console-public-and-cards.md) — composer, public feed/post, scorebug OG + 1080×1350 story PNG, analytics + closing passes.

## Global constraints (apply to every spec — same rails as v15)

- **This is NOT the Next.js you know** — read `node_modules/next/dist/docs/`
  before route/handler work.
- Migrations live at repo root `db/migration/deltas/`; `db:apply` = incremental
  Flyway; DB-backed vitest needs `DATABASE_URL` (`skipIf(!HAS_DB)`).
- **Every code change ships a regression test that fails without it.**
- **Extend `scripts/smoke.ts`** — a pro path AND a free path per feature.
- **i18n parity gate**: new console strings are typed keys in
  `apps/web/src/lib/i18n-keys.ts`, filled in **en/fr/es/nl** (hi/ta skipped).
- **Help closing pass mandatory**: update `apps/web/content/help/*` in the same
  PR; keep `HELP_ARTICLE_SLUGS` bidirectional-clean (`help-content.test.ts`).
- **OpenAPI regen after ANY schema change** (`apps/web/src/server/api-v1/openapi.ts`
  route registry — bitten three times in v13).
- **Worktree branch per spec** (`.claude/worktrees/v16-<spec>`); never switch
  branches in the main checkout.
- **Verify before push**: `tsc` + unit + touched suites; then smoke.

## Non-goals (whole wave)

- No social-platform posting APIs (Facebook/X/Instagram).
- No public/cross-org referee mark display; no referee league tables.
- No per-fixture lineup/squad-selection entity (blocks stay soft, D8).
- No SMS anything.
- No new Stripe SKUs, prices, or metered billing.
- No email digest of news posts (the `standingsTable` email block stays ready;
  digest is its own later spec).
- No site-builder (custom pages/menus/widgets) — separate decision later.

## Deploy notes

- Three migrations this wave — SPEC-1/2/3 only, renumbered at build → stg
  then prod, direct-connection Flyway per the standing stg constraint.
  (SPEC-4's V294 ships only if/when that spec is revived.)
- No pricing-page changes this wave (that was SPEC-4, deferred).
- No webhook, Connect, or env changes anywhere in the wave.
