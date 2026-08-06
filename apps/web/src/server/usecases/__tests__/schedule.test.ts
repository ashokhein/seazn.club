// PROMPT-17 acceptance E2E (doc 12): 8-team group+KO division — auto-schedule
// across 2 courts with a rest constraint, drag into a court clash (blocked),
// into a rest violation (warned, allowed), lock two cards, re-flow, publish,
// start, score round 1, rain-reschedule remaining. Plus the Community gates
// (doc 12 §5): constraints/board are Pro, quick-start unaffected.
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  putScheduleSettings,
  getScheduleSettings,
  loadSettings,
  autoSchedule,
  applySchedule,
  moveFixture,
  validateSchedule,
  publishSchedule,
  startDivision,
} from "../schedule";
import { patchFixture } from "../fixtures";
import { scoreEvent } from "../scoring";
import { publicSchedule } from "../public";
import {
  ApplyScheduleRequest,
  AutoScheduleRequest,
  AutoScheduleResult,
  ScheduleMetrics,
  ScheduleSolverInfo,
} from "@/server/api-v1/schemas";
import { seedOrg as seedOfficialsOrg, seedFutureDivision } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

async function seedOrg(plan: "community" | "pro"): Promise<{ auth: AuthCtx; orgSlug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  if (plan === "pro") {
    for (const feature of ["scheduling.constraints", "scheduling.board", "scheduling.multi_division"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value)
        values (${orgId}, ${feature}, true)
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
  }
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgSlug: "org-" + suffix,
  };
}

async function decide(auth: AuthCtx, fixtureId: string, homeScore: number, awayScore: number) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: homeScore, p2Score: awayScore },
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Pure schema contract (no DB): the apply request must accept source "ai"
// (v4/03 §4). This guards the zod enum widening at schemas.ts ApplyScheduleRequest
// — it goes red if the "ai" member is reverted, independent of the DB constraint.
describe("ApplyScheduleRequest schema (v4/03 §4)", () => {
  const validAssignment = {
    fixture_id: randomUUID(),
    scheduled_at: "2026-08-01T09:00:00.000Z",
    court_label: "Court 1",
  };

  it("accepts source 'ai'", () => {
    const parsed = ApplyScheduleRequest.parse({
      assignments: [validAssignment],
      source: "ai",
      expected_seq: 0,
    });
    expect(parsed.source).toBe("ai");
  });

  it("still accepts 'auto' and 'manual' and defaults to 'auto'", () => {
    expect(ApplyScheduleRequest.parse({ assignments: [validAssignment], source: "auto" }).source).toBe("auto");
    expect(ApplyScheduleRequest.parse({ assignments: [validAssignment], source: "manual" }).source).toBe("manual");
    expect(ApplyScheduleRequest.parse({ assignments: [validAssignment] }).source).toBe("auto");
  });

  it("rejects an unknown source", () => {
    expect(() => ApplyScheduleRequest.parse({ assignments: [validAssignment], source: "robot" })).toThrow();
  });
});

describe.skipIf(!HAS_DB)("scheduling console (doc 12, PROMPT-17)", () => {
  it("drives the full plan-first lifecycle on an 8-team group+KO division", async () => {
    const { auth, orgSlug } = await seedOrg("pro");
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Weekend Carnival",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [groups] = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      {
        seq: 2, kind: "knockout", name: "KO", config: {},
        qualification: { take: [
          { pool: "A", rank: 1 }, { pool: "B", rank: 2 },
          { pool: "B", rank: 1 }, { pool: "A", rank: 2 },
        ] },
      },
    ]);

    // Settings: 2 courts + rest constraint (Pro — the override allows it).
    const settings = await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court 1", "Court 2"],
        perEntrantMinRest: 30,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    expect(settings.config.courts).toHaveLength(2);
    const roundTrip = await getScheduleSettings(auth, division.id);
    expect(roundTrip.config.perEntrantMinRest).toBe(30);

    // Generate the group stage (2 pools × 6 fixtures) and auto-schedule it.
    const generated = await generateStageFixtures(auth, groups.id);
    expect(generated.created).toBe(12);

    const proposal = await autoSchedule(auth, groups.id, { only_unlocked: false, mode: "build" });
    expect(proposal.assignments).toHaveLength(12);
    expect(proposal.conflicts.filter((c) => c.blocking)).toHaveLength(0);
    // Both courts in use; per-entrant rest ≥ 30 min in the proposal.
    expect(new Set(proposal.assignments.map((a) => a.court_label))).toEqual(
      new Set(["Court 1", "Court 2"]),
    );

    // Propose-only: nothing persisted until apply (doc 12 §4).
    const [{ n: persisted }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where stage_id = ${groups.id} and scheduled_at is not null`;
    expect(persisted).toBe(0);

    const applied = await applySchedule(auth, groups.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });
    expect(applied.applied).toBe(12);

    const board = await sql<
      { id: string; scheduled_at: Date; court_label: string; home_entrant_id: string; away_entrant_id: string; schedule_source: string }[]
    >`
      select id, scheduled_at, court_label, home_entrant_id, away_entrant_id, schedule_source
      from fixtures where stage_id = ${groups.id} order by scheduled_at, court_label`;
    expect(board.every((f) => f.schedule_source === "auto")).toBe(true);

    // Rest constraint honoured in the persisted board.
    const byEntrant = new Map<string, number[]>();
    for (const f of board) {
      for (const e of [f.home_entrant_id, f.away_entrant_id]) {
        (byEntrant.get(e) ?? byEntrant.set(e, []).get(e)!).push(f.scheduled_at.getTime());
      }
    }
    for (const times of byEntrant.values()) {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual((30 + 30) * MIN);
      }
    }

    // Drag into a court clash → BLOCKED (conflict.court, doc 12 §2), nothing moves.
    const [f1, f2] = [board[0]!, board.find((f) => f.id !== board[0]!.id)!];
    await expect(
      moveFixture(auth, f2.id, {
        scheduled_at: f1.scheduled_at.toISOString(),
        court_label: f1.court_label,
      }),
    ).rejects.toSatisfy((err: unknown) => EngineError.is(err, "SCHEDULE_CONFLICT"));
    const [f2After] = await sql<{ scheduled_at: Date; court_label: string }[]>`
      select scheduled_at, court_label from fixtures where id = ${f2.id}`;
    expect(f2After.scheduled_at.getTime()).toBe(f2.scheduled_at.getTime());
    expect(f2After.court_label).toBe(f2.court_label);

    // Drag into a rest violation → warned but ALLOWED. Park two fixtures that
    // share an entrant back-to-back on different courts, far from the rest.
    const shared = board.find(
      (f) =>
        f.id !== f1.id &&
        (f.home_entrant_id === f1.home_entrant_id || f.away_entrant_id === f1.home_entrant_id ||
         f.home_entrant_id === f1.away_entrant_id || f.away_entrant_id === f1.away_entrant_id),
    )!;
    await moveFixture(auth, f1.id, { scheduled_at: at(600), court_label: "Court 1" });
    await moveFixture(auth, shared.id, { scheduled_at: at(630), court_label: "Court 2" });
    const report = await validateSchedule(auth, division.id);
    const restWarnings = report.conflicts.filter((c) => c.code === "warn.rest");
    expect(restWarnings.length).toBeGreaterThan(0);
    expect(restWarnings.every((c) => !c.blocking)).toBe(true);
    // The single move is audited (doc 12 §2: schedule_edited {fixture, from, to}).
    const [{ n: edits }] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_events
      where division_id = ${division.id} and type = 'schedule_edited'`;
    expect(edits).toBeGreaterThanOrEqual(2);

    // Lock two cards, re-flow the rest: pins survive byte-identically.
    const pinA = board[2]!;
    const pinB = board[3]!;
    await patchFixture(auth, pinA.id, { schedule_locked: true });
    await patchFixture(auth, pinB.id, { schedule_locked: true });
    const reflow = await autoSchedule(auth, groups.id, { only_unlocked: true, mode: "reflow" });
    const pinnedOut = new Map(reflow.assignments.map((a) => [a.fixture_id, a]));
    expect(pinnedOut.get(pinA.id)?.scheduled_at).toBe(pinA.scheduled_at.toISOString());
    expect(pinnedOut.get(pinA.id)?.court_label).toBe(pinA.court_label);
    expect(pinnedOut.get(pinB.id)?.scheduled_at).toBe(pinB.scheduled_at.toISOString());
    await applySchedule(auth, groups.id, {
      assignments: reflow.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });

    // Publish-gating (PROMPT-17 item 7): while the division is in setup the
    // public schedule shows no timetable; publish lights it up.
    const before = (await publicSchedule(orgSlug, competition.slug, division.slug)) as {
      fixtures: { scheduled_at: string | null }[];
    };
    expect(before.fixtures.every((f) => f.scheduled_at === null)).toBe(true);

    const published = await publishSchedule(auth, division.id);
    expect(published.status).toBe("scheduled");
    const after = (await publicSchedule(orgSlug, competition.slug, division.slug)) as {
      fixtures: { scheduled_at: string | null }[];
    };
    expect(after.fixtures.some((f) => f.scheduled_at !== null)).toBe(true);

    // Scoring is still closed between publish and start (doc 12 §1).
    await expect(decide(auth, board[4]!.id, 1, 0)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "WRONG_PHASE"),
    );
    const startOut = await startDivision(auth, division.id);
    expect(startOut).toMatchObject({ status: "active", started: true, generated: 0 });

    // Score round 1.
    const round1 = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${groups.id} and round_no = 1`;
    for (const f of round1) await decide(auth, f.id, 2, 0);

    // Rain! Reschedule the remaining fixtures only; decided ones are immutable.
    const remaining = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${groups.id} and status = 'scheduled'
      order by scheduled_at, id`;
    expect(remaining.length).toBeGreaterThan(0);
    const rain = await applySchedule(auth, groups.id, {
      assignments: remaining.map((f, i) => ({
        fixture_id: f.id,
        scheduled_at: at(24 * 60 + i * 35),
        court_label: "Court 1",
      })),
      source: "auto",
    });
    expect(rain.applied).toBe(remaining.length);
    await expect(
      moveFixture(auth, round1[0]!.id, { scheduled_at: at(24 * 60), court_label: "Court 2" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      applySchedule(auth, groups.id, {
        assignments: [{ fixture_id: round1[0]!.id, scheduled_at: at(25 * 60), court_label: "Court 2" }],
        source: "auto",
      }),
    ).rejects.toMatchObject({ status: 422 });

    // The structural ledger recorded the whole story.
    const events = await sql<{ type: string }[]>`
      select type from division_events where division_id = ${division.id} order by seq`;
    const types = new Set(events.map((e) => e.type));
    for (const expected of ["schedule_applied", "schedule_edited", "schedule_published", "division_started"]) {
      expect(types).toContain(expected);
    }
  });

  // Was "constraints/board are 402-gated". V353 (#382) opened
  // `scheduling.constraints` and `scheduling.board` to every plan — a community
  // organiser could already ask the AI for a schedule and then not drag one
  // fixture of it. INVERTED rather than deleted: both gates still stand in
  // `putScheduleSettings`, `applySchedule` and `moveFixture`, so an unapplied
  // migration or an override switching either key back off reds this test.
  it("Community org: constraints/board are open, quick-start unaffected (#382)", async () => {
    const { auth } = await seedOrg("community");
    const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "Club Night", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });

    // Constraint solver fields: stored, not refused (#382). Two courts is what
    // trips `usesConstraints`, and the stored value is read back so a no-op
    // write cannot pass this.
    const constrained = await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0, matchMinutes: 30, gapMinutes: 0,
        courts: ["C1", "C2"], // multi-court is the constraint solver
        perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
      },
      tz: "UTC",
    });
    expect(constrained.config.courts).toEqual(["C1", "C2"]);

    // Back to a single court for the auto-schedule assertions below.
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0, matchMinutes: 30, gapMinutes: 0,
        courts: ["C1"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
      },
      tz: "UTC",
    });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    const proposal = await autoSchedule(auth, stage.id, { only_unlocked: false, mode: "build" });
    expect(proposal.assignments).toHaveLength(6);
    await applySchedule(auth, stage.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_label: a.court_label,
      })),
      source: "auto",
    });

    // Board editing (pins, manual assignment sets) is open too (#382). Both
    // `scheduling.board` branches are exercised — the pin on `moveFixture` and
    // `source: "manual"` on `applySchedule` — and each is read back, so a call
    // that returned quietly without writing cannot pass.
    await patchFixture(auth, fixtures[0]!.id, { schedule_locked: true });
    await applySchedule(auth, stage.id, {
      assignments: [{ fixture_id: fixtures[0]!.id, scheduled_at: at(600), court_label: "C1" }],
      source: "manual",
    });
    const [pinned] = await sql<{ schedule_locked: boolean; court_label: string | null }[]>`
      select schedule_locked, court_label from fixtures where id = ${fixtures[0]!.id}`;
    expect(pinned!.schedule_locked).toBe(true);
    expect(pinned!.court_label).toBe("C1");

    // Quick-start unaffected: start opens scoring immediately.
    const started = await startDivision(auth, division.id);
    expect(started.status).toBe("active");
    const out = await decide(auth, fixtures[0]!.id, 2, 1);
    expect(out.status).toBe("decided");
  });

  it("quick-start generates fixtures and slots rolling round times (doc 12 §1.A)", async () => {
    const { auth } = await seedOrg("community");
    const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "Rolling", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0, matchMinutes: 25, gapMinutes: 0,
        courts: ["C1"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
        roundMinutes: 60,
      },
      tz: "UTC",
    });

    // One click: generate → sequence-slot → active (no fixtures existed).
    const started = await startDivision(auth, division.id);
    expect(started.started).toBe(true);
    expect(started.generated).toBe(6);

    const rows = await sql<{ round_no: number; scheduled_at: Date | null }[]>`
      select round_no, scheduled_at from fixtures f
      join stages s on s.id = f.stage_id
      where s.division_id = ${division.id} order by round_no`;
    // Rolling: round r starts at startAt + (r−1)·roundMinutes.
    for (const r of rows) {
      expect(r.scheduled_at?.toISOString()).toBe(at((r.round_no - 1) * 60));
    }
  });

  it("rejects a stale expected_seq on schedule writes with 409 SEQ_CONFLICT (v3/11 gap 10)", async () => {
    const { auth } = await seedOrg("pro");
    const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "TwoAdmins", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0, matchMinutes: 30, gapMinutes: 0,
        courts: ["C1", "C2"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
      },
      tz: "UTC",
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const [fa, fb] = fixtures;

    const seqOf = async () => {
      const [row] = await sql<{ seq: number }[]>`
        select seq::int from divisions where id = ${division.id}`;
      return Number(row!.seq);
    };

    // Client A loads the board at seq S, writes with expected_seq = S — lands.
    const seq0 = await seqOf();
    await patchFixture(auth, fa!.id, {
      scheduled_at: at(0), court_label: "C1", expected_seq: seq0,
    });

    // Client B still holds seq S: its write must 409, nothing persisted.
    let conflict: unknown;
    try {
      await patchFixture(auth, fb!.id, {
        scheduled_at: at(0), court_label: "C2", expected_seq: seq0,
      });
    } catch (err) {
      conflict = err;
    }
    expect(EngineError.is(conflict)).toBe(true);
    expect((conflict as EngineError).code).toBe("SEQ_CONFLICT");
    // the 409 carries the current seq so the client can resync
    expect((conflict as EngineError).data).toMatchObject({ actualSeq: await seqOf() });
    const [bRow] = await sql<{ scheduled_at: Date | null }[]>`
      select scheduled_at from fixtures where id = ${fb!.id}`;
    expect(bRow!.scheduled_at).toBeNull();

    // After resync (fresh seq) the same write goes through.
    await patchFixture(auth, fb!.id, {
      scheduled_at: at(60), court_label: "C2", expected_seq: await seqOf(),
    });

    // Writes without the token stay accepted (older clients keep working).
    await patchFixture(auth, fa!.id, { scheduled_at: at(120) });
  });

  it("accepts source 'ai' and stamps schedule_source (v4/03 §4)", async () => {
    const { auth } = await seedOrg("pro");
    const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "AI Cup", visibility: "private", branding: {} });
    const division = await createDivision(auth, competition.id, {
      name: "Open", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
      { kind: "individual", display_name: "C", seed: 3, members: [] },
      { kind: "individual", display_name: "D", seed: 4, members: [] },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0, matchMinutes: 30, gapMinutes: 0,
        courts: ["C1", "C2"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
      },
      tz: "UTC",
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const target = fixtures[0]!;

    // The AI accept flow applies with source:"ai"; the placed fixture carries it
    // so the ledger/analytics can tell AI applies from auto/manual ones.
    const out = await applySchedule(auth, stage!.id, {
      source: "ai",
      assignments: [{ fixture_id: target.id, scheduled_at: at(0), court_label: "C1" }],
    });
    expect(out.applied).toBeGreaterThan(0);
    const [row] = await sql<{ schedule_source: string }[]>`
      select schedule_source from fixtures where id = ${target.id}`;
    expect(row!.schedule_source).toBe("ai");
  });
});

describe.skipIf(!HAS_DB)("official conflicts on the board", () => {
  it("emits warn.official_declined for a declined assignment", async () => {
    const { auth } = await seedOfficialsOrg("pro");
    const { division, fixtures } = await seedFutureDivision(auth);
    const fixtureId = fixtures[0]!.id;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, 'Ref X') returning id`;
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name, role_keys)
      values (${auth.orgId}, ${person!.id}, 'Ref X', ${sql.json(["referee"])}) returning id`;
    await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
              values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'declined')`;

    const { conflicts } = await validateSchedule(auth, division.id);
    expect(conflicts.some((c) => c.code === "warn.official_declined" && c.fixture_id === fixtureId)).toBe(true);
    expect(conflicts.find((c) => c.code === "warn.official_declined")!.blocking).toBe(false);
  });
});

// W2 (#397): ONE organisation timezone governs every temporal decision in the
// AI scheduling pack, while a division that already holds its own tz keeps
// winning for DISPLAY. Both answers have to be available on the settings row or
// the pack cannot honour the rule.
describe.skipIf(!HAS_DB)("loadSettings resolves the organisation zone separately (#397)", () => {
  async function seedDivisionWithOrgTz(orgTz: string | null): Promise<{
    auth: AuthCtx;
    divisionId: string;
  }> {
    const { auth } = await seedOrg("pro");
    await sql`update organizations set timezone = ${orgTz} where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "TZ Cup",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
      eligibility: [],
    });
    return { auth, divisionId: division.id };
  }

  // Driven through `loadSettings` directly, not the HTTP boundary: `orgTz` is
  // an INTERNAL field. `getScheduleSettings`/`putScheduleSettings` map to the
  // wire shape and deliberately drop it — that boundary is pinned separately in
  // schedule-settings-wire.test.ts.
  const load = (auth: AuthCtx, divisionId: string) =>
    withTenant(auth.orgId, (tx) => loadSettings(tx, divisionId));

  it("returns the org zone in orgTz even when the division overrides displayTz", async () => {
    const { auth, divisionId } = await seedDivisionWithOrgTz("Europe/London");
    await sql`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${divisionId}, ${sql.json({})}, 'Europe/Madrid', now())
      on conflict (division_id) do update set tz = excluded.tz`;

    const settings = await load(auth, divisionId);
    expect(settings.displayTz).toBe("Europe/Madrid"); // display lane, unchanged
    expect(settings.orgTz).toBe("Europe/London"); // governing lane, new
    // And the same division over the wire still renders in the display zone.
    expect((await getScheduleSettings(auth, divisionId)).tz).toBe("Europe/Madrid");
  });

  it("falls back to UTC when the organisation has no timezone", async () => {
    const { auth, divisionId } = await seedDivisionWithOrgTz(null);
    const settings = await load(auth, divisionId);
    expect(settings.orgTz).toBe("UTC");
  });

  it("falls back to UTC when the organisation timezone is not a valid IANA id", async () => {
    const { auth, divisionId } = await seedDivisionWithOrgTz("Pacific/Atlantis");
    const settings = await load(auth, divisionId);
    expect(settings.orgTz).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------
// Auto-schedule API contract (z3 solver programme, task 8). Pure schema tests —
// no DB, so they are deliberately OUTSIDE the skipIf(!HAS_DB) blocks above.
// ---------------------------------------------------------------------------

describe("AutoScheduleRequest.mode", () => {
  it("defaults to reflow when only_unlocked is true", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: true }).mode).toBe("reflow");
  });

  it("defaults to build when only_unlocked is false", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: false }).mode).toBe("build");
  });

  it("defaults to reflow for an empty body, matching today's only_unlocked default", () => {
    expect(AutoScheduleRequest.parse({}).mode).toBe("reflow");
  });

  it("takes an explicit mode over the derived one", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: true, mode: "polish" }).mode).toBe("polish");
  });

  /** Sharper than the "polish" case: here the explicit value is one the
   *  derivation could also produce, but for the OTHER only_unlocked. An
   *  implementation that always derives returns "build" and is caught. */
  it("keeps an explicit mode that contradicts the derivation", () => {
    expect(AutoScheduleRequest.parse({ only_unlocked: false, mode: "reflow" }).mode).toBe("reflow");
  });

  it("rejects an unknown mode", () => {
    expect(() => AutoScheduleRequest.parse({ mode: "magic" })).toThrow();
  });

  /** Regression guard: adding `mode` must not disturb the pre-existing field
   *  the route still reads (`body.only_unlocked`). */
  it("leaves only_unlocked defaulting to true and still type-checked", () => {
    expect(AutoScheduleRequest.parse({}).only_unlocked).toBe(true);
    expect(AutoScheduleRequest.parse({ only_unlocked: false }).only_unlocked).toBe(false);
    expect(() => AutoScheduleRequest.parse({ only_unlocked: "yes" })).toThrow();
  });
});

describe("AutoScheduleResult metrics + solver contract", () => {
  const metrics = {
    makespan_minutes: 240,
    worst_idle_gap_minutes: 45,
    court_imbalance_minutes: 30,
    placed: 11,
    total: 14,
  };
  const solver = {
    engine: "z3" as const,
    status: "ok" as const,
    tiers_completed: 2,
    tiers_total: 4,
    budget_expired: false,
    elapsed_ms: 1234,
    moved: 6,
  };

  /** A round-trip toEqual, not a field-by-field check: a key declared twice in
   *  one z.object is silent both ways, and only the round-trip sees it. */
  it("round-trips the metrics block Task 9 fills and Task 11 renders", () => {
    expect(ScheduleMetrics.parse(metrics)).toEqual(metrics);
  });

  it("round-trips the solver telemetry block", () => {
    expect(ScheduleSolverInfo.parse(solver)).toEqual(solver);
  });

  it("carries metrics and solver through the full result envelope", () => {
    const result = { assignments: [], conflicts: [], metrics, solver };
    expect(AutoScheduleResult.parse(result)).toEqual(result);
  });

  it("requires metrics and solver — they are not optional add-ons", () => {
    expect(() => AutoScheduleResult.parse({ assignments: [], conflicts: [] })).toThrow();
  });

  /** These seven must stay one-for-one with the engine's BuildStatus union.
   *  Pinned as literals rather than imported: packages/engine is under
   *  concurrent edit in sibling lanes, and this is the API-side contract. */
  it("accepts exactly the seven BuildStatus values", () => {
    for (const status of [
      "ok",
      "already_optimal",
      "infeasible",
      "verifier_rejected",
      "z3_unavailable",
      "solver_busy",
      "not_searched",
    ]) {
      expect(ScheduleSolverInfo.parse({ ...solver, status }).status).toBe(status);
    }
    expect(() => ScheduleSolverInfo.parse({ ...solver, status: "partial" })).toThrow();
  });

  /**
   * The whole envelope, with `not_searched` on it.
   *
   * Separate from the enum loop above because the enum loop parses the solver
   * block alone, and the shape that actually leaves `autoSchedule` is the
   * envelope. `schedule.ts` assigns the engine's `BuildStatus` straight into
   * this object, so a member the enum does not list is a board the API cannot
   * describe: the assignment does not compile, and in a build that skipped the
   * typecheck the value reaches the wire as a status no reader has a sentence
   * for.
   *
   * `not_searched` is the one status whose whole purpose is to REFUSE a claim —
   * the solver could not put this board on its lattice, so it never searched it
   * — and the previous behaviour it replaces was telling the organiser
   * `already_optimal` about a board nothing had looked at. Dropping it on the
   * wire would reinstate exactly that silence.
   */
  it("carries a not_searched run through the full result envelope", () => {
    const result = {
      assignments: [],
      conflicts: [],
      metrics,
      solver: { ...solver, status: "not_searched" as const, engine: "greedy" as const },
    };
    expect(AutoScheduleResult.parse(result)).toEqual(result);
  });

  it("accepts exactly the three solver engines", () => {
    for (const engine of ["greedy", "z3", "z3+lns"]) {
      expect(ScheduleSolverInfo.parse({ ...solver, engine }).engine).toBe(engine);
    }
    expect(() => ScheduleSolverInfo.parse({ ...solver, engine: "cpsat" })).toThrow();
  });

  /** REQUIRED, not optional. `tiers_completed` is a numerator and the strip has
   *  to render "N of M"; an optional denominator is one the component would
   *  have to guess at, which is the hardcoded `IMPROVEMENT_TARGETS = 4` this
   *  field exists to retire. */
  it("requires tiers_total — a numerator with no denominator is not telemetry", () => {
    const withoutTotal: Record<string, unknown> = { ...solver };
    delete withoutTotal.tiers_total;
    expect(() => ScheduleSolverInfo.parse(withoutTotal)).toThrow();
    expect(() => ScheduleSolverInfo.parse({ ...solver, tiers_total: 4.5 })).toThrow();
  });

  /** OPTIONAL, and its absence is meaningful: an `infeasible` without it is the
   *  engine saying the proof is about the BOARD, not about the pinned set. A
   *  reader that has not been taught about it falls back to `total - placed`. */
  it("carries contradictory_pins only when the engine named them", () => {
    expect(ScheduleSolverInfo.parse(solver).contradictory_pins).toBe(undefined);
    const pinned = { ...solver, status: "infeasible" as const, contradictory_pins: ["f-2", "f-9"] };
    expect(ScheduleSolverInfo.parse(pinned)).toEqual(pinned);
    expect(() => ScheduleSolverInfo.parse({ ...solver, contradictory_pins: [7] })).toThrow();
  });
});
