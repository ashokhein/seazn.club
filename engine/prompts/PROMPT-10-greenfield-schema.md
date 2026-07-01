# PROMPT-10 — Greenfield Schema + Persistence Adapter

**Read first:** `engine/07-greenfield-schema.md` (normative DDL); `engine/02-domain-model.md`
§6, §8; `engine/03-engine-architecture.md` §5; existing `supabase/migrations/010` + `011`
(patterns to replicate). Preamble: PROMPT-00. Depends: PROMPT-02. **Greenfield: v1
tournament tables will be dropped, but only in PROMPT-15 — here, create v2 alongside.**

## Task
1. Write `supabase/schema_v2.sql` implementing doc 07 verbatim (fix the `coalesce`-in-PK
   sketches with generated columns or partial unique indexes — PK expressions aren't
   valid; note the deviation in the doc). Include:
   - RLS enable+force + direct `org_id = current_org_id()` policies on every tenant table,
     `app_user` grants (schema.sql pattern).
   - Generic `set_org_from_parent()` triggers (010 pattern) for child tables.
   - Hash chains on `score_events` (per-fixture chain) and `division_events`
     (per-division chain) with verify functions (011 pattern, adapted keying).
   - Public read views (`public_competitions_v`, `public_fixtures_v`,
     `public_standings_v`, `public_entrants_v`) implementing visibility + consent
     filtering (doc 06 §4.7, doc 07 note 4) — initials when name consent absent, no DOB
     ever, photos only when consented.
2. Sport catalog seed: sync script `scripts/sync-sports.ts` that reads the engine
   registry (`@seazn/engine`) and upserts `sports` + system `sport_variants` rows from
   module metadata — the DB catalog is generated, never hand-edited.
3. Persistence adapter `apps/web/src/server/engine-db/`:
   - `appendEvent(fixtureId, expectedSeq, envelope)` per 03 §5: `withTenant` tx →
     advisory lock (`hashtext('fixture:'||id)`) → seq check (409 on mismatch) →
     load `match_states` + tail events → fold-validate via pinned module →
     insert event → upsert state/summary → write `fixtures.outcome`+status on decision →
     realtime publish `fixture:{id}` after commit.
   - `rebuildState(fixtureId)`, `verifyStateConsistency()` (cron/CI: refold N random
     fixtures, compare snapshots).
   - `completeStageIfReady`, `recomputeStandings` calling `@seazn/engine` competition
     layer under a division advisory lock.
4. Integration tests against a real Postgres (CI service container): concurrent
   `appendEvent` race (two writers, same expected_seq → exactly one 409); state rebuild
   equivalence; RLS cross-tenant denial per table (extend `scripts/check-rls.ts` to v2
   tables); hash-chain verify after simulated tamper.

## Acceptance
- `npm run db:apply` provisions v2 alongside v1 on a fresh DB.
- All integration tests green in CI; `check:rls` covers every v2 tenant table.
- Doc 07 updated where DDL sketches were corrected.
