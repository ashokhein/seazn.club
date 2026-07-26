# v17 Gap Remediation — Design

**Date:** 2026-07-26
**Source:** Audit index #283 (children #284–#302, label `v17-gap`)
**Goal:** Close all 19 gap issues before the first production deploy. All bands complete → deploy.
**Shape:** 8 wave PRs (worktree branch each, subagent-driven, review gate per PR) + an ops track with no PRs.

## Decisions (settled 2026-07-26 with owner)

| Issue | Decision |
|-------|----------|
| #284 | No production data exists; prod DB is created at head so V335's table is live from day 0. #284 becomes a runbook verification step (backfill dry-run, expect 0 rows) plus settling the procedure on staging now. No maintenance window, no feature flag. |
| #291 | Decouple the trial grant: while trialing, grant qty = `max(quantity_paid, liveOrgCount)`. #279's billing freeze stays intact and its tests stay green. |
| #293 | Extra-org add-on ships at same-as-tier-2 pricing ($9 Pro / $19 Pro Plus per extra org). **Both Pro and Pro Plus can buy** — exceeding the org cap is a purchase, not an upgrade wall. |
| #294 | Event Pass L rung ships: $59, ∞ entrants, ≤20 divisions, **25 credits** (same grant as M — credit machinery unchanged). Entitlements derived from the M rung so they cannot drift. |
| #295 | Instrument now, weight later: `pack_units` on ai_runs + COGS-vs-sold panel + 2×-median alert. Size-weighted pricing (`1 + floor(packUnits/T)`) ships only when data shows a real leak. |
| #296 | Gate the earn grants on real usage: onboarding +10 and referral +10 pay out only on a published-competition-with-division signal. Monthly 10 on signup stays. Daily earn-volume alerting as backstop. |
| #297 | **Ratify never-expires.** Update SPEC-2 §5.4 + README, record liability treatment. Shipped copy already promises it, so no copy change. |
| #300 | Verify-first: list registrations, record account presets, test-purchase per SKU family reading `taxability_reason`, present candidate `txcd_` codes to the accountant. Code lands via stripe-sync once chosen. |

**Engineering defaults (approved):**

- #287 — broad invalidation: `invalidateOrgEntitlements` on **any** competition write, not just status/ends_on.
- #289 — `live` = started (`published` does not count); narrow `statusChangedTo` to the zod enum type so bogus literals fail tsc.
- #288 — audit all Stripe degrade statuses in one pass: `incomplete` + `unpaid` + `incomplete_expired` → community.
- #290 — no retroactive back-grant for months already missed.
- #286 — undetermined reversal **keeps the cap held**; staff "resolve" control deferred to a phase 2.
- #285 — leaver takes no wallet share on detach; merged earn credits do **not** count toward the group lifetime earn cap.
- #302 — #252 closed as deferred, with a staleness-lock alternative (lock on N-days-no-writes, not age) noted for later.

## Wave order (sequential — waves share files)

| # | Wave | Issues | Order rationale |
|---|------|--------|-----------------|
| W1 | money-leaks | #285 #286 | P0 wallet loss first; both are ledger migrations. W6 also touches attach, so W1 lands before it. |
| W2 | resolver-truth | #287 #288 #289 | #287 unblocks #301 (W8) and closing #249/#250. Ships the Redis-gated CI suite. |
| W3 | grant-correct | #290 #291 #292 | All in lib/credits.ts; #290+#291 are the same function — one sweep rework. |
| W4 | credit-economics | #295 #296 #297 | Instrument + farm-gate + ratify docs. |
| W5 | L-rung | #294 | Before W7 so the copy pass covers the L description. |
| W6 | extra-org add-on | #293 | Biggest build; after W1 (attach) and W5 (stripe-plans.json conflicts). |
| W7 | truth-in-copy | #298 #299 | Last copy pass reflects final packaging; ships guard tests. |
| W8 | pass-UX | #301 | Depends on #287 (W2). |

## Per-wave design

### W1 — money-leaks (#285, #286)

- **#285** Wallet merge inside the `attachOrgToGroup` transaction (usecases/billing-groups.ts:680): two compensating ledger rows (−balance old wallet / +balance group wallet), bucket-preserving (grant vs pack), new `source` enum value via migration (V330/V331 pattern), advisory locks on both wallets taken in sorted order. Detach writes an audit marker row. One-off reconciliation script for already-stranded wallets (staging only — no prod data). Re-keying the ledger was rejected (breaks append-only).
- **#286** New `reversal_undetermined_at` state in `reversePassCreditOnRefund` (server/usecases/pass-credit.ts:499): when `otherCreditActivitySince()` says `unsafe`, mark undetermined instead of `reversed_at` — the V335 partial-index cap stays held, no re-mint possible. Index predicate updated in the same migration. Alert on undetermined rows.
- **Tests:** attach-with-balance round-trip; bucket preservation; unsafe reversal keeps cap held; second mint refused while undetermined.

### W2 — resolver-truth (#287, #288, #289)

- **#287** `invalidateOrgEntitlements(auth.orgId)` on any competition write in `patchCompetition` (usecases/competitions.ts:212 — plan-verified name; the audit digest said "updateCompetition"); pass-refund path audited during planning: already correct (lib/billing.ts:819,881), W2 documents it with a proof test. scripts/smoke.ts:1839-1855 carries a manual `bustOrgEntitlements` workaround for this exact bug — W2 removes it so smoke can catch regressions. Real deliverable: a Redis-gated suite (usecase-only seeding → warm cache → mutate via updateCompetition → assert the lock fires) with its own CI step alongside the rate-limiter step (ci.yml:227 scopes REDIS_URL to one step today — this class of defect is structurally invisible until this lands).
- **#288** V338 copies `org_has_feature` (V334) forward adding the `incomplete` → community arm. Plan-time status audit found `STATUS_MAP` (lib/billing.ts:404-416) collapses `unpaid`→`past_due` and `incomplete_expired`→`canceled` at write time — those literals never reach `subscriptions.status`, so only the one arm is needed; W2 ships tests proving the other two are non-issues. Two new parity cases: incomplete sub, suspended org.
- **#289** competitions.ts:312-314 compares to `"live"`/`"completed"`; `statusChangedTo` typed as `z.infer<typeof CompetitionStatus> | null`.
- **Smoke:** lock path added to scripts/smoke.ts.

### W3 — grant-correct (#290, #291, #292)

One rework of the grant sweep (lib/credits.ts:314-324):

- **#290** Grant on the **resolved** plan (`orgPlanKey`, entitlements.ts:169) instead of the raw status filter — churned orgs get Community 10/mo, all statuses fixed at once. Qty = 1 for community, `quantity_paid` otherwise (subject to the #291 trial branch). Keep the live-org guard; pick the grant org via `groupOrgLimit`'s selection rule (lib/billing-group.ts:155-164). Accept N+1 until measured; never hand-copy the SQL CASE.
- **#291** Trial branch: qty = `max(quantity_paid, liveOrgCount)`. #279 tests stay green.
- **#292** `date_trunc('month', (now() at time zone 'utc'))` in `spentThisPeriodByOrg` (credits.ts:819); extract a shared period-boundary helper; grep other `date_trunc(now())`/`current_date` money reads. Test forces `set local time zone 'Europe/London'` at 23:30 UTC month-end (V334 parity-test pattern).

### W4 — credit-economics (#295, #296, #297)

- **#295** `pack_units` recorded per AI run (plan-verified: no `ai_runs` table exists — runs are `competition_events` rows, so it's a JSONB payload key, no migration); credits-sold-vs-COGS panel on /admin/revenue (two independent aggregates — ledger and run audit share no join key); staff-email alert at ≥2× trailing-median run cost, reusing the existing `STAFF_ALERT_EMAIL` pattern.
- **#296** Move the onboarding-earn (credits.ts:533) and referral-welcome (credits.ts:540) call sites behind a published-competition-with-division signal (grants already idempotent per (reason, ref)). Daily earn_grant volume alert; day-0 spend signature noted for the panel. Check whether email verification already gates org creation first.
- **#297** SPEC-2 §5.4 + README updated to record never-expires and the liability treatment. Help copy already correct.

### W5 — L-rung (#294)

Migration seeds `event_pass_l` into plans + plan_entitlements **derived from the M rung** (differences only: ∞ entrants, ≤20 divisions). $59 price in stripe-plans.json (per-currency). `pass_key` threaded through pass-checkout → session metadata → webhook. Two-option purchase modal leads with the entrant/division difference — no "best value" label. Lock/credit/refund machinery is rung-agnostic already; regression tests prove it (lock fires on L, +25 credit grant, refund clawback).

### W6 — extra-org add-on (#293)

`extra_org` recurring price ($9/$19 per currency, lookup_key). Reuse the extra-seat machinery wholesale (lib/seat-addons.ts + billing-events `syncSeatAddonsForSubscription`); the webhook is the single writer of the org_addons row with `feature_key='orgs.max_owned'`. Route `groupOrgLimit`'s degenerate branch (lib/billing-group.ts:171-177) through the resolver. Add-ons tab entry + purchase offer in the `assertWithinGroupCap` 402 body. Both Pro and Pro Plus eligible. BILLING_LIVE suite + smoke purchase path.

### W7 — truth-in-copy (#298, #299)

- **#298** Fix stripe-plans.json:110 (dead run caps, 64→128 entrants, +25 credits unmentioned) and :59 (AI scheduling is on every tier); event-pass.md:20/57/71 dead caps; :39 fee sentence corrected for V316 fee-freeze. Run stripe:sync and verify rendered Checkout. Fix SPEC-1 §5 spec-side (branding marked ✅ wrongly). **Guard tests:** quoted numbers pinned against plan_entitlements; any customer surface naming a retired feature_key fails.
- **#299** Write help/billing/add-ons.md — what/scope split (credits group-wide, seats per-org, size packs per-competition, extra-org per-group from W6), billing shape, who pays, lapse = freeze-not-delete, currency lock, cross-links; register in the help-slug registry. Add the lifetime-cap sentence to groups.md:149. Prices link /pricing, never hardcoded.
- e2e text grep before merge (UI-text-breaks-e2e rule).

### W8 — pass-UX (#301)

Thread the existing `isPassLocked` predicate (billing-manage.ts:411 — no second copy) into competition-pass-entry.tsx. Three states: eligible / live / ended. Ended names the reason (terminal status vs past ends_on), leads with data-not-deleted, offers "Create next year's edition" + Go Pro. pass-checkout/route.ts:69 keeps the no-re-buy refusal but the sentence tells the truth. Sweep billing-pass-offer.tsx + upgrade page for the same row-exists assumption. Guard test that nothing copies competition_passes. Records #248 Q4 = no re-buy; copy-competition feature explicitly out of scope.

## Ops track (no PRs)

1. **Now (post-spec):** write the settled decisions back onto #284, #291, #293, #294, #295, #296, #297, #300 and the defaults onto #285, #286, #287, #288, #289, #290, #302 as issue comments.
2. **During W1–W3:** #300 verify checklist (accountant latency is external — start early). Registrations list, preset recording, one test-mode purchase per SKU family with `expand[]=line_items.data.taxes`, read `taxability_reason` before concluding. Candidate codes → accountant.
3. **Before deploy:** #284 runbook step in the deploy plan (#211): backfill dry-run, expect 0 rows in prod; settle the full procedure on staging while data is disposable.
4. **Last:** #302 hygiene — verify+close #253 (note the dead `requireFeature("officials.roles_multi")` gate at officials-ai.ts:1035) and #243 (pointing at #295/#296); narrow #246 to the `support.priority` question; write #248 Q1/Q2/Q5/Q6 answers back; close #252 as deferred; #249/#250 close after W2/W8 land.

## Standing acceptance rules (every wave)

- Regression test that fails without the change.
- New/changed user-facing strings in all four locales (en/es/fr/nl); gen-keys + i18n:check clean. (Applies to UI dictionary strings — plan-verified that the help content tree `apps/web/content/help/` is a single-locale English tree with no `[lang]` nesting.)
- UI designed with the frontend-design skill; screenshot-verified light+dark; clean at 375px, no horizontal page scroll.
- Help pages are a closing pass in the same wave, not a follow-up.
- Billing waves (W1, W4, W5, W6) run `BILLING_LIVE=1` live suites vs test-mode Stripe (30s timeout) plus e2e against a prod build.
- scripts/smoke.ts extended for behaviour changes (W2 lock path, W5/W6 purchase paths).
- `/code-review` on every branch before merge.

## Error handling notes

- W1 merge math must be exact: sum of compensating rows nets to zero per bucket; property-style test over random balances.
- W2 invalidation is fail-open by design (cache TTL 300s bounds staleness if the invalidate call ever fails) — do not make competition writes fail on Redis errors.
- W6 webhook writer must be idempotent per subscription-item quantity (extra-seat machinery already is — keep that property).

## Out of scope

- #266 auto-topup (owner hold — off-session Stripe).
- Size-weighted run pricing (#295 opt 1) — ships only if instrumentation shows a leak.
- Staff resolve control for undetermined reversals (#286 phase 2).
- Copy-competition feature (#301 guard test only).
- DB session TZ pinned to UTC globally (#292 — own issue later).
