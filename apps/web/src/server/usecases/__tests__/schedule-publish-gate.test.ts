// #230 item 2 — the server-side final validation gate at publish.
//
// `publishSchedule` used to advance the division and append `schedule_published`
// after counting the fixtures that carried a `scheduled_at`. A count is not a
// check: the board's conflicts panel is client-side and advisory, so a board that
// was valid when the organiser last looked could be published broken after a
// settings change, a new blackout, an entrant withdrawal or a cross-division edit.
//
// The gate runs the SAME validator the panel runs (`validateScheduleIn`), inside
// publish's own transaction and AFTER its advisory lock, so nothing can land
// between the check and the event.
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
import { publishSchedule, validateSchedule } from "../schedule";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** The org zone governs every calendar boundary (#397/#448) and `seedOrg` leaves
 *  `organizations.timezone` null, so `orgTz` resolves to UTC. Every instant below
 *  is therefore written in Z and the day keys line up without arithmetic. */
const DAY = "2026-08-10";
const DAY_BEFORE = "2026-08-09";
const at = (ymd: string, hhmm: string): string => `${ymd}T${hhmm}:00.000Z`;

interface ConfigOpts {
  /** Per-entrant rest floor, minutes. 120 turns a 30-minute turnaround into a
   *  `warn.rest` — non-blocking, which is the whole point of the warning tests. */
  restMin?: number;
  /** Last day the timetable may run. Present makes `applyWindow` return a window,
   *  which is what a `warn.window` (BLOCKING) needs to be reachable at all. */
  endAt?: string | null;
}

function settingsConfig(opts: ConfigOpts) {
  const rest = opts.restMin ?? 20;
  return {
    startAt: at(DAY, "08:00"),
    ...(opts.endAt !== undefined && opts.endAt !== null ? { endAt: at(opts.endAt, "23:00") } : {}),
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: rest,
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
  hhmm: string;
  court: string;
}

interface Board {
  auth: AuthCtx;
  divisionId: string;
  fixtureIds: string[];
}

async function seedBoard(slots: Slot[], config: ConfigOpts): Promise<Board> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Publish Gate ${tag}`,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: `Div ${tag}`,
    slug: `pub-${tag}`,
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
      values (${stage!.id}, ${division.id}, ${auth.orgId}, 1, ${i}, ${`f${i}`},
              'scheduled', ${byName.get(`E${s.home}`)!}, ${byName.get(`E${s.away}`)!},
              ${at(DAY, s.hhmm)}, ${s.court})
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

/** E1 plays twice with a 30-minute turnaround. Under a 120-minute floor that is
 *  `warn.rest` — deliberately NOT blocking ("uncomfortable is not impossible"). */
const REST_WARNING: Slot[] = [
  { home: 1, away: 2, hhmm: "09:00", court: "Court 1" },
  { home: 1, away: 3, hhmm: "10:00", court: "Court 2" },
];

async function publishedEvents(divisionId: string): Promise<{ payload: Record<string, unknown> }[]> {
  return sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events
    where division_id = ${divisionId} and type = 'schedule_published' order by seq`;
}

async function divisionStatus(divisionId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from divisions where id = ${divisionId}`;
  return row!.status;
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

describe.skipIf(!HAS_DB)("publish validates the board it is about to publish (#230)", () => {
  it("refuses a board with a BLOCKING conflict, and writes nothing", async () => {
    const board = await seedBoard(COURT_CLASH, {});

    let thrown: unknown;
    await publishSchedule(board.auth, board.divisionId).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    // Which conflict, not merely "a 422". A bare status assertion is satisfied by
    // every other refusal on this path — completed division, frozen competition.
    const refused = thrownConflicts(thrown);
    expect(refused.some((c) => c.code === "conflict.court" && c.blocking)).toBe(true);
    expect(new Set(refused.map((c) => c.fixture_id))).toEqual(new Set(board.fixtureIds));

    // The status is the visible half; the EVENT is the half a naive
    // implementation gets wrong, by appending before it throws.
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await publishedEvents(board.divisionId)).toHaveLength(0);
  }, 120_000);

  it("refuses a warning-only board unacknowledged, and publishes it acknowledged", async () => {
    const board = await seedBoard(REST_WARNING, { restMin: 120 });

    await expect(publishSchedule(board.auth, board.divisionId)).rejects.toMatchObject({
      status: 422,
      code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS",
    });
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await publishedEvents(board.divisionId)).toHaveLength(0);

    const out = await publishSchedule(board.auth, board.divisionId, {
      acknowledge_warnings: true,
    });
    expect(out).toMatchObject({ status: "scheduled", published: true });
    expect(await publishedEvents(board.divisionId)).toHaveLength(1);
  }, 120_000);

  it("stores the report it published against on the event", async () => {
    const board = await seedBoard(REST_WARNING, { restMin: 120 });
    await publishSchedule(board.auth, board.divisionId, {
      acknowledge_warnings: true,
      reason: "venue confirmed the turnaround",
    });

    const [event] = await publishedEvents(board.divisionId);
    const payload = event!.payload as {
      fixturesScheduled: number;
      conflicts: ScheduleConflict[];
      acknowledged: boolean;
      reason?: string;
    };
    expect(payload.fixturesScheduled).toBe(2);
    expect(payload.acknowledged).toBe(true);
    expect(payload.reason).toBe("venue confirmed the turnaround");
    // The question this answers after a dispute is "what did the board look like
    // when this was published", so the conflict itself must be in there — not a
    // count of them.
    expect(payload.conflicts.some((c) => c.code === "warn.rest")).toBe(true);
    expect(payload.conflicts.every((c) => !c.blocking)).toBe(true);
  }, 120_000);

  it("does NOT let acknowledge_warnings past a blocking conflict", async () => {
    // The security-shaped test. Without it `acknowledge_warnings` is an override
    // for everything, which is precisely what it must never be: there is no
    // override for physically impossible.
    const board = await seedBoard(COURT_CLASH, {});

    await expect(
      publishSchedule(board.auth, board.divisionId, {
        acknowledge_warnings: true,
        reason: "ship it",
      }),
    ).rejects.toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    expect(await divisionStatus(board.divisionId)).toBe("setup");
    expect(await publishedEvents(board.divisionId)).toHaveLength(0);
  }, 120_000);

  it("publishes a clean board exactly as before", async () => {
    const board = await seedBoard(CLEAN, {});

    const out = await publishSchedule(board.auth, board.divisionId);
    expect(out).toMatchObject({
      division_id: board.divisionId,
      status: "scheduled",
      published: true,
    });
    expect(await divisionStatus(board.divisionId)).toBe("scheduled");

    const events = await publishedEvents(board.divisionId);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as {
      fixturesScheduled: number;
      conflicts: ScheduleConflict[];
      acknowledged: boolean;
    };
    expect(payload.fixturesScheduled).toBe(2);
    expect(payload.conflicts).toEqual([]);
    expect(payload.acknowledged).toBe(false);
  }, 120_000);

  it("sees a change made AFTER the board was last validated", async () => {
    // The actual #230 scenario, and the one thing a gate reading a CACHED report
    // cannot do. Every other test in this file passes against such a gate.
    const board = await seedBoard(CLEAN, { endAt: DAY });
    await publishSchedule(board.auth, board.divisionId);
    expect(await publishedEvents(board.divisionId)).toHaveLength(1);

    // The organiser pulls the competition's last day back a day. Both cards are
    // now outside the window the board runs in — `warn.window`, blocking.
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      select config from schedule_settings where division_id = ${board.divisionId}`;
    await sql`
      update schedule_settings
      set config = ${sql.json({ ...row!.config, endAt: at(DAY_BEFORE, "23:00") } as never)},
          updated_at = now()
      where division_id = ${board.divisionId}`;

    let thrown: unknown;
    await publishSchedule(board.auth, board.divisionId).catch((err: unknown) => {
      thrown = err;
    });
    expect(thrown).toMatchObject({ status: 422, code: "SCHEDULE_BLOCKING_CONFLICTS" });
    // Named, so this cannot pass on some unrelated refusal the settings write
    // happened to provoke: the board is out of its window and nothing else moved.
    expect(thrownConflicts(thrown).every((c) => c.code === "warn.window" && c.blocking)).toBe(true);
    // Still exactly the one event from the first, legitimate publish.
    expect(await publishedEvents(board.divisionId)).toHaveLength(1);
  }, 120_000);

  it("reports exactly what the standalone validator reports", async () => {
    // The anti-fork assertion. The placer/verifier split is the recurring defect
    // in this subsystem — an hour before this was written the auto pass proposed
    // a board its own apply gate rejected. A second validation implementation for
    // publish would be the same hole; deep equality is what forbids one.
    for (const [slots, config] of [
      [REST_WARNING, { restMin: 120 }],
      [COURT_CLASH, {}],
    ] as [Slot[], ConfigOpts][]) {
      const board = await seedBoard(slots, config);
      const panel = await validateSchedule(board.auth, board.divisionId);
      expect(panel.conflicts.length).toBeGreaterThan(0);

      let thrown: unknown;
      try {
        await publishSchedule(board.auth, board.divisionId);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrownConflicts(thrown)).toEqual(panel.conflicts);
    }
  }, 120_000);
});
