import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import { sql } from "@/lib/db";
import {
  EDITOR_ROLES,
  updateSportPresetSchema,
  type SportPreset,
} from "@/lib/types";

const PRESET_SELECT = `
  id, org_id, sport_key, sport_name, entity_label, format, result_mode,
  score_label, points_win, points_draw, points_loss, allow_draws,
  use_progress_score, round_minutes, clock_minutes, default_category,
  default_group_rounds, default_knockout_size, is_system, sort_order, created_at
`;

/** Update a sport preset (editors only). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; presetId: string }> },
) {
  return handler(async () => {
    const { id, presetId } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const patch = updateSportPresetSchema.parse(await req.json());

    const [existing] = await sql<SportPreset[]>`
      select ${sql.unsafe(PRESET_SELECT)}
      from org_sport_presets
      where id = ${presetId} and org_id = ${id}`;
    if (!existing) throw new Error("Sport preset not found");

    const next = {
      sport_name: patch.sport_name ?? existing.sport_name,
      entity_label: patch.entity_label ?? existing.entity_label,
      format: patch.format ?? existing.format,
      result_mode: patch.result_mode ?? existing.result_mode,
      score_label: patch.score_label ?? existing.score_label,
      points_win: patch.points_win ?? existing.points_win,
      points_draw: patch.points_draw ?? existing.points_draw,
      points_loss: patch.points_loss ?? existing.points_loss,
      allow_draws: patch.allow_draws ?? existing.allow_draws,
      use_progress_score:
        patch.use_progress_score ?? existing.use_progress_score,
      round_minutes: patch.round_minutes ?? existing.round_minutes,
      clock_minutes: patch.clock_minutes ?? existing.clock_minutes,
      default_category: patch.default_category ?? existing.default_category,
      default_group_rounds:
        patch.default_group_rounds !== undefined
          ? patch.default_group_rounds
          : existing.default_group_rounds,
      default_knockout_size:
        patch.default_knockout_size !== undefined
          ? patch.default_knockout_size
          : existing.default_knockout_size,
    };

    const [row] = await sql<SportPreset[]>`
      update org_sport_presets set
        sport_name = ${next.sport_name},
        entity_label = ${next.entity_label},
        format = ${next.format},
        result_mode = ${next.result_mode},
        score_label = ${next.score_label},
        points_win = ${next.points_win},
        points_draw = ${next.points_draw},
        points_loss = ${next.points_loss},
        allow_draws = ${next.allow_draws},
        use_progress_score = ${next.use_progress_score},
        round_minutes = ${next.round_minutes},
        clock_minutes = ${next.clock_minutes},
        default_category = ${next.default_category},
        default_group_rounds = ${next.default_group_rounds},
        default_knockout_size = ${next.default_knockout_size}
      where id = ${presetId} and org_id = ${id}
      returning ${sql.unsafe(PRESET_SELECT)}`;
    return row;
  });
}

/** Delete a custom sport preset (editors only; system presets cannot be deleted). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; presetId: string }> },
) {
  return handler(async () => {
    const { id, presetId } = await params;
    await requireOrgRole(id, EDITOR_ROLES);

    const [existing] = await sql<SportPreset[]>`
      select is_system from org_sport_presets
      where id = ${presetId} and org_id = ${id}`;
    if (!existing) throw new Error("Sport preset not found");
    if (existing.is_system) {
      throw new Error("Built-in sport presets cannot be deleted — reset instead");
    }

    await sql`
      delete from org_sport_presets
      where id = ${presetId} and org_id = ${id}`;
    return { ok: true };
  });
}
