-- V347 — W4a follow-up Task 1: freeze the config a fixture was SCORED under.
--
-- THE DEFECT. `cfg` is not frozen with the stream. `append-event.ts` rebuilt it
-- live from `stageScopedCfg(division.config, stage?.config)` on every call, and
-- every READ replays the whole ledger from `init` — there is no incremental
-- fold and no cached partial state. So an organiser editing a division's config
-- changes the input to every past fold at once. Two consequences, and the second
-- is not recoverable:
--
--   * A finished fixture is RESCORED. Lower `points.w`, flip `allowDraws`, drop
--     a period and the standings move under matches that were played, agreed and
--     published weeks ago.
--   * A cfg-derived refusal inside a fold fires on events ALREADY IN THE LEDGER.
--     Each of those events was legal when it was recorded, so there is nothing
--     to void and no scorer action that recovers it: the state endpoint, the
--     score page and standings all throw, and the fixture is permanently
--     unviewable. Six instances of this exact shape were found by hand during
--     W4a alone (see `packages/engine/src/sports/cfg-replay.conformance.test.ts`
--     for the property that files the class).
--
-- THE FIX. Snapshot the RESOLVED cfg — the output of `stageScopedCfg`, stage
-- overlay already applied — onto the fixture when its FIRST event is appended,
-- inside the same transaction and under the advisory lock that append already
-- holds. Every later read folds against the snapshot instead of the live config,
-- so a config edit governs future fixtures and cannot reach back into recorded
-- ones.
--
-- WHY `stageScopedCfg`'s OUTPUT and not the raw division config: the overlay
-- would otherwise be re-applied at read time against a stage config that has
-- since moved, which reintroduces exactly the drift the snapshot exists to stop
-- — just one layer down.
--
-- NULLABLE, and null is meaningful rather than a migration artefact. A fixture
-- with zero events has nothing to protect and legitimately reads LIVE config:
-- the organiser is still setting the division up, and the format they choose
-- must apply. `config_snapshot is null` is precisely "not scored yet". The
-- resolver in `apps/web/src/server/engine-db/fixture-cfg.ts` is the single place
-- that decision is made, shared by the read and write folds so neither can drift
-- back to live cfg on its own.
--
-- `config_snapshot_at` records WHEN it was frozen. It is not redundant with the
-- first event's `recorded_at`: the escape hatch below rewrites the snapshot
-- without touching the ledger, and after a re-snapshot the two disagree — which
-- is the one moment somebody reading a support ticket needs to see.
--
-- THE ESCAPE HATCH. A snapshot with no way out converts one class of
-- unrecoverable state into another: an organiser who genuinely set the wrong
-- config would be frozen into it forever. `/admin/fixtures` can re-snapshot a
-- REOPENED fixture from live config, audited to `staff_audit_log`. Deliberately
-- not a column concern — the hatch writes these same two columns.
--
-- Greenfield: no prod data, so no backfill. Both columns are nullable with no
-- default, making this a catalogue-only change (no table rewrite).
alter table fixtures
  add column if not exists config_snapshot    jsonb,
  add column if not exists config_snapshot_at timestamptz;

comment on column fixtures.config_snapshot is
  'W4a follow-up: the RESOLVED sport config (stage overlay applied) this fixture '
  'was scored under, frozen on the first event append. Null means "no events yet" '
  '— such a fixture folds against live division/stage config. Every read folds '
  'against this when set, so a later config edit cannot rescore or brick it.';

comment on column fixtures.config_snapshot_at is
  'When config_snapshot was taken. Diverges from the first event''s recorded_at '
  'only after a staff re-snapshot (audited in staff_audit_log).';
