import "server-only";
// Constraints-v2 extras (Jul3/04 §4–§6): bulk shift (undoable), wait-time
// report, and the AI prose → constraints layer. The model only ever emits a
// Zod-validated constraints object — the deterministic solver does the rest.
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  scheduleReport,
  shiftSchedule,
  type Assignment,
} from "@seazn/engine/scheduling";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendDivisionEvent } from "@/server/engine-db";
import type { ScheduleConfig } from "@/server/api-v1/schemas";

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

// ---------------------------------------------------------------------------
// AI-assisted planning (Jul3/04 §5) — prose → validated constraints. The
// model never writes the DB or a schedule; unparseable output is refused.
// ---------------------------------------------------------------------------

// What the model may emit. Targets are free-text names the organiser used;
// the server resolves them to ids after validation. Times are HH:MM local.
const AiStartWindow = z.object({
  targetKind: z.enum(["entrant", "pool", "division"]),
  targetName: z.string(),
  notBefore: z.string().optional(), // "09:30"
  notAfter: z.string().optional(),
});
const AiConstraints = z.object({
  restMin: z.number().int().optional(),
  noBackToBack: z.boolean().default(false),
  fieldFairness: z.enum(["off", "balance", "rotate"]).default("off"),
  parallelism: z.enum(["block", "mixed"]).default("mixed"),
  crossPersonClash: z.enum(["warn", "hard"]).default("warn"),
  startWindows: z.array(AiStartWindow).default([]),
});
export type AiConstraints = z.infer<typeof AiConstraints>;

const SYSTEM = `You translate a tournament organiser's scheduling wishes into a constraints object.
Rules:
- "no player plays two teams/matches at once", "player in two categories" → crossPersonClash: "hard".
- "at least one break between games", "no back to back" → noBackToBack: true. An explicit "N minutes rest" → restMin: N.
- "team/category X not before HH:MM" or "starts later" → a startWindows entry (targetKind "entrant"/"pool", notBefore, 24h HH:MM).
- A blanket start time with no specific team — "matches start at 9am", "kick off at HH:MM", "everything from HH:MM" → a single startWindows entry with targetKind "division", targetName "all", notBefore in 24h HH:MM (e.g. "09:00").
- "don't keep a team on one field", "alternate fields" → fieldFairness: "balance" (or "rotate" if they ask to rotate every game).
- "divisions play in parallel / mixed" → parallelism: "mixed"; "one division at a time / block" → "block".
- Only include what the organiser asked for. If the prose contains no recognisable scheduling constraint, emit the defaults with an empty startWindows array.`;

/** The LLM call, isolated for tests: prose → AiConstraints (Zod-parsed). */
export async function parseAiConstraints(
  prose: string,
  generate?: (system: string, prose: string) => Promise<unknown>,
): Promise<AiConstraints> {
  if (generate) {
    return AiConstraints.parse(await generate(SYSTEM, prose));
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // Optional feature — fail with a clear message, not the raw SDK auth error.
    throw new HttpError(503, "AI-assisted scheduling isn't set up on this server yet.");
  }
  const client = new Anthropic();
  const response = await client.messages.parse({
    // Overridable without a redeploy; Opus is the default. Prose → schema-
    // constrained JSON works on any tier (zodOutputFormat guarantees shape).
    model: process.env.SCHEDULING_AI_MODEL ?? "claude-opus-4-8",
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: "user", content: prose }],
    output_config: { format: zodOutputFormat(AiConstraints) },
  });
  if (!response.parsed_output) {
    // Jul3/04 §5: unparseable output is refused, never guessed.
    throw new HttpError(422, "could not derive constraints from that description");
  }
  return response.parsed_output;
}

export interface AiConstraintsOut {
  constraints: NonNullable<ScheduleConfig["constraints"]>;
  unresolved: { kind: string; name: string }[];
}

/** POST /divisions/{id}/schedule/ai-constraints — propose only; the organiser
 *  reviews and applies via schedule-settings (Pro `scheduling.ai`). */
export async function aiConstraintsForDivision(
  auth: AuthCtx,
  divisionId: string,
  prose: string,
  generate?: (system: string, prose: string) => Promise<unknown>,
): Promise<AiConstraintsOut> {
  await requireFeature(auth.orgId, "scheduling.ai");
  const parsed = await parseAiConstraints(prose, generate);

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ id: string; slug: string; name: string }[]>`
      select id, slug, name from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const entrants = await tx<{ id: string; display_name: string }[]>`
      select id, display_name from entrants where division_id = ${divisionId}`;
    const pools = await tx<{ id: string; key: string; name: string }[]>`
      select p.id, p.key, p.name from pools p
      join stages s on s.id = p.stage_id where s.division_id = ${divisionId}`;
    const [settings] = await tx<{ config: { startAt?: string | null } }[]>`
      select config from schedule_settings where division_id = ${divisionId}`;
    const baseDate = settings?.config?.startAt
      ? new Date(settings.config.startAt).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const fold = (s: string) => s.trim().toLowerCase();
    const unresolved: { kind: string; name: string }[] = [];
    const startWindows: NonNullable<ScheduleConfig["constraints"]>["startWindows"] = [];
    for (const w of parsed.startWindows) {
      let id: string | null = null;
      if (w.targetKind === "entrant") {
        id = entrants.find((e) => fold(e.display_name) === fold(w.targetName))?.id ?? null;
      } else if (w.targetKind === "pool") {
        id = pools.find((p) => fold(p.key) === fold(w.targetName) || fold(p.name) === fold(w.targetName))?.id ?? null;
      } else {
        // A division-level window applies to the whole division — the name is
        // just a hint ("all" / the division name), so always target this one.
        id = division.id;
      }
      if (id === null) {
        unresolved.push({ kind: w.targetKind, name: w.targetName });
        continue;
      }
      const toIso = (hhmm: string | undefined) =>
        hhmm !== undefined && /^\d{1,2}:\d{2}$/.test(hhmm)
          ? `${baseDate}T${hhmm.padStart(5, "0")}:00.000Z`
          : undefined;
      const notBefore = toIso(w.notBefore);
      const notAfter = toIso(w.notAfter);
      startWindows.push({
        target: { kind: w.targetKind, id },
        ...(notBefore !== undefined ? { notBefore } : {}),
        ...(notAfter !== undefined ? { notAfter } : {}),
      });
    }
    return {
      constraints: {
        ...(parsed.restMin !== undefined ? { restMin: parsed.restMin } : {}),
        noBackToBack: parsed.noBackToBack,
        fieldFairness: parsed.fieldFairness,
        parallelism: parsed.parallelism,
        crossPersonClash: parsed.crossPersonClash,
        startWindows,
      },
      unresolved,
    };
  });
}
