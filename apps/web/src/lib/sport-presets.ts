import { sql } from "@/lib/db";
import type postgres from "postgres";
import type { SportPreset } from "@/lib/types";

type Db = typeof sql | postgres.TransactionSql;

/** Built-in defaults per sport — used when seeding a new org. */
export const SYSTEM_SPORT_PRESET_DEFS: Omit<
  SportPreset,
  "id" | "org_id" | "created_at"
>[] = [
  {
    sport_key: "chess",
    sport_name: "Chess",
    entity_label: "Players",
    format: "swiss_knockout",
    result_mode: "win_loss",
    score_label: "Score",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: true,
    round_minutes: 30,
    clock_minutes: 15,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 0,
  },
  {
    sport_key: "carrom",
    sport_name: "Carrom",
    entity_label: "Players",
    format: "swiss_knockout",
    result_mode: "win_loss",
    score_label: "Score",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: false,
    round_minutes: 20,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 1,
  },
  {
    sport_key: "football",
    sport_name: "Football",
    entity_label: "Teams",
    format: "round_robin",
    result_mode: "score",
    score_label: "Goals",
    points_win: 3,
    points_draw: 1,
    points_loss: 0,
    allow_draws: true,
    use_progress_score: false,
    round_minutes: 90,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 2,
  },
  {
    sport_key: "cricket",
    sport_name: "Cricket",
    entity_label: "Teams",
    format: "round_robin",
    result_mode: "score",
    score_label: "Runs",
    points_win: 2,
    points_draw: 1,
    points_loss: 0,
    allow_draws: true,
    use_progress_score: false,
    round_minutes: 180,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 3,
  },
  {
    sport_key: "volleyball",
    sport_name: "Volleyball",
    entity_label: "Teams",
    format: "knockout",
    result_mode: "score",
    score_label: "Sets",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: false,
    round_minutes: 45,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 4,
  },
  {
    sport_key: "tabletennis",
    sport_name: "Table Tennis",
    entity_label: "Players",
    format: "knockout",
    result_mode: "score",
    score_label: "Sets",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: false,
    round_minutes: 25,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 5,
  },
  {
    sport_key: "badminton",
    sport_name: "Badminton",
    entity_label: "Players",
    format: "knockout",
    result_mode: "score",
    score_label: "Sets",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: false,
    round_minutes: 30,
    clock_minutes: 0,
    default_category: "adult",
    default_group_rounds: null,
    default_knockout_size: null,
    is_system: true,
    sort_order: 6,
  },
];

const PRESET_SELECT = `
  id, org_id, sport_key, sport_name, entity_label, format, result_mode,
  score_label, points_win, points_draw, points_loss, allow_draws,
  use_progress_score, round_minutes, clock_minutes, default_category,
  default_group_rounds, default_knockout_size, is_system, sort_order, created_at
`;

/**
 * Insert built-in sport presets for an org when none exist yet.
 */
export async function seedDefaultSportPresets(
  db: Db,
  orgId: string,
): Promise<void> {
  const existing = await db`
    select 1 from org_sport_presets where org_id = ${orgId} limit 1`;
  if (existing.length > 0) return;

  for (const def of SYSTEM_SPORT_PRESET_DEFS) {
    await db`
      insert into org_sport_presets (
        org_id, sport_key, sport_name, entity_label, format, result_mode,
        score_label, points_win, points_draw, points_loss, allow_draws,
        use_progress_score, round_minutes, clock_minutes, default_category,
        default_group_rounds, default_knockout_size, is_system, sort_order
      ) values (
        ${orgId}, ${def.sport_key}, ${def.sport_name}, ${def.entity_label},
        ${def.format}, ${def.result_mode}, ${def.score_label},
        ${def.points_win}, ${def.points_draw}, ${def.points_loss},
        ${def.allow_draws}, ${def.use_progress_score}, ${def.round_minutes},
        ${def.clock_minutes}, ${def.default_category},
        ${def.default_group_rounds}, ${def.default_knockout_size},
        ${def.is_system}, ${def.sort_order}
      )`;
  }
}

/** List presets for an org, seeding defaults on first access. */
export async function listOrgSportPresets(orgId: string): Promise<SportPreset[]> {
  await seedDefaultSportPresets(sql, orgId);
  return sql<SportPreset[]>`
    select ${sql.unsafe(PRESET_SELECT)}
    from org_sport_presets
    where org_id = ${orgId}
    order by sort_order, sport_name`;
}

/** Slugify a custom sport name into a sport_key. */
export function slugifySportKey(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base ? `custom-${base}` : `custom-${Date.now().toString(36)}`;
}

/** Reset a system preset row to its built-in defaults. */
export async function resetSystemSportPreset(
  orgId: string,
  sportKey: string,
): Promise<SportPreset | null> {
  const def = SYSTEM_SPORT_PRESET_DEFS.find((d) => d.sport_key === sportKey);
  if (!def) return null;

  const [row] = await sql<SportPreset[]>`
    update org_sport_presets set
      sport_name = ${def.sport_name},
      entity_label = ${def.entity_label},
      format = ${def.format},
      result_mode = ${def.result_mode},
      score_label = ${def.score_label},
      points_win = ${def.points_win},
      points_draw = ${def.points_draw},
      points_loss = ${def.points_loss},
      allow_draws = ${def.allow_draws},
      use_progress_score = ${def.use_progress_score},
      round_minutes = ${def.round_minutes},
      clock_minutes = ${def.clock_minutes},
      default_category = ${def.default_category},
      default_group_rounds = ${def.default_group_rounds},
      default_knockout_size = ${def.default_knockout_size}
    where org_id = ${orgId} and sport_key = ${sportKey} and is_system = true
    returning ${sql.unsafe(PRESET_SELECT)}`;
  return row ?? null;
}
