// PROMPT-17 acceptance E2E (doc 12): 8-team group+KO division — auto-schedule
// across 2 courts with a rest constraint, drag into a court clash (blocked),
// into a rest violation (warned, allowed), lock two cards, re-flow, publish,
// start, score round 1, rain-reschedule remaining. Plus the Community gates
// (doc 12 §5): constraints/board are Pro, quick-start unaffected.
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import {
  putScheduleSettings,
  getScheduleSettings,
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

describe.skipIf(!HAS_DB)("scheduling console (doc 12, PROMPT-17)", () => {
  it("drives the full plan-first lifecycle on an 8-team group+KO division", async () => {
    const { auth, orgSlug } = await seedOrg("pro");
    const competition = await createCompetition(auth, {
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

    const proposal = await autoSchedule(auth, groups.id, false);
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
    const reflow = await autoSchedule(auth, groups.id, true);
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

  it("Community org: constraints/board are 402-gated, quick-start unaffected", async () => {
    const { auth } = await seedOrg("community");
    const competition = await createCompetition(auth, { name: "Club Night", visibility: "private", branding: {} });
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

    // Constraint solver fields → 402 scheduling.constraints (doc 12 §5).
    await expect(
      putScheduleSettings(auth, division.id, {
        config: {
          startAt: T0, matchMinutes: 30, gapMinutes: 0,
          courts: ["C1", "C2"], // multi-court is the constraint solver
          perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
        },
        tz: "UTC",
      }),
    ).rejects.toMatchObject({ featureKey: "scheduling.constraints" });

    // Basic single-court settings + basic auto are Community features.
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0, matchMinutes: 30, gapMinutes: 0,
        courts: ["C1"], perEntrantMinRest: 0, blackouts: [], sessionWindows: [],
      },
      tz: "UTC",
    });
    const { fixtures } = await generateStageFixtures(auth, stage.id);
    const proposal = await autoSchedule(auth, stage.id, false);
    expect(proposal.assignments).toHaveLength(6);
    await applySchedule(auth, stage.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_label: a.court_label,
      })),
      source: "auto",
    });

    // Board editing (pins, manual assignment sets) is Pro (view-only board).
    await expect(
      patchFixture(auth, fixtures[0]!.id, { schedule_locked: true }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    await expect(
      applySchedule(auth, stage.id, {
        assignments: [{ fixture_id: fixtures[0]!.id, scheduled_at: at(600), court_label: "C1" }],
        source: "manual",
      }),
    ).rejects.toMatchObject({ featureKey: "scheduling.board" });

    // Quick-start unaffected: start opens scoring immediately.
    const started = await startDivision(auth, division.id);
    expect(started.status).toBe("active");
    const out = await decide(auth, fixtures[0]!.id, 2, 1);
    expect(out.status).toBe("decided");
  });

  it("quick-start generates fixtures and slots rolling round times (doc 12 §1.A)", async () => {
    const { auth } = await seedOrg("community");
    const competition = await createCompetition(auth, { name: "Rolling", visibility: "private", branding: {} });
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
    const competition = await createCompetition(auth, { name: "TwoAdmins", visibility: "private", branding: {} });
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
});
