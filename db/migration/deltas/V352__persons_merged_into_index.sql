-- #404 review follow-up: index the tombstone pointer.
--
-- `persons.merged_into` is read on three hot paths and indexed on none of them:
--
--   * the merge itself flattens inbound tombstones with
--     `update persons set merged_into = $1 where merged_into = $2`
--     (person-merge.ts §4);
--   * `reverseMerge` restores that set the same way;
--   * and `recomputePlayerStats` now runs
--     `select id, merged_into from persons where merged_into is not null`
--     on EVERY refold (player-stats.ts) — which `personStats` calls once per
--     division, so a person with a season's worth of divisions pays for it
--     repeatedly.
--
-- It is also the target of an `on delete set null` FK, and Postgres has to scan
-- the referencing side for those.
--
-- Partial on `merged_into is not null`: tombstones are the rare case by
-- construction (one row per merge an organiser confirmed by hand), so the index
-- stays a fraction of the table's size and still answers every query above —
-- all three carry that predicate, either literally or as `merged_into = <uuid>`,
-- which implies it.
create index if not exists persons_merged_into_idx
  on persons (merged_into)
  where merged_into is not null;
