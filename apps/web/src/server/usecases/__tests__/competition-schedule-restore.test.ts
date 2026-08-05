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
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

/** Poll `pred` until true. Returns false on timeout — the CALLER asserts, so a
 *  lock that is never taken fails an assertion instead of hanging the suite. */
async function waitUntil(pred: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
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

    // Wait for the lock to be HELD rather than sleeping: this is what makes the
    // competitor below start from a known state instead of a hopeful one. It is
    // also the assertion that fails the moment the lock stops being taken.
    expect(await waitUntil(() => advisoryLockHeld(`joint:${competitionId}`))).toBe(true);
    // …and the restore is still running, so the competitor really does have to
    // wait for it. Without this, a restore that had already finished would make
    // the ordering below pass for the wrong reason.
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

    const out = await restoring;
    await applying;
    expect(out.ok).toBe(true);
    // The whole point: by the time the apply got in, the ENTIRE rewind had
    // committed. A lock released between rewind steps — or never taken — lets it
    // in while fixtures are still placed.
    expect(placedWhenApplyGotIn).toBe(false);
  }, 180_000);

  it("leaves the per-division locks free — the joint key must not be the division key", async () => {
    const { auth, competitionId, divisions, checkpoints } = await seedAppliedJoint(2);
    const order: string[] = [];

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
    // Granted while the restore is still mid-flight: the namespaces are disjoint.
    expect(order).toEqual(["division"]);

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
