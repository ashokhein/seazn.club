# PROMPT-28 — Format Engine Extensions

**Read first:** `engine/Jul3/08-format-extensions.md` (normative);
`engine/05-formats-progression-tiebreakers.md` §2 (roundrobin/swiss/bracket) + §6
(invariants); `engine/02-domain-model.md` §5–6, §8 (stage graph, feeds, progression).
Preamble: PROMPT-00. **Depends:** PROMPT-09 (generators), PROMPT-08 (progression). Ties to
Jul3/04 (flexible scheduling) and Jul3/05 (fractional points, placement ranks).

## Task
1. **RR legs>2** (Jul3/08 §2): lift the `legs` cap in `roundrobin.ts`; home/away balance
   across all legs; property `completeness = n(n−1)/2·legs`.
2. **Americano/Mexicano** (Jul3/08 §3): new `americano` stage kind; even rotation
   (americano) + rank-derived pairing reusing swiss `pairRound` (mexicano); on-the-fly `pair`
   entrants; per-person points.
3. **Custom brackets + cross-format feeds** (Jul3/08 §4): organiser-chosen byes /
   non-power-of-2 in `bracket.ts`; allow `loser_to`/`winner_to` to target a fixture in a
   **different stage** (CL→EL); `places:[..]` fixtures resolving to explicit final ranks
   (into Jul3/05 §4 override). Validate the feed graph is a DAG (fail closed).
4. **Independent pools + auto-advance + early slot fill** (Jul3/08 §5): per-pool completion
   releasing pool-only dependents; `auto_progress` division flag; feed resolver runs
   per-decided-fixture (partial "Winner QF1 vs TBD"), not per-round. Emit `stage_auto_advanced`.
5. **Ladder + Hammes** (Jul3/08 §6–7): `ladder` stage kind (challenge-based, flexible
   schedule) — minimal viable; `swiss` `pairing:'rank_adjacent'` preset (Hammes), no new code.
6. **API/entitlements** (Jul3/08 §8): stage config extensions via existing stages endpoint;
   `formats.advanced` (americano/custom_bracket/cross_feed/ladder/auto_progress) = Pro.

## Acceptance
- Property: triple-RR completeness/balance; americano rotation covers pairings evenly for
  feasible counts; cross-format feed graph rejected if cyclic; per-decided-fixture fill never
  seeds a KO slot before its source decides.
- Golden: 6-team custom bracket with chosen byes matches an expected layout; CL QF loser
  lands in the EL QF slot; pool A completes and opens its dependent fixtures while pool B is
  unfinished; Hammes 5-round on 8 entrants, zero rematches.
- E2E: `auto_progress` on → finishing a group auto-generates the next stage (no button);
  a team sees its next-round fixture the moment its opponent's source is decided.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes. Ladder/Kinball
  deep-dives, if they grow, split into their own follow-up prompts (noted in Jul3/08 §6, §9).
