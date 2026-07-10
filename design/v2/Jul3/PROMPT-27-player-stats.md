# PROMPT-27 — Player Statistics Engine

**Read first:** `engine/Jul3/07-player-stats.md` (normative); `engine/02-domain-model.md`
§6–7 (ledger/derived caches); `engine/14-score-granularity.md`; `engine/06-divisions-and-eligibility.md`
§4.7 (consent); `engine/10-pro-entitlements.md` §Sport depth. Preamble: PROMPT-00.
**Depends:** PROMPT-04..07 (fine events), PROMPT-11 (api), PROMPT-18 (scorer console emits).

## Task
1. **Schema** (Jul3/07 §2): `player_stat_snapshots` (disposable cache); RLS/org_id +
   `check:rls`; rebuildable from events (CI consistency check like standings).
2. **Engine** `packages/engine/stats/` — **pure**: `SportModule.playerStats` declaration
   (metrics/from/agg/derive, awards) per Jul3/07 §3; `aggregatePlayerStats(events, roster,
   model) → StatRow[]`, deterministic; football goals/assists/points(derive)/cards +
   set-sports points/aces. Cite `// Jul3/07 §3`. Voided events excluded.
3. **Awards** (Jul3/07 §4): `core.award {personId, key:'motm'}` event on the existing scoring
   endpoint; aggregate to division-scoped MOTM leaderboard.
4. **Scorer-picker numbers** (Jul3/07 §5): lineup read model returns `squadNumber`; picker
   renders `#7 — Name` + number-order sort option (fixes 9 Sep ×4 / 11 Jun / 10 Jul / 19 May).
5. **API** (Jul3/07 §6): `divisions/{id}/stats/players?metric=&sort=`, `persons/{id}/stats`,
   public consent-filtered `divisions/{slug}/stats`.
6. **Entitlements** (Jul3/07 §7): `stats.player` (Pro) for leaderboards/cards/MOTM tables;
   scorer-picker numbers all plans; MOTM entry wherever scoring is enabled.

## Acceptance
- Property: stats are a pure fold — refold(events) == snapshot; a `core.void` on a goal
  drops the goal and its assist; player in two divisions has per-division tables that don't
  bleed.
- Golden: a football fixture ledger → goals/assists/points table with `points=goals+assists`
  (16 Apr); MOTM award appears in the division leaderboard.
- E2E: ref enters goal + scorer via `#number` picker → top-scorer table updates; enters MOTM
  → MVP table updates; Community (ball-by-ball off) shows "requires detailed scoring" not
  wrong zeros; minor's name gated on public leaderboard.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes.
