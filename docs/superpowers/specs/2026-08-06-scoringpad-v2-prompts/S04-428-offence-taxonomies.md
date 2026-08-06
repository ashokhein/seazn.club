# S4 — #428: offence taxonomies — closed vocabularies for cards, fouls, conduct

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(specifically S3's person-role ruling), then this. Mostly engine, plus dictionaries.

Branch `feat/s4-offence-taxonomies` in a fresh worktree. One PR. Issue #428.

## Why

Four dossiers deferred the same thing: the **reason** for a sanction is recorded
as free text, so nothing downstream can count or filter it.

- **football** — the offence that conceded a penalty: "requires the Law 12
  direct-free-kick offence taxonomy, which no declared fidelity tier records.
  Needs a product decision".
- **tennis** — the specific code violation: "the ITF offence list is long and
  tour-specific … until someone decides the taxonomy is worth an enum".
- **carrom / boardgame** — which foul it was; arbiter warning and conduct
  penalty: "a closed foul vocabulary needs a product decision plus four locale
  dictionaries".
- **hockey / icehockey** — card and infraction `reason`: "recorded, never
  adjudicated".

Beyond tidiness: W4 gave `DisciplineCard` a `reason` field, so the suspension
fold can finally see *why* a card was given. With free text it still cannot
express a real league rule — "three cards for the same offence", "any 10-minute
yellow counts double". **A closed vocabulary is what turns the field from a note
into an adjudicable fact.**

## The person-role gap (shared with S3)

Both hockey dossiers: "nothing marks the named person as a non-player, so a
manager's yellow lands in the player stat table. A `role` discriminator needs a
product decision on whether non-players exist in the person model."

S3 settles whether a coach/team official exists in the person model at all.
**Read that ruling from `_INDEX.md` before designing anything here.** If S3 has
not landed, ask the owner rather than inventing a second model.

## Scope

1. **Decide per sport** whether a closed offence enum is worth it, or whether
   free text plus a `reason` label is the right fidelity. `deferred + reason`
   remains a legitimate outcome for any of them — record it in `_INDEX.md`,
   do not open an issue. Bring a recommendation per sport, with the size of the
   real-world vocabulary (football Law 12 is short and closed; the ITF list is
   long and tour-specific — those should not get the same answer).
2. **For each enum adopted**: engine-side additive optional enum, four locale
   dictionaries, pad picker entry. The pad-picker half coordinates with S7 —
   if S7 has not run, declare the label keys here and let S7 translate them.
3. **A person-role discriminator** so a card to a coach or team official never
   reaches a player leaderboard. This is the row with real data damage: it is
   currently silently corrupting stats.
4. **`DisciplineCard.minutes`** — hockey asked for it in W4 and it was ruled out
   of that pass's scope. A duration-keyed accumulation rule needs it. The core
   time model (#425, W4a) is **merged**, so durations already have an owner —
   reuse that model, do not invent a parallel one.

## Acceptance criteria

- [ ] A per-sport table in the PR body: enum adopted / free-text kept /
      deferred + reason. No blank cells.
- [ ] Every adopted enum is **additive and optional**; no existing recorded
      payload becomes invalid
- [ ] `DisciplineCard.reason` is adjudicable: a test expresses a real league rule
      over it (e.g. "three cards for the same offence") and that rule fires
- [ ] Person-role discriminator lands; a card issued to a non-player produces
      **no** player-stat row — regression test asserting the leaderboard, not
      just the field
- [ ] `DisciplineCard.minutes` present and driven by W4a's duration model
      (grep proves no second duration implementation)
- [ ] Every new enum member has a label key declared engine-side and translated
      in **all 4** dictionaries; `i18n:gen-keys` then `i18n:check` green;
      `git status --porcelain` empty after both drift generators
- [ ] `DisciplineCard.entrantSide` remains the **offender's** side — regression
      test where offender side and beneficiary side disagree
- [ ] Goldens byte-identical, or a deliberate isolated re-baseline commit with a
      state diff (S1 policy); modules stay `1.0.0`
- [ ] Engine purity gate, conformance ×11 modules × variants, `tsc EXIT=0`,
      engine + root lint `✖ 0 problems`, vitest counts from the JSON reporter

### Test types

- **Unit** — enum validation, role discriminator, minutes accumulation.
- **Regression** — the coach-card-in-player-stats bug (fails today);
  the `entrantSide` offender/beneficiary disagreement; an accumulation rule over
  `reason`.
- **Conformance + golden replay** for the engine half.
- **E2E (Playwright) + smoke: deferred to S12/S13.** The pad pickers are not
  reachable until the v2 pad ships. Say so in the PR body.

## Gotchas

- `DisciplineCard.entrantSide` is the **offender's** side, and `Side = EntrantId`
  — a same-typed field pair. Any test where the two sides agree proves nothing.
- Per-sport subsetting matters: ITTF sanctions are yellow/red only, BWF adds
  black. A shared kernel union that over-offers puts a card colour on a pad for a
  sport that has no such card. Gate by variant, not by kernel.
- Instruction/rule conflicts elsewhere in this codebase are warn-only by
  structure — do not assume a new "rule" mechanism blocks anything unless you
  wire it into the blocking path deliberately.
- Free text is a legitimate answer. An enum guessed at from broadcast vocabulary
  is worse than the text it replaced.

## Execution

Engine enums + role discriminator are one interlocked file set → **one inline
implementer pass**. Dictionary work is disjoint and can follow in the same pass
(it is small).

**Scout (sonnet) brief:** locate `DisciplineCard` (definition, every construction
site, every read in folds and stats), the suspension fold, W4a's duration model
entry points, and how `scoring-vocab.ts` declares closed enums + `MessageKey`.
file:line table only, under 25 lines, no file contents.

**Implementer (opus, high):** brief carries the per-sport decision table and S3's
person-role ruling verbatim, plus the scout table. TDD.

**Reviewer (sonnet):** does any adopted enum break an existing payload? Is the
role discriminator enforced at the **stats** boundary or only stored? Is there a
second duration implementation? Gap list only.

## On close

`_INDEX.md`: status S4 → DONE, the per-sport enum decisions in the decision log,
label keys declared (input to S7), person-role model as finally shipped. Memory +
`scripts/agent-memory-snapshot.sh`.
