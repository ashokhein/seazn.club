// Task 10 (v4/03 §10): the ACCEPT rails must record what the AI did. An apply
// carrying an `ai` block stamps that provenance into the schedule_applied ledger
// event; GET /divisions/{id}/schedule/ai-last recalls the latest AI-sourced
// apply. Also guards the READ-side schedule_source enum widening — a fixture
// applied with source "ai" must survive Fixture response validation.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { putScheduleSettings, autoSchedule, applySchedule, lastAiApply } from "../schedule";
import { ApplyScheduleRequest, Fixture } from "@/server/api-v1/schemas";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};
const T0 = "2026-08-01T09:00:00.000Z";

async function seedOrg(): Promise<AuthCtx> {
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
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedPlannableStage(auth: AuthCtx) {
  const competition = await createCompetition(auth, { name: "Carnival", visibility: "public", branding: {} });
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
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 1 } } },
  ]);
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["Court 1"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  const proposal = await autoSchedule(auth, stage.id, false);
  return { division, stage, proposal };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Pure schema contract (no DB): the apply request must accept the optional `ai`
// provenance block and trim the instruction server-side (v4/03 §10).
describe("ApplyScheduleRequest.ai (v4/03 §10)", () => {
  const validAssignment = {
    fixture_id: randomUUID(),
    scheduled_at: "2026-08-01T09:00:00.000Z",
    court_label: "Court 1",
  };

  it("accepts an ai block (trimming is applied server-side at the apply seam)", () => {
    const parsed = ApplyScheduleRequest.parse({
      assignments: [validAssignment],
      source: "ai",
      ai: { instruction: "spread the finals", summary: "moved 6 fixtures", model: "claude", repair_rounds: 1 },
    });
    expect(parsed.ai?.instruction).toBe("spread the finals");
    expect(parsed.ai?.summary).toBe("moved 6 fixtures");
  });

  it("leaves ai undefined when absent", () => {
    expect(ApplyScheduleRequest.parse({ assignments: [validAssignment] }).ai).toBeUndefined();
  });

  // Binding #1: the READ-side Fixture schema must accept schedule_source "ai".
  it("Fixture response schema accepts schedule_source 'ai'", () => {
    const row = {
      id: randomUUID(), stage_id: randomUUID(), division_id: randomUUID(), pool_id: null,
      round_no: 1, seq_in_round: 1, home_entrant_id: null, away_entrant_id: null,
      scheduled_at: null, venue: null, court_label: null, officials: [], status: "scheduled",
      outcome: null, schedule_source: "ai", schedule_locked: false, created_at: T0,
    };
    expect(Fixture.parse(row).schedule_source).toBe("ai");
  });
});

describe.skipIf(!HAS_DB)("AI audit trail in the ledger (v4/03 §10)", () => {
  it("stamps the ai block into schedule_applied and ai-last recalls it", async () => {
    const auth = await seedOrg();
    const { division, stage, proposal } = await seedPlannableStage(auth);

    const applied = await applySchedule(auth, stage.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "ai",
      ai: { instruction: "  keep courts balanced  ", summary: "scheduled 6 fixtures across 1 court", model: "claude-x", repair_rounds: 2 },
    });
    expect(applied.applied).toBeGreaterThan(0);

    // The latest schedule_applied event carries the (trimmed) provenance.
    const [event] = await sql<{ payload: { source: string; ai?: { instruction: string; summary: string; model: string; repair_rounds: number } } }[]>`
      select payload from division_events
      where division_id = ${division.id} and type = 'schedule_applied'
      order by seq desc limit 1`;
    expect(event.payload.source).toBe("ai");
    expect(event.payload.ai?.instruction).toBe("keep courts balanced");
    expect(event.payload.ai?.summary).toBe("scheduled 6 fixtures across 1 court");
    expect(event.payload.ai?.model).toBe("claude-x");
    expect(event.payload.ai?.repair_rounds).toBe(2);

    // ai-last recalls the trimmed instruction + summary + a timestamp.
    const last = await lastAiApply(auth, division.id);
    expect(last).not.toBeNull();
    expect(last!.instruction).toBe("keep courts balanced");
    expect(last!.summary).toBe("scheduled 6 fixtures across 1 court");
    expect(new Date(last!.at).toString()).not.toBe("Invalid Date");

    // Binding #1 (integration): the persisted fixtures read back through the
    // Fixture response schema with schedule_source "ai".
    const rows = await sql`
      select id, stage_id, division_id, pool_id, round_no, seq_in_round,
             home_entrant_id, away_entrant_id, scheduled_at, venue, court_label,
             officials, status, outcome, schedule_source, schedule_locked, created_at
      from fixtures where stage_id = ${stage.id} and scheduled_at is not null limit 1`;
    const parsed = Fixture.parse({
      ...rows[0],
      scheduled_at: rows[0]!.scheduled_at ? new Date(rows[0]!.scheduled_at as string).toISOString() : null,
      created_at: new Date(rows[0]!.created_at as string).toISOString(),
    });
    expect(parsed.schedule_source).toBe("ai");
  });

  it("returns null for a division with no AI-sourced apply", async () => {
    const auth = await seedOrg();
    const { division, stage, proposal } = await seedPlannableStage(auth);
    // Apply with a non-AI source — must NOT be recalled by ai-last.
    await applySchedule(auth, stage.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });
    expect(await lastAiApply(auth, division.id)).toBeNull();
  });
});
