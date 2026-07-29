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
import {
  COMPETITION_MOVABLE_CAP,
  JOINT_APPLY_EVENT,
  lastCompetitionAiApply,
} from "../competition-schedule-ai";
import {
  ApplyCompetitionScheduleRequest,
  ApplyCompetitionScheduleResult,
} from "@/server/api-v1/schemas";
import {
  applyCompetitionSchedule,
  lockDivisions,
  lockOrder,
  type CompetitionApplyDivision,
  type CompetitionApplyOut,
} from "../competition-schedule-apply";
import { seedOrg } from "./_seed";

/**
 * COMPILE-TIME half of the wire contract (the runtime half is the
 * `ApplyCompetitionScheduleResult.parse` in the blackout test below).
 *
 * `tsc` is the only thing that can catch the usecase's return type drifting away
 * from the schema the route publishes. Zod cannot: it STRIPS keys the schema
 * does not declare, so a drift shows up as fields silently missing from a 200,
 * never as an exception. Substituting `ScheduleConflict[]` for `Conflict[]` on
 * either side must fail here.
 */
const _wireBridge: ApplyCompetitionScheduleResult = null as unknown as CompetitionApplyOut;
void _wireBridge;

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

/** Patch a division's stored `constraints` — the family the joint verifier reads
 *  through `verifyConfigFor`. Written straight to the row: `putScheduleSettings`
 *  would drag in the `scheduling.constraints` entitlement, which is not what
 *  these tests are about. */
async function setConstraints(
  divisionId: string,
  courts: string[],
  constraints: object,
): Promise<void> {
  await sql`
    update schedule_settings
    set config = ${sql.json({ ...settingsConfig(courts), constraints } as never)}
    where division_id = ${divisionId}`;
}

/** One person rostered into one entrant of each named fixture — the only way to
 *  make a `person_overlap` conflict, within a division or across two. */
async function sharePerson(orgId: string, fixtureIds: string[]): Promise<string> {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name)
    values (${orgId}, ${"Shared Player " + randomUUID().slice(0, 6)}) returning id`;
  for (const fixtureId of fixtureIds) {
    const [row] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${row!.home_entrant_id}, ${person!.id}, ${orgId})`;
  }
  return person!.id;
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

// ---------------------------------------------------------------------------
// No database needed. Kept out of the suite below so these do not pay its
// per-test seeding — the house pattern for a pure helper (shouldFireMadePublic,
// competitionLifecycleEvent).
// ---------------------------------------------------------------------------
describe("joint apply — pure contracts", () => {
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

  it("an assignment carrying schedule_locked is a 400, not a stripped 200", async () => {
    // The plan's own `proposal` entries carry an optional `schedule_locked`, and
    // zod strips unknown keys — so without `.strict()` a plan asking to pin a
    // fixture applies cleanly and silently loses the pin. Loud beats silent.
    const base = {
      division_id: "11111111-0000-4000-8000-000000000001",
      expected_seq: 0,
      assignments: [
        {
          fixture_id: "22222222-0000-4000-8000-000000000002",
          scheduled_at: "2026-08-01T09:00:00.000Z",
          court_label: "Court 1",
        },
      ],
    };
    // The same body without the extra key parses, so the rejection below is the
    // extra key and nothing else.
    expect(() =>
      ApplyCompetitionScheduleRequest.parse({ divisions: [base], source: "ai" }),
    ).not.toThrow();
    expect(() =>
      ApplyCompetitionScheduleRequest.parse({
        divisions: [
          { ...base, assignments: [{ ...base.assignments[0]!, schedule_locked: true }] },
        ],
        source: "ai",
      }),
    ).toThrow();
  });
});

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

    // RUNTIME half of the wire contract (the compile-time half is `_wireBridge`
    // at the top of this file). This is the only test that produces a non-empty
    // `conflicts`, so it is the only place a schema/usecase mismatch is visible
    // at all: zod STRIPS undeclared keys, so declaring the wrong conflict shape
    // would empty every warning into `{}` with no exception anywhere.
    const parsed = ApplyCompetitionScheduleResult.parse(out);
    expect(parsed.conflicts).toEqual(out.conflicts);
    expect(parsed.conflicts.every((c) => typeof c.fixtureId === "string" && c.reason !== undefined))
      .toBe(true);
  }, 60_000);

  it("an org without scheduling.multi_division is refused, and nothing is written", async () => {
    // The request carries client-supplied assignments, so this endpoint needs no
    // prior plan run and no AI: it is a multi-division bulk write in its own
    // right, reachable with a bare `manage` key. `scheduling.multi_division` is
    // the paywall for exactly that capability. Community holds `scheduling.ai`
    // and lacks this one, which is what makes it the right seed.
    const { auth: community } = await seedOrg("community");
    const free = await seedBoard(community);
    const divisions = [
      lineUp(free.alpha, await divisionSeq(free.alpha.id), "Court 1", 0),
      lineUp(free.bravo, await divisionSeq(free.bravo.id), "Court 3", 0),
    ];
    await expect(
      applyCompetitionSchedule(community, free.competitionId, {
        divisions,
        source: "ai",
        ai: AI,
      }),
      // The FEATURE KEY, not the 402 — a bare status is what every paywall on
      // this path answers with, including the frozen-competition one.
    ).rejects.toMatchObject({ featureKey: "scheduling.multi_division" });
    expect(unplaced(await slots(free.alpha.id))).toBe(true);
    expect(unplaced(await slots(free.bravo.id))).toBe(true);
  }, 90_000);

  it("crossPersonClash 'hard' blocks a person double-booking, 'warn' only reports it", async () => {
    // The per-stage apply consults this setting (schedule.ts:553) and refuses.
    // Riding bare `isBlocking` meant the same org with the same setting got a
    // 409 from one endpoint and a written-through 200 from this one.
    //
    // Alpha's round 1 is two fixtures over four disjoint entrants: put one
    // person in both, place them at the same instant on Alpha's two courts, and
    // the only conflict on the board is a person overlap — no court clash.
    await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.alpha.fixtureIds[1]!]);
    const overlapping = (expectedSeq: number): CompetitionApplyDivision => ({
      division_id: board.alpha.id,
      expected_seq: expectedSeq,
      assignments: board.alpha.fixtureIds.map((fixture_id, i) => ({
        fixture_id,
        scheduled_at: i < 2 ? at(0) : at(i * 30),
        court_label: i === 1 ? "Court 2" : "Court 1",
      })),
    });
    const bravoOf = async (): Promise<CompetitionApplyDivision> =>
      lineUp(board.bravo, await divisionSeq(board.bravo.id), "Court 3", 0);

    // "warn" (the default — no constraints row at all): reported, not blocking.
    const warned = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [overlapping(await divisionSeq(board.alpha.id)), await bravoOf()],
      source: "ai",
      ai: AI,
    });
    expect(warned.applied).toBe(9);
    expect(warned.conflicts.some((c) => c.reason === "person_overlap")).toBe(true);
    // The board really was written — so the "hard" refusal below is the setting
    // and not some other property of this seed.
    expect(unplaced(await slots(board.alpha.id))).toBe(false);

    // Same board, same overlap, opted in: refused.
    ({ auth } = await seedOrg("pro"));
    board = await seedBoard(auth);
    await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.alpha.fixtureIds[1]!]);
    await setConstraints(board.alpha.id, ["Court 1", "Court 2"], {
      restMin: 0,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "hard",
    });
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [overlapping(await divisionSeq(board.alpha.id)), await bravoOf()],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 120_000);

  it("a cross-division person clash blocks when EITHER division opted in", async () => {
    // Person in Alpha and in Bravo; only Alpha is "hard". Alpha's own pass sees
    // Bravo's proposed slot on the merged board and blocks. `Conflict` carries
    // no division, so the pass that emitted it is the only possible attribution
    // — and "hard if any involved division opted in" is the safe direction for
    // an org that explicitly asked not to double-book its people.
    await sharePerson(auth.orgId, [board.alpha.fixtureIds[0]!, board.bravo.fixtureIds[0]!]);
    await setConstraints(board.alpha.id, ["Court 1", "Court 2"], {
      restMin: 0,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "hard",
    });
    // Bravo keeps the default "warn" — its own pass would let this through.
    const { alpha, bravo } = await clean();
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        divisions: [alpha, bravo],
        source: "ai",
        ai: AI,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    expect(unplaced(await slots(board.alpha.id))).toBe(true);
    expect(unplaced(await slots(board.bravo.id))).toBe(true);
  }, 60_000);

  it("a start-window violation is reported as a warning and still applies", async () => {
    // `verifyConfigFor` used to hardcode startWindows: [], so `start_window` was
    // a conflict class the whole joint product was blind to while the per-stage
    // apply reported it. Warnings only: `isBlocking` does not cover it.
    await setConstraints(board.bravo.id, ["Court 1", "Court 3"], {
      restMin: 0,
      noBackToBack: false,
      // Division-targeted, which only works because the joint path stamps
      // `divisionId` on every proposed assignment.
      startWindows: [{ target: { kind: "division", id: board.bravo.id }, notBefore: at(240) }],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
    });
    const { alpha, bravo } = await clean();
    const out = await applyCompetitionSchedule(auth, board.competitionId, {
      divisions: [alpha, bravo],
      source: "ai",
      ai: AI,
    });
    // Applied, not refused.
    expect(out.applied).toBe(9);
    const windows = out.conflicts.filter((c) => c.reason === "start_window");
    expect(windows.length).toBeGreaterThan(0);
    // Bravo's window; Alpha, at the same instants, has none.
    for (const c of windows) expect(board.bravo.fixtureIds).toContain(c.fixtureId);
    expect((await slots(board.bravo.id)).every((r) => r.at !== null)).toBe(true);
  }, 60_000);

  it("more than 500 assignments in one call is refused before anything is read", async () => {
    // The PLAN path caps a whole run at 500 movable fixtures. Without the same
    // cap here the schema's 500-per-division x 20 divisions would admit 10 000
    // single-row updates in one transaction holding 20 advisory locks.
    const bulk = (n: number): CompetitionApplyDivision["assignments"] =>
      Array.from({ length: n }, () => ({
        fixture_id: randomUUID(),
        scheduled_at: at(0),
        court_label: "Court 1",
      }));
    const over = {
      divisions: [
        { division_id: board.alpha.id, expected_seq: 0, assignments: bulk(300) },
        { division_id: board.bravo.id, expected_seq: 0, assignments: bulk(201) },
      ],
      source: "ai" as const,
    };
    expect(over.divisions.reduce((n, d) => n + d.assignments.length, 0)).toBe(
      COMPETITION_MOVABLE_CAP + 1,
    );
    // The ids are fabricated, so every later guard would also refuse this —
    // the CODE is what pins that the cap is the one that fired, and that it
    // fired before any of them.
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, over),
    ).rejects.toMatchObject({ status: 409, code: "SCHEDULE_APPLY_TOO_LARGE" });

    // One under the cap gets past it and is refused by the NEXT guard instead,
    // which proves the boundary is 500 and not "any bulk request".
    await expect(
      applyCompetitionSchedule(auth, board.competitionId, {
        ...over,
        divisions: [over.divisions[0]!, { ...over.divisions[1]!, assignments: bulk(200) }],
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_APPLY_UNKNOWN_FIXTURE" });
  }, 60_000);

  it("exactly one schedule.applied_multi competition event is written", async () => {
    // Rename so the (name, slug) DOMAIN order is provably the REVERSE of the
    // UUID order. Without this the ids are random, so a UUID sort would match
    // the domain order about half the time and the assertion below would only
    // catch the defect on a coin flip.
    const byUuid = [board.alpha, board.bravo].sort((a, b) => (a.id < b.id ? -1 : 1));
    await sql`update divisions set name = 'Zulu', slug = 'zulu' where id = ${byUuid[0]!.id}`;
    await sql`update divisions set name = 'Alfa', slug = 'alfa' where id = ${byUuid[1]!.id}`;
    const domainOrder = [byUuid[1]!.id, byUuid[0]!.id];

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
    // DOMAIN order, asserted as emitted. Re-sorting a copy here — which this
    // test used to do — makes it blind to the UUID sort the module header
    // forbids for anything that is not lock acquisition.
    expect(rows[0]!.payload.division_ids).toEqual(domainOrder);
    expect(rows[0]!.payload.division_ids).not.toEqual([...domainOrder].sort());
    // …and the per-division rows carry the same list in the same order.
    const [division] = await sql<{ payload: { joint?: { division_ids?: string[] } } }[]>`
      select payload from division_events
      where division_id = ${board.alpha.id} and type = 'schedule_applied'`;
    expect(division!.payload.joint?.division_ids).toEqual(domainOrder);
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
