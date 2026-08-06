// #399 W4 acceptance — blocking is DELTA-based on the board and the apply path.
//
// The rule this file exists to prove, in both directions:
//
//   REJECT   a change that INTRODUCES a person overlap, or puts a fixture
//            outside the competition's own dates, is refused (409).
//   ACCEPT   a board that ALREADY carries one stays editable. Boards published
//            before this wave may hold person overlaps — they were warnings all
//            along — and under an absolute rule the organiser's next edit would
//            409, leaving them unable to fix the very thing that is wrong.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { applySchedule, moveFixture, putScheduleSettings, validateSchedule } from "../schedule";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const T0 = "2026-08-03T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * MIN).toISOString();

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Board {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Round-robin over A/B/C/D, one fixture per 60 minutes on Court 1. */
  fixtures: { id: string; home: string; away: string; at: string; court: string }[];
}

/**
 * Four entrants, a round robin (6 fixtures), every fixture on its own hour so
 * the starting board verifies CLEAN. `perEntrantMinRest` is 0 on purpose: this
 * file is about person overlap and the window, and a rest warning in the middle
 * of it would only make the assertions ambiguous.
 */
async function seedBoard(endAt?: string): Promise<Board> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Delta ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((display_name, i) => ({
      kind: "individual" as const,
      display_name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      ...(endAt !== undefined ? { endAt } : {}),
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court 1", "Court 2", "Court 3"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const rows = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures
    where stage_id = ${stage!.id} order by round_no, seq_in_round`;
  const placed = rows.map((r, i) => ({
    id: r.id,
    home: r.home_entrant_id,
    away: r.away_entrant_id,
    at: at(i * 60),
    court: "Court 1",
  }));
  const applied = await applySchedule(auth, stage!.id, {
    assignments: placed.map((p) => ({ fixture_id: p.id, scheduled_at: p.at, court_label: p.court })),
    source: "manual",
  });
  expect(applied.applied).toBe(fixtures.length);
  expect(applied.conflicts.filter((c) => c.blocking)).toHaveLength(0);
  return { auth, divisionId: division.id, stageId: stage!.id, fixtures: placed };
}

/** Write a slot straight to the row, bypassing every gate — the only way to
 *  manufacture the board a pre-W4 organiser could legitimately be sitting on. */
async function forceSlot(fixtureId: string, scheduledAt: string, court: string): Promise<void> {
  await sql`
    update fixtures set scheduled_at = ${scheduledAt}, court_label = ${court}
    where id = ${fixtureId}`;
}

/** Two fixtures that share an entrant — the pair a person overlap needs. */
function sharingPair(board: Board): [Board["fixtures"][number], Board["fixtures"][number]] {
  const first = board.fixtures[0]!;
  const other = board.fixtures.find(
    (f) => f.id !== first.id && (f.home === first.home || f.away === first.home),
  )!;
  return [first, other];
}

describe.skipIf(!HAS_DB)("delta-based blocking (#399)", () => {
  it("REFUSES a drag that introduces a person overlap", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await expect(
      moveFixture(board.auth, sharer.id, { scheduled_at: anchor.at, court_label: "Court 2" }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
    const [after] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${sharer.id}`;
    expect(after!.scheduled_at.toISOString()).toBe(sharer.at);
  });

  it("names the rule on the refusal, so the organiser and a repair round agree", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    const err = await moveFixture(board.auth, sharer.id, {
      scheduled_at: anchor.at,
      court_label: "Court 2",
    }).catch((e: unknown) => e);
    expect(EngineError.is(err, "SCHEDULE_CONFLICT")).toBe(true);
    const conflicts = ((err as EngineError).data as {
      conflicts: { code: string; rule?: string; blocking: boolean }[];
    }).conflicts;
    expect(conflicts.every((c) => c.blocking)).toBe(true);
    expect(conflicts.some((c) => c.code === "warn.person_overlap" && c.rule === "H4")).toBe(true);
  });

  it("keeps a board that ALREADY holds a person overlap editable", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    // The board a pre-W4 organiser is sitting on: the overlap is already there.
    await forceSlot(sharer.id, anchor.at, "Court 2");

    // An unrelated card still moves.
    const unrelated = board.fixtures.find((f) => f.id !== anchor.id && f.id !== sharer.id)!;
    await moveFixture(board.auth, unrelated.id, {
      scheduled_at: at(600),
      court_label: "Court 2",
    });
    const [moved] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${unrelated.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(at(600));

    // And the pre-existing overlap is still REPORTED. `blocking` on a report
    // means IMPOSSIBLE, not "refused" (#399): the board paints that card red,
    // which is honest — and the edit above proves red does not mean frozen.
    const report = await validateSchedule(board.auth, board.divisionId);
    const overlaps = report.conflicts.filter((c) => c.code === "warn.person_overlap");
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps.every((c) => c.blocking)).toBe(true);
    expect(overlaps.every((c) => c.rule === "H4")).toBe(true);
  });

  it("re-applies a dirty board unchanged rather than 409ing on its own history", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await forceSlot(sharer.id, anchor.at, "Court 2");

    const out = await applySchedule(board.auth, board.stageId, {
      assignments: board.fixtures.map((f) => ({
        fixture_id: f.id,
        scheduled_at: f.id === sharer.id ? anchor.at : f.at,
        court_label: f.id === sharer.id ? "Court 2" : f.court,
      })),
      source: "manual",
    });
    expect(out.applied).toBe(board.fixtures.length);
    expect(out.conflicts.some((c) => c.code === "warn.person_overlap")).toBe(true);
  });

  it("REFUSES a change that WORSENS an existing overlap", async () => {
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await forceSlot(sharer.id, anchor.at, "Court 2");
    // A third fixture with the same entrant dragged onto the same instant: the
    // person was already double-booked, and this makes it three at once.
    const third = board.fixtures.find(
      (f) =>
        f.id !== anchor.id &&
        f.id !== sharer.id &&
        (f.home === anchor.home || f.away === anchor.home),
    );
    // The round robin gives entrant A three opponents, so this always exists.
    expect(third).toBeDefined();
    // Court 3, so the refusal can only be the person — a third card on Court 2
    // would be a court clash and would block for a reason this test is not about.
    await expect(
      moveFixture(board.auth, third!.id, { scheduled_at: anchor.at, court_label: "Court 3" }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("REFUSES a drag outside the competition's own dates", async () => {
    const board = await seedBoard(at(60 * 24)); // one day long
    const target = board.fixtures[0]!;
    await expect(
      moveFixture(board.auth, target.id, {
        scheduled_at: at(60 * 24 * 5),
        court_label: "Court 2",
      }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("keeps a board already outside its window editable", async () => {
    const board = await seedBoard(at(60 * 24));
    const stray = board.fixtures[0]!;
    await forceSlot(stray.id, at(60 * 24 * 5), "Court 2");
    // Moving the stray card WITHIN the same out-of-window day is not a new
    // conflict — the same key was already there.
    await moveFixture(board.auth, stray.id, {
      scheduled_at: at(60 * 24 * 5 + 90),
      court_label: "Court 2",
    });
    const [moved] = await sql<{ scheduled_at: Date }[]>`
      select scheduled_at from fixtures where id = ${stray.id}`;
    expect(moved!.scheduled_at.toISOString()).toBe(at(60 * 24 * 5 + 90));
  });

  it("REFUSES a SWAP that double-books a different fixture on the same court", async () => {
    // The subtle leak: a fixture already clashing on Court 1 with B, dragged to
    // a slot where it clashes with C instead. Both are "court double-booked" on
    // the same card and the same court — so a conflict identity that named only
    // the court would key them the same and write a BRAND-NEW double-booking
    // through as pre-existing, on the one reason that blocked absolutely before
    // this wave.
    const board = await seedBoard();
    const [first, second, third] = [board.fixtures[0]!, board.fixtures[1]!, board.fixtures[2]!];
    // Pre-existing: `second` sits on top of `first`.
    await forceSlot(second.id, first.at, first.court);
    // Now drag it onto `third` instead — same court, different victim.
    await expect(
      moveFixture(board.auth, second.id, { scheduled_at: third.at, court_label: third.court }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("REFUSES a SWAP that double-books a different person", async () => {
    // Same leak, the person lane: entrant A already overlapping with one
    // fixture, moved to overlap with another. Different clash, same card.
    const board = await seedBoard();
    const [anchor, sharer] = sharingPair(board);
    await forceSlot(sharer.id, anchor.at, "Court 2");
    const otherSharer = board.fixtures.find(
      (f) =>
        f.id !== anchor.id &&
        f.id !== sharer.id &&
        (f.home === sharer.home || f.away === sharer.home || f.home === sharer.away || f.away === sharer.away),
    )!;
    await expect(
      moveFixture(board.auth, sharer.id, {
        scheduled_at: otherSharer.at,
        court_label: "Court 3",
      }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });

  it("still refuses a court double-booking, delta or not", async () => {
    // The one reason that blocked before this wave must keep blocking.
    const board = await seedBoard();
    const [a, b] = [board.fixtures[0]!, board.fixtures[1]!];
    await expect(
      moveFixture(board.auth, b.id, { scheduled_at: a.at, court_label: a.court }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
  });
});
