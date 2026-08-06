-- V354 — a division's quota slot is spent by RECORDED RESULTS, not by existence.
--
-- `divisions.per_competition.max` counted only `archived_at is null`, on the
-- rule "archiving frees the slot (v3/09 §4)". Community's bite is 1 active
-- competition with 4 divisions in it (V270 set 2; V319 raised it to 4), so
-- create → play → archive → create again was unlimited divisions inside one
-- competition, for nothing — the ceiling is on how many exist AT ONCE, and
-- archiving reset the counter.
--
-- The guard already existed on the OTHER door: deleteDivision refuses a played
-- division with DIVISION_HAS_RESULTS. Archive was a delete that skipped that
-- guard and refunded the slot as well.
--
-- Deliberately NARROWER than delete's predicate. Delete asks
-- `status <> 'setup' OR decided > 0` because it destroys data. Nothing is
-- destroyed here, and merely PUBLISHING a division before noticing the sport
-- or variant is wrong is a mistake, not usage — burning a paid slot for it is
-- the unfairness this rule exists to avoid. Only a real result spends the slot.
--
-- STABLE, not IMMUTABLE (cf. pass_applies, V343, which takes scalars and reads
-- no table). SECURITY INVOKER by default, deliberately: RLS on `fixtures` then
-- applies to the caller, and both call sites already run inside withTenant.
create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and f.status in ('decided', 'finalized', 'forfeited'))
  $$;

-- The quota count evaluates this per archived division on every division
-- create. Partial, because only these three statuses are ever asked about.
create index if not exists fixtures_division_results_idx
  on fixtures (division_id)
  where status in ('decided', 'finalized', 'forfeited');

-- The escape hatch (staff-only). An org can burn a slot by genuine accident —
-- one stray recorded result — and a rule with a support path beats a rule with
-- a timer that doubles as a loophole.
alter table divisions add column if not exists slot_waived_at timestamptz;
alter table divisions add column if not exists slot_waived_by uuid;
