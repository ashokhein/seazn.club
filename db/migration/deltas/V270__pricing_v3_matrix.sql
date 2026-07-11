-- v3/07 §2 (PROMPT-36) — plan matrix v3. Values CHANGE here, so unlike the
-- v2 seeds this upserts with DO UPDATE. Unchanged dimensions are not repeated.
--   community: 1 active comp (was 2), 2 divisions/comp (was 1)
--   pro: 3 orgs (was 5), unlimited divisions/comp (was 10),
--        256 entrants/div (was 64), 15 members (was 10)
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('community', 'competitions.max_active',       null, 1),
  ('community', 'divisions.per_competition.max', null, 2),
  ('pro',       'orgs.max_owned',                null, 3),
  ('pro',       'divisions.per_competition.max', null, null),
  ('pro',       'entrants.per_division.max',     null, 256),
  ('pro',       'members.max',                   null, 15)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Event Pass (v3/07 §3): a dark plans row so plan_entitlements holds every
-- offer in one table — the pricing page renders Free/Pass/Pro from data, and
-- the resolver reads the pass column for community orgs holding a pass on the
-- competition in scope. Never subscribable; priced one-time via
-- stripe_price_id_onetime (written by stripe:sync).
insert into plans (key, name, is_public) values ('event_pass', 'Event Pass', false)
on conflict (key) do nothing;

alter table plans add column if not exists stripe_price_id_onetime text;

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('event_pass', 'divisions.per_competition.max', null,  10),
  ('event_pass', 'entrants.per_division.max',     null,  32),
  ('event_pass', 'members.max',                   null,  5),
  ('event_pass', 'formats.advanced',              true,  null),
  ('event_pass', 'formats.double_elim',           true,  null),
  ('event_pass', 'registration.enabled',          true,  null),
  ('event_pass', 'registration.paid',             true,  null),
  ('event_pass', 'branding',                      true,  null),
  ('event_pass', 'dashboard.branding',            false, null),
  ('event_pass', 'exports',                       true,  null),
  ('event_pass', 'realtime',                      true,  null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Per-plan platform cut of entry fees (v3/07 §2 fee row): pass 5%, pro 2%.
-- Community has registration.paid=false so no row is needed; the app falls
-- back to PLATFORM_FEE_PERCENT for plans without one.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value) values
  ('event_pass', 'registration.fee_percent', null, 5),
  ('pro',        'registration.fee_percent', null, 2),
  ('business',   'registration.fee_percent', null, 2)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- Grandfather (v3/07 §2): community orgs already over the new 1-active-comp
-- cap keep what they have (capped at the old limit of 2) so the freeze
-- machinery never bites retroactively. Override → pass → plan chain already
-- honours these rows; DO NOTHING keeps any hand-set override authoritative.
insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
select o.id, 'competitions.max_active', least(count(c.id), 2)::int,
       'v3 pricing grandfather (2026-07)'
from organizations o
left join subscriptions s on s.org_id = o.id
join competitions c on c.org_id = o.id and c.status in ('draft', 'published', 'live')
where coalesce(s.plan_key, 'community') = 'community'
group by o.id
having count(c.id) > 1
on conflict (org_id, feature_key) do nothing;
