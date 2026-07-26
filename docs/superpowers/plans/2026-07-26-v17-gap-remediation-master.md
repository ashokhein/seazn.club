# v17 Gap Remediation — Master Plan (index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 19 v17-gap issues (#284–#302) before the first production deploy — 8 wave PRs plus an ops track.

**Architecture:** Sequential wave PRs, each a worktree branch with its own detailed plan file (below). Ops tasks carry no PRs and interleave as scheduled. Spec: `docs/superpowers/specs/2026-07-26-v17-gap-remediation-design.md` (decisions recorded there and on each GitHub issue, 2026-07-26).

**Tech Stack:** Next.js (repo-pinned — read `node_modules/next/dist/docs/` first), Postgres/Flyway, Stripe (test mode until launch), Redis (Upstash), vitest, Playwright.

## Global Constraints

- Waves execute **strictly in order** W1→W8; each assumes all earlier waves merged. Rebase at task boundaries only, never mid-agent.
- One worktree branch per wave (never checkout in the main repo dir); merge via PR only (smoke CI runs on PRs, not main pushes); `/code-review` before every merge; `tsc` + unit green before push.
- Migration numbers are pre-assigned across waves: V336, V337 (W1) · V338 (W2) · V341 (W5). W3/W7/W8 are code/content-only. W4 needs NO migration (there is no `ai_runs` table — runs live as `competition_events` rows; `pack_units` is a JSONB payload key). W6 needs NO migration (org_addons exists since V323). V339/V340/V342 stay unused — do not renumber, do not reuse skipped numbers.
- Every behaviour change ships a regression test that fails without it; user-facing strings in all four locales (en/es/fr/nl), gen-keys + i18n:check clean; help pages same-wave; billing waves run `BILLING_LIVE=1` live suites (30s timeout) + local e2e (prod build, `E2E_PROD_TARGET`, :3100); `scripts/smoke.ts` extended per behaviour; UI light-only (dark only /admin), 375px clean, screenshot-verified; NEVER enable `.github/workflows/e2e.yml`.

---

## Wave plan files (execute in this order)

| # | Plan file | Branch | Issues |
|---|-----------|--------|--------|
| W1 | `2026-07-26-v17-gap-w1-money-leaks.md` | fix/v17gap-w1-money-leaks | #285 #286 |
| W2 | `2026-07-26-v17-gap-w2-resolver-truth.md` | fix/v17gap-w2-resolver-truth | #287 #288 #289 |
| W3 | `2026-07-26-v17-gap-w3-grant-correct.md` | fix/v17gap-w3-grant-correct | #290 #291 #292 |
| W4 | `2026-07-26-v17-gap-w4-credit-economics.md` | feat/v17gap-w4-credit-economics | #295 #296 #297 |
| W5 | `2026-07-26-v17-gap-w5-l-rung.md` | feat/v17gap-w5-l-rung | #294 |
| W6 | `2026-07-26-v17-gap-w6-extra-org.md` | feat/v17gap-w6-extra-org | #293 |
| W7 | `2026-07-26-v17-gap-w7-truth-in-copy.md` | fix/v17gap-w7-truth-in-copy | #298 #299 |
| W8 | `2026-07-26-v17-gap-w8-pass-ux.md` | fix/v17gap-w8-pass-ux | #301 |

Close each wave's issues when its PR merges. #249 closes after W2; #250 after W8.

---

## Ops Task O1: #300 tax verification (run during W1–W3 — accountant latency is external)

**Files:**
- Modify: `stripe-plans.json` (comment block recording account presets; exact path — locate with `rg -l "event_pass" --glob 'stripe-plans.json'`)
- No code ships until the accountant chooses; the chosen code+behavior lands later via the stripe-sync script.

- [ ] **Step 1: List active tax registrations (test mode).**
  Run: `stripe tax registrations list` (or `curl https://api.stripe.com/v1/tax/registrations -u "$STRIPE_SK:"` with sk_test from main repo `.env.local` — never print the key). Record: which jurisdictions, if any. Expected per SPEC-2 §8: none — confirm.
- [ ] **Step 2: Read account tax defaults.**
  Run: `stripe tax settings retrieve` → record `defaults.tax_code` + `defaults.tax_behavior`. This is what every v17 SKU currently inherits.
- [ ] **Step 3: One test-mode purchase per SKU family** (credit pack, size pack, extra seat, subscription plan, event pass) with `expand[]=line_items.data.taxes` on session retrieve; record `taxability_reason` per line. `not_collecting` + no registration = Risk 1 confirmed (silently collecting nothing).
- [ ] **Step 4: Record findings.** Comment the findings table on #300; add the preset code/behavior as a comment block in stripe-plans.json (no functional change; commit `docs(billing): record account tax presets for #300`).
- [ ] **Step 5: Present candidates to the accountant.** Shortlist (do NOT pick): general electronically-supplied services vs SaaS-consumable codes for AI credits; note US taxability question for AI-service consumables and the inclusive-vs-exclusive margin variance on the 52%-modelled pack (#207 linkage). Decision owner: accountant. When chosen: set `tax_code` + `tax_behavior` per SKU in the stripe-sync script (version-controlled), re-run Step 3, close #300.

## Ops Task O2: #284 backfill runbook (settle on staging now; verify at prod deploy)

**Files:**
- Create: `docs/runbooks/pass-credit-backfill.md` (if a deploy runbook already exists for #211, add a section there instead — check `rg -il "runbook|deploy" docs/` first)

- [ ] **Step 1: Staging settle.** On staging DB (disposable data): `npm run backfill:pass-credit-redemptions` dry-run → reconcile row list vs Stripe `pass_credit_intent` session metadata (read #207 before `--write`) → `--write` → re-run dry-run, expect 0.
- [ ] **Step 2: Write the runbook.** Content: what the backfill does (populates V335's `pass_credit_redemptions` cap table from historical redemptions), when it must run (before pass-credit traffic on any env with pre-V335 redemptions), the staging-verified command sequence, and the **prod truth**: prod DB is created at head, so the table is live from day 0 — the prod step is dry-run-expect-0-rows, nothing more. No maintenance window, no feature flag (decided 2026-07-26).
- [ ] **Step 3: Commit runbook** (`docs(runbooks): pass-credit backfill procedure for #284`), comment the staging evidence on #284, add the dry-run-expect-0 line to the #211 deploy checklist, close #284.

## Ops Task O3: #302 hygiene (run LAST, after W8 merges)

- [ ] **Step 1: Verify-and-close shipped work.** #253: confirm V319 caps live; file a new small issue for the dead `requireFeature("officials.roles_multi")` gate at `officials-ai.ts:1035` (remove-or-document — verify line first), then close #253. #243: close pointing at #295/#296 outcomes (W4).
- [ ] **Step 2: Write #248 answers back** (comment): Q1 terminal = {completed, archived} (V328); Q2 grace = 7d (entitlements.ts:105); Q4 = no re-buy (shipped in W8/#301); Q5 = fee frozen at first paid entry (V316; copy fixed in W7/#298); Q6 = no auto-status-write, compute-at-read (SPEC-4 §13.1). Then close #248.
- [ ] **Step 3: Narrow #246** to the open `support.priority` question (retitle + comment).
- [ ] **Step 4: Close #252 as deferred**, noting the staleness-lock alternative (lock on N-days-no-writes, not age) and that #289's now-live analytics (W2) will supply the evidence if it's ever revisited.
- [ ] **Step 5: Close the index.** Confirm #284–#302 all closed, close #283 with a summary comment linking the 8 merged PRs + runbook.

---

## Definition of done (whole program)

All 8 wave PRs merged · all 19 issues + #283 closed · O1 findings with accountant decision recorded (code landed if chosen) · O2 runbook committed with staging evidence · full local e2e + smoke green on main · first prod deploy unblocked per #211 checklist.
