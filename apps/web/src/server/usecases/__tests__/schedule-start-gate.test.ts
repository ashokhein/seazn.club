// #230 item 2, follow-up — the publish gate was walkable around via "Start".
//
// `publishSchedule` validates the board before it goes public. `startDivision`
// did not validate anything at all: it advanced `setup → active`, and on the
// quick-start path it WROTE rolling round times itself and then opened scoring
// (`scoring.ts` opens on `active`). So an organiser whose board failed the
// publish gate could simply press Start instead and the same broken timetable
// went live, with no `schedule_published` event to record that it ever had.
//
// The owner's design is not a second refusal but a second CALLER: starting the
// tournament auto-publishes the schedule, under the same validation, the same
// error codes and the same `acknowledge_warnings` contract, so the console's
// confirm dialog serves both buttons with one code path.
//
// Two properties this file exists to pin, both of which a plausible
// implementation gets wrong:
//
//   * the gate rejects CONFLICTS, never INCOMPLETENESS. Many existing suites
//     start divisions whose boards are empty or half-slotted; an empty board
//     yields no assignments, so `validateAssignments` — which reports only on
//     `assignments`, never on `existing` — has nothing to report. If that ever
//     stops being true, this file reds before those suites do.
//   * on the quick-start path the check runs AFTER the rolling times are
//     written. Validating first checks a board that does not exist yet.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages } from "../stages";
import { publishSchedule, startDivision, validateSchedule } from "../schedule";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** `seedOrg` leaves `organizations.timezone` null, so `orgTz` resolves to UTC
 *  and every instant below is written in Z — day keys line up with no
 *  arithmetic (#397/#448). */
const DAY = "2026-09-14";
const at = (ymd: string, hhmm: string): string => `${ymd}T${hhmm}:00.000Z`;

interface ConfigOpts {
  /** Per-entrant rest floor, minutes. 120 turns a 60-minute turnaround into a
   *  `warn.rest`, which is NOT blocking — the whole point of the warning tests. */
  restMin?: number;
  /** Quick-start rolling round length. Present makes `startDivision` write
   *  `scheduled_at` for every round that has none. */
  roundMinutes?: number;
}

function settingsConfig(opts: ConfigOpts) {
  const rest = opts.restMin ?? 20;
  return {
    startAt: at(DAY, "08:00"),
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: rest,
    ...(opts.roundMinutes !== undefined ? { roundMinutes: opts.roundMinutes } : {}),
    blackouts: [],
    sessionWindows: [],
    constraints: {
      restMin: rest,
      noBackToBack: false,
      startWindows: [],
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
      hard: [],
    },
  };
}

interface Slot {
  /** 1-based entrant numbers, into the four seeded entrants. */
  home: number;
  away: number;
  /** Omitted leaves `scheduled_at` NULL — an unscheduled card. */
  hhmm?: string;
  /** Omitted leaves `court_label` NULL. A card needs BOTH to be an assignment. */
  court?: string;
  round?: number;
}

interface Board {
  auth: AuthCtx;
  divisionId: string;
  fixtureIds: string[];
}

async function seedBoard(slots: Slot[], config: ConfigOpts = {}): Promise<Board> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Start Gate ${tag}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: `Div ${tag}`,
    slug: `start-${tag}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json(settingsConfig(config))}, ${"UTC"}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  await createEntrants(
    auth,
    division.id,
    [1, 2, 3, 4].map((n) => ({
      kind: "individual" as const,
      display_name: `E${n}`,
      seed: n,
      members: [],
    })),
  );
  const entrants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${division.id}`;
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "RR",
    config: {},
  });
  const fixtureIds: string[] = [];
  for (const [i, s] of slots.entries()) {
    const [f] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key,
                            status, home_entrant_id, away_entrant_id, scheduled_at, court_label)
      values (${stage!.id}, ${division.id}, ${auth.orgId}, ${s.round ?? 1}, ${i}, ${`f${i}`},
              'scheduled', ${byName.get(`E${s.home}`)!}, ${byName.get(`E${s.away}`)!},
              ${s.hhmm ? at(DAY, s.hhmm) : null}, ${s.court ?? null})
      returning id`;
    fixtureIds.push(f!.id);
  }
  return { auth, divisionId: division.id, fixtureIds };
}

/** Two fixtures, disjoint entrants, an hour apart on one court. Nothing to report. */
const CLEAN: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 3, away: 4, hhmm: "10:00", court: "Court 1" },
];

/** Same court, same instant — `conflict.court`, the archetypal BLOCKING conflict
 *  (`isBlockingConflict`: court / person_overlap / window / direct order). */
const COURT_CLASH: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 3, away: 4, hhmm: "09:00", court: "Court 1" },
];

/** E1 plays twice with a 60-minute turnaround. Under a 120-minute floor that is
 *  `warn.rest` — deliberately NOT blocking ("uncomfortable is not impossible"). */
const REST_WARNING: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 1, away: 3, hhmm: "10:00", court: "Court 2" },
];

/** The shape every other suite in this repo starts: real fixtures, no times and
 *  no courts. INCOMPLETE, not conflicted. */
const UNSCHEDULED: Slot[] = [
  { home: 1, away: 2 },
  { home: 3, away: 4 },
];

/** Half a board: one card placed, one card not. Still no conflict between them. */
const HALF_PLACED: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 3, away: 4 },
];

async function eventsOfType(divisionId: string, type: string): Promise<{ payload: Record<string, unknown> }[]> {
  return sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events
    where division_id = ${divisionId} and type = ${type} order by seq`;
}

async function divisionStatus(divisionId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`;
  return row!.status;
}

async function scheduledCount(divisionId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixtures
    where division_id = ${divisionId} and scheduled_at is not null`;
  return row!.n;
}

/** The `extra` bag an `HttpError` carries into the /api/v1 error body. */
function thrownConflicts(err: unknown): ScheduleConflict[] {
  return (err as { extra?: { conflicts?: ScheduleConflict[] } }).extra?.conflicts ?? [];
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("starting a division publishes it, under the publish gate (#230)", () => {
  it("refuses a board with a BLOCKING conflict, and writes nothing", async () => {
    const board = await seedBoard(COURT_CLASH);

    let thrown: unknown;
    await startDivision(board.auth, board.divisionId).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    // WHICH conflict, not merely "a 422": this path already refuses a completed
    // division, a frozen competition and a division with no stages, and a bare
    // status assertion is satisfied by all three.
    const refused = thrownConflicts(thrown);
    expect(refused.some((c) => c.code === "conflict.court" && c.blocking)).toBe(true);
    expect(new Set(refused.map((c) => c.fixture_id))).toEqual(new Set(board.fixtureIds));

    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(0);
    expect(await eventsOfType(board.divisionId, "schedule_published")).toHaveLength(0);
  }, 120_000);

  it("refuses a warning-only board unacknowledged, and starts it acknowledged", async () => {
    const board = await seedBoard(REST_WARNING, { restMin: 120 });

    await expect(startDivision(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS",
    });
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(0);

    const out = await startDivision(board.auth, board.divisionId, {
      acknowledge_warnings: true,
      reason: "venue confirmed the turnaround",
    });
    expect(out).toMatchObject({ status: "active", started: true });
    expect(await divisionStatus(board.divisionId)).toBe("active");
  }, 120_000);

  it("records the publish it performed on the way through", async () => {
    // The event is the only record anywhere that a publish happened —
    // `history-panel.tsx` renders it, and the public schedule went live on the
    // back of it. A start that flips the status without appending it publishes
    // silently.
    const board = await seedBoard(REST_WARNING, { restMin: 120 });
    await startDivision(board.auth, board.divisionId, {
      acknowledge_warnings: true,
      reason: "venue confirmed the turnaround",
    });

    const published = await eventsOfType(board.divisionId, "schedule_published");
    expect(published).toHaveLength(1);
    const payload = published[0]!.payload as {
      fixturesScheduled: number;
      conflicts: ScheduleConflict[];
      acknowledged: boolean;
      reason?: string;
    };
    expect(payload.fixturesScheduled).toBe(2);
    expect(payload.acknowledged).toBe(true);
    expect(payload.reason).toBe("venue confirmed the turnaround");
    expect(payload.conflicts.some((c) => c.code === "warn.rest")).toBe(true);
    expect(payload.conflicts.every((c) => !c.blocking)).toBe(true);

    // …and the start itself is still recorded, from the status it came from.
    const started = await eventsOfType(board.divisionId, "division_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ from: "setup" });
  }, 120_000);

  it("does NOT let acknowledge_warnings past a blocking conflict", async () => {
    // The security-shaped one. Without it the flag is an override for
    // everything, which is exactly what it must never be: there is no override
    // for physically impossible.
    const board = await seedBoard(COURT_CLASH);

    await expect(
      startDivision(board.auth, board.divisionId, { acknowledge_warnings: true, reason: "ship it" }),
    ).rejects.toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(0);
  }, 120_000);

  it("starts a clean board and publishes it, unacknowledged", async () => {
    const board = await seedBoard(CLEAN);

    const out = await startDivision(board.auth, board.divisionId);
    expect(out).toMatchObject({ status: "active", started: true });

    const published = await eventsOfType(board.divisionId, "schedule_published");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      fixturesScheduled: 2,
      conflicts: [],
      acknowledged: false,
    });
  }, 120_000);

  // -------------------------------------------------------------------------
  // The incompleteness carve-out. `custom-points.test.ts`, `device-links.test.ts`,
  // `integration.test.ts` and a dozen others start divisions that look like this.
  // -------------------------------------------------------------------------

  it("starts an UNSCHEDULED board exactly as before — the gate rejects conflicts, not gaps", async () => {
    const board = await seedBoard(UNSCHEDULED);

    const out = await startDivision(board.auth, board.divisionId);
    expect(out).toMatchObject({ status: "active", started: true });
    expect(await divisionStatus(board.divisionId)).toBe("active");
    // Nothing was slotted, so nothing was published — but the division started.
    expect(await scheduledCount(board.divisionId)).toBe(0);
    expect(await eventsOfType(board.divisionId, "division_started")).toHaveLength(1);
  }, 120_000);

  it("starts a HALF-PLACED board — one card with no time is not a conflict", async () => {
    const board = await seedBoard(HALF_PLACED);

    await expect(startDivision(board.auth, board.divisionId)).resolves.toMatchObject({
      status: "active",
      started: true,
    });
  }, 120_000);

  // -------------------------------------------------------------------------
  // Ordering: the quick-start write happens first, and is what gets validated.
  // -------------------------------------------------------------------------

  it("validates the rolling times QUICK-START wrote, and rolls them back when they clash", async () => {
    // Both cards sit on one court in round 1 with no time. Quick-start gives
    // every fixture in a round the SAME instant, so writing the times is what
    // creates the double-booking. A gate that validated before the write sees
    // two unscheduled cards, finds nothing, and starts the division on a board
    // with two matches on one court at 08:00 — every other test in this file
    // passes against that gate.
    const board = await seedBoard(
      [
        { home: 1, away: 2, court: "Court 1", round: 1 },
        { home: 3, away: 4, court: "Court 1", round: 1 },
      ],
      { roundMinutes: 60 },
    );
    expect(await scheduledCount(board.divisionId)).toBe(0);

    let thrown: unknown;
    await startDivision(board.auth, board.divisionId).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    expect(thrownConflicts(thrown).some((c) => c.code === "conflict.court")).toBe(true);

    // The refusal rolls the times back with it — one transaction, so the
    // organiser is not left with a half-started board that now HAS a clash.
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await scheduledCount(board.divisionId)).toBe(0);
  }, 120_000);

  // -------------------------------------------------------------------------
  // The other statuses on the way through.
  // -------------------------------------------------------------------------

  it("does not publish a second time when the division was already published", async () => {
    const board = await seedBoard(CLEAN);
    await publishSchedule(board.auth, board.divisionId);
    expect(await divisionStatus(board.divisionId)).toBe("scheduled");
    expect(await eventsOfType(board.divisionId, "schedule_published")).toHaveLength(1);

    await expect(startDivision(board.auth, board.divisionId)).resolves.toMatchObject({
      status: "active",
      started: true,
    });
    // Still the one publish. `scheduled → active` is not a publish.
    expect(await eventsOfType(board.divisionId, "schedule_published")).toHaveLength(1);
  }, 120_000);

  it("still gates a division that was published before its board went bad", async () => {
    const board = await seedBoard(COURT_CLASH);
    await sql`update divisions set status = 'scheduled' where id = ${board.divisionId}`;

    await expect(startDivision(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_BLOCKING_CONFLICTS",
    });
    expect(await divisionStatus(board.divisionId)).toBe("scheduled");
  }, 120_000);

  it("reports exactly what the standalone validator reports", async () => {
    // The anti-fork assertion. A start-specific validation pass is how the
    // placer and the verifier drifted apart three times in this programme;
    // deep equality against the panel's own answer is what forbids one.
    for (const [slots, config] of [
      [REST_WARNING, { restMin: 120 }],
      [COURT_CLASH, {}],
    ] as [Slot[], ConfigOpts][]) {
      const board = await seedBoard(slots, config);
      const panel = await validateSchedule(board.auth, board.divisionId);
      expect(panel.conflicts.length).toBeGreaterThan(0);

      let thrown: unknown;
      try {
        await startDivision(board.auth, board.divisionId);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrownConflicts(thrown)).toEqual(panel.conflicts);
    }
  }, 120_000);
});
