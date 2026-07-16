# Scoring-vocab + payments-console i18n — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans to implement task-by-task. Steps use `- [ ]`.

**Goal:** Localize the remaining English domain vocab (sport names, wicket/extra kinds, card colours, brand swatches) and two hardcoded console sub-components (payments-instructions card + shared prose-editor toolbar) into en/fr/es/nl.

**Architecture:** Display-only lookups over unchanged stored enums. Closed-enum vocab uses typed `Record<Enum, MessageKey>` maps in a new `lib/scoring-vocab.ts` + `useMsg`/`msgFor`. Chrome components convert hardcoded JSX to `useMsg()`. New keys land flat in `dictionaries/en/ui.json`, filled fr/es/nl by the translate pipeline.

**Tech Stack:** Next 16, React client islands, `lib/messages` (`msg`/`useMsg`/`msgFor`), `dict-provider`, `scripts/i18n/*`.

## Global Constraints

- Locales: en/fr/es/nl. Keys flat dot-notation in `dictionaries/en/ui.json`.
- Dynamic vocab keys are FORBIDDEN — use typed `Record<Enum, MessageKey>` maps + `useMsg`/`msgFor` (never `useT` for these).
- Stored enums untouched (DB `sport_key`, event payloads, palette hex→name).
- Activity feed (`describeEvent`) OUT OF SCOPE.
- After adding en keys: `npm run i18n:gen-keys` (regens `MessageKey` union), then `npm run i18n:translate`, then `npm run i18n:check` (hard-fails on drift).
- Every change ships a regression test (house rule). Dev server: `rtk proxy npx next dev` from `apps/web`.
- Commit after each task.

---

### Task 1: `scoring-vocab.ts` helpers + en keys

**Files:**
- Create: `apps/web/src/lib/scoring-vocab.ts`
- Modify: `apps/web/src/dictionaries/en/ui.json` (+37 keys)
- Test: `apps/web/src/lib/__tests__/scoring-vocab.test.ts`

**Produces:** `sportLabel(k, m)`, `wicketLabel(k, m)`, `extraLabel(k, m)`, `cardLabel(c, m)`, `swatchLabel(hex, m)` where `m: (key: MessageKey)=>string`; types `WicketKind`, `ExtraKind`, `CardColour`, `SportKey`.

- [ ] **Step 1:** Add en keys to `dictionaries/en/ui.json` (flat): `sport.badminton`="Badminton", `sport.boardgame`="Board game", `sport.carrom`="Carrom", `sport.cricket`="Cricket", `sport.football`="Football", `sport.generic`="Generic", `sport.hockey`="Hockey", `sport.icehockey`="Ice hockey", `sport.tabletennis`="Table tennis", `sport.tennis`="Tennis", `sport.volleyball`="Volleyball"; `wicket.bowled`="Bowled", `wicket.caught`="Caught", `wicket.lbw`="LBW", `wicket.runout`="Run out", `wicket.stumped`="Stumped", `wicket.hitwicket`="Hit wicket", `wicket.retired`="Retired", `wicket.obstructed`="Obstructing the field", `wicket.timedout`="Timed out"; `extra.wide`="Wide", `extra.noball`="No-ball", `extra.bye`="Bye", `extra.legbye`="Leg bye", `extra.penalty`="Penalty"; `card.yellow`="Yellow", `card.red`="Red"; `swatch.Teal`="Teal", `swatch.Ocean`="Ocean", `swatch.Cobalt`="Cobalt", `swatch.Midnight`="Midnight", `swatch.Forest`="Forest", `swatch.Ember`="Ember", `swatch.Bronze`="Bronze", `swatch.Crimson`="Crimson", `swatch.Magenta`="Magenta", `swatch.Graphite`="Graphite". Run `npm run i18n:gen-keys`.
- [ ] **Step 2:** Write `scoring-vocab.ts` exactly as the spec's code block (typed maps + helpers).
- [ ] **Step 3:** Write test: build a stub `m = (k)=>`«${k}»`; assert `wicketLabel("bowled", m)`==="«wicket.bowled»", `extraLabel`, `cardLabel`, `sportLabel` similar; unknown `sportLabel("kabaddi", m)`==="Kabaddi" (title-case fallback); `swatchLabel("#0f766e", m)`==="«swatch.Teal»"; `swatchLabel(null, m)`===null. Exhaustiveness: import `WICKET_KINDS`/`EXTRA_KINDS` from cricket-pad… (they're not exported) — instead iterate the four maps' keys via a re-export `export const SCORING_VOCAB_KEYS` from scoring-vocab and assert each resolves through `m` without hitting fallback. Add that export.
- [ ] **Step 4:** `cd apps/web && npx vitest run src/lib/__tests__/scoring-vocab.test.ts` → PASS. `npx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(i18n): scoring-vocab typed-map label helpers + en keys`.

---

### Task 2: Cricket pad wicket/extra dropdowns

**Files:**
- Modify: `apps/web/src/components/v2/pads/cricket-pad.tsx` (render at :414 extras, :442 wicket)
- Test: `apps/web/src/components/v2/pads/__tests__/cricket-pad-i18n.test.tsx` (create)

**Consumes:** `wicketLabel`, `extraLabel` from Task 1.

- [ ] **Step 1:** Test: render `CricketPad` (minimal props, over-by-over open) inside a `fr` `<DictProvider dict={frUi}>`; assert an option reads "Run out" localized token (fr) and no raw `bowled`. (Load fr ui.json.)
- [ ] **Step 2:** Run → FAIL (renders raw `bowled`).
- [ ] **Step 3:** In cricket-pad add `const m = useMsg();` (import from `@/components/i18n/dict-provider`). Change extras option `{k}`→`{extraLabel(k, m)}` (:414-area), wicket option `W: {k}`→`W: {wicketLabel(k, m)}` (:442).
- [ ] **Step 4:** Run test → PASS; existing `device-score-pad.test` still PASS; tsc 0.
- [ ] **Step 5:** Commit `feat(i18n): localize cricket pad wicket/extra kinds`.

---

### Task 3: Football + period pad card colours

**Files:**
- Modify: `apps/web/src/components/v2/pads/football-pad.tsx` (yellow/red buttons ~:191-200)
- Modify: `apps/web/src/components/v2/pads/period-pad.tsx` (`classLabel` :58 / card display)
- Test: `apps/web/src/components/v2/pads/__tests__/football-pad-i18n.test.tsx`

**Consumes:** `cardLabel` from Task 1.

- [ ] **Step 1:** Test: render `FootballPad` under fr DictProvider; assert card button shows fr `card.yellow` token, not "Yellow"/"yellow".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** football-pad: `const m = useMsg();` add localized visible label to yellow/red buttons via `cardLabel("yellow", m)` / `cardLabel("red", m)` (keep `action` state values English). period-pad: where a card colour renders a human label, wrap with `cardLabel(key, m)` (leave `classKey` values untouched).
- [ ] **Step 4:** Run → PASS; tsc 0; existing pad tests PASS.
- [ ] **Step 5:** Commit `feat(i18n): localize football/period card colours`.

---

### Task 4: Sport name on public surfaces + OG

**Files:**
- Modify: `apps/web/src/app/[lang]/(marketing)/discover/page.tsx` + `discover/[sport]/page.tsx` (filter chips)
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx` (+ div/fixture pages where sport renders)
- Modify OG: `apps/web/src/app/(public)/shared/**/opengraph-image.tsx`, `apps/web/src/app/(public)/r/[ref]/ticket.png/route.tsx` (sport + card)
- Test: `apps/web/src/lib/__tests__/scoring-vocab-public.test.ts` (asserts helper output; render-level covered by existing page tests if any)

**Consumes:** `sportLabel`, `cardLabel`, server `msgFor(locale, key)`.

- [ ] **Step 1:** Test: `sportLabel("boardgame", (k)=>msgFor("fr", k))` !== "Board game" and equals the fr ui value; `sportLabel("generic", fr)` localized.
- [ ] **Step 2:** Run → currently sport chips hardcode the raw key/`SPORT_META` english; confirm test drives the helper (green once helper exists — this test guards regressions of the wiring).
- [ ] **Step 3:** In discover chips + shared pages, replace the English sport label expression with `sportLabel(sportKey, (k)=>t(dict,k))` (server; the page already loads its dict) — or `msgFor(locale, …)` where no dict in scope. In OG routes, resolve the fixture/org locale and pass `sportLabel`/`cardLabel` via `msgFor`. Keep the emoji (data).
- [ ] **Step 4:** tsc 0; `npm run build`-free check via `npx tsc`; run any existing discover/shared page tests → PASS.
- [ ] **Step 5:** Commit `feat(i18n): localize sport names on discover + shared pages + OG`.

---

### Task 5: Swatch picker + console sport-name callers

**Files:**
- Modify: `apps/web/src/components/brand-color-picker.tsx` (swatch name)
- Modify: `apps/web/src/components/v2/division-builder.tsx`, `start-funnel-form.tsx`, `onboarding-wizard.tsx` (sport name where shown as label)
- Test: `apps/web/src/components/__tests__/brand-color-picker-i18n.test.tsx`

**Consumes:** `swatchLabel`, `sportLabel`.

- [ ] **Step 1:** Test: render `BrandColorPicker` under fr; assert a swatch's visible/aria name uses `swatch.Teal` fr token.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** brand-color-picker: `const m = useMsg()`; replace `swatchName(hex)`/`s.name` display with `swatchLabel(hex, m)` (aria-label + any visible text). In division-builder/funnel/onboarding, where the sport option renders its English name as a user label (not the query value), wrap with `sportLabel(key, useMsg())`; keep the value/query token as the raw key.
- [ ] **Step 4:** tsc 0; test PASS; existing brand-palette tests PASS.
- [ ] **Step 5:** Commit `feat(i18n): localize brand swatch names + console sport labels`.

---

### Task 6: `prose-editor.tsx` toolbar

**Files:**
- Modify: `apps/web/src/components/prose-editor.tsx`
- Modify: `apps/web/src/dictionaries/en/ui.json` (+~20 `editor.*` keys)
- Test: `apps/web/src/components/__tests__/prose-editor-i18n.test.tsx`

- [ ] **Step 1:** Add en keys: `editor.mode`="Editor mode", `editor.write`="Write", `editor.preview`="Preview", `editor.charsLeft`="{n} left", `editor.heading`="Heading", `editor.subheading`="Subheading", `editor.bold`="Bold", `editor.italic`="Italic", `editor.link`="Link", `editor.bulletList`="Bullet list", `editor.numberedList`="Numbered list", `editor.quote`="Quote", `editor.divider`="Divider", `editor.image`="Image (up to 2 MB)", `editor.cta`="Sponsor / call-to-action button", `editor.description`="Description", `editor.nothingPreview`="Nothing to preview yet.", `editor.linkUrl`="Link URL", `editor.buttonLabel`="Button label", `editor.buttonLink`="Button link (https://…)", `editor.registerNow`="Register now", `editor.imageTooLarge`="Images can be up to 2 MB.", `editor.uploadFailed`="Upload failed", `editor.uploadNotAllowed`="Upload not allowed". Run `i18n:gen-keys`.
- [ ] **Step 2:** Test: render `ProseEditor` under fr DictProvider (stub `orgId`, `value=""`, `onChange`); assert toolbar button "Bold" title uses fr token; tab "Write"/"Preview" localized.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** In prose-editor add `const m = useMsg()`. Replace every hardcoded string above (toolbar `label=`, tabs `["write", m("editor.write")…]`, `{remaining} left`→`m("editor.charsLeft",{n:remaining.toLocaleString()})`, aria default, prompts, upload errors, "Nothing to preview yet."). Keep icons + markdown grammar untouched.
- [ ] **Step 5:** Run test → PASS; tsc 0; existing marketing-shell/editor tests PASS.
- [ ] **Step 6:** Commit `feat(i18n): localize shared prose-editor toolbar`.

---

### Task 7: `org-payment-instructions.tsx`

**Files:**
- Modify: `apps/web/src/components/org-payment-instructions.tsx`
- Modify: `apps/web/src/dictionaries/en/ui.json` (+~22 `pay.*` keys)
- Test: `apps/web/src/components/__tests__/org-payment-instructions-i18n.test.tsx`

- [ ] **Step 1:** Add en keys (`pay.cardTitle`, `pay.cardBlurb`, `pay.statusLive`, `pay.statusIncomplete`, `pay.statusNone`, `pay.stepConnect`/`.stepConnectDetail`, `pay.stepVerify`/`.stepVerifyDetail`, `pay.stepGoLive`/`.stepGoLiveDetail`, `pay.tosAgree` (with `{terms}` token like LegalNotice pattern), `pay.tosTerms`, `pay.opening`, `pay.resume`, `pay.connect`, `pay.needPro`, `pay.onboardErr`, `pay.methodLegend`, `pay.methodHint`, `pay.methodOffline`, `pay.methodStripe`, `pay.cashTitle`, `pay.cashHint` (with `{reference}` literal preserved), `pay.saving`, `pay.save`, `pay.saved`, `pay.saveFailed`) copying the English verbatim from the component. Run `i18n:gen-keys`.
- [ ] **Step 2:** Test: render `OrgPaymentInstructions` (isOwner, connect=null) under fr; assert "Card payments (Stripe)" is GONE and the fr `pay.cardTitle` token shows; "Save" localized.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** `const m = useMsg()`. Replace every hardcoded string. The three `steps` array entries → key refs resolved at render (`label: m("pay.stepConnect")`, `detail: m("pay.stepConnectDetail")`). Radio labels, legend, hint, cash title/hint (keep `{{reference}}` code literal), buttons, errors. ToS sentence: use `{terms}` token interpolation so word order survives translation (mirror `LegalNotice`).
- [ ] **Step 5:** Run test → PASS; tsc 0.
- [ ] **Step 6:** Commit `feat(i18n): localize org payments-instructions console card`.

---

### Task 8: Translate + parity + smoke + help + live-verify

**Files:**
- Modify: `dictionaries/{fr,es,nl}/ui.json` (pipeline output)
- Modify: `scripts/smoke.ts`, `content/help/sharing/languages.md`

- [ ] **Step 1:** `cd <repo> && npm run i18n:translate` (chunked; ANTHROPIC key in `apps/web/.env.local`). Then `npm run i18n:check` → parity OK all three.
- [ ] **Step 2:** Extend `scripts/smoke.ts`: assert a fr console/public surface shows a localized sport name (e.g. `/fr/discover` body contains the fr `sport.boardgame` value, not "Board game").
- [ ] **Step 3:** Update `content/help/sharing/languages.md` — add "Scoring vocabulary & payments" note.
- [ ] **Step 4:** Full gate: `npx tsc --noEmit` 0; `cd apps/web && npx vitest run` all pass; `npm run smoke` (or the smoke invocation) pass.
- [ ] **Step 5:** Live-verify on running dev: `/fr/discover` chips show "Jeu de société"/localized Generic; `/fr/…/settings/payments` fully French (payments card + editor toolbar); English originals ABSENT.
- [ ] **Step 6:** Commit `feat(i18n): translate fr/es/nl + smoke + help for scoring vocab & payments`.

---

## Self-review notes
- Spec coverage: sport (T4,T5), wicket/extra (T2), card (T3,T4), swatch (T5), payments card (T7), prose-editor (T6), pipeline/tests/help (T8). All covered.
- describeEvent intentionally absent (out of scope).
- Type consistency: `m: (key: MessageKey)=>string` used identically across helpers + callers; `useMsg()` returns exactly that.
