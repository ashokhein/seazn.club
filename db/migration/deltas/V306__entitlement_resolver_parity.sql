-- V306 — the SQL resolver catches up with lib/entitlements.ts.
--
-- V228 was accurate when written. Every mechanism it misses arrived later:
-- override expiry + comped_until (V266), Event Pass (V270/V271), the past_due
-- anchor (V291). Until now a lapsed comp or an expired staff override kept
-- granting Pro on every public page, and a paid Event Pass granted nothing.
--
-- security definer + a pinned search_path so the competition_passes read is not
-- RLS-filtered if this is ever called from a withTenant transaction. The
-- search_path repeats the repo-wide definer convention verbatim —
-- `${flyway:defaultSchema}, public, extensions, pg_temp`, the same shape the
-- V226 hash-chain functions use. Two parts are load-bearing:
--   * the FIRST element is the Flyway default schema placeholder, NOT a literal
--     `public`: the app lives in seazn_club (db/flyway.toml, scripts/flyway.sh
--     -defaultSchema), and a literal would make the function resolve tables in
--     the wrong schema and silently return false for everything;
--   * pg_temp is named LAST on purpose. When it is not named at all Postgres
--     searches it FIRST, so any session able to `create temp table
--     plan_entitlements` (or subscriptions / org_entitlement_overrides /
--     competition_passes) could shadow the real table inside this definer
--     function and dictate what it returns.
--
-- The live-subscription status list is copied from
-- apps/web/src/lib/subscription-status.ts (LIVE_SUBSCRIPTION_STATUSES =
-- trialing, active, past_due). Keep the two in step — the parity suite
-- apps/web/src/lib/__tests__/entitlements-sql-parity.test.ts is the tie.

-- NO DEFAULT on p_competition_id, deliberately. A defaulted third parameter
-- would make every surviving 2-arg call ambiguous ("function
-- org_has_feature(uuid, text) is not unique"), and the 2-arg form cannot simply
-- be dropped here: public_players_v still depends on it (its gate sits over
-- `from persons p`, with no competition in scope — moved to the caller in a
-- later task), and so does server/public-site/data.ts. Instead the 2-arg form
-- becomes a thin delegating wrapper (below), so both arities coexist
-- unambiguously and callers migrate one task at a time.
create or replace function org_has_feature(
  p_org_id uuid,
  p_feature_key text,
  p_competition_id uuid
) returns boolean
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, public, extensions, pg_temp as $$
    with plan as (
      select case
        -- Mirrors entitlements.ts — a comp past its end date resolves as
        -- community unless a LIVE subscription still owns the plan. coalesce is
        -- load-bearing: a bare NOT IN over a null status yields NULL, not true.
        when s.comped_until is not null and s.comped_until <= now()
             and (s.stripe_subscription_id is null
                  or coalesce(s.status, '') not in
                     ('trialing', 'active', 'past_due'))
             then 'community'
        -- Mirrors entitlements.ts — dunning gets 14 days from the TRANSITION,
        -- not from the last retry (status_changed_at, coalesced for rows the
        -- V291 backfill never saw).
        when s.status = 'past_due'
             and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
             then 'community'
        else coalesce(s.plan_key, 'community')
      end as plan_key
      from organizations o
      left join subscriptions s on s.org_id = o.id
      where o.id = p_org_id
    )
    select coalesce(
      -- Override wins, but only while it is alive, and only field by field: a
      -- row that answers the INT question with a null bool_value is NOT a deny,
      -- it is no answer, and falls through.
      (select bool_value from org_entitlement_overrides
        where org_id = p_org_id and feature_key = p_feature_key
          and (expires_at is null or expires_at > now())),
      -- Event Pass: community orgs only, competition in scope. A key absent
      -- from the pass matrix falls through to the plan row rather than denying.
      (select pe.bool_value
         from competition_passes cp
         join plan_entitlements pe
           on pe.plan_key = cp.pass_key and pe.feature_key = p_feature_key
        where p_competition_id is not null
          and cp.competition_id = p_competition_id
          and cp.org_id = p_org_id
          and (select plan_key from plan) = 'community'),
      (select pe.bool_value from plan_entitlements pe
        where pe.feature_key = p_feature_key
          and pe.plan_key = (select plan_key from plan)),
      false)
  $$;

-- Dependent views move to the 3-arg form so a paid Event Pass is visible to the
-- public read model. Each body is copied VERBATIM from its effective source —
-- public_competitions_v from v2-engine/views/V230, public_entrants_v from
-- deltas/V289 (which supersedes V236 and V242), public_discovery_v from
-- v2-engine/views/V238 — with the ONLY change being the third argument on each
-- org_has_feature call, using the competition id already in scope.
-- create-or-replace may only APPEND columns, so no column is added, removed or
-- reordered here.

create or replace view public_competitions_v as
  select id, org_id, name, slug, description, starts_on, ends_on,
         case when org_has_feature(org_id, 'dashboard.branding', id) then branding
              else '{}'::jsonb end as branding,
         status, created_at, visibility
  from competitions
  where visibility in ('public','unlisted');

create or replace view public_entrants_v as
  select e.id, e.division_id, e.kind, e.display_name, e.seed, e.status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
              'name',  public_person_name(p.full_name, p.consent),
              'photo', case when coalesce((p.consent->>'public_photo')::boolean, false)
                             and org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)
                            then p.photo_path else null end,
              'person_id', case when coalesce((p.consent->>'public_name')::boolean, false)
                                 and org_has_feature(c.org_id, 'dashboard.player_profiles', c.id)
                                then p.id else null end,
              'squad_number', em.squad_number,
              'position', em.default_position_key)
              order by em.squad_number nulls last, p.full_name)
            from entrant_members em
            join persons p on p.id = em.person_id
            where em.entrant_id = e.id),
           '[]'::jsonb) as members,
         case when e.team_id is not null then
           (select jsonb_build_object(
              'club_id',    td.club_id,
              'club_name',  td.club_name,
              'logo_path',  td.logo_path,
              'colors',     td.colors)
            from team_display_v td where td.team_id = e.team_id)
         end as team_display,
         e.badge_url
  from entrants e
  join divisions d    on d.id = e.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted')
    and e.status in ('registered','confirmed');

create or replace view public_discovery_v as
select c.id,
       c.name,
       c.slug,
       c.starts_on,
       c.ends_on,
       c.status,
       c.created_at,
       c.discovery->>'city'    as city,
       c.discovery->>'country' as country,
       -- Presentation depth is the paid layer (doc 15 §5).
       case when org_has_feature(c.org_id, 'discovery.branding', c.id)
            then c.discovery->>'tagline' end as tagline,
       case when org_has_feature(c.org_id, 'discovery.branding', c.id)
            then c.discovery->>'hero_image_path' end as hero_image_path,
       -- Staff-curated featured flag, honoured only while the org holds the
       -- Pro perk (doc 15 §3 — eligible, not guaranteed).
       (c.discovery_featured
         and org_has_feature(c.org_id, 'discovery.featured', c.id)) as featured,
       o.name as org_name,
       o.slug as org_slug,
       (select array_agg(distinct d.sport_key)
          from divisions d where d.competition_id = c.id)     as sports,
       (select count(*)::int from entrants e
          join divisions d on d.id = e.division_id
         where d.competition_id = c.id
           and e.status in ('registered','confirmed'))        as entrant_count,
       (select count(*)::int from fixtures f
         where f.division_id in (select id from divisions d where d.competition_id = c.id)
           and f.status = 'in_play')                          as in_play_count,
       (select min(f.scheduled_at) from fixtures f
          join divisions d on d.id = f.division_id
         where d.competition_id = c.id
           and d.status <> 'setup'                            -- publish-gated (doc 12 §1)
           and f.status = 'scheduled'
           and f.scheduled_at >= now())                       as next_fixture_at
from competitions c
join organizations o on o.id = c.org_id
where c.discoverable
  and c.visibility = 'public'
  and not c.discovery_blocked
  and o.status = 'active'
  -- Quality floor (doc 15 §3): email-verified owner…
  and exists (select 1 from org_members m join users u on u.id = m.user_id
               where m.org_id = o.id and m.role = 'owner' and u.email_verified)
  -- …and ≥1 decided fixture or a published schedule (division past setup).
  and (exists (select 1 from fixtures f join divisions d on d.id = f.division_id
                where d.competition_id = c.id
                  and f.status in ('decided','finalized'))
    or exists (select 1 from divisions d
                where d.competition_id = c.id
                  and d.status in ('scheduled','active','completed')));

-- public_players_v is deliberately NOT touched: its gate sits over
-- `from persons p` with no competition column, and pushing the gate inward
-- would mean one Event Pass exposes a person across every unpaid competition.
-- That gate moves to its caller in a later task; until then it keeps calling
-- the 2-arg wrapper.

-- Event Pass gains branded exports (spec D6). Inert until the exports use case
-- threads its competitionId — both land in this branch.
insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
values ('event_pass', 'exports.branded', true, null)
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;

-- The 2-arg form survives as a delegating wrapper so nothing breaks mid-branch.
-- It is NOT a second resolver: it forwards to the one above with no competition
-- in scope, which is exactly what an org-level question means. It is removed
-- once nothing calls it.
create or replace function org_has_feature(p_org_id uuid, p_feature_key text)
  returns boolean
  language sql stable security definer
  set search_path = ${flyway:defaultSchema}, public, extensions, pg_temp as $$
    select org_has_feature(p_org_id, p_feature_key, null::uuid)
  $$;
