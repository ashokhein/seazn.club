# v3/00 — Intake Backlog (founder list, 9 Jul 2026)

All 31 items verbatim (lightly normalised), mapped to the v3 design doc that owns each.
Nothing dropped. Style mirrors `engine/Jul3/00-idea-backlog.md`.

| # | Item (verbatim intent) | Owner doc | Notes |
|---|------------------------|-----------|-------|
| 1 | Fix Org Setting mobile view | [02](02-mobile-responsive-overhaul.md) §3.1 | settings/page.tsx is a 427-line desktop table layout |
| 2 | Fix all mobile views | [02](02-mobile-responsive-overhaul.md) | full audit + patterns + viewport e2e gate |
| 3 | Fix payment detail view | [02](02-mobile-responsive-overhaul.md) §3.2 | settings/billing: invoices table, checkout iframe width |
| 4 | Routing should be org/comp/div format | [01](01-routing-and-navigation.md) | today: flat `/competitions/[id]`, `/divisions/[id]` |
| 5 | Remove Business refs in UI | [03](03-ui-system-refresh.md) §6 | plan-badge.tsx, settings/page.tsx, api-keys.tsx; keep hidden DB plan |
| 6 | Publish OpenAPI; restrict developer keys; docs | [08](08-admin-and-developer-api.md) §2–3 | `/api/v1/openapi.json` exists (1.1 MB, uncurated), no docs UI, keys unscoped |
| 7 | Reorganise Free/Pro features (comps/divisions/dashboards/orgs) | [07](07-pricing-packaging-v3.md) §2 | current: 2 comps, 3 members, 16 entrants/div, 1 dashboard |
| 8 | Allow deleting a Division? | [09](09-engine-fixes-and-sim.md) §4 | no DELETE endpoint exists today; needs safe-destructive design |
| 9 | Where to display org / club / team logo? | [03](03-ui-system-refresh.md) §5 | team logo does not exist yet; club badge fallback does (`team_display_v`) |
| 10 | Update marketing pages (home, pricing) | [07](07-pricing-packaging-v3.md) §5 | |
| 11 | Convert comp/division grid to cards | [03](03-ui-system-refresh.md) §2 | |
| 12 | Back button on every page (simple icon) | [01](01-routing-and-navigation.md) §4 | |
| 13 | Schedule board ugly at 5+ divisions | [04](04-scheduling-ux-v3.md) §2 | |
| 14 | Division schedule page: lots to fix | [04](04-scheduling-ux-v3.md) §3 | enumerated fix list |
| 15 | Per-event price, metered (2 comps / 10 divisions / 16 rosters) | [07](07-pricing-packaging-v3.md) §3 | market-validated: Tournify €40/€120 single-use upgrades |
| 16 | Do non-technical users understand unlisted vs public? | [03](03-ui-system-refresh.md) §7 | plain-language visibility picker |
| 17 | Add tips in lots of places | [03](03-ui-system-refresh.md) §4 | Tips framework + content registry |
| 18 | Good editor on competition page incl. preview | [06](06-content-editor-and-help.md) §2 | |
| 19 | Redesign public registration page + generate ref number | [05](05-registration-v2.md) | |
| 20 | Registration custom fields render below save button | [05](05-registration-v2.md) §3 | form-order bug, part of redesign |
| 21 | Mind-mapping for fixture formats | [06](06-content-editor-and-help.md) §4 | format gallery with flow diagrams |
| 22 | Supporting document per feature/flow (free tool ok) | [06](06-content-editor-and-help.md) §3 | recommendation: in-repo `/help` MDX, no external tool |
| 23 | Fixture-format generation example incl. mind map | [06](06-content-editor-and-help.md) §4 | same surface as #21 |
| 24 | "Start competition" CTA on marketing page → magic link → auto-onboard with pre-filled details | [07](07-pricing-packaging-v3.md) §6 | the v3 growth funnel |
| 25 | Multi-currency support + annual offer | [07](07-pricing-packaging-v3.md) §4 | Stripe `currency_options`; annual = 2 months free, surface it |
| 26 | Admin route: coupons (exists), extend trial, upgrade/downgrade orgs | [08](08-admin-and-developer-api.md) §1 | |
| 27 | Update the deep simulation replay | [09](09-engine-fixes-and-sim.md) §3 | `packages/engine/scripts/sim-replay.ts` predates Jul3 features |
| 28 | Badminton scoring: chosen score not reflected in top score; set-cap rule (win-by-2, cap) | [09](09-engine-fixes-and-sim.md) §1 | BWF: 21, win-by-2, 30-cap (the "tennis 45" analogy) |
| 29 | Cricket: "undo last" made scoring disappear | [09](09-engine-fixes-and-sim.md) §2 | fold/replay regression on compensating event |
| 30 | Don't use default alert/confirm; modal confirmation | [03](03-ui-system-refresh.md) §3 | 8 files call `confirm()` today |
| 31 | (implied by ask) Deep-dive, out-of-the-box ROI features + suggestions | [10](10-roi-features-and-suggestions.md) | ranked impact × effort |

## Cluster summary

- **Fix trust** (28, 29, 27, 8): engine correctness + safe deletes → PROMPT-38.
- **Fix the shell** (1–3, 11–14, 12, 30, 17, 16, 9, 5): mobile + UI system + navigation → PROMPT-30/31/32/33.
- **Fix the funnel** (7, 10, 15, 24, 25, 19, 20): packaging, marketing, registration → PROMPT-34/36.
- **Explain the product** (18, 21–23): editor + help + format gallery → PROMPT-35.
- **Operate & open up** (26, 6): admin v2 + developer API → PROMPT-37.
- **Grow** (31): ROI backlog → PROMPT-39 wave 1.
