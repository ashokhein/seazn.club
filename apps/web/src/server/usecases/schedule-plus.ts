import "server-only";
// Constraints-v2 extras (Jul3/04 §4, §6): bulk shift (undoable) and the
// pre-publish wait-time report. Deterministic solver work only.
import { z } from "zod";
import {
  scheduleReport,
  shiftSchedule,
  type Assignment,
} from "@seazn/engine/scheduling";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendDivisionEvent } from "@/server/engine-db";

const MS_PER_MIN = 60_000;

export const ShiftInput = z.object({
  division_id: z.string().uuid(),
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  delta_minutes: z.number().int().min(-24 * 60).max(24 * 60).refine((n) => n !== 0, "zero shift"),
});
export type ShiftInput = z.infer<typeof ShiftInput>;

/** POST /api/v1/schedule/shift — push everything in scope by ±N minutes
 *  (10 Jun / 5 Sep / 26 Jun). One schedule_shifted ledger event; undoable
 *  via Jul3/03. All plans. */
export async function shiftDivisionSchedule(
  auth: AuthCtx,
  input: ShiftInput,
): Promise<{ shifted: number; skipped: { locked: number; decided: number }; seq: number }> {
  return withTenant(auth.orgId, async (tx) => {
    const divisionId = input.division_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ seq: number }[]>`
      select seq from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const rows = await tx<{
      id: string; stage_id: string; pool_id: string | null; court_label: string | null;
      scheduled_at: string | null; schedule_locked: boolean; status: string;
    }[]>`
      select id, stage_id, pool_id, court_label, scheduled_at::text as scheduled_at,
             schedule_locked, status
      from fixtures where division_id = ${divisionId}`;
    const { moves, skipped } = shiftSchedule(
      rows.map((f) => ({
        id: f.id,
        at: f.scheduled_at,
        court: f.court_label,
        stageId: f.stage_id,
        poolId: f.pool_id ?? undefined,
        locked: f.schedule_locked,
        decided: f.status === "decided",
      })),
      input.scope,
      input.delta_minutes,
    );
    for (const m of moves) {
      await tx`update fixtures set scheduled_at = ${m.to.at} where id = ${m.fixture}`;
    }
    if (moves.length === 0) {
      return { shifted: 0, skipped, seq: division.seq };
    }
    const seq = await appendDivisionEvent(tx, divisionId, "schedule_shifted", {
      delta_minutes: input.delta_minutes,
      scope: input.scope,
      moves,
    });
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return { shifted: moves.length, skipped, seq };
  });
}

/** GET /api/v1/divisions/{id}/schedule/report — min/max wait per entrant
 *  before publish (16 Sep). Derived read model; all plans. */
export async function divisionScheduleReport(auth: AuthCtx, divisionId: string) {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [settings] = await tx<{ config: { matchMinutes?: number } }[]>`
      select config from schedule_settings where division_id = ${divisionId}`;
    const matchMinutes = settings?.config?.matchMinutes ?? 30;
    const rows = await tx<{
      id: string; court_label: string | null; scheduled_at: string;
      home_entrant_id: string | null; away_entrant_id: string | null;
    }[]>`
      select id, court_label, scheduled_at::text as scheduled_at,
             home_entrant_id, away_entrant_id
      from fixtures
      where division_id = ${divisionId} and scheduled_at is not null`;
    const assignments: Assignment[] = rows.map((f) => {
      const start = new Date(f.scheduled_at).getTime();
      return {
        fixtureId: f.id,
        court: f.court_label ?? "",
        startAt: start,
        endAt: start + matchMinutes * MS_PER_MIN,
        entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
        people: [],
      };
    });
    const names = await tx<{ id: string; display_name: string }[]>`
      select id, display_name from entrants where division_id = ${divisionId}`;
    const nameById = new Map(names.map((n) => [n.id, n.display_name]));
    const report = scheduleReport(assignments);
    const label = (r: (typeof report.perEntrant)[number]) => ({
      ...r,
      display_name: nameById.get(r.entrantId) ?? r.entrantId,
    });
    return { perEntrant: report.perEntrant.map(label), worst: report.worst.map(label) };
  });
}
