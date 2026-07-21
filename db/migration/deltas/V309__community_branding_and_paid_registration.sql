-- V309 — repackaging (product owner, 2026-07-21, D18/D19/D20). Not a bug fix:
-- two features move OUT of the paid tier and one is re-monetised by fee.
--
--   branding           org logo upload + display   → free for everyone
--   registration.paid  charging an entry fee       → free for everyone
--   registration.fee_percent   community 8 / pass 5 / pro 2 / pro plus 1
--
-- The trade: logos are table stakes, so gating them only made free events look
-- broken without converting anyone. Entry fees earn more as a rate than as a
-- wall — an org that cannot charge at all sends us nothing, an org charging at
-- 8% sends us something and has a live reason to buy the pass or a plan (the
-- ladder pays for itself at roughly £500 of entries on the $29 pass).
--
-- V308 is the highest applied migration in db/migration (deltas, jul3, perf,
-- v1-baseline, v2-engine all checked), so this is V309.
--
-- Unqualified DDL: Flyway runs with -defaultSchema=seazn_club (db/flyway.toml,
-- scripts/flyway.sh) and the app schema is the only schema in play; `public` is
-- not used. Same insert … on conflict shape as V306's exports.branded grant.

-- --------------------------------------------------------------------------
-- D18 — logos for everyone.
--
-- This does NOT touch `dashboard.branding`, and the omission is deliberate, not
-- an oversight. `dashboard.branding` is the org THEME COLOUR on public pages
-- and the slideshow; it stays false for community AND for the Event Pass. Logos
-- become table stakes, the theme colour stays the visible Pro differentiator
-- and the PLG badge trigger (D7). Pinned by
-- apps/web/src/lib/__tests__/pricing-matrix.test.ts and
-- apps/web/src/server/__tests__/pro-plus-matrix.test.ts.
-- --------------------------------------------------------------------------
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('community', 'branding', true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- --------------------------------------------------------------------------
-- D19 — anyone may charge an entry fee.
--
-- Knock-on, handled in a later task, NOT here: usecases/stripe-connect.ts gates
-- Connect onboarding on this key with an inline any-pass escape hatch. With
-- community true that gate is now trivially satisfied and the escape hatch is
-- dead weight — simplify it there rather than extracting a helper for it.
-- --------------------------------------------------------------------------
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('community', 'registration.paid', true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- --------------------------------------------------------------------------
-- D20 — the fee ladder. THIS ROW IS LOAD-BEARING AND MUST BE EXPLICIT.
--
-- Community had no registration.fee_percent row at all. feePercentFor
-- (apps/web/src/server/usecases/registrations.ts:62) reads getLimit and falls
-- back to platformFeeDefault() when the value is null OR <= 0; that default is
-- 5 (apps/web/src/lib/platform-settings.ts:15, PLATFORM_FEE_PERCENT env → 5).
-- So "no row" does not mean "no cut", it means EXACTLY THE PASS RATE. Leaving
-- it absent would have shipped a matrix that reads 8/5/2/1 on /pricing while
-- every community org was in fact charged 5% — the pass would discount nothing
-- and the whole D20 story would be a silent no-op.
--
-- The `> 0` part of that fallback also rules out expressing "free" as 0 here;
-- 0 would fall back to 5 as well. Nothing wants 0 today, but a future
-- zero-fee plan needs a resolver change, not a row.
--
-- The other three rows are restated rather than assumed: this is the one place
-- the whole ladder is written down, and a do-update on the current value is a
-- no-op if they already match.
-- --------------------------------------------------------------------------
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('community', 'registration.fee_percent', null, 8),
       ('event_pass', 'registration.fee_percent', null, 5),
       ('pro',        'registration.fee_percent', null, 2),
       ('pro_plus',   'registration.fee_percent', null, 1)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
