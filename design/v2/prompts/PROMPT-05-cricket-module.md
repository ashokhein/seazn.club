# PROMPT-05 — Cricket Sport Module

**Read first:** `engine/04-sport-scoring-specs.md` §2 (normative, read twice), §9;
`engine/11-sources.md` cricket section — fetch current ICC playing conditions for points/
NR conventions before coding. Preamble: PROMPT-00. Depends: PROMPT-03. **Largest module —
budget accordingly; split into two sessions at §2.5 (DLS) if needed.**

## Task
Implement `sports/cricket/` per spec 04 §2:

1. Cfg schema + variants `t20`/`odi`/`hundred`/`test` (+ community `pairs-6-a-side`).
   Validate cross-field: `maxOversPerBowler ≤ balls/over math`, `followOn` only when
   `inningsPerSide=2`.
2. **Dual fidelity (spec §2.2 design note — the critical requirement):**
   - Fine: `cricket.ball` events with full grammar (extras, wickets, free hits, striker
     rotation, over/bowler legality).
   - Coarse: `cricket.innings.summary {runs, wickets, legalBalls}`.
   - Both fold into the same `InningsTotals`; all result/NRR/DLS math reads only
     `InningsTotals`. Conformance dual-fidelity hook: `coarsen(ballEvents)` ≡ summaries.
   - Tier 2 (`engine/14-score-granularity.md`): `cricket.player.line` post-match
     scorecard events (per-player runs/balls/wickets/overs) with sum-consistency
     validation against `InningsTotals` — reject mismatched cards with a diff.
3. Innings state machine: openers from lineup order, striker rotation (odd runs, over
   end), dismissal → next batter by order, all-out at `playersPerSide − 1` wickets,
   innings close (all out / balls exhausted / declare / target passed).
4. Result determination §2.3 incl. margins ("by 24 runs" / "by 6 wickets"), tie → super
   over recursion (`superover.ball` folds a nested 1-over innings pair; still-tied policy
   from cfg: repeat | boundary-count | shared), `no_result` below `minOversForResult`,
   2-innings test results incl. draw + innings victory + follow-on enforcement.
5. **NRR ledger** §2.4: `standingsDelta` carries integer `runs_for, balls_faced_eff,
   runs_against, balls_bowled_eff` with the all-out full-quota rule and
   `ballsPerOver`-general decimalisation. No floats.
6. **DLS** §2.5: embed the published Standard Edition resource table as data;
   `dlsTarget()` + par curve; folded via the `revise` event; label 'standard'. Manual
   umpire override (revise with explicit target) always wins.
7. Positions/roles per §2.7; lineup validation: exactly `playersPerSide` starting, one
   wicketkeeper, batting order = order_no; bowling figures derivable from ball events.
8. Goldens: (a) real T20 scorecard (pick a published one, cite it) ball-by-ball → known
   totals/result; (b) all-out NRR worked example from the CricHeroes source; (c) DLS
   worked example vs published calculator output (tolerance: exact on table values);
   (d) tied T20 → super over → boundary-count; (e) test-match draw.
9. `arbitraryEvent(state)` generating only legal deliveries.

## Acceptance
- Conformance + goldens green. NRR property: permuting fixture order never changes
  accumulated ledger. Bowler-legality property: generated streams never violate
  consecutive-over or quota rules.
