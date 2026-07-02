import { requireOrgRole } from "@/lib/auth";
import { handler } from "@/lib/http";
import {
  listOrgSportPresets,
  slugifySportKey,
} from "@/lib/sport-presets";
import { sql } from "@/lib/db";
import {
  createSportPresetSchema,
  EDITOR_ROLES,
  ORG_ROLES,
  type SportPreset,
} from "@/lib/types";

const PRESET_SELECT = `
  id, org_id, sport_key, sport_name, entity_label, format, result_mode,
  score_label, points_win, points_draw, points_loss, allow_draws,
  use_progress_score, round_minutes, clock_minutes, default_category,
  default_group_rounds, default_knockout_size, is_system, sort_order, created_at
`;

/** List sport presets for an org (seeds defaults on first access). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, ORG_ROLES);
    return listOrgSportPresets(id);
  });
}

/** Create a custom sport preset (editors only). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    await requireOrgRole(id, EDITOR_ROLES);
    const body = createSportPresetSchema.parse(await req.json());

    let sportKey = slugifySportKey(body.sport_name);
    const taken = await sql`
      select 1 from org_sport_presets
      where org_id = ${id} and sport_key = ${sportKey}`;
    if (taken.length > 0) {
      sportKey = `${sportKey}-${Date.now().toString(36).slice(-4)}`;
    }

    const [maxOrder] = await sql<{ max: number | null }[]>`
      select max(sort_order) as max from org_sport_presets where org_id = ${id}`;
    const sortOrder = (maxOrder?.max ?? 0) + 1;

    const [row] = await sql<SportPreset[]>`
      insert into org_sport_presets (
        org_id, sport_key, sport_name, entity_label, format, result_mode,
        score_label, points_win, points_draw, points_loss, allow_draws,
        use_progress_score, round_minutes, clock_minutes, default_category,
        default_group_rounds, default_knockout_size, is_system, sort_order
      ) values (
        ${id}, ${sportKey}, ${body.sport_name}, ${body.entity_label},
        ${body.format}, ${body.result_mode}, ${body.score_label},
        ${body.points_win}, ${body.points_draw}, ${body.points_loss},
        ${body.allow_draws}, ${body.use_progress_score}, ${body.round_minutes},
        ${body.clock_minutes}, ${body.default_category},
        ${body.default_group_rounds}, ${body.default_knockout_size},
        false, ${sortOrder}
      )
      returning ${sql.unsafe(PRESET_SELECT)}`;
    return row;
  });
}
