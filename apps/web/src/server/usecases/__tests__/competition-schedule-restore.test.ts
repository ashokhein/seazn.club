// #386 — restoreCompetitionSchedule: undo ONE joint apply from the server.
//
// `applyCompetitionSchedule` writes every selected division in one transaction;
// the undo was a CLIENT loop over the per-division restore (`ai-joint-apply.ts`),
// so a closed tab part-way through left half the board carrying the AI schedule
// and half carrying the old one. This suite pins the server-side twin.
//
// What it is NOT: atomic. `restoreCheckpoint` rewinds by appending inverse
// events, each its own transaction, deliberately (history.ts:379). The
// guarantees under test are instead (a) the division set is validated against
// the apply event rather than trusted, and (b) a per-division failure is
// REPORTED, not swallowed and not allowed to abort the divisions after it.
//
// THE SEED IS DELIBERATELY ASYMMETRIC (Alpha 4 entrants -> 6 fixtures, Bravo 3
// -> 3): two identically-sized divisions cannot tell a real per-division
// restore from the first division's result repeated.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SessionLockHandle } from "@/lib/db";
import { sql, withSessionLocks, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  RestoreCompetitionScheduleRequest,
  RestoreCompetitionScheduleResult,
} from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createCheckpoint } from "../history";
import { applyCompetitionSchedule } from "../competition-schedule-apply";
import { JOINT_APPLY_EVENT } from "../competition-schedule-ai";
import { restoreCompetitionSchedule } from "../competition-schedule-restore";
import { seedOrg } from "./_seed";

/**
 * A seam on the lock handle `withSessionLocks` hands the usecase, and NOTHING
 * else: the real helper still runs, still takes the real key on its own
 * out-of-pool connection, still beats and still unlocks. `interpose` is
 * undefined for every test but the two lock-loss ones below, so the rest of this
 * suite exercises the unmocked path.
 *
 * Why a seam is needed at all — two reasons, both of them "timing cannot produce
 * this state":
 *
 *  - A lost lock is only OBSERVABLE at a beat, seconds apart, while a rewind of
 *    a seeded division is milliseconds, so "the loss lands between division 1
 *    and division 2" is unreachable. The test that terminates a real backend
 *    proves `held()` really goes false; the mid-loop test proves what the rewind
 *    loop does when it has.
 *  - A seeded two-division rewind holds its lock for as little as 30ms
 *    (measured), so every "wait for the lock, then race it" test was sampling a
 *    30ms window and losing on a loaded runner. `parkInsideLock` below holds the
 *    window OPEN instead of polling for it.
 */
const hooks = vi.hoisted(() => ({
  interpose: undefined as
    | undefined
    | ((lock: SessionLockHandle, keys: readonly string[]) => Promise<SessionLockHandle>),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    withSessionLocks: ((keys, fn, opts) =>
      actual.withSessionLocks(
        keys,
        async (lock) => fn(hooks.interpose ? await hooks.interpose(lock, keys) : lock),
        opts,
      )) as typeof actual.withSessionLocks,
  };
});

/** Gates opened by `afterEach` whatever the test did — a failed assertion must
 *  not leave a restore parked forever on a promise nobody will resolve. */
const openGates: (() => void)[] = [];

afterEach(() => {
  hooks.interpose = undefined;
  for (const open of openGates.splice(0)) open();
});

/**
 * Park the next `withSessionLocks` body AFTER its keys are acquired and BEFORE
 * it does any work, until the returned `open()` is called.
 *
 * This is the deterministic replacement for "start the restore, then poll
 * `pg_locks` until the key shows up". The lock is real and really held — the
 * seam only delays the body — so a competitor started while the gate is shut is
 * provably racing a held lock rather than hoping to catch one. Polling could not
 * be made sound: the entire rewind of a seeded pair holds the key for ~30ms.
 */
function parkInsideLock(): () => void {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  hooks.interpose = async (lock) => {
    await gate;
    return lock;
  };
  openGates.push(open);
  return open;
}

/** The served body must match the contract the spec publishes — a field the
 *  usecase returns but the schema does not declare is stripped from `data`,
 *  and only running the schema over a REAL payload sees that. */
function wireRoundTrip(out: unknown): void {
  const onWire = JSON.parse(JSON.stringify(out)) as unknown;
  expect(RestoreCompetitionScheduleResult.parse(onWire)).toEqual(onWire);
}

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
 *  the joint apply below cannot 409 on something this suite did not seed. */
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
  /** Its own court — courts are matched across divisions by string, so two
   *  divisions sharing one make a joint apply 409 on a cross-division clash. */
  court: string;
  /** Fixture ids in (round_no, seq_in_round) order. */
  fixtureIds: string[];
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
  return { id: division.id, name, court: courts[0]!, fixtureIds: ordered.map((f) => f.id) };
}

async function divisionSeq(divisionId: string): Promise<number> {
  const [row] = await sql<{ seq: string | number }[]>`
    select seq from divisions where id = ${divisionId}`;
  return Number(row?.seq ?? 0);
}

async function slots(
  divisionId: string,
): Promise<{ at: string | null; court: string | null }[]> {
  const rows = await sql<{ scheduled_at: Date | null; court_label: string | null }[]>`
    select scheduled_at, court_label from fixtures
    where division_id = ${divisionId}
    order by round_no, seq_in_round, id`;
  return rows.map((r) => ({
    at: r.scheduled_at === null ? null : new Date(r.scheduled_at).toISOString(),
    court: r.court_label,
  }));
}

/** Every fixture unplaced — "the AI board is gone". */
const unplaced = (rows: Awaited<ReturnType<typeof slots>>): boolean =>
  rows.every((r) => r.at === null && r.court === null);

/** ONE joint apply over exactly `divisions` — i.e. one `schedule.applied_multi`
 *  event naming exactly those division ids. */
async function jointApply(
  auth: AuthCtx,
  competitionId: string,
  divisions: SeededDivision[],
): Promise<void> {
  const payload = [];
  for (const d of divisions) {
    payload.push({
      division_id: d.id,
      expected_seq: await divisionSeq(d.id),
      assignments: d.fixtureIds.map((fixture_id, j) => ({
        fixture_id,
        scheduled_at: at(j * 30),
        court_label: d.court,
      })),
    });
  }
  await applyCompetitionSchedule(auth, competitionId, { divisions: payload, source: "ai" });
}

interface AppliedJoint {
  auth: AuthCtx;
  competitionId: string;
  divisions: SeededDivision[];
  checkpoints: { divisionId: string; checkpointId: string }[];
  /** Same org, same competition, NOT in the apply event's `division_ids`. */
  foreignDivisionId: string;
}

/**
 * `n` divisions with fixtures, one `kind: "ai"` anchor each, then ONE joint
 * apply — the exact state the console is in when it offers "Undo".
 *
 * Anchors are taken BEFORE the apply on purpose: a checkpoint records the
 * current edit watermark, so one taken afterwards would rewind to the AI board
 * and every assertion below would pass against a no-op.
 *
 * Each division gets its OWN court: courts are matched across divisions by
 * string, so a shared one makes the joint apply 409 on a cross-division clash.
 */
async function seedAppliedJoint(n: number): Promise<AppliedJoint> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    name: `Joint Restore Cup ${Date.now()}`,
    visibility: "public",
    branding: {},
  });
  const names = ["Alpha", "Bravo", "Charlie", "Delta"];
  const divisions: SeededDivision[] = [];
  for (let i = 0; i < n; i++) {
    // Asymmetric entrant counts — 4, 3, 4, 3 — so a per-division result can be
    // told apart from the first division's repeated.
    divisions.push(
      await seedDivision(auth, comp.id, names[i]!, i % 2 === 0 ? 4 : 3, [`Court ${i + 1}`]),
    );
  }
  const foreign = await seedDivision(auth, comp.id, "Foreign", 3, [`Court ${n + 1}`]);

  const checkpoints: { divisionId: string; checkpointId: string }[] = [];
  for (const d of divisions) {
    const cp = await createCheckpoint(auth, d.id, "Before AI schedule", "ai");
    checkpoints.push({ divisionId: d.id, checkpointId: cp.id });
  }

  await jointApply(auth, comp.id, divisions);

  return {
    auth,
    competitionId: comp.id,
    divisions,
    checkpoints,
    foreignDivisionId: foreign.id,
  };
}

interface TwoJointApplies {
  auth: AuthCtx;
  competitionId: string;
  /** Divisions of the FIRST apply, then of the SECOND. Disjoint sets. */
  first: SeededDivision[];
  second: SeededDivision[];
  /** division id -> its pre-apply anchor. */
  anchors: Map<string, string>;
}

/**
 * ONE competition, TWO joint applies over DISJOINT division sets: Alpha+Bravo
 * first, then Charlie+Delta. Only the latest apply is restorable, so the two
 * sets are the two candidate answers to "which apply does the undo validate
 * against" — a reader that picks the wrong event refuses the set that IS
 * restorable and accepts one that is not.
 *
 * Anchors for all four are taken before either apply: a checkpoint records the
 * current watermark, so one taken after would rewind to the AI board.
 */
async function seedTwoJointApplies(): Promise<TwoJointApplies> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    name: `Joint Restore Twice ${Date.now()}`,
    visibility: "public",
    branding: {},
  });
  // Asymmetric entrant counts (4/3/4/3) and a court each, as above.
  const all: SeededDivision[] = [];
  for (const [i, name] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
    all.push(await seedDivision(auth, comp.id, name, i % 2 === 0 ? 4 : 3, [`Court ${i + 1}`]));
  }
  const anchors = new Map<string, string>();
  for (const d of all) {
    const cp = await createCheckpoint(auth, d.id, "Before AI schedule", "ai");
    anchors.set(d.id, cp.id);
  }
  const first = all.slice(0, 2);
  const second = all.slice(2);
  await jointApply(auth, comp.id, first);
  await jointApply(auth, comp.id, second);
  return { auth, competitionId: comp.id, first, second, anchors };
}

/** The wire body for `divisions`, anchors attached. */
const checkpointsFor = (
  divisions: SeededDivision[],
  anchors: Map<string, string>,
): { division_id: string; checkpoint_id: string }[] =>
  divisions.map((d) => ({ division_id: d.id, checkpoint_id: anchors.get(d.id)! }));

/**
 * Is an advisory lock on `key` GRANTED to someone right now?
 *
 * pg_locks splits the single-argument bigint key across (classid, objid) — the
 * high and low 32 bits — so the two halves are reconstructed here rather than
 * recombined into one bigint, which would overflow int8 for a negative hashtext.
 * `granted` matters: a WAITER has a row too, and counting it would turn "someone
 * is blocked on this lock" into "the lock is held", which is the opposite fact.
 */
async function advisoryLockHeld(key: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and granted
       and classid::bigint = ((hashtext(${key})::bigint >> 32) & 4294967295)
       and objid::bigint = (hashtext(${key})::bigint & 4294967295)`;
  return (row?.n ?? 0) > 0;
}

/**
 * Is anyone WAITING on an advisory lock on `key` right now?
 *
 * The mirror of `advisoryLockHeld`, and the two must not be merged: `granted`
 * distinguishes "someone holds it" from "someone is parked on it", and the
 * second is what proves a caller has reached its lock acquisition and gone no
 * further. Halves compared separately, for the reason given above.
 */
async function advisoryLockWaiting(key: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and not granted
       and classid::bigint = ((hashtext(${key})::bigint >> 32) & 4294967295)
       and objid::bigint = (hashtext(${key})::bigint & 4294967295)`;
  return (row?.n ?? 0) > 0;
}

/**
 * The backend PID currently holding the advisory lock on `key`, if any.
 *
 * `pg_locks.pid` is the backend, so this is the process a `pg_terminate_backend`
 * has to name to take the lock away from its holder the way a pooler restart or
 * an admin does. Halves compared separately, for the reason given above.
 */
async function advisoryLockHolderPid(key: string): Promise<number | undefined> {
  const [row] = await sql<{ pid: number }[]>`
    select pid from pg_locks
     where locktype = 'advisory' and granted
       and classid::bigint = ((hashtext(${key})::bigint >> 32) & 4294967295)
       and objid::bigint = (hashtext(${key})::bigint & 4294967295)
     limit 1`;
  return row?.pid;
}

/**
 * Write a `schedule.applied_multi` row directly — i.e. what a joint apply that
 * has just COMMITTED looks like to the restore's event read.
 *
 * Deliberately not `jointApply`: the real apply takes the same `joint:` key, so
 * it cannot be made to commit while a test holds that key, which is exactly the
 * window these tests need to open. What is under test is WHEN the event is
 * read, not what an apply writes into it.
 */
async function insertJointApplyEvent(
  auth: AuthCtx,
  competitionId: string,
  divisionIds: string[],
): Promise<void> {
  await sql`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${competitionId}, ${auth.orgId}, ${JOINT_APPLY_EVENT},
            ${sql.json({ source: "ai", division_ids: divisionIds, applied: [] } as never)},
            ${auth.userId})`;
}

/**
 * Poll `pred` until true. Returns false on timeout — the CALLER asserts, so a
 * lock that is never taken fails an assertion instead of hanging the suite.
 *
 * The gap is SMALL because some of what this watches for is short-lived: a
 * seeded two-division rewind holds its lock for as little as 30ms on a warm
 * local Postgres (measured), so a 25ms gap plus a round trip could step right
 * over the window and report "the lock was never taken" about a lock that was.
 * The cost of sampling harder is a handful of extra `pg_locks` reads.
 */
async function waitUntil(pred: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** The `schedule.applied_multi` rows of one competition, oldest first. */
async function applyEvents(competitionId: string): Promise<{ id: string; created_at: Date }[]> {
  return sql<{ id: string; created_at: Date }[]>`
    select id, created_at from competition_events
     where competition_id = ${competitionId} and type = ${JOINT_APPLY_EVENT}
     order by created_at, id`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("restoreCompetitionSchedule (#386)", () => {
  it("restores every division named by the apply event, in one call", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    // The apply really did place both boards — otherwise "restored" below is
    // satisfied by a no-op.
    expect(unplaced(await slots(divisions[0]!.id))).toBe(false);
    expect(unplaced(await slots(divisions[1]!.id))).toBe(false);

    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    });
    expect(out.ok).toBe(true);
    expect(out.restored.map((r) => r.division_id).sort()).toEqual(
      divisions.map((d) => d.id).sort(),
    );
    expect(out.failed).toEqual([]);
    // Every division actually rewound — a report with no write behind it is the
    // failure mode this endpoint exists to prevent.
    expect(out.restored.every((r) => r.steps > 0)).toBe(true);
    expect(unplaced(await slots(divisions[0]!.id))).toBe(true);
    expect(unplaced(await slots(divisions[1]!.id))).toBe(true);
    wireRoundTrip(out);
  }, 120_000);

  it("refuses a subset — the apply was all-or-nothing, so the undo is too", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    await expect(
      restoreCompetitionSchedule(auth, competitionId, {
        checkpoints: [
          { division_id: checkpoints[0]!.divisionId, checkpoint_id: checkpoints[0]!.checkpointId },
        ],
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
    // …and it refused BEFORE writing: the named division is still on the AI
    // board, so this is a refusal rather than a partial restore.
    expect(unplaced(await slots(divisions[0]!.id))).toBe(false);
    expect(unplaced(await slots(divisions[1]!.id))).toBe(false);
  }, 120_000);

  it("refuses a division that was not in the apply event", async () => {
    const { auth, competitionId, checkpoints, foreignDivisionId } = await seedAppliedJoint(2);
    await expect(
      restoreCompetitionSchedule(auth, competitionId, {
        checkpoints: [
          ...checkpoints.map((c) => ({
            division_id: c.divisionId,
            checkpoint_id: c.checkpointId,
          })),
          { division_id: foreignDivisionId, checkpoint_id: checkpoints[0]!.checkpointId },
        ],
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 120_000);

  it("reports a per-division failure instead of aborting the rest", async () => {
    const { auth, competitionId, checkpoints } = await seedAppliedJoint(2);
    const bad = [
      { division_id: checkpoints[0]!.divisionId, checkpoint_id: checkpoints[0]!.checkpointId },
      {
        division_id: checkpoints[1]!.divisionId,
        checkpoint_id: "00000000-0000-0000-0000-000000000000",
      },
    ];
    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: bad,
      confirm: true,
    });
    expect(out.ok).toBe(false);
    expect(out.restored).toHaveLength(1);
    expect(out.failed).toHaveLength(1);
    // The two halves name DIFFERENT divisions — a loop that reported the same
    // division twice would satisfy the lengths above.
    expect(out.restored[0]!.division_id).toBe(checkpoints[0]!.divisionId);
    expect(out.failed[0]!.division_id).toBe(checkpoints[1]!.divisionId);
    // The good one was really rewound, not merely counted.
    expect(unplaced(await slots(checkpoints[0]!.divisionId))).toBe(true);
    // The FAILED half is on the wire too — `reason` is part of the contract.
    wireRoundTrip(out);
  }, 120_000);

  it("validates against the MOST RECENT apply when the competition has two", async () => {
    const { auth, competitionId, first, second, anchors } = await seedTwoJointApplies();
    // The earlier apply's pair is no longer the restorable set…
    await expect(
      restoreCompetitionSchedule(auth, competitionId, {
        checkpoints: checkpointsFor(first, anchors),
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
    // …the later one is, and it really rewinds.
    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpointsFor(second, anchors),
      confirm: true,
    });
    expect(out.ok).toBe(true);
    expect(out.restored.map((r) => r.division_id).sort()).toEqual(
      second.map((d) => d.id).sort(),
    );
    expect(unplaced(await slots(second[0]!.id))).toBe(true);
    // The untouched pair is still on its AI board — the restore rewound the
    // divisions the LATEST event named, not "the ones it found first".
    expect(unplaced(await slots(first[0]!.id))).toBe(false);
  }, 180_000);

  it("breaks a created_at tie on the id, exactly as lastCompetitionAiApply does", async () => {
    const { auth, competitionId, first, second, anchors } = await seedTwoJointApplies();
    const [older, newer] = await applyEvents(competitionId);
    // Same random prefix, opposite tails: LO < HI bytewise, and the prefix keeps
    // them unique on a test database that is reused across runs.
    const prefix = randomUUID().slice(0, 24);
    const LO = prefix + "000000000000";
    const HI = prefix + "ffffffffffff";
    // competition_events has no seq column, so a created_at tie is broken by
    // the id and by nothing else. Nothing in the app writes two applies inside
    // one transaction, so the tie has to be made by hand.
    //
    // The LOW id deliberately goes to the row an UNORDERED tie resolves to: the
    // update below rewrites it last, so it is the physically last live tuple,
    // which is what a plain `order by created_at desc limit 1` returns here.
    // Without the `, id desc` the restore then validates against the WRONG
    // event and refuses the pair asserted below.
    // created_at is copied IN SQL: a JS Date carries milliseconds and would
    // truncate Postgres's microseconds, which makes the two rows merely close
    // rather than tied, and the tie-break under test would never be reached.
    await sql`
      update competition_events set id = ${HI},
             created_at = (select created_at from competition_events where id = ${older!.id})
       where id = ${newer!.id}`;
    await sql`update competition_events set id = ${LO} where id = ${older!.id}`;

    // Highest id wins the tie -> the SECOND apply's pair is the restorable one.
    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpointsFor(second, anchors),
      confirm: true,
    });
    expect(out.ok).toBe(true);
    expect(out.restored.map((r) => r.division_id).sort()).toEqual(second.map((d) => d.id).sort());
    await expect(
      restoreCompetitionSchedule(auth, competitionId, {
        checkpoints: checkpointsFor(first, anchors),
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 180_000);

  // -------------------------------------------------------------------------
  // The competition-scoped lock. It is held SESSION-level for the whole rewind,
  // on a connection outside the pool, under a key the rewinds themselves never
  // take. All three facts are load-bearing and each has a test here.
  // -------------------------------------------------------------------------

  it("blocks a concurrent joint apply for the WHOLE rewind, not just an instant", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const order: string[] = [];

    // The restore is parked INSIDE its lock, before it rewinds anything. This
    // used to poll `pg_locks` for the key instead, which was a race the runner
    // could lose: the whole rewind holds the key for ~30ms, so a competitor
    // started "once the lock is held" was really started once the lock HAPPENED
    // to still be held. Now the window is held open until this test opens it.
    const openTheGate = parkInsideLock();

    const restoring = restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    }).then((out) => {
      order.push("restore");
      return out;
    });

    // Still the assertion that fails the moment the lock stops being taken — the
    // gate delays the BODY, it does not take the key. If `withSessionLocks`
    // acquired nothing, nothing is granted here however long we wait.
    expect(await waitUntil(() => advisoryLockHeld(`joint:${competitionId}`))).toBe(true);
    // …and the restore has not finished, so the competitor really does have to
    // wait for it.
    expect(order).toEqual([]);

    // The competitor takes the key exactly as applyCompetitionSchedule takes it:
    // transaction-level, same key, on a POOL connection. No lock_timeout here on
    // purpose — a bounded wait would hide the very thing under test.
    //
    // What it asserts is the BOARD as it stood the instant the lock was granted,
    // not a JS marker: the restore's promise resolves only after its lock
    // connection has also been closed, so a marker race here would be a race
    // between two teardown round trips rather than the guarantee under test.
    // Read after the lock, in the same transaction: READ COMMITTED gives each
    // statement a fresh snapshot, so this sees every rewind that had committed.
    let placedWhenApplyGotIn: boolean | undefined;
    const applying = withTenant(auth.orgId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"joint:" + competitionId}))`;
      order.push("apply");
      const rows = await tx<{ scheduled_at: Date | null }[]>`
        select scheduled_at from fixtures
         where division_id in ${tx(divisions.map((d) => d.id))}`;
      placedWhenApplyGotIn = rows.some((r) => r.scheduled_at !== null);
    });

    // The competitor is PARKED on the key — proven from pg_locks, not slept for
    // — before a single rewind step runs. That ordering is what makes the claim
    // in this test's title true by construction rather than by luck: the apply
    // is demonstrably waiting when the rewind starts, so if it gets in early it
    // can only be because the lock let go.
    expect(await waitUntil(() => advisoryLockWaiting(`joint:${competitionId}`))).toBe(true);
    expect(order).toEqual([]);

    openTheGate();
    const out = await restoring;
    await applying;
    expect(out.ok).toBe(true);
    // The whole point: by the time the apply got in, the ENTIRE rewind had
    // committed. A lock released between rewind steps — or never taken — lets it
    // in while fixtures are still placed.
    expect(placedWhenApplyGotIn).toBe(false);
  }, 180_000);

  it("still holds the key after the lock connection's idle timeout — a long rewind is not left unprotected", async () => {
    // "the WHOLE rewind" above is only tested over a rewind of a few seconds.
    // The lock connection runs no statements during a rewind — every append
    // goes through the pool — so it is idle by design, and postgres.js closes
    // an idle connection after `idle_timeout` (10s), which hands the backend's
    // session locks back. Measured before the keepalive: the key was gone 10.4s
    // in, i.e. every rewind longer than that finished unprotected while still
    // believing it was excluding a concurrent apply. A real joint undo — up to
    // 20 divisions, up to 500 inverse appends each — is well past 10s.
    //
    // A synthetic key: this is about the connection, not about any competition,
    // and a unique one keeps a reused test database from colliding.
    const key = `joint:idle-${randomUUID()}`;
    let heldLate: boolean | undefined;
    await withSessionLocks([key], async () => {
      await new Promise((r) => setTimeout(r, 13_000));
      // Observed from the POOL, i.e. another connection — the only vantage
      // point from which "someone still holds this" means anything.
      heldLate = await advisoryLockHeld(key);
    });
    expect(heldLate).toBe(true);
    // …and released the moment the body ended, so the keepalive did not turn a
    // holder into a leak.
    expect(await advisoryLockHeld(key)).toBe(false);
  }, 60_000);

  it("tells the body its lock is GONE when the backend holding it is terminated", async () => {
    // The keepalive is not proof of a lock. postgres.js reconnects transparently
    // (connection.js: `reconnect()` on close, `connect(query)` requeues), and
    // this connection is idle >99% of the time, so a drop — pooler restart,
    // network reset, admin termination — almost always lands BETWEEN beats. A
    // plain `select 1` then opens a NEW backend and SUCCEEDS: the advisory lock
    // died with the old backend, the body carries on believing it excludes a
    // concurrent apply, and the finally unlocks a backend that never held
    // anything. Only the backend PID tells the two apart.
    //
    // A synthetic key: this is about the connection, not any competition.
    const key = `joint:killed-${randomUUID()}`;
    let heldAtStart: boolean | undefined;
    let heldAfterKill: boolean | undefined;
    let pingStillWorks: boolean | undefined;
    await withSessionLocks([key], async (lock) => {
      heldAtStart = lock.held();
      const pid = await advisoryLockHolderPid(key);
      expect(pid).toBeGreaterThan(0);
      await sql`select pg_terminate_backend(${pid!})`;
      // The key really is gone — observed from the pool, the only vantage point
      // from which "nobody holds this" means anything.
      expect(await waitUntil(async () => !(await advisoryLockHeld(key)), 20_000)).toBe(true);
      // …and the helper says so, within a beat or two.
      await waitUntil(async () => !lock.held(), 20_000);
      heldAfterKill = lock.held();
      // The trap, pinned: the connection is perfectly usable again. A keepalive
      // that only asked "did the ping fail" would have seen nothing wrong.
      const [row] = await sql<{ n: number }[]>`select 1::int as n`;
      pingStillWorks = row?.n === 1;
    });
    expect(heldAtStart).toBe(true);
    expect(heldAfterKill).toBe(false);
    expect(pingStillWorks).toBe(true);
  }, 90_000);

  it("stops the rewind and reports EVERY division when the lock is lost before the first", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const body = {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    } as const;

    // A REAL loss: the restore's own lock backend is terminated, and the body
    // does not start until the helper's own beat has noticed. Nothing about the
    // lock is faked here — only the moment of the loss is made deterministic.
    hooks.interpose = async (lock, keys) => {
      const pid = await advisoryLockHolderPid(keys[0]!);
      expect(pid).toBeGreaterThan(0);
      await sql`select pg_terminate_backend(${pid!})`;
      expect(await waitUntil(async () => !lock.held(), 30_000)).toBe(true);
      return lock;
    };

    const out = await restoreCompetitionSchedule(auth, competitionId, body);
    // Not a throw: rewinds already performed would have been written, and the
    // caller needs a truthful record of them. Here none were.
    expect(out.ok).toBe(false);
    expect(out.restored).toEqual([]);
    expect(out.failed.map((f) => f.division_id).sort()).toEqual(divisions.map((d) => d.id).sort());
    expect(out.failed.every((f) => /lock/i.test(f.reason))).toBe(true);
    // …and it really did stop: both boards still carry the AI schedule, so the
    // report names exactly the divisions that still need undoing.
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(false);
    wireRoundTrip(out);
  }, 180_000);

  it("stops MID-rewind: what was rewound is reported restored, the rest come back failed", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    // The loop rewinds in division-id order, so these are its first and second.
    const [firstId, secondId] = divisions.map((d) => d.id).sort();

    // The lock survives the first division and is gone for the second. The
    // termination above proves `held()` really flips; this pins what the loop
    // does with it, which no amount of timing could produce reliably.
    hooks.interpose = async (lock) => {
      let checks = 0;
      return { held: () => (checks++ === 0 ? lock.held() : false) };
    };

    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    });
    expect(out.ok).toBe(false);
    // THE PARTIAL REPORT SURVIVES, and that is the whole reason a lost lock is
    // not a throw. The division rewound before the loss is still in `restored[]`
    // — with its real watermark and a non-zero step count, so it is a record of
    // work and not a placeholder — while only the untouched one is in `failed[]`.
    // Rejecting here would have discarded the only record that the first
    // division no longer carries the AI board.
    expect(out.restored.map((r) => r.division_id)).toEqual([firstId]);
    expect(out.restored[0]!.steps).toBeGreaterThan(0);
    expect(out.restored[0]!.watermark).toBeGreaterThan(0);
    expect(out.failed.map((f) => f.division_id)).toEqual([secondId]);
    expect(out.failed[0]!.reason).toMatch(/lock/i);
    // …and the report is TRUE of the board: the first division really was
    // rewound and must not be re-listed as outstanding; the second was never
    // attempted and still carries the AI board.
    expect(unplaced(await slots(firstId!))).toBe(true);
    expect(unplaced(await slots(secondId!))).toBe(false);
    // Both halves reach the caller — a partial report that the schema stripped
    // would be no better than a throw.
    wireRoundTrip(out);
  }, 180_000);

  it("leaves the per-division locks free — the joint key must not be the division key", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const order: string[] = [];

    // Parked inside the lock, for the reason given on the test above: this used
    // to poll for a key that is only held for ~30ms.
    //
    // The gate does NOT weaken the regression this pins. `withSessionLocks`
    // acquires every one of its keys BEFORE the body — and so before the gate —
    // so if the session key were ever `division:<id>`, it is already held
    // exclusively by the time the wait below starts.
    const openTheGate = parkInsideLock();

    const restoring = restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    }).then((out) => {
      order.push("restore");
      return out;
    });
    expect(await waitUntil(() => advisoryLockHeld(`joint:${competitionId}`))).toBe(true);
    expect(order).toEqual([]);

    // THE DEADLOCK REGRESSION. `division:<id>` is the key every rewind step
    // takes for itself (history.ts step(), on a pool connection). If the session
    // lock above ever reuses it, this wait never ends — and neither does the
    // restore, which is why the failure would be a hang rather than a red.
    await withTenant(auth.orgId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisions[0]!.id}))`;
      order.push("division");
    });
    // Granted while the restore holds its joint key: the namespaces are disjoint.
    expect(order).toEqual(["division"]);

    // …and the rewind itself then runs to completion while nothing here holds a
    // division key, which is the other half of "disjoint": a session lock on
    // `division:` would hang the steps rather than this wait.
    openTheGate();
    const out = await restoring;
    expect(out.ok).toBe(true);
    expect(order).toEqual(["division", "restore"]);
  }, 180_000);

  it("makes a blocked apply fail fast with a retryable 409 instead of stalling", async () => {
    const { auth, competitionId, divisions } = await seedAppliedJoint(2);
    // Hold the key the way a restore in flight holds it, and try to apply.
    await withSessionLocks([`joint:${competitionId}`], async () => {
      const started = Date.now();
      await expect(jointApply(auth, competitionId, divisions)).rejects.toMatchObject({
        status: 409,
        code: "SCHEDULE_APPLY_RESTORE_IN_PROGRESS",
      });
      // Fast is half the contract: the caller gets an answer it can act on
      // rather than a request that hangs until a gateway kills it.
      expect(Date.now() - started).toBeLessThan(30_000);
    });
  }, 180_000);

  it("makes a SECOND restore fail fast with a retryable 409 instead of waiting for the first", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const body = {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    } as const;

    // The key held exactly as a restore in flight holds it. The apply side has
    // always failed fast here; before the timeout on this side, a second undo
    // instead SAT on the lock, pinning a second out-of-pool connection for as
    // long as the first rewind took — and the likeliest second undo is the same
    // organiser double-clicking, not another admin.
    const started = Date.now();
    await withSessionLocks([`joint:${competitionId}`], async () => {
      await expect(restoreCompetitionSchedule(auth, competitionId, body)).rejects.toMatchObject({
        status: 409,
        code: "SCHEDULE_APPLY_RESTORE_IN_PROGRESS",
      });
    });
    // Fast is half the contract: without the bound this call does not return
    // until the holder does, so an unbounded wait fails here as a timeout.
    expect(Date.now() - started).toBeLessThan(60_000);
    // A refusal, not a partial undo: nothing rewound behind the 409.
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(false);

    // The SAME body succeeds once the key is free, so the 409 was the lock and
    // not something wrong with the request — a guard that refused either way
    // would satisfy the assertion above.
    const out = await restoreCompetitionSchedule(auth, competitionId, body);
    expect(out.ok).toBe(true);
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(true);
  }, 180_000);

  it("reads the apply event UNDER the lock — an apply that lands first is not missed", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const body = {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    } as const;

    // A stand-in for a joint write already in flight. Holding the key is what
    // opens the window: the restore below parks on the lock, and anything it
    // read BEFORE the lock was read from a world that is about to change.
    let release!: () => void;
    const holderDone = new Promise<void>((r) => {
      release = r;
    });
    const holding = withSessionLocks([`joint:${competitionId}`], () => holderDone);
    expect(await waitUntil(() => advisoryLockHeld(`joint:${competitionId}`))).toBe(true);

    const restoring = restoreCompetitionSchedule(auth, competitionId, body).then(
      (out) => ({ out, err: undefined }),
      (err: unknown) => ({ out: undefined, err }),
    );

    // Parked ON the lock, proven from pg_locks rather than slept for: every
    // step the restore performs before acquiring has now happened, so the read
    // either already ran (the bug) or is still to come (the fix).
    //
    // The budget is deliberately SMALL. The restore's 5s `lock_timeout` starts
    // ticking when it issues `pg_advisory_lock`, i.e. before this poll, and the
    // remainder still has to cover `insertJointApplyEvent` and the holder's
    // release round-trip. Spend 4s of the 5 here and a loaded machine gets a 409
    // instead, failing on the 422 assertion below with a misleading message;
    // spend 1.5s and a lock that is never waited on fails HERE, saying so.
    expect(
      await waitUntil(() => advisoryLockWaiting(`joint:${competitionId}`), 1_500),
    ).toBe(true);

    // …and NOW a joint apply commits, over a different division set. The
    // restore's anchors no longer name what the latest apply wrote.
    await insertJointApplyEvent(auth, competitionId, [divisions[0]!.id]);
    release();
    await holding;

    // Under the fix the event read happens after the wait, so the superseding
    // apply is visible and the set check refuses. With the read outside the
    // lock the restore validated against the OLD event and rewound a board the
    // organiser had already replaced.
    const settled = await restoring;
    expect(settled.err).toMatchObject({ status: 422 });
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(false);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Tenancy. Every read here is org-scoped; these pin that the scoping is real
  // and that a refusal leaves the other org's board alone. A 404 and a 200 that
  // did nothing look identical in the response, so each asserts the BOARD too.
  // -------------------------------------------------------------------------

  it("cannot reach another org's apply event or another org's board", async () => {
    const mine = await seedAppliedJoint(2);
    const theirs = await seedAppliedJoint(2);

    // Their competition, my credentials: the event read is scoped by org, so
    // there is no joint apply to be found at all.
    await expect(
      restoreCompetitionSchedule(mine.auth, theirs.competitionId, {
        checkpoints: theirs.checkpoints.map((c) => ({
          division_id: c.divisionId,
          checkpoint_id: c.checkpointId,
        })),
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // My competition, their divisions: refused on the set check, before any
    // rewind — the anchors are theirs, so a leak here would rewind their board.
    await expect(
      restoreCompetitionSchedule(mine.auth, mine.competitionId, {
        checkpoints: theirs.checkpoints.map((c) => ({
          division_id: c.divisionId,
          checkpoint_id: c.checkpointId,
        })),
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });

    // The status codes above are only half the claim: BOTH boards are untouched.
    for (const d of [...theirs.divisions, ...mine.divisions]) {
      expect(unplaced(await slots(d.id))).toBe(false);
    }
  }, 240_000);

  it("reports a checkpoint that belongs to a DIFFERENT division rather than rewinding", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    // Both divisions are named, so the set check passes and the request reaches
    // the rewind — but each anchor is paired with the OTHER division. A
    // checkpoint is looked up by (id, division_id), so neither resolves.
    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: [
        { division_id: checkpoints[0]!.divisionId, checkpoint_id: checkpoints[1]!.checkpointId },
        { division_id: checkpoints[1]!.divisionId, checkpoint_id: checkpoints[0]!.checkpointId },
      ],
      confirm: true,
    });
    expect(out.ok).toBe(false);
    expect(out.restored).toEqual([]);
    expect(out.failed.map((f) => f.division_id).sort()).toEqual(divisions.map((d) => d.id).sort());
    expect(out.failed.every((f) => /checkpoint not found/i.test(f.reason))).toBe(true);
    // Nothing rewound: a mispaired anchor must not fall back to "the latest".
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(false);
  }, 180_000);

  // -------------------------------------------------------------------------
  // State edges.
  // -------------------------------------------------------------------------

  it("404s when the competition has no joint apply at all", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: `Never Applied ${Date.now()}`,
      visibility: "public",
      branding: {},
    });
    const division = await seedDivision(auth, comp.id, "Alpha", 4, ["Court 1"]);
    const cp = await createCheckpoint(auth, division.id, "Anchor", "ai");
    await expect(
      restoreCompetitionSchedule(auth, comp.id, {
        checkpoints: [{ division_id: division.id, checkpoint_id: cp.id }],
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  }, 180_000);

  it("answers the BODY's 422 ahead of the missing-apply 404 when both are available", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: `Never Applied Dup ${Date.now()}`,
      visibility: "public",
      branding: {},
    });
    const division = await seedDivision(auth, comp.id, "Alpha", 4, ["Court 1"]);
    const cp = await createCheckpoint(auth, division.id, "Anchor", "ai");

    // Two refusals are both available here: the body names one division TWICE,
    // and the competition has no joint apply to restore at all. The body check
    // wins deliberately — moving the cheap checks above the lock changed this
    // answer from 404 to 422, and the new order is the one to keep: a caller
    // told "no joint apply to restore" would go hunting for a missing event
    // instead of looking at the duplicate it sent.
    //
    // The MESSAGE is asserted, not just the status: this endpoint has more than
    // one 422, and a bare status would be satisfied by the set-mismatch refusal
    // that lives under the lock — i.e. by exactly the ordering under test.
    await expect(
      restoreCompetitionSchedule(auth, comp.id, {
        checkpoints: [
          { division_id: division.id, checkpoint_id: cp.id },
          { division_id: division.id, checkpoint_id: cp.id },
        ],
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/named twice/) });
  }, 180_000);

  it("refuses when the apply event names no divisions — it does not restore nothing and call it a success", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    // `payload.division_ids ?? []` is the fallback under test. An empty list can
    // match no request, so EVERY request must be refused — the failure mode
    // being pinned is a future refactor turning this into ok:true, 0 restored.
    await sql`
      update competition_events set payload = ${sql.json({})}
       where competition_id = ${competitionId} and type = ${JOINT_APPLY_EVENT}`;
    await expect(
      restoreCompetitionSchedule(auth, competitionId, {
        checkpoints: checkpoints.map((c) => ({
          division_id: c.divisionId,
          checkpoint_id: c.checkpointId,
        })),
        confirm: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(false);
  }, 180_000);

  it("reports EVERY division when they all fail, and releases the lock afterwards", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const out = await restoreCompetitionSchedule(auth, competitionId, {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: "00000000-0000-0000-0000-000000000000",
      })),
      confirm: true,
    });
    expect(out.ok).toBe(false);
    expect(out.restored).toEqual([]);
    expect(out.failed.map((f) => f.division_id).sort()).toEqual(divisions.map((d) => d.id).sort());
    wireRoundTrip(out);

    // THE `finally` GUARANTEE. A restore that did no work still has to release
    // its session lock: if it does not, the competition is wedged for every
    // subsequent joint write until the lock connection idles out.
    const started = Date.now();
    await jointApply(auth, competitionId, divisions);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 180_000);

  it("is idempotent — restoring twice rewinds once and reports no second rewind", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const body = {
      checkpoints: checkpoints.map((c) => ({
        division_id: c.divisionId,
        checkpoint_id: c.checkpointId,
      })),
      confirm: true,
    } as const;

    const first = await restoreCompetitionSchedule(auth, competitionId, body);
    expect(first.ok).toBe(true);
    expect(first.restored.every((r) => r.steps > 0)).toBe(true);

    // Already at the anchor: a second call is harmless and says so with 0 steps.
    // It must not refuse, and it must not rewind PAST the checkpoint.
    const second = await restoreCompetitionSchedule(auth, competitionId, body);
    expect(second.ok).toBe(true);
    expect(second.failed).toEqual([]);
    expect(second.restored.every((r) => r.steps === 0)).toBe(true);
    for (const d of divisions) expect(unplaced(await slots(d.id))).toBe(true);
  }, 240_000);

  it("requires confirm: true", async () => {
    const { auth, competitionId, checkpoints } = await seedAppliedJoint(2);
    await expect(
      restoreCompetitionSchedule(auth, competitionId, {
        checkpoints: checkpoints.map((c) => ({
          division_id: c.divisionId,
          checkpoint_id: c.checkpointId,
        })),
        confirm: false as unknown as true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  }, 120_000);
});

// The request bounds live in the zod schema, and the usecase never re-parses its
// input — the schema runs only in the route — so these are the ONLY place the
// edges of the body are enforced. No DB: not gated on one.
describe("RestoreCompetitionScheduleRequest bounds", () => {
  const anchor = () => ({ division_id: randomUUID(), checkpoint_id: randomUUID() });

  it("rejects an empty checkpoint list — an undo of nothing is a mistake, not a no-op", () => {
    const r = RestoreCompetitionScheduleRequest.safeParse({ checkpoints: [], confirm: true });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "checkpoints")).toBe(true);
  });

  it("accepts 20 anchors and rejects 21 — the joint apply's own division cap", () => {
    const many = (n: number) => ({
      checkpoints: Array.from({ length: n }, anchor),
      confirm: true,
    });
    expect(RestoreCompetitionScheduleRequest.safeParse(many(20)).success).toBe(true);
    expect(RestoreCompetitionScheduleRequest.safeParse(many(21)).success).toBe(false);
  });

  it("rejects confirm false and confirm absent — the double-submit guard is a literal", () => {
    expect(
      RestoreCompetitionScheduleRequest.safeParse({ checkpoints: [anchor()], confirm: false })
        .success,
    ).toBe(false);
    expect(
      RestoreCompetitionScheduleRequest.safeParse({ checkpoints: [anchor()] }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid id rather than passing it to a query", () => {
    expect(
      RestoreCompetitionScheduleRequest.safeParse({
        checkpoints: [{ division_id: "not-a-uuid", checkpoint_id: randomUUID() }],
        confirm: true,
      }).success,
    ).toBe(false);
  });
});
