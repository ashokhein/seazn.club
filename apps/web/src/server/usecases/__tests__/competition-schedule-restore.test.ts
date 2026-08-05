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
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createCheckpoint } from "../history";
import { applyCompetitionSchedule } from "../competition-schedule-apply";
import { restoreCompetitionSchedule } from "../competition-schedule-restore";
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
  return { id: division.id, name, fixtureIds: ordered.map((f) => f.id) };
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

  const payload = [];
  for (const [i, d] of divisions.entries()) {
    payload.push({
      division_id: d.id,
      expected_seq: await divisionSeq(d.id),
      assignments: d.fixtureIds.map((fixture_id, j) => ({
        fixture_id,
        scheduled_at: at(j * 30),
        court_label: `Court ${i + 1}`,
      })),
    });
  }
  await applyCompetitionSchedule(auth, comp.id, { divisions: payload, source: "ai" });

  return {
    auth,
    competitionId: comp.id,
    divisions,
    checkpoints,
    foreignDivisionId: foreign.id,
  };
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
  }, 120_000);

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
