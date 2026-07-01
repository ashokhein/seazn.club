# PROMPT-09 — Fixture Generation & Calendar Slotting

**Read first:** `engine/05-formats-progression-tiebreakers.md` §2, §6. Preamble: PROMPT-00.
Depends: PROMPT-08.

## Task
Implement `scheduling/` (pure, deterministic — all randomness via seeded rng):

1. `roundrobin.ts` — circle method per 05 §2.1: bye padding, legs (mirrored home/away),
   court rotation. Properties: completeness n(n−1)/2·legs, ≤1 fixture/entrant/round,
   home/away balance |h−a| ≤ 1 per leg.
2. `swiss.ts` — `pairRound(standings, history, constraints)` per 05 §2.2 behind an
   interface: score groups, top-vs-bottom fold, backtracking transpositions for no-rematch
   (hard) and colour rules (chess flag: no 3-in-a-row, |W−B| ≤ 2), float tracking, bye to
   lowest un-byed. Properties: no rematches ever; colour bounds hold; total pairing when
   a perfect matching exists (verify via brute force on n ≤ 10).
3. `bracket.ts` — SE fold seeding (recursive interleave per 05 §2.3), byes to top seeds
   auto-decided as awards, winner/loser feed wiring, 3rd-place option, cross-pool
   templates (A1–B2…; same-pool rematch deferred latest); DE per 05 §2.4 with optional
   bracket reset; stepladder per §2.5. Properties: 05 §6 bracket invariants.
4. `calendar.ts` — greedy slotting per 05 §2.6 with rest/blackout/court constraints;
   returns `{assignments, conflicts[]}` — never silently drops a constraint. Cross-division
   awareness: accepts existing assignments from sibling divisions (doc 06 §4.3) and
   per-person overlap warnings.
5. Generation is a pure function of `(entrants, seeds, config, rngSeed)` — regenerate ≡
   identical output (idempotence property, feeds included).

## Acceptance
- Property suites green (fast-check, n up to 64 entrants).
- Golden: 6-team double-RR circle-method table matches a published schedule; 16-bracket
  seeding matches the standard 1-16 fold layout; a 5-round Swiss on 9 entrants with a bye
  each round and zero rematches.
