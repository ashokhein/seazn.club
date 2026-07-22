-- V307 — the player-card entitlement gate leaves public_players_v.
--
-- V306 made org_has_feature pass-aware by taking a competition id, and moved
-- public_competitions_v / public_entrants_v / public_discovery_v onto the 3-arg
-- form. public_players_v could not follow: its gate sits over `from persons p`,
-- and the view HAS no competition column because a person plays in many
-- competitions. The only competition reference is inside the correlated
-- exists() BELOW the gate, and pushing the gate in there would change what it
-- asserts — from "this org is entitled" to "*some* competition this person
-- appears in is entitled". One Event Pass would then have exposed that person
-- across every unpaid competition in the org, which is the precise leak the
-- pass-aware resolver exists to avoid.
--
-- So the gate moves OUT, to the single consumer that already knows which
-- competition is being viewed: getPublicPlayer (server/public-site/data.ts),
-- which now calls hasFeature(org, 'dashboard.player_profiles', competition)
-- OUTSIDE its unstable_cache closure — entitlement changes do not bust a
-- `competition:{id}` tag, so a gate inside the closure would stay frozen for a
-- whole revalidate window.
--
-- The view's contract NARROWS to consent + public visibility. Body copied
-- verbatim from v2-engine/views/V237__view_public_players.sql with exactly one
-- line deleted (the org_has_feature predicate); the column list is untouched,
-- because create-or-replace may only APPEND columns and a reordered list either
-- fails outright or silently changes a public API. The 2-arg org_has_feature
-- wrapper stays — data.ts still calls it for the org-wide `realtime` reads.
-- V239's grant on this view is unaffected.
create or replace view public_players_v as
  select p.id, p.org_id, p.full_name as name,
         case when coalesce((p.consent->>'public_photo')::boolean, false)
              then p.photo_path else null end as photo
  from persons p
  where coalesce((p.consent->>'public_name')::boolean, false)
    and exists (
      select 1 from entrant_members em
      join entrants e     on e.id = em.entrant_id
      join divisions d    on d.id = e.division_id
      join competitions c on c.id = d.competition_id
      where em.person_id = p.id
        and c.visibility in ('public','unlisted')
        and e.status in ('registered','confirmed'));
