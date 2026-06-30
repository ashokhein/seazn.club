import { sql } from "@/lib/db";
import { getActiveOrgId, requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { withinLimit } from "@/lib/entitlements";
import { writeAudit } from "@/lib/tournament";
import { trackEvent } from "@/lib/activation";
import {
  EDITOR_ROLES,
  createTournamentSchema,
  type Tournament,
} from "@/lib/types";

export async function POST(req: Request) {
  return handler(async () => {
    const orgId = await getActiveOrgId();
    if (!orgId) throw new Error("Select or create an organization first");
    const { user } = await requireOrgRole(orgId, EDITOR_ROLES);
    const input = createTournamentSchema.parse(await req.json());

    // Guard: the chosen season (if any) must belong to the active org.
    if (input.season_id) {
      const ok = await sql`
        select 1 from seasons where id = ${input.season_id} and org_id = ${orgId}`;
      if (ok.length === 0) throw new Error("Unknown season for this organization");
    }

    // Entitlement checks
    const { ok: playersOk, limit: playersLimit } = await withinLimit(
      orgId,
      "players.max",
      input.players.length,
    );
    if (!playersOk)
      throw new HttpError(
        402,
        `Player limit is ${playersLimit} on your current plan. Upgrade to Pro for up to 256 players.`,
      );

    if (input.season_id) {
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count from tournaments where season_id = ${input.season_id}`;
      const { ok, limit } = await withinLimit(
        orgId,
        "tournaments.per_season.max",
        count + 1,
      );
      if (!ok)
        throw new HttpError(
          402,
          `Tournament limit per season is ${limit} on your current plan. Upgrade to Pro for unlimited tournaments.`,
        );
    }

    const id = await sql.begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`
        insert into tournaments
          (org_id, season_id, created_by, sport, name, category, format,
           num_group_rounds, knockout_size, result_mode, score_label,
           points_win, points_draw, points_loss, allow_draws,
           use_progress_score, starts_at, round_minutes, clock_minutes,
           venue, status)
        values
          (${orgId}, ${input.season_id ?? null}, ${user.id}, ${input.sport},
           ${input.name}, ${input.category}, ${input.format},
           ${input.num_group_rounds}, ${input.knockout_size},
           ${input.result_mode}, ${input.score_label}, ${input.points_win},
           ${input.points_draw}, ${input.points_loss}, ${input.allow_draws},
           ${input.use_progress_score}, ${input.starts_at ?? null},
           ${input.round_minutes}, ${input.clock_minutes},
           ${input.venue ?? null}, 'setup')
        returning id`;

      const rows = input.players.map((p, i) => {
        const name = typeof p === "string" ? p : p.name;
        const image = typeof p === "string" ? null : p.image_url ?? null;
        return {
          tournament_id: t.id,
          name: name.trim(),
          seed: i + 1,
          image_url: image && image.trim() ? image.trim() : null,
        };
      });
      await tx`insert into players ${tx(
        rows,
        "tournament_id",
        "name",
        "seed",
        "image_url",
      )}`;
      await writeAudit(
        tx,
        t.id,
        user.display_name,
        "create",
        `Created "${input.name}" — ${input.sport}, ${rows.length} entrants`,
        { sport: input.sport, format: input.format, players: rows.length },
      );
      return t.id;
    });

    const [[tournament], players] = await Promise.all([
      sql<Tournament[]>`select * from tournaments where id = ${id}`,
      sql<{ id: string; name: string; seed: number }[]>`
        select id, name, seed from players where tournament_id = ${id} order by seed`,
    ]);

    // Count BEFORE this insert (we just inserted, so count is now ≥ 1).
    // If count = 1, this is the first tournament for the org.
    const [{ cnt }] = await sql<{ cnt: number }[]>`
      select count(*)::int as cnt from tournaments where org_id = ${orgId}`;
    if (cnt === 1) {
      void trackEvent(user.id, orgId, "first_tournament_created", {
        sport: input.sport,
        format: input.format,
      });
    }

    return { ...tournament, players };
  });
}
