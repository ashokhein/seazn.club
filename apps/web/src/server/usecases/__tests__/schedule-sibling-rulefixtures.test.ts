// #462 — a sibling division's fixtures carry their RULE IDENTITY, not just
// their court time.
//
// `siblingAssignments` returned `Assignment[]`, a shape that structurally cannot
// carry `extKey` or `winnerTo`. The engine's day-cap tally counts only the
// `existing` rows it can NAME —
//
//     existing.filter((e) => fixtureById.has(e.fixtureId))          calendar.ts
//
// where `fixtureById` is built from `config.ruleFixtures`. Every board path in
// `schedule.ts` built `ruleFixtures` from THIS division's rows alone, so a
// sibling's card was on the board as occupancy and invisible to every typed
// rule. A competition-scoped `max_fixtures_per_day` therefore undercounted by
// exactly the number of sibling fixtures on the day — silently, and in the
// direction that says "this board is fine".
//
// WHY THE NUMBER IS THE ASSERTION. "A conflict was reported" is satisfied by an
// undercount that still breaches the cap; only the count distinguishes 3-on-the-
// day from 2. Every board below is therefore built so the cap is breached ONLY
// once the sibling is counted: two of this division's fixtures against a 2/day
// cap is legal on its own.
//
// FOUR call sites take siblings, and a missed one is exactly this defect again.
// Three are exercised here — `validateSchedule` (the board report),
// `applySchedule` (the write gate) and `autoSchedule` (the placer). The fourth,
// `moveFixture`, returns no conflicts to assert on until #461; it is covered in
// `schedule-move-conflicts.test.ts`.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { HardConstraint } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { applySchedule, autoSchedule, validateSchedule } from "../schedule";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const TZ = "Europe/London";
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** One day, in the org zone. Every card on every board below sits on it. */
const DAY = "2026-08-10";
const AT = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

/** The cap that only breaks once the sibling counts. */
const DAY_CAP: HardConstraint[] = [
  { type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } },
];

/** The sibling plays on a court THIS division does not have, so no court
 *  double-booking can stand in for the rule firing; and its entrants are its
 *  own, so no shared person can either. The only link is the calendar day. */
const SIBLING_COURT = "Far Court";

function settingsConfig(courts: string[], hard: HardConstraint[], endAt?: string) {
  return {
    startAt: AT("08:00"),
    ...(endAt !== undefined ? { endAt } : {}),
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 20,
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: 20,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard,
    },
  };
}

interface Div {
  id: string;
  stageId: string;
  entrantByName: Map<string, string>;
}

async function makeDivision(
  auth: AuthCtx,
  competitionId: string,
  slug: string,
  courts: string[],
  entrantNames: string[],
  hard: HardConstraint[],
  endAt?: string,
): Promise<Div> {
  const division = await createDivision(auth, competitionId, {
    name: `Div ${slug}`,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(courts, hard, endAt))}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    entrantNames.map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const rows = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  return {
    id: division.id,
    stageId: stage!.id,
    entrantByName: new Map(rows.map((r) => [r.display_name, r.id])),
  };
}

async function addFixture(
  auth: AuthCtx,
  d: Div,
  seq: number,
  extKey: string,
  home: string,
  away: string,
  slot: { at: string; court: string } | null,
  status = "scheduled",
): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id, scheduled_at, court_label)
    values (${d.stageId}, ${d.id}, ${auth.orgId}, 1, ${seq}, ${extKey}, ${status},
            ${d.entrantByName.get(home)!}, ${d.entrantByName.get(away)!},
            ${slot?.at ?? null}, ${slot?.court ?? null})
    returning id`;
  return f!.id;
}

/** A competition with a planned division and one sibling holding a single
 *  already-fixed card on `DAY`. `placed` decides whether the planned division's
 *  own two fixtures start on the timetable or off it. */
async function seedBoard(placed: boolean, endAt?: string): Promise<{
  auth: AuthCtx;
  planned: Div;
  fa1: string;
  fa2: string;
  siblingFixtureId: string;
}> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `Sibling Rule Identity ${tag}`,
    visibility: "public",
    branding: {},
  });
  const planned = await makeDivision(
    auth,
    comp.id,
    `planned-${tag}`,
    ["Court 1", "Court 2"],
    ["A-1", "A-2", "A-3", "A-4"],
    DAY_CAP,
    endAt,
  );
  const sibling = await makeDivision(
    auth,
    comp.id,
    `sibling-${tag}`,
    [SIBLING_COURT],
    ["B-1", "B-2"],
    [],
  );

  const fa1 = await addFixture(
    auth, planned, 0, "a-f1", "A-1", "A-2",
    placed ? { at: AT("09:00"), court: "Court 1" } : null,
  );
  const fa2 = await addFixture(
    auth, planned, 1, "a-f2", "A-3", "A-4",
    placed ? { at: AT("11:00"), court: "Court 2" } : null,
  );
  // Fixed court time in another division of the same competition, on the day.
  const siblingFixtureId = await addFixture(
    auth, sibling, 0, "b-f1", "B-1", "B-2",
    { at: AT("14:00"), court: SIBLING_COURT }, "finalized",
  );
  return { auth, planned, fa1, fa2, siblingFixtureId };
}

const capRows = (conflicts: readonly ScheduleConflict[]): ScheduleConflict[] =>
  conflicts.filter((c) => c.code === "warn.instruction" && (c.detail ?? "").includes("/day cap"));

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("sibling fixtures carry their rule identity (#462)", () => {
  it("validateSchedule counts the sibling's card against a competition-wide day cap", async () => {
    const { auth, planned, fa1, fa2 } = await seedBoard(true);
    const { conflicts } = await validateSchedule(auth, planned.id);

    const capped = capRows(conflicts);
    // Three fixtures on the day against a 2/day cap. Reported on the cards this
    // division can actually move, which is its own two — never on the sibling's,
    // which nobody looking at this board can drag.
    expect(capped).toHaveLength(2);
    expect(capped.map((c) => c.fixture_id).sort()).toEqual([fa1, fa2].sort());
    // The NUMBER is the point: `2 fixtures on …` would be the undercount that
    // reports nothing at all, and any figure other than 3 means the sibling was
    // counted the wrong number of times.
    expect(capped[0]!.detail).toContain(`3 fixtures on ${DAY}`);
  }, 120_000);

  it("applySchedule's gate counts it too", async () => {
    const { auth, planned, fa1, fa2 } = await seedBoard(true);
    const out = await applySchedule(auth, planned.stageId, {
      source: "manual",
      assignments: [
        { fixture_id: fa1, scheduled_at: AT("09:00"), court_label: "Court 1" },
        { fixture_id: fa2, scheduled_at: AT("11:00"), court_label: "Court 2" },
      ],
    });
    expect(out.applied).toBe(2);

    const capped = capRows(out.conflicts);
    expect(capped).toHaveLength(2);
    expect(capped.map((c) => c.fixture_id).sort()).toEqual([fa1, fa2].sort());
    expect(capped[0]!.detail).toContain(`3 fixtures on ${DAY}`);
  }, 120_000);

  it("autoSchedule refuses to propose the card the sibling pushes over the cap", async () => {
    // A one-DAY window, so the placer has nowhere else to put the second card:
    // its only honest answer is to leave it unplaced.
    const { auth, planned } = await seedBoard(false, AT("22:00"));
    const out = await autoSchedule(auth, planned.stageId, { only_unlocked: false, mode: "build" });

    // The sibling already holds one of the day's two slots, so exactly one of
    // this division's fixtures fits. Blind to the sibling, the placer proposed
    // both and the apply gate then warned about a board it had just drawn — the
    // placer/verifier fork this repo keeps producing.
    expect(out.assignments).toHaveLength(1);
    expect(out.conflicts.map((c) => c.code)).toContain("warn.no_slot");
    // And the proposal it DID make is clean: one card plus the sibling is two,
    // which the cap allows. A placer that reported a breach on its own one-card
    // board would be counting the sibling twice.
    expect(capRows(out.conflicts)).toHaveLength(0);
  }, 120_000);
});
