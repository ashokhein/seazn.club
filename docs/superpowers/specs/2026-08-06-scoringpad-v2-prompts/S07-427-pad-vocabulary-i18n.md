# S7 — #427: pad vocabulary + i18n for W4's new events and enums

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(S4's label keys, S6's label-key convention), then this. Web + dictionaries,
almost no engine.

Branch `feat/s7-pad-vocabulary-i18n` in a fresh worktree. One PR. Issue #427.

## Why

**This is the single largest thing standing between W4's schemas and a pad a
scorer can actually use — and it is not an engine change.**

W4 added roughly 14 new event types and 6 enums across all 11 sports. Not one has
a label. `apps/web/src/lib/scoring-vocab.ts` humanises unknown values, so nothing
breaks and nothing shows correctly either: a cricket dismissal renders as
**"Hitballtwice"**, football's new card reasons and penalty outcomes read as raw
snake_case, and tennis's `default` sanction level — as the dossier notes —
"reads badly unlabelled".

Every dossier flagged it in the same words: "the humanising fallback will render
it … until a label is added (and translated into all four dictionaries)".

Running this **after** S3/S4/S6 is deliberate: those sessions add more enums, and
labelling twice across four locales is the waste this ordering avoids.

## Owed, by sport (from the dossiers — do not re-derive)

- **cricket** — `cricket.retire`, `.newball`, `.powerplay`, `.review`;
  `hitballtwice`; `wicket.fielderAssist`, `wicket.incoming`; `Cfg.reviews.perInnings`
- **football** — `football.penalty`, `football.sinbin`; `CardReason` (13 members);
  `PenaltyOutcome`
- **hockey / icehockey** — `<key>.set_piece`; prompts for goal `emptyNet` and
  `clockRef`, suspension `reason`/`minutes`/`servedBy`, shoot-out `goalkeeper`
- **tennis** — `tennis.sanction`, `NestedSanctionLevel`
- **volleyball / badminton / tabletennis** — `<key>.timeout`, `.sanction`,
  `.sub`, `SetBasedSanctionLevel`, `rally.server`, `rally.scorer`
- **boardgame** — `boardgame.pairing` + 4 new `method` members (repetition,
  fifty-move, dead position, illegal move)
- **carrom** — per-board player pickers
- **generic** — `generic.score`, "the one screen that makes an unmodelled sport
  scoreable live"

**Plus** everything S3, S4 and S6 added since #427 was written — read their
entries in `_INDEX.md` and label those too. Also #431 item 8 (generic's two loose
ends): `generic.score.points` collides in name with `Cfg.points` ("they are
different things") and needs disambiguating labels; a tally-settled
`generic.result {}` is a new legal payload shape needing client validation
relaxed to accept it.

## Scope

1. **Labels in `scoring-vocab.ts`** for every new event type and enum member,
   following the existing **closed-enum + `MessageKey`** pattern so the compiler
   forces completeness. If the compiler does not currently force it, make it —
   that is the mechanism that stops the next wave repeating this session.
2. **All four locale dictionaries** (`en`, `es`, `fr`, `nl`), flat dotted keys,
   then `i18n:gen-keys` + `i18n:check`.
3. **Per-sport subsetting where a shared enum over-offers**: ITTF sanctions are
   yellow/red only, BWF adds black — the kernel's union must not put a card
   colour on a pad for a sport that does not use it. Drive the subset from the
   variant-gating S6 built; do not add a second gating mechanism.
4. **Pad controls for each new event, gated by fidelity tier**: cricket's
   retire/powerplay/review, football's sin bin and missed penalty, the hockeys'
   penalty-corner-awarded, the racquet family's timeout/sanction, carrom's
   per-board player picker, `generic.score`'s +N and undo. These are `PadSpec`
   actions (S6) — declare them there if S6 missed one; **do not hand-write a
   control that bypasses the spec.**

## Acceptance criteria

- [ ] Zero humanised fallbacks remain for shipped vocabulary: a test enumerates
      every event type and enum member across all 11 modules and asserts each has
      a declared key — **failing today**. This test is the deliverable that keeps
      the gap closed.
- [ ] "Hitballtwice" renders as a proper dismissal label; tennis `default`
      sanction reads correctly; football `CardReason` all 13 members labelled
- [ ] Compiler forces completeness: adding an enum member without a label fails
      typecheck (prove it — add one, see it fail, revert)
- [ ] All 4 dictionaries updated; `i18n:gen-keys` then `i18n:check` green;
      `git status --porcelain` **empty** after both drift generators
- [ ] Per-sport subsetting: badminton offers black, table tennis does not —
      regression test per sport, driven by S6's variant gating (grep proves no
      second mechanism)
- [ ] `generic.score.points` vs `Cfg.points` disambiguated in the labels;
      `generic.result {}` accepted by client validation
- [ ] Every new pad control is a `PadSpec` action, not a bespoke component —
      reviewer verifies dispatch path
- [ ] UI: Playwright screenshots desktop **and 375px**, no horizontal page
      scroll, touch-sized targets
- [ ] `git grep -a` the changed strings across `e2e/` (both phases) before merge
- [ ] `rtk proxy npm run lint` `✖ 0 problems`; `tsc EXIT=0`; vitest counts from
      the JSON reporter

### Test types

- **Unit** — the completeness enumeration test; per-sport subsetting.
- **E2E (Playwright)** — the labels are user-visible, so this session **owes real
  e2e**: assert a labelled dismissal and a labelled sanction render as words, not
  snake_case, on whichever surface is reachable at this point. If the v2 pad is
  not yet wired (S12), drive the existing v1 surface that reads
  `scoring-vocab.ts`; if truly nothing renders these strings yet, say so
  explicitly in the PR body and add the assertion to S12's e2e list.
- **Smoke** — extend `scripts/smoke.ts` only if a labelled surface is on a smoke
  path; otherwise note the deferral to S13.
- **Regression** — one per previously-humanised value.

## Gotchas

- `content/help/**` is **one English tree** and owes no translation. That
  exception does **not** extend to `scoring-vocab.ts` or the dictionaries, which
  need all four locales.
- Dictionaries are **flat dotted-key JSON** — not nested objects.
- Two CI-only drift gates exist: `openapi:gen` **and** `i18n:gen-keys`. Run both,
  then `git status --porcelain` must be empty. This has bitten 5×.
- UI text changes break e2e — grep the old **and** new strings across both e2e
  phases.
- A label key changed after it ships breaks dictionaries and tests silently in
  three places. Get the key names from S6's convention; do not rename later.

## Execution

Dictionaries + `scoring-vocab.ts` + pad controls are one interlocked file set →
**one inline implementer pass**. Translation of 4 locales is mechanical and stays
in the same pass.

**Scout (sonnet) brief:** `apps/web/src/lib/scoring-vocab.ts` — the closed-enum +
`MessageKey` pattern, the humanising fallback, and the hardcoded sport-key list
(was `:15-17`, re-pin); the 4 dictionary files and their key layout; every
surface that renders a scoring label today. file:line table only, under 20 lines.

**Implementer (opus, high):** brief carries the full owed-by-sport list above
plus S3/S4/S6 additions from `_INDEX.md`, so it never re-reads the dossiers.

**Reviewer (sonnet):** does the completeness test actually enumerate from the
engine modules, or from a hand-maintained list that will drift? Are all four
locales real translations or English copied? Does any pad control bypass
`PadSpec`? Gap list only.

## On close

`_INDEX.md`: S7 → DONE, the completeness-test location (it is the guard for every
future sport), any label key that had to change. Memory + snapshot script.
