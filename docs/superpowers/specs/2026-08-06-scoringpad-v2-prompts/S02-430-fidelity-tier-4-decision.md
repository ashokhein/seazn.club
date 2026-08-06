# S2 — #430: is fidelity tier 4 (a stats terminal) a product we build?

Paste this whole file as the session opener. Read `_RULES.md` then `_INDEX.md`
first. **Decision session — short, and it may end with zero code.** No branch
needed unless the decision produces work.

## Why now

W5 (S6) freezes the fidelity tier model into `PadSpec`, and W8's renderer and
W9's skins consume it. If a fourth tier is ever coming, the tier type and the
entitlement seam are cheaper to shape now than after three sessions build on a
three-tier assumption. If it is never coming, say so once and stop re-deriving it.

## What was deferred, and why

10 rows across 8 sports were refused in W4 for the same honest reason: they are a
different fidelity than our declared tiers, and in several cases a different
product.

- **icehockey** — shots on goal, saves, save %, faceoffs: "tier 3 tops out at
  attributed timeline scoring, and a per-shot stream is a different product (and
  a different pad)".
- **icehockey** — plus/minus and the six players on ice at each goal: "no phone
  scorer enters twelve ids per goal, and a half-entered on-ice set produces
  **wrong** plus/minus rather than none".
- **hockey / volleyball / tennis / badminton / tabletennis** — circle
  penetrations, possession, attack-block-dig chains, first vs second serve, rally
  length: "wrong fidelity for our scoring tiers"; "pro statistics, not scoresheet
  facts"; "a broadcast statistic".
- **boardgame** — movetext / PGN: "turns the engine into a chess implementation";
  also needs a decision on blob storage.
- **carrom / generic** — strike-by-strike: already typed as `CarromStrike` with
  `apply()` rejecting it, reserved Pro fidelity, entitlement
  `scoring.strike_by_strike`.

The audit did **not** use this as a dumping ground — it separately refused ~20
other rows as derivable or belonging to another layer. These ten are a coherent
product boundary.

## The question to answer

Tier 4 is not an engine feature. It is a second product: a two-thumb terminal for
a dedicated statistician sitting through a match, not a phone scorer running one.
It implies its own pad, its own entitlement, its own data volume, and its own
failure mode (a half-entered on-ice set is worse than no data).

Bring the owner a recommendation, not a survey. Cover:

1. **Verdict** — build, never, or defer-with-a-trigger (and name the trigger:
   a customer ask? a plan tier? a sport?).
2. **Cost of leaving the seam open** in S6 — what exactly does `PadSpec` need so
   a fourth tier is additive later: is `fidelity` an open enum, is the tier
   ordering a list rather than a triple, does the entitlement check already have
   a hook. Quantify: how many files change now vs after S6/S10/S11 ship.
3. **The strike-by-strike precedent** — `CarromStrike` is already typed with
   `apply()` rejecting it and an entitlement name reserved. Is that the pattern
   for all ten rows (type it, reject it, name the entitlement) or is dead typed
   code a liability we should delete?
4. **The plus/minus trap** — partial entry producing *wrong* numbers, not missing
   ones, is a data-integrity argument independent of product appetite. Whatever
   the verdict, decide whether tier-4-shaped data must be all-or-nothing per
   match.

## Acceptance criteria

- [ ] A written recommendation with the four points above, ≤ 2 pages, in the
      session output **and** appended to `_INDEX.md`'s decision log
- [ ] The owner's ruling recorded verbatim in `_INDEX.md` (this is the artefact
      that survives compaction — the conversation will not)
- [ ] If the ruling is "defer" or "never": #430's own text is enough of a record;
      leave it. **Do not open a new issue.**
- [ ] If the ruling creates work: it lands **inside S6's prompt file** as extra
      scope (edit `S06-416-w5-padspec.md` directly), not as a new session, unless
      the owner says otherwise
- [ ] `S06-416-w5-padspec.md` updated either way — even a "never" needs one line
      in S6 saying the tier model is closed at three, so S6 does not re-ask

### Test types

None — no code by default. If the ruling produces engine work, it inherits S6's
test obligations (unit + conformance + regression; e2e/smoke via S12/S13).

## Gotchas

- Do not let this session drift into building the seam "just in case". The
  cheapest open seam is an enum that is not sealed; anything more is speculative.
- The ten rows are already documented on #430 in the sports' own words. Do not
  re-derive them from the dossiers — that is a fresh read of 11 files for facts
  already written down.
- If the owner is not available, do **not** block the programme: record the
  recommendation, mark S2 as `AWAITING RULING` in `_INDEX.md`, and run S3 next.
  S6 is the real deadline, not S2.

## Execution

Inline, main thread. At most one scout call:

**Scout (sonnet) brief:** find where fidelity tiers exist today —
`fidelityTiers` on `SportInfo` (was around `fixture-console.tsx:132`, re-pin),
the `CarromStrike` type + its rejecting `apply()`, and any entitlement named
`scoring.*`. Return a file:line table under 15 lines, no file contents.

## On close

Append the ruling to `_INDEX.md`, update the S2 row's status, and edit S6's
prompt file to reflect it. Write memory only if the ruling is "build" (a new
programme), otherwise the index line is enough.
