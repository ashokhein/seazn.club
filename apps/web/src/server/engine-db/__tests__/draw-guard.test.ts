// PROMPT-61 — a knockout fixture must never finalize as a draw. The engine
// declares supportsDraws(cfg, stage) on every module; these tests pin that the
// finalize path actually enforces it (and, per stage-scoped config, that a
// knockout stage can opt into a decider). DB-backed like integration.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "../index";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

// Full parsed football config (engine-db folds the stored config verbatim —
// no schema defaulting — so the seed must store the complete shape).
const FOOTBALL_CONFIG = {
  halfMinutes: 45,
  halves: 2,
  extraTime: { enabled: false, halfMinutes: 15 },
  shootout: false,
  points: { win: 3, draw: 1, loss: 0 },
  awardScore: { goals: 3 },
  fairPlay: true,
  abandonPolicy: "replay",
} as const;

interface Seed {
  orgId: string;
  divisionId: string;
  stageId: string;
  fixtureId: string;
  home: string;
  away: string;
}

// Same superuser seeding shape as integration.test.ts, parameterised by sport,
// stage kind and stage config (the PROMPT-61 surface under test).
async function seedFixture(opts: {
  sport: "generic" | "football";
  stageKind: "league" | "group" | "knockout";
  stageConfig?: Record<string, unknown>;
  divisionConfig?: Record<string, unknown>;
}): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id
  `;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${opts.sport}, ${opts.sport}, '1.0.0',
            ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing
  `;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id
  `;
  const config = opts.divisionConfig ?? (opts.sport === "generic" ? GENERIC_CONFIG : FOOTBALL_CONFIG);
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, ${opts.sport}, 'std',
            ${sql.json(config as never)}, '1.0.0')
    returning id
  `;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, ${opts.stageKind}, 'Stage',
            ${sql.json((opts.stageConfig ?? {}) as never)})
    returning id
  `;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Home', 1) returning id
  `;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', 'Away', 2) returning id
  `;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id
  `;
  return { orgId, divisionId, stageId, fixtureId, home, away };
}

async function eventCount(fixtureId: string): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from score_events where fixture_id = ${fixtureId}
  `;
  return count;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("knockout draw guard (PROMPT-61)", () => {
  it("rejects finalizing a level generic knockout fixture and leaves the ledger untouched", async () => {
    const s = await seedFixture({ sport: "generic", stageKind: "knockout" });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await expect(
      appendEvent(s.orgId, s.fixtureId, 1, {
        type: "generic.result",
        payload: { p1Score: 1, p2Score: 1 },
      }),
    ).rejects.toMatchObject({ code: "DRAW_NOT_ALLOWED" });
    expect(await eventCount(s.fixtureId)).toBe(1); // the drawing event never landed

    const [fixture] = await sql<{ status: string; outcome: unknown }[]>`
      select status, outcome from fixtures where id = ${s.fixtureId}
    `;
    expect(fixture.outcome).toBeNull(); // bracket not stalled by a silent draw
  });

  it("still finalizes the same level score as a draw in a league stage", async () => {
    const s = await seedFixture({ sport: "generic", stageKind: "league" });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    const r = await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 1 },
    });
    expect(r.outcome).toMatchObject({ kind: "draw" });
    expect(r.status).toBe("decided");
  });

  it("rejects a level football knockout full-time when no decider is configured", async () => {
    const s = await seedFixture({ sport: "football", stageKind: "knockout" });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "football.goal",
      payload: { by: s.home, minute: 12 },
    });
    await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "football.period",
      payload: { phase: "HT" },
    });
    await appendEvent(s.orgId, s.fixtureId, 3, {
      type: "football.goal",
      payload: { by: s.away, minute: 71 },
    });
    await expect(
      appendEvent(s.orgId, s.fixtureId, 4, {
        type: "football.period",
        payload: { phase: "FT" },
      }),
    ).rejects.toMatchObject({ code: "DRAW_NOT_ALLOWED" });
    expect(await eventCount(s.fixtureId)).toBe(4);
  });

  it("a knockout STAGE config shootout:true routes a level FT into the shootout, not a draw", async () => {
    const s = await seedFixture({
      sport: "football",
      stageKind: "knockout",
      stageConfig: { shootout: true }, // division config keeps shootout:false
    });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "football.period",
      payload: { phase: "HT" },
    });
    const ft = await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "football.period",
      payload: { phase: "FT" },
    });
    // 0-0 at FT with the stage-scoped shootout enabled: the match is pending
    // its decider — neither rejected nor a draw.
    expect(ft.outcome).toBeNull();
    expect(ft.status).not.toBe("decided");
  });

  it("the sibling group stage of the same division still records the draw", async () => {
    const s = await seedFixture({ sport: "football", stageKind: "group" });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "football.period",
      payload: { phase: "HT" },
    });
    const ft = await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "football.period",
      payload: { phase: "FT" },
    });
    expect(ft.outcome).toMatchObject({ kind: "draw" });
    expect(ft.status).toBe("decided");
  });
});
