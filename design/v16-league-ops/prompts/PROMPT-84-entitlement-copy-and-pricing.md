# PROMPT-84 — Wave closing: entitlement copy, pricing page, help index

**Goal:** the three new Pro entitlements this wave ships —
`discipline.enforced`, `officials.marks`, `news.auto` — become visible and
sellable: upgrade-moment copy in `feature-copy.ts`, pricing-page feature
rows (4-locale), the plans help article updated, and a cross-check that all
three feature help articles landed with clean slug registry.

**Read first:**
- `apps/web/src/lib/feature-copy.ts` — `FEATURE_REASONS` map +
  `featurePlan()`; the 402 handlers and `<UpgradeGate>`/PlusReveal read this
  copy. A missing key falls back to generic copy — that is the bug this
  prompt fixes.
- `apps/web/src/app/[lang]/(marketing)/pricing/page.tsx` +
  `FREE_FEATURES`/`PASS_FEATURES`/`PRO_FEATURES`/`PLUS_CARD_FEATURES`
  (imported at the top — follow to their definition module) — hardcoded,
  i18n'd lists; NOT derived from `plan_entitlements`.
- `apps/web/src/dictionaries/en/marketing.json` — pricing feature strings +
  the parity gate (en/fr/es/nl).
- The billing/plans help article under `apps/web/content/help/billing/` — 
  where "what's in each plan" lives.
- `apps/web/src/lib/help.ts` `HELP_ARTICLE_SLUGS` + `help-content.test.ts`.

**Depends:** PROMPT-79, 81, 83 merged (the features and their help articles
exist). **No migrations.**

## Scope

1. **`feature-copy.ts`** — add all three keys:
   - `"discipline.enforced"`: "Automatic suspension tracking is a Pro feature."
   - `"officials.marks"`: "Rating your match officials is a Pro feature."
   - `"news.auto"`: "Auto-drafted result posts are a Pro feature."
   `featurePlan()` returns `"pro"` for all three (they seed true on pro AND
   pro_plus; the plan label names the cheapest plan that unlocks). Match the
   file's existing copy voice exactly (short, "…is a Pro feature." /
   "…needs a bigger plan." patterns).
2. **Pricing page** — add to `PRO_FEATURES` (and Pro Plus inherits via
   "Everything in Pro" — verify PLUS_CARD_FEATURES pinning comment before
   touching it): three rows — suspensions & discipline, official ratings,
   auto-drafted news posts. New dictionary keys in all four locales; run the
   parity test. Review every existing pricing-page claim against the new
   matrix (nothing this wave changes limits, so expect copy-add only).
3. **Plans help article** — add the three features to the Pro list in the
   billing/plans article, same voice as its existing rows.
4. **Cross-check (verification step, no new content expected):** the three
   feature articles from 79/81/83 exist
   (`divisions/discipline.md`, the officials marking + portal-report
   updates, `sharing/news.md`), `HELP_ARTICLE_SLUGS` is
   bidirectional-clean, and `help-content.test.ts` passes. If any are
   missing, STOP and report BLOCKED naming the gap — the fix belongs to
   that feature's task, not here.
5. **Smoke** — extend the pricing/marketing check (if `scripts/smoke.ts`
   asserts pricing content, add one new-feature string; if it doesn't,
   skip — do not invent a new smoke section for static marketing copy).

## Out of scope

- No entitlement seeds or migrations (the three keys were seeded in
  V292/V293/V294 by their feature tasks).
- No SPEC-4 / team-scale copy (deferred).
- No /start funnel or feature-page marketing beyond the pricing page.

## Build steps

- [ ] **Step 1 — Failing tests first.** If `feature-copy` has a test file,
  add cases: `featureReason("discipline.enforced")` returns the exact
  string above (same for the other two), `featurePlan` returns `"pro"`.
  If no test file exists, create one covering exactly these six
  assertions. Run: FAIL.
- [ ] **Step 2 — Implement copy map entries.** PASS.
- [ ] **Step 3 — Pricing rows + dictionaries.** Add the three rows + keys,
  fill en/fr/es/nl. Run the marketing parity test: PASS.
- [ ] **Step 4 — Help article update + cross-check** per Scope 3–4. Run
  `help-content.test.ts`: PASS.
- [ ] **Step 5 — Screenshot-verify** the pricing page (390×844 + desktop):
  three new rows render on the Pro card in en + one other locale.
- [ ] **Step 6 — Verify + commit.** `tsc` + touched suites. Commit:
  `feat(pricing): surface v16 entitlements — discipline, marks, auto news drafts`.
