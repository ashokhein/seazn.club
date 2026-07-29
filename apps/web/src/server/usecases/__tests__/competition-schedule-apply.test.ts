// #350 Task 6 — applyCompetitionSchedule acceptance: ONE transaction writes
// every selected division's assignments, or none of them.
//
// Everything in this product's apply path is single-division today (one
// advisory lock, one seq assertion, one seq bump), and the board orchestrates a
// multi-division apply by calling the per-stage endpoint in a loop — so a
// failure halfway through leaves half the board written. Spec §8 requires the
// opposite, and "a stale expected_seq on the SECOND division rolls back the
// FIRST" is the test that can tell the two apart.
//
// THE SEED IS DELIBERATELY ASYMMETRIC (Alpha 6 fixtures, Bravo 3): two
// identically-sized divisions cannot distinguish per-division data from
// first-division-wins.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { schedulingAiModel } from "../schedule-ai";
import { JOINT_APPLY_EVENT, lastCompetitionAiApply } from "../competition-schedule-ai";
import {
  applyCompetitionSchedule,
  lockDivisions,
  lockOrder,
  type CompetitionApplyDivision,
} from "../competition-schedule-apply";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const T0 = Date.parse("2026-08-01T09:00:00.000Z");
const MIN = 60_000;
const TZ = "Europe/London";
const at = (offsetMin: number): string => new Date(T0 + offsetMin * MIN).toISOString();

/** Wide session window, no constraints: a well-spaced board verifies clean, so
 *  any conflict a test sees is the one that test seeded. */
function settingsConfig(courts: string[]) {
  return {
    startAt: at(0),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [{ from: at(0), to: at(720) }],
  };
}

interface SeededDivision {
  id: string;
  name: string;
  /** Fixture ids in (round_no, seq_in_round) order. */
  fixtureIds: string[];
}

interface Board {
  competitionId: string;
  alpha: SeededDivision;
  bravo: SeededDivision;
}

async function seedDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
  entrants: number,
  courts: string[],
): Promise<SeededDivision> {
  const slug = name.toLowerCase();
  const division = await createDivision(auth, competitionId, {
    name,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `${slug}-E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const ordered = [...fixtures].sort(
    (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
  );
  return { id: division.id, name, fixtureIds: ordered.map((f) => f.id) };
}

/** Alpha: 4 entrants -> 6 round-robin fixtures. Bravo: 3 -> 3. Both own
 *  "Court 1", which is what makes a cross-division clash expressible at all
 *  (court identity across divisions is a string match and nothing else). */
async function seedBoard(auth: AuthCtx): Promise<Board> {
  const comp = await createCompetition(auth, {
    name: `Joint Apply Cup ${Date.now()}`,
    visibility: "public",
    branding: {},
  });
  const alpha = await seedDivision(auth, comp.id, "Alpha", 4, ["Court 1", "Court 2"]);
  const bravo = await seedDivision(auth, comp.id, "Bravo", 3, ["Court 1", "Court 3"]);
  return { competitionId: comp.id, alpha, bravo };
}

async function divisionSeq(divisionId: string): Promise<number> {
  const [row] = await sql<{ seq: string | number }[]>`
    select seq from divisions where id = ${divisionId}`;
  return Number(row?.seq ?? 0);
}

async function eventCount(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${divisionId}`;
  return row!.n;
}

async function maxEventSeq(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select coalesce(max(seq), 0)::int as n from division_events where division_id = ${divisionId}`;
  return row!.n;
}

async function slots(
  divisionId: string,
): Promise<{ id: string; at: string | null; court: string | null; source: string | null }[]> {
  const rows = await sql<
    { id: string; scheduled_at: Date | null; court_label: string | null; schedule_source: string | null }[]
  >`
    select id, scheduled_at, court_label, schedule_source from fixtures
    where division_id = ${divisionId}
    order by round_no, seq_in_round, id`;
  return rows.map((r) => ({
    id: r.id,
    at: r.scheduled_at === null ? null : new Date(r.scheduled_at).toISOString(),
    court: r.court_label,
    source: r.schedule_source,
  }));
}

/** Every fixture still unplaced — "nothing was written". */
const unplaced = (rows: Awaited<ReturnType<typeof slots>>): boolean =>
  rows.every((r) => r.at === null && r.court === null);

/** Sequential slots on one court, starting at `startMin`. */
function lineUp(
  division: SeededDivision,
  expectedSeq: number,
  court: string,
  startMin: number,
): CompetitionApplyDivision {
  return {
    division_id: division.id,
    expected_seq: expectedSeq,
    assignments: division.fixtureIds.map((fixture_id, i) => ({
      fixture_id,
      scheduled_at: at(startMin + i * 30),
      court_label: court,
    })),
  };
}

const AI = {
  instruction: "  Fit both divisions into the morning.  ",
  summary: "Alpha on Court 1, Bravo on Court 3.",
  model: "not-the-model-that-ran",
  repair_rounds: 1,
};

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("applyCompetitionSchedule (#350)", () => {
  let auth: AuthCtx;
  let board: Board;

  beforeEach(async () => {
    if (!HAS_DB) return;
    ({ auth } = await seedOrg("pro"));
    board = await seedBoard(auth);
  }, 90_000);

  const clean = async (): Promise<{ alpha: CompetitionApplyDivision; bravo: CompetitionApplyDivision }> => ({
    alpha: lineUp(board.alpha, await divisionSeq(board.alpha.id), "Court 1", 0),
    bravo: lineUp(board.bravo, await divisionSeq(board.bravo.id), "Court 3", 0),
  });

  it("writes every division's assignments in one go", async () => {
    const { alpha, bravo } = await clean();
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    // 6 + 3 — asymmetric on purpose: a symmetric board cannot tell a real
    // per-division write from the first division's write repeated.
    expect(out.applied).toBe(9);

    const alphaRows = await slots(board.alpha.id);
    expect(alphaRows.map((r) => r.at)).toEqual(alpha.assignments.map((a) => a.scheduled_at));
    expect(alphaRows.map((r) => r.court)).toEqual(alpha.assignments.map(() => "Court 1"));
    expect(alphaRows.map((r) => r.source)).toEqual(alpha.assignments.map(() => "ai"));

    const bravoRows = await slots(board.bravo.id);
    expect(bravoRows).toHaveLength(3);
    expect(bravoRows.map((r) => r.at)).toEqual(bravo.assignments.map((a) => a.scheduled_at));
    expect(bravoRows.map((r) => r.court)).toEqual(bravo.assignments.map(() => "Court 3"));
    expect(bravoRows.map((r) => r.source)).toEqual(bravo.assignments.map(() => "ai"));

    // A clean, well-spaced board: no conflict is invented.
    expect(out.conflicts).toEqual([]);
  }, 60_000);

  it("a stale expected_seq on the SECOND division rolls back the FIRST", async () => {
    // Run BOTH directions. Whichever division the implementation happens to
    // write first, one of these two cases is a genuine rollback assertion — a
    // one-directional version passes vacuously the day the write order flips.
    for (const stale of ["alpha", "bravo"] as const) {
      ({ auth } = await seedOrg("pro"));
      board = await seedBoard(auth);
      const { alpha, bravo } = await clean();
      const poison = (d: CompetitionApplyDivision): CompetitionApplyDivision => ({
        ...d,
        expected_seq: d.expected_seq + 7,
      });
      await expect(
        applyCompetitionSchedule(auth, board.competitionId, {
          divisions: [stale === "alpha" ? poison(alpha) : alpha, stale === "bravo" ? poison(bravo) : bravo],
          source: "ai",
          ai: AI,
        }),
      ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });

      // NOTHING is written — including the division whose seq was fine.
      expect(unplaced(await slots(board.alpha.id))).toBe(true);
      expect(unplaced(await slots(board.bravo.id))).toBe(true);
      // …and no ledger row survives either.
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from division_events
        where division_id in (${board.alpha.id}, ${board.bravo.id})
          and type = 'schedule_applied'`;
      expect(row!.n).toBe(0);
    }
  }, 120_000);

  it("a cross-division court clash is a 409 and writes nothing", async () => {
    const { alpha } = await clean();
    // Bravo lands on Court 1 at exactly Alpha's first three slots.
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), "Court 1", 0);
    let caught: unknown;
    try {
      await applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      });
    } catch (err) {
      caught = err;
    }
    expect(EngineError.is(caught)).toBe(true);
    // SCHEDULE_CONFLICT is 409 in the /api/v1 engine-code map.
    expect((caught as EngineError).code).toBe("SCHEDULE_CONFLICT");
    const conflicts = (caught as EngineError).data as { conflicts: { fixtureId: string; reason: string }[] };
    expect(conflicts.conflicts.some((c) => c.reason === "court")).toBe(true);
    // Both SIDES of the clash are named — the report must not collapse a
    // cross-division clash onto whichever division verified first.
    const clashing = new Set(
      conflicts.conflicts.filter((c) => c.reason === "court").map((c) => c.fixtureId),
    );
    expect([...clashing].some((id) => board.alpha.fixtureIds.includes(id))).toBe(true);
    expect([...clashing].some((id) => board.bravo.fixtureIds.includes(id))).toBe(true);

    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("a locked division aborts the whole apply", async () => {
    const { alpha, bravo } = await clean();
    await sql`update divisions set schedule_locked = true where id = ${board.bravo.id}`;
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
      // The code pins WHICH 422 — a bare status would be satisfied by any of
      // the four other refusals in this path.
    ).rejects.toMatchObject({ status: 422, code: "SCHEDULE_LOCKED" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("a court held by a division OUTSIDE the run still blocks the apply", async () => {
    // The run's own divisions are re-planned together; every OTHER division of
    // the competition is fixed occupancy nobody in this apply can move. Drop it
    // from the board and a joint apply cheerfully double-books a real, already
    // scheduled fixture — and reports success.
    const charlie = await seedDivision(auth, board.competitionId, "Charlie", 3, ["Court 1"]);
    await sql`
      update fixtures set scheduled_at = ${at(0)}, court_label = 'Court 1'
      where id = ${charlie.fixtureIds[0]!}`;
    const { alpha, bravo } = await clean();
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
  }, 60_000);

  it("a fixture the apply does not list is still fixed occupancy in its own division", async () => {
    // Alpha's last fixture keeps its existing slot and is left out of the
    // request. It is movable, so it is not an obstacle by status — it is one
    // because this apply is not moving it.
    const held = board.alpha.fixtureIds[5]!;
    await sql`
      update fixtures set scheduled_at = ${at(0)}, court_label = 'Court 2'
      where id = ${held}`;
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), "Court 3", 0);
    const alpha: CompetitionApplyDivision = {
      division_id: board.alpha.id,
      expected_seq: await divisionSeq(board.alpha.id),
      // The first listed fixture is aimed straight at the held slot.
      assignments: board.alpha.fixtureIds
        .filter((id) => id !== held)
        .map((fixture_id, i) => ({
          fixture_id,
          scheduled_at: at(i * 30),
          court_label: "Court 2",
        })),
    };
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    // …and the held fixture is exactly where it was.
    const rows = await slots(board.alpha.id);
    expect(rows.find((r) => r.id === held)!.at).toBe(at(0));
  }, 60_000);

  it("every division's seq is bumped exactly once on success", async () => {
    const { alpha, bravo } = await clean();
    const before = {
      alpha: { seq: await divisionSeq(board.alpha.id), events: await eventCount(board.alpha.id) },
      bravo: { seq: await divisionSeq(board.bravo.id), events: await eventCount(board.bravo.id) },
    };
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    for (const [key, division] of [
      ["alpha", board.alpha],
      ["bravo", board.bravo],
    ] as const) {
      // exactly one new ledger row…
      expect(await eventCount(division.id)).toBe(before[key].events + 1);
      // …the division's seq moved…
      const after = await divisionSeq(division.id);
      expect(after).toBeGreaterThan(before[key].seq);
      // …and it moved TO the new row's seq, not past it.
      expect(after).toBe(await maxEventSeq(division.id));
    }
  }, 60_000);

  it("a schedule_applied event is appended per division carrying the shared ai audit", async () => {
    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    for (const [division, moves] of [
      [board.alpha, 6],
      [board.bravo, 3],
    ] as const) {
      const rows = await sql<
        {
          payload: {
            source?: string;
            moves?: unknown[];
            ai?: { instruction?: string; summary?: string; model?: string; repair_rounds?: number };
          };
        }[]
      >`
        select payload from division_events
        where division_id = ${division.id} and type = 'schedule_applied'`;
      expect(rows).toHaveLength(1);
      const p = rows[0]!.payload;
      expect(p.source).toBe("ai");
      // Asymmetric: 6 moves for Alpha, 3 for Bravo.
      expect(p.moves).toHaveLength(moves);
      expect(p.ai?.summary).toBe(AI.summary);
      // Trimmed at the seam, exactly as applySchedule trims it.
      expect(p.ai?.instruction).toBe("Fit both divisions into the morning.");
      expect(p.ai?.repair_rounds).toBe(1);
      // The RUNTIME model, never the client's — SCHEDULING_AI_MODEL can override
      // what actually ran, so trusting the request would misrecord the audit.
      expect(p.ai?.model).toBe(schedulingAiModel());
      expect(p.ai?.model).not.toBe(AI.model);
    }
  }, 60_000);

  it("each division is judged by its OWN settings, and warnings come back in full", async () => {
    // `validateAssignments` takes ONE scalar config, and a joint run's divisions
    // legitimately differ on every field of it. Merging them is wrong in both
    // directions and silently so — a merged blackout blacks out a division that
    // never had one. Bravo gets an 11:00-12:00 blackout; Alpha does not.
    await sql`
      update schedule_settings
      set config = ${sql.json({
        ...settingsConfig(["Court 1", "Court 3"]),
        blackouts: [{ from: at(120), to: at(180) }],
      })}
      where division_id = ${board.bravo.id}`;
    const alpha = lineUp(board.alpha, await divisionSeq(board.alpha.id), "Court 2", 120);
    const bravo = lineUp(board.bravo, await divisionSeq(board.bravo.id), "Court 3", 120);
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    // R13: a blackout is a WARNING. It does not block, and it is returned in
    // full rather than filtered away — downstream is the last line of defence.
    expect(out.applied).toBe(9);
    const blackouts = out.conflicts.filter((c) => c.reason === "blackout");
    expect(blackouts.length).toBeGreaterThan(0);
    for (const c of blackouts) expect(board.bravo.fixtureIds).toContain(c.fixtureId);
    // …and Alpha, sitting at the very same instants, is NOT charged Bravo's
    // blackout. That is the half a merged config would get wrong.
    for (const id of board.alpha.fixtureIds) {
      expect(blackouts.some((c) => c.fixtureId === id)).toBe(false);
    }
  }, 60_000);

  it("locks are taken in sorted division-id order", async () => {
    // Sorting is the DEADLOCK GUARD: two concurrent joint applies over
    // overlapping division sets that lock in different orders deadlock.
    const ids = [
      "ffffffff-0000-4000-8000-000000000003",
      "11111111-0000-4000-8000-000000000001",
      "88888888-0000-4000-8000-000000000002",
    ];
    const sorted = [...ids].sort();
    expect(lockOrder(ids)).toEqual(sorted);
    // Duplicates collapse — a repeated division must not be locked twice.
    expect(lockOrder([...ids, ids[0]!])).toEqual(sorted);
    // The input is never mutated in place.
    const copy = [...ids];
    lockOrder(copy);
    expect(copy).toEqual(ids);

    // …and the statement the transaction actually emits follows that order.
    const seen: unknown[] = [];
    const fakeTx = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(values[0]);
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    await lockDivisions(fakeTx, ids);
    expect(seen).toEqual(sorted.map((id) => `division:${id}`));
  });

  it("exactly one schedule.applied_multi competition event is written", async () => {
    const { alpha, bravo } = await clean();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const rows = await sql<{ payload: { source?: string; division_ids?: string[] } }[]>`
      select payload from competition_events
      where competition_id = ${board.competitionId} and type = ${JOINT_APPLY_EVENT}`;
    // ONE row per transaction, not one per division: competition_events.id is a
    // random uuid and now() is transaction-start time, so two rows written in
    // one transaction tie on (created_at, id) and ai-last's "latest" becomes a
    // coin flip.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.source).toBe("ai");
    expect([...(rows[0]!.payload.division_ids ?? [])].sort()).toEqual(
      [board.alpha.id, board.bravo.id].sort(),
    );
  }, 60_000);

  it("ai-last returns the applied plan after a joint apply", async () => {
    expect((await lastCompetitionAiApply(auth, board.competitionId)).last).toBeNull();
    const { alpha, bravo } = await clean();
    const before = Date.now();
    await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    const out = await lastCompetitionAiApply(auth, board.competitionId);
    expect(out.last).not.toBeNull();
    expect(out.last!.instruction).toBe("Fit both divisions into the morning.");
    expect(out.last!.summary).toBe(AI.summary);
    expect(Date.parse(out.last!.at)).toBeGreaterThanOrEqual(before - 60_000);
  }, 60_000);

  it("a fixture id outside the pack is a 4xx, not a 500", async () => {
    // Two ways to be outside the pack: a fixture that belongs to a DIFFERENT
    // division of the run, and one that does not exist at all. The runner path
    // 500s AI_PLAN_INVALID_ASSIGNMENT on both, because only a server bug can
    // reach it there; at apply time the ids come off the wire, so it is a
    // request defect (R14).
    for (const foreignId of [board.bravo.fixtureIds[0]!, randomUUID()]) {
      const { alpha, bravo } = await clean();
      const withForeign: CompetitionApplyDivision = {
        ...alpha,
        assignments: [
          ...alpha.assignments,
          { fixture_id: foreignId, scheduled_at: at(600), court_label: "Court 2" },
        ],
      };
      // Bravo must NOT also list it. Leaving it in both places trips the
      // "appears more than once" guard first, which is a different 422 — and a
      // test satisfiable by two constraints proves neither.
      const rest: CompetitionApplyDivision = {
        ...bravo,
        assignments: bravo.assignments.filter((a) => a.fixture_id !== foreignId),
      };
      let caught: unknown;
      try {
        await applyCompetitionSchedule(auth, board.competitionId, {
          divisions: [withForeign, rest],
          source: "ai",
          ai: AI,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      // The code pins WHICH refusal this is, so the duplicate-fixture guard
      // cannot stand in for the unknown-fixture one.
      expect((caught as HttpError).code).toBe("SCHEDULE_APPLY_UNKNOWN_FIXTURE");
      const status = (caught as HttpError).status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(unplaced(await slots(board.alpha.id))).toBe(true);
      expect(unplaced(await slots(board.bravo.id))).toBe(true);
    }
  }, 60_000);
});
