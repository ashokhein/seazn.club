# Chess — Engine & Scoring Architecture

Module: `boardgame` preset `chess` · Spec anchor: `04-sport-scoring-specs.md` §6 ·
Implementation: PROMPT-07 (module) + PROMPT-09 §2 (Swiss pairing).

## 1. What makes chess different
Scoring a single game is trivial (win/draw/loss); **all complexity lives in the
competition layer**: Swiss pairing, colour allocation, and cascade-time tiebreaks that
depend on opponents' *final* scores. Chess is the stress test for the competition engine,
not for the match engine.

## 2. Match model
```
Cfg   { scoring: {win: 2, draw: 1, loss: 0}   // half-point integers ×2 — never 0.5 floats
        colors: true, byeScore: 'win'|'draw',
        clock?: {base, increment} }            // metadata only, no scoring effect
Ev    result { winner: entrantId|null, method?: checkmate|resign|time|agreement|
               stalemate|insufficient|forfeit|adjudication }
State { result?, colorOfHome: 'W'|'B' }
```
- One terminal event per fixture. Undo = void it.
- `colorOfHome` assigned by the pairing algorithm, stored on the fixture (home = White).
- Variants `classical|rapid|blitz` differ only in clock metadata → one rating pool per
  variant later (ratings reserved, not v2).
- Draws always allowed (`supportsDraws = true` even in knockout — KO chess resolves ties
  via **multi-game mini-matches**: model a KO "tie" as `parent_fixture_id` children
  (classical pair → rapid pair → blitz → armageddon), each child a normal fixture; parent
  outcome = aggregate. Ship simple version first: single game + organiser picks winner
  manually on draw, with the mini-match structure as the Pro follow-up).

## 3. Swiss integration (the real architecture)
Per-entrant pairing state maintained by the competition engine from the module's ledger:
```
{ score,                       // Σ points (half-point ints)
  opponents: [entrantId...],   // rematch prevention + Buchholz inputs
  colorSeq: 'WBWB…',           // colour constraints
  floats: [round→up|down],     // float history
  byes: [round...] }
```
Pairing per round (05 §2.2): score groups → top-half vs bottom-half fold → backtracking
transpositions honouring **hard**: no rematch, ≤2 colour imbalance, no 3 same colours in
a row; **soft**: alternation, avoid repeat floats. Bye → lowest-ranked never-byed entrant.

## 4. Tiebreak cascade (computed at rank time, FIDE-grounded)
`score → buchholz_cut1 → buchholz → sberger → direct → wins → lots(seeded)`
- **Buchholz** = Σ opponents' final scores; **Cut-1** drops lowest (FIDE-recommended first).
- **Sonneborn-Berger** = Σ defeated opponents' scores + ½ Σ drawn opponents' scores.
- Unplayed games: FIDE virtual-opponent adjustment (bye counts as opponent with
  own-score-based virtual result — cite handbook section in code).
- All computed from the opponents ledger during ranking; never folded incrementally
  (they depend on final scores).

## 5. Team chess (later, designed now)
Team entrant, board order = `LineupSlot.order_no`; a team round = parent fixture with N
child board fixtures; team points: match points (2/1/0 on board-point majority) or game
points per config. Reuses `parent_fixture_id` — same mechanism as TT team ties.

## 6. Fidelity & entitlements
Single-event sport ⇒ no coarse/fine split. Pro depth instead: PGN/move upload attachment
(`core.note` payload) + downloadable cross-table exports (`exports`), mini-match KO ties,
ratings later.

## 7. Edge cases checklist
- Odd entrants every round (rotating bye, never repeated).
- Withdrawal mid-swiss: entrant skipped in pairing; opponents' Buchholz uses FIDE
  unplayed-game rules.
- Forfeit (no-show): `result{winner, method: forfeit}` — scores like a win but flagged;
  excluded from colour history.
- Double forfeit: `no_result`-style zero-zero (add to outcome mapping).
- Cross-table golden test against a published event is mandatory (PROMPT-07 §5).
