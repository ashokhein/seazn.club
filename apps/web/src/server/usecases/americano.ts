import "server-only";
// Americano / Mexicano read model (Jul3/08 §3): the rotation grid + live
// personal-points leaderboard. Personal points = the score a player's pair
// posted, summed across decided fixtures (padel scoring is per-point, not
// win/loss). A disposable projection of the score ledger — reads only.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";

export interface AmericanoMatch {
  fixture_id: string;
  court: number;
  status: string;
  team1: { entrant_id: string; label: string; score: number | null };
  team2: { entrant_id: string; label: string; score: number | null };
}
export interface AmericanoRound {
  round_no: number;
  matches: AmericanoMatch[];
}
export interface AmericanoLeader {
  person_id: string;
  name: string;
  points: number;
  games: number;
}
export interface AmericanoView {
  stage_id: string;
  mode: "americano" | "mexicano";
  rounds: AmericanoRound[];
  leaderboard: AmericanoLeader[];
}

interface FxRow {
  id: string;
  round_no: number | null;
  seq_in_round: number | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  home_score: number | null;
  away_score: number | null;
  home_label: string | null;
  away_label: string | null;
}

export async function americanoView(auth: AuthCtx, stageId: string): Promise<AmericanoView> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ kind: string; config: Record<string, unknown> }[]>`
      select kind, config from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind !== "americano") throw new HttpError(422, "not an americano stage");
    const mode = stage.config.mode === "mexicano" ? "mexicano" : "americano";

    const fixtures = await tx<FxRow[]>`
      select f.id, f.round_no, f.seq_in_round, f.home_entrant_id, f.away_entrant_id, f.status,
             (m.state->'score'->>'home')::numeric as home_score,
             (m.state->'score'->>'away')::numeric as away_score,
             eh.display_name as home_label, ea.display_name as away_label
      from fixtures f
      left join match_states m on m.fixture_id = f.id
      left join entrants eh on eh.id = f.home_entrant_id
      left join entrants ea on ea.id = f.away_entrant_id
      where f.stage_id = ${stageId}
      order by f.round_no, f.seq_in_round`;

    const roundMap = new Map<number, AmericanoMatch[]>();
    for (const f of fixtures) {
      const round = f.round_no ?? 0;
      const list = roundMap.get(round) ?? [];
      list.push({
        fixture_id: f.id,
        court: f.seq_in_round ?? 1,
        status: f.status,
        team1: { entrant_id: f.home_entrant_id ?? "", label: f.home_label ?? "TBD", score: f.home_score },
        team2: { entrant_id: f.away_entrant_id ?? "", label: f.away_label ?? "TBD", score: f.away_score },
      });
      roundMap.set(round, list);
    }
    const rounds: AmericanoRound[] = [...roundMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round_no, matches]) => ({ round_no, matches }));

    // personal points: each player's pair score across decided fixtures.
    const leaders = await tx<{ person_id: string; name: string; points: number; games: number }[]>`
      select em.person_id, p.full_name as name,
             coalesce(sum(
               case when f.home_entrant_id = em.entrant_id
                    then (m.state->'score'->>'home')::numeric
                    else (m.state->'score'->>'away')::numeric end), 0)::int as points,
             count(*)::int as games
      from fixtures f
      join match_states m on m.fixture_id = f.id
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      join persons p on p.id = em.person_id
      where f.stage_id = ${stageId} and f.status in ('decided', 'finalized')
      group by em.person_id, p.full_name
      order by points desc, name`;

    return { stage_id: stageId, mode, rounds, leaderboard: leaders };
  });
}
