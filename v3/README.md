# v3 — Product Polish, Packaging & Growth Wave

Third design wave (after `engine/` v2 corpus and `engine/Jul3/`). Where v1/v2 built the
engine and Jul3 built organiser power-features, **v3 is about the product around the
engine**: mobile, navigation, pricing/packaging, self-serve growth, documentation, and a
handful of correctness fixes. Intake: the 9 Jul 2026 organiser/founder list (31 items,
captured verbatim in [00-intake-backlog.md](00-intake-backlog.md)).

> **Status: designed, not implemented.** Prompts numbered PROMPT-30…39 (continuing
> Jul3's 21–29). Numbering of design docs is independent of `engine/` docs.

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
| 07 | [07-pricing-packaging-v3.md](07-pricing-packaging-v3.md) | Free/Pro matrix reorg, per-event Event Pass (metered), multi-currency, annual framing, marketing home/pricing rewrite, Start-a-competition funnel | PROMPT-36 |
| 08 | [08-admin-and-developer-api.md](08-admin-and-developer-api.md) | Admin console v2 (trial extend, plan flips, overrides), published OpenAPI docs, scoped developer keys | PROMPT-37 |
| 09 | [09-engine-fixes-and-sim.md](09-engine-fixes-and-sim.md) | Badminton scoring correctness, cricket undo regression, sim-replay refresh, safe division delete | PROMPT-38 |
| 10 | [10-roi-features-and-suggestions.md](10-roi-features-and-suggestions.md) | Out-of-the-box ROI features + market research, impact×effort ranked | PROMPT-39 (wave 1 only) |

## Prompt index (`prompts/`)

Self-contained (context, task, files, acceptance). PROMPT-00 conventions still apply, plus
the house rules: every change ships a regression test that fails without it; `scripts/smoke.ts`
extended for every feature (pro + free paths); `tsc` + unit tests before push.

| Prompt | Delivers | Depends on |
|--------|----------|-----------|
| [PROMPT-30](prompts/PROMPT-30-routing-and-navigation.md) | Slug-based `/o/[org]/c/[comp]/d/[div]` console routes, breadcrumbs, back button | — |
| [PROMPT-31](prompts/PROMPT-31-mobile-responsive-overhaul.md) | Mobile pass over every console page + viewport e2e suite | 30 (route names) |
| [PROMPT-32](prompts/PROMPT-32-ui-system-refresh.md) | Card grids, ConfirmDialog, Tips, logo matrix, Business scrub, visibility picker | — |
| [PROMPT-33](prompts/PROMPT-33-scheduling-ux-v3.md) | Multi-division schedule board v3 + division schedule fixes | 31, 32 |
| [PROMPT-34](prompts/PROMPT-34-registration-v2.md) | Registration page v2 + reference numbers | 32 |
| [PROMPT-35](prompts/PROMPT-35-content-and-help.md) | Description editor + `/help` centre + format gallery | 32 (Tips) |
| [PROMPT-36](prompts/PROMPT-36-pricing-packaging-v3.md) | Plan matrix v3, Event Pass, multi-currency, marketing pages, start-funnel | — (touches 32 scrub) |
| [PROMPT-37](prompts/PROMPT-37-admin-and-developer-api.md) | Admin v2 + published API docs + key scopes | — |
| [PROMPT-38](prompts/PROMPT-38-engine-fixes-and-sim.md) | Badminton/cricket fixes, sim-replay v2, division delete | — (do FIRST) |
| [PROMPT-39](prompts/PROMPT-39-roi-quick-wins.md) | Share cards, QR poster, embeds, sponsor slots | 32 |

## Suggested build order

1. **PROMPT-38** — correctness first; badminton/cricket bugs erode trust daily.
2. **PROMPT-32** → **PROMPT-31** — UI primitives, then the mobile pass that uses them.
3. **PROMPT-30** — routing (big churn; land while surface is freshly touched).
4. **PROMPT-33 / 34** — scheduling board + registration (organiser-visible wins).
5. **PROMPT-36** — pricing/packaging + funnel (revenue).
6. **PROMPT-35 / 37 / 39** — help, admin/API, growth quick-wins, any order.
