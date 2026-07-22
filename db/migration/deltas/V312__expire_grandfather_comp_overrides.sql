-- V312 — retire the v3 grandfather pins on competitions.max_active (D22
-- follow-up, 2026-07-21).
--
-- V270 (:53-64) wrote org_entitlement_overrides rows for every community org
-- that already had more than one active competition when the free cap dropped
-- 2 → 1, pinning `competitions.max_active` at `least(count(*), 2)`. Those rows
-- existed to RAISE an org above a cap that had just been lowered under it, so
-- the freeze machinery would not bite retroactively.
--
-- V311 raised community to 5. Every one of those pins is now BELOW the plan
-- row, and `int_value` is deliberately NOT coalesced through to the plan
-- (apps/web/src/lib/entitlements.ts:128-134 — a null int means UNLIMITED on
-- this column, so the resolver cannot treat a present override as "unset").
-- The consequence: an override that was written to help now caps its org at 2
-- while /pricing, the help pages and the in-app billing panel all advertise 5.
-- A grandfather clause that outlives the thing it grandfathered is just a
-- lower cap with a friendly reason string.
--
-- DELETE, NOT EXPIRE — deliberately.
--   * Expiry is not the softer option. As the V310/V311 review put it, an
--     expiration that has taken effect is permanent: there is no un-expire,
--     and the admin API refuses to write a past `expires_at` at all
--     (api/admin/orgs/[id]/entitlement-override/route.ts:30 — "The expiry must
--     be in the future"). Back-dating one here would mint a row state the
--     app's own write path forbids and offers no way out of. It is exactly as
--     final as a delete.
--   * A dead row is not free. /admin/orgs/[id] lists every override regardless
--     of expiry and /admin/entitlements counts them by key, so staff would
--     read "this org has a competitions.max_active override" and be wrong.
--   * There is nothing to preserve. The row carries no history the migration
--     log does not; its whole content was a cap that no longer binds.
--
-- Scope is the invariant, not the provenance: `reason` is free text and could
-- have been overwritten by staff, so it is not in the predicate. What makes a
-- row safe to drop is that it can only ever RESTRICT — an int_value at or
-- below the live community cap. Rows above it, and rows with a null int_value
-- (UNLIMITED — the strongest grant there is), still raise their org and are
-- left completely alone, as is every other feature_key.
--
-- The cap is read from plan_entitlements rather than hard-coded so this cannot
-- drift from V311. If community's cap were ever null (unlimited), `<=` yields
-- NULL and this deletes nothing — the fail-safe direction.
--
-- Production has zero customers, so this is inert there. Dev and staging orgs
-- seeded before V270 carry these rows and read the wrong cap without it.
--
-- Unqualified DML: Flyway runs with -defaultSchema=seazn_club (db/flyway.toml,
-- scripts/flyway.sh).

delete from org_entitlement_overrides o
where o.feature_key = 'competitions.max_active'
  and o.int_value is not null
  and o.int_value <= (
    select pe.int_value from plan_entitlements pe
    where pe.plan_key = 'community' and pe.feature_key = 'competitions.max_active'
  );
