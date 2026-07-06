-- ---------------------------------------------------------------------------
-- RLS policies for app_user
-- All policies are PERMISSIVE (default). A row is visible/writable if ANY
-- policy allows it. Superuser sessions see everything (bypasses RLS).
-- ---------------------------------------------------------------------------

-- organizations: accessible when it is the active org
create policy orgs_tenant on organizations
  for all to app_user
  using (id = current_org_id())
  with check (id = current_org_id());

-- org_members: accessible when they belong to the active org
create policy org_members_tenant on org_members
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- org_invites: accessible within the active org
create policy org_invites_tenant on org_invites
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- org_sport_presets: scoped to active org
create policy org_sport_presets_tenant on org_sport_presets
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- seasons: scoped to active org
create policy seasons_tenant on seasons
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- tournaments: scoped to active org
create policy tournaments_tenant on tournaments
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- players / rounds / matches / match_events / audit_log:
-- denormalize org_id onto these hot tables so the policy is a cheap index scan,
-- not a join. Until that migration lands, use a sub-select to the parent tournament.
create policy players_tenant on players
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy rounds_tenant on rounds
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy matches_tenant on matches
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy match_events_tenant on match_events
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );

create policy audit_log_tenant on audit_log
  for all to app_user
  using (
    tournament_id in (
      select id from tournaments where org_id = current_org_id()
    )
  );
