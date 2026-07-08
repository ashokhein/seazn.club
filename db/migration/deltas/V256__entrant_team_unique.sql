-- ---------------------------------------------------------------------------
-- A team may be enrolled into a given division at most once. Individual/pair
-- entrants (team_id IS NULL) are unconstrained, so the index is partial.
-- Backs the 409 on duplicate enrollment in the unified "Add Entrant" flow.
-- ---------------------------------------------------------------------------
create unique index if not exists entrants_team_division_uq
  on entrants(team_id, division_id)
  where team_id is not null;
