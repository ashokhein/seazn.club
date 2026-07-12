# v3 — Product Polish, Packaging & Growth Wave

Third design wave (after `engine/` v2 corpus and `engine/Jul3/`). Where v1/v2 built the
engine and Jul3 built organiser power-features, **v3 is about the product around the
engine**: mobile, navigation, pricing/packaging, self-serve growth, documentation, and a
handful of correctness fixes. Intake: the 9 Jul 2026 organiser/founder list (31 items,
captured verbatim in [00-intake-backlog.md](00-intake-backlog.md)).

> **Status: designed; PROMPT-38, PROMPT-32, PROMPT-31, PROMPT-30, PROMPT-33,
> PROMPT-34, PROMPT-35, PROMPT-37 and PROMPT-39 implemented (PROMPT-36 remains).**
> PROMPT-35 + PROMPT-37 + PROMPT-39 (2026-07-11, branch
> `feat/v3-help-admin-growth-35-37-39`) —
> content: `lib/prose.ts` (ONE sanitize pipeline; CTA = paragraph that is only
> a bold link — chosen over a TipTap custom node so stored Markdown stays
> portable), TipTap editor (`prose-editor.tsx`, Write/Preview where Preview IS
> the public renderer + org theme), wired into competition settings + org
> About (V267; division description ships column+API+public render, editor UI
> deferred — no natural settings home yet); `/help` centre (31 Markdown
> articles under `apps/web/content/help/**`, registry in `lib/help.ts`,
> stale-doc gate test, FlexSearch over `/api/help-index`, console `?` menu,
> `help-shots.ts` + weekly workflow, PR-checklist line); format gallery
> (`config/format-gallery.tsx`: 8 families × SVG mind-map + engine-real
> preview at `/help/formats/*` + marketing `/formats`; picker "How this
> works →" panel + pure `recommendFormats` strip, enumeration test pins every
> StageKind).
> admin/API: key scopes read<score<manage + competition pin (V265; legacy
> write→manage, api.write Business rung retired — Pro under api.access),
> route→scope allowlist DEFAULT-DENY in `api-v1/key-scopes.ts` (enumeration
> test walks route files), per-key 60/300 rpm + `X-RateLimit-*` via ALS,
> curated published spec (`openapi/v1.public.json`, `x-required-scope`,
> auto-examples) + self-hosted Scalar `/developers` + 3 guides + changelog;
> admin plan panel (comp-to-Pro with read-time `comped_until` expiry,
> downgrade-with-freeze-preview + typedName, trial extend syncing Stripe,
> override editor with `expires_at` — V266; Event-Pass grant deferred to
> PROMPT-36 which owns `competition_passes`; Stripe-test-clock e2e skipped —
> covered at DB level).
> growth: OG cards (comp hero/division standings/fixture) via next/og on the
> shared `server/og/` model — youth rule + contrast guard unit-tested; share
> buttons (Web Share + wa.me) on fixture/division/ticket/console-decided;
> `poster.pdf` (pdfkit direct — DocModel has no image vocabulary) + console
> buttons; `/embed/divisions/[id]/{standings,schedule,bracket}` (frame-
> ancestors relaxed for /embed only, visibility-honouring `embed-data.ts`,
> auto-height postMessage, snippet UI gated on new `embeds.enabled` V269);
> org sponsor slots in `organizations.branding.sponsors` (merge-safe writes —
> V-fixed the color-wipes-sponsors bug; dashboard footer + registration
> masthead + persistent slideshow strip, entitlement-gated reads).
> smoke: `v3ContentApiSuite` (35 checks, pro + free). V265–V269.
> PROMPT-33 + PROMPT-34 (2026-07-10, branch `feat/v3-sched-reg-prompt-33-34`) —
> board v3 (`components/v2/board/*`: hue-chip blocks, legend-as-filter `?d=`,
> Board/Agenda/By-division density, conflicts side panel, unscheduled tray with
> pick-then-place for touch+keyboard, `expected_seq` optimistic 409 on every
> schedule write), division fixtures page fix list (rounds + date ranges,
> competition-tz times, pinned unscheduled + auto CTA, Now-playing strip,
> undo-able inline reschedule, bye/void ghosts, timetable-export print),
> registration v2 (ticket-not-a-form rebuild with ONE ordered section list,
> `SZ-XXXX-XXXX` refs — mask widened from the doc's `SZ-XXXX-XX` to hold its
> own stated 6+2 composition — tear-off ticket + QR + save-PNG via next/og,
> `/r/[ref]` public status, token-gated self-withdraw, panel ref search,
> honeypot + IP+division rate bucket), youth privacy (auto `divisions.youth`,
> `player_name_display` masking across public JSON/slideshow/ticket, guardian
> preset always on youth forms). V264.
> PROMPT-38 (2026-07-10, branch `feat/engine-fixes-prompt-38`) — badminton
> headline + set-end matrix, cricket undo/status coherence + scoring error
> boundary, sim-replay v2, division delete/archive/restore.
> PROMPT-32 + PROMPT-31 (2026-07-10, branch `feat/v3-ui-prompt-32-31`) —
> match-day card system (EntityCard/StatusChip/division hue), promise-based
> ConfirmDialog provider (all 9 native `confirm()` sites replaced + ESLint
> ban), Tips framework (12-tip registry), EntityLogo chain + team badges,
> plan scrub + CI grep gate, visibility radio cards + youth interstitial,
> `lib/messages.ts` copy layer, `lib/routes.ts` route builder, five mobile
> patterns applied console-wide, Playwright `mobile-se`/`mobile-14` viewport
> gate (no-h-scroll + axe serious/critical + Fast-3G LCP). Deviations noted
> inline in docs 02/03. The rest are designed, not implemented. Prompts
> numbered PROMPT-30…39 (continuing Jul3's 21–29). Numbering of design docs
> is independent of `engine/` docs.

## Theme

The engine is ahead of the shell. Organisers hit a world-class scheduling/scoring core
through a UI that is desktop-first, id-based URLs, one price, no docs, and `window.confirm`.
v3 closes that gap and adds the two highest-ROI monetisation moves the market validates:
**per-event passes** (Tournify sells €40/€120 single-use upgrades on top of free ≤8 teams)
and a **marketing-page → competition funnel** that converts visitors before they sign up.

## Document index

| # | File | Contents | Prompt |
|---|------|----------|--------|
| 00 | [00-intake-backlog.md](00-intake-backlog.md) | Verbatim 9 Jul intake, mapped item → design doc | — |
| 01 | [01-routing-and-navigation.md](01-routing-and-navigation.md) | Hierarchical `org/comp/div` URLs, breadcrumbs, universal back button | PROMPT-30 |
| 02 | [02-mobile-responsive-overhaul.md](02-mobile-responsive-overhaul.md) | Mobile audit + patterns: org settings, payment detail, all console views | PROMPT-31 |
| 03 | [03-ui-system-refresh.md](03-ui-system-refresh.md) | Card grids, ConfirmDialog (kill `window.confirm`), Tips framework, logo placement matrix, Business-plan scrub, visibility picker | PROMPT-32 |
| 04 | [04-scheduling-ux-v3.md](04-scheduling-ux-v3.md) | Competition schedule board at 5+ divisions; division schedule page fix list | PROMPT-33 |
| 05 | [05-registration-v2.md](05-registration-v2.md) | Public registration redesign, reference-number generation, custom-field ordering | PROMPT-34 |
| 06 | [06-content-editor-and-help.md](06-content-editor-and-help.md) | Competition rich editor + preview, in-repo help centre, fixture-format gallery with mind-maps | PROMPT-35 |
| 07 | [07-pricing-packaging-v3.md](07-pricing-packaging-v3.md) | Free/Pro matrix reorg, per-event Event Pass (metered), multi-currency, annual framing, marketing home/pricing rewrite, Start-a-competition funnel, in-app billing (no Stripe Portal) | PROMPT-36 |
| 08 | [08-admin-and-developer-api.md](08-admin-and-developer-api.md) | Admin console v2 (trial extend, plan flips, overrides), published OpenAPI docs, scoped developer keys | PROMPT-37 |
| 09 | [09-engine-fixes-and-sim.md](09-engine-fixes-and-sim.md) | Badminton scoring correctness, cricket undo regression, sim-replay refresh, safe division delete | PROMPT-38 |
| 10 | [10-roi-features-and-suggestions.md](10-roi-features-and-suggestions.md) | Out-of-the-box ROI features + market research, impact×effort ranked | PROMPT-39 (wave 1 only) |
| 11 | [11-gaps-and-decisions.md](11-gaps-and-decisions.md) | Self-review: 16 gaps with decided defaults (Event Pass quota/tax, i18n layer, analytics, jobs, youth privacy, a11y bar, …) — **read before implementing any prompt** | patches inline |
| 12 | [12-marketing-redesign.md](12-marketing-redesign.md) | Home/marketing redesign: "stadium night / matchday arc" identity, object-relay hero, The Draw configurator (`/api/public/format-preview`), ticket-stub pricing finale, `/scheduling` attract-mode board — approved 12 Jul brainstorm | branch `feat/marketing-matchday` |

## Prompt index (`prompts/`)

Self-contained (context, task, files, acceptance). PROMPT-00 conventions still apply, plus
the house rules: every change ships a regression test that fails without it; `scripts/smoke.ts`
extended for every feature (pro + free paths); `tsc` + unit tests before push.

| Prompt | Delivers | Depends on |
|--------|----------|-----------|
| [PROMPT-30](prompts/PROMPT-30-routing-and-navigation.md) | Slug-based `/o/[org]/c/[comp]/d/[div]` console routes, breadcrumbs, back button — ✅ implemented (branch `feat/v3-routing-prompt-30`: V263 slug_history + fixture_no, requireOrgPage family, legacy 301s, org/comp/div rename redirects incl. /shared, readable org slugs, lint ban on string console hrefs) | — |
| [PROMPT-31](prompts/PROMPT-31-mobile-responsive-overhaul.md) | Mobile pass over every console page + viewport e2e suite | 32 (primitives) |
| [PROMPT-32](prompts/PROMPT-32-ui-system-refresh.md) | Card grids, ConfirmDialog, Tips, logo matrix, Business scrub, visibility picker | — |
| [PROMPT-33](prompts/PROMPT-33-scheduling-ux-v3.md) | Multi-division schedule board v3 + division schedule fixes | 31, 32 |
| [PROMPT-34](prompts/PROMPT-34-registration-v2.md) | Registration page v2 + reference numbers | 32 |
| [PROMPT-35](prompts/PROMPT-35-content-and-help.md) | Description editor + `/help` centre + format gallery | 32 (Tips) |
| [PROMPT-36](prompts/PROMPT-36-pricing-packaging-v3.md) | Plan matrix v3, Event Pass, multi-currency, marketing pages, start-funnel | — (touches 32 scrub) |
| [PROMPT-37](prompts/PROMPT-37-admin-and-developer-api.md) | Admin v2 + published API docs + key scopes | — |
| [PROMPT-38](prompts/PROMPT-38-engine-fixes-and-sim.md) | Badminton/cricket fixes, sim-replay v2, division delete | — (do FIRST) |
| [PROMPT-39](prompts/PROMPT-39-roi-quick-wins.md) | Share cards, QR poster, embeds, sponsor slots | 32 |
| [PROMPT-40](prompts/PROMPT-40-marketing-redesign.md) | Stadium-night marketing redesign: matchday-arc home, The Draw configurator, `/scheduling` attract board (spec: [12-marketing-redesign.md](../12-marketing-redesign.md)) — ✅ implemented (branch `feat/marketing-matchday`) | 30 (routes), 36 (funnel/pricing) |

## Build order (canonical — see v3/11 gap 3)

1. **PROMPT-38** — correctness first; badminton/cricket bugs erode trust daily.
2. **PROMPT-32** → **PROMPT-31** — UI primitives, then the mobile pass that uses them
   (31 depends on 32 only; components patterned in 31 survive the route move in 30).
3. **PROMPT-30** — routing: one short-lived branch, merged same-day; rollback = revert.
4. **PROMPT-33 / 34** — scheduling board + registration (organiser-visible wins).
5. **PROMPT-36** — pricing/packaging + funnel (revenue).
6. **PROMPT-35 / 37 / 39** — help, admin/API, growth quick-wins, any order.

**Prompts 30–33 must not run in parallel** — routing, mobile and board work churn the
same files (and other sessions work this repo). Read
[11-gaps-and-decisions.md](11-gaps-and-decisions.md) before starting any prompt: its 16
decided defaults override older doc text where they conflict.
