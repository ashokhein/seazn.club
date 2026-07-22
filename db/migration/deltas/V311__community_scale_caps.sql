-- V311 — scale caps (product owner, 2026-07-21, D22). Not a bug fix in the
-- code: the MATRIX was the bug. /pricing and the help pages have advertised
-- "32 players" and "5 seasons" since the v3 rewrite while plan_entitlements
-- said 16 and 1. The marketing was the intent all along; this makes the table
-- agree with what we have been telling people we sell.
--
--   entrants.per_division.max    community 16 → 32, event_pass 32 → 64
--   competitions.max_active      community  1 →  5
--
-- Ladder after this: entrants 32 / 64 / 256 / ∞.
--
-- V310 is the highest applied migration on this branch. V309 is NOT free — it
-- belongs to feat/billing-groups (V309__billing_groups.sql), claimed
-- concurrently; see /tmp/seaznclub/RESERVATIONS.md, where V311 is claimed for
-- this file before it was written.
--
-- Unqualified DDL: Flyway runs with -defaultSchema=seazn_club (db/flyway.toml,
-- scripts/flyway.sh) and the app schema is the only schema in play. Same
-- `insert … on conflict (plan_key, feature_key) do update` shape as V310.

-- --------------------------------------------------------------------------
-- D22a — entrants per division: 32 / 64 / 256 / ∞.
--
-- THE PASS ROW IS LOAD-BEARING. Raising community to 32 without moving
-- event_pass would leave the pass at the community value, and the resolver
-- treats an event_pass row equal to community as a no-op: the key would drop
-- out of the pass-lifted set entirely and a $29 purchase would buy exactly
-- zero extra entrants. 64 keeps the pass worth buying and keeps the rung
-- visible on /pricing.
--
-- Knock-on for the pass-scoping guard
-- (apps/web/src/lib/__tests__/pass-scoping-guard.test.ts): because this key
-- STAYS lifted, server/usecases/registrations.ts:828 stays on the guard's
-- offender list. That is intended — it is the next phase's work queue, not
-- something this migration resolves.
--
-- pro (256) and pro_plus (null = unlimited) are deliberately NOT restated:
-- they do not move, and V290 owns them.
-- --------------------------------------------------------------------------
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('community',  'entrants.per_division.max', null, 32),
       ('event_pass', 'entrants.per_division.max', null, 64)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- --------------------------------------------------------------------------
-- D22b — active competitions on the free plan: 1 → 5.
--
-- Statuses counted are draft/published/live (server/usecases/entitlement-freeze.ts);
-- archived and completed do not count, and over-cap competitions FREEZE rather
-- than delete. One active competition made the free plan a demo, not a
-- product — a club running a league plus a cup was already over the line.
--
-- NO event_pass ROW HERE, DELIBERATELY. A passed competition is already
-- excluded from the active count (server/usecases/competitions.ts:86) — that
-- is the correct mechanism and it is per-competition. A row here would instead
-- raise the ORG-WIDE cap for any org holding a single pass, which is not what
-- the pass sells. The pass column on /pricing renders prose
-- ("pricing.matrix.passedEvent") for exactly this reason.
--
-- pro / pro_plus stay null (unlimited); not restated, V290 owns them.
-- --------------------------------------------------------------------------
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('community', 'competitions.max_active', null, 5)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
