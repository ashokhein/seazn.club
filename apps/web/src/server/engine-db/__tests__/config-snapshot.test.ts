// A CONFIG EDIT MUST NOT REACH BACK INTO A FIXTURE THAT IS ALREADY SCORED
// (W4a follow-up Task 1, V347).
//
// The engine's own `cfg-replay.conformance.test.ts` proves the hazard exists at
// module level. This proves the RAIL closes it: that the resolved cfg is really
// frozen onto the fixture row on the first append, that both folds really read
// it, and that the two failure modes the freeze exists to stop — a silent
// rescore and a permanently unreadable fixture — really do stop.
//
// DB-backed on purpose. The defect is a read/write seam over a real column and
// a real transaction; an in-memory double would be asserting my own mock.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent, rebuildState, verifyStateConsistency } from "../index";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_SCORE_DRAWS = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

const TENNIS_BEST_OF_3 = {
  bestOf: 3,
  set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
  finalSet: "same",
  game: { noAd: false },
  tiebreak: { winBy: 2 },
  points: { win: 2, loss: 0 },
} as const;

interface Seed {
  orgId: string;
  divisionId: string;
  stageId: string;
  fixtureId: string;
  home: string;
  away: string;
}

/** Fresh org → competition → division → stage → 2 entrants → fixture, as the
 *  owner role (RLS bypassed, same shape as `integration.test.ts`). */
async function seed(opts: {
  sportKey?: string;
  config?: unknown;
  stageConfig?: Record<string, unknown> | null;
  stageKind?: string;
}): Promise<Seed> {
  const sportKey = opts.sportKey ?? "generic";
  const config = opts.config ?? GENERIC_SCORE_DRAWS;
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${sportKey}, ${sportKey}, '1.0.0',
            ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, ${sportKey}, 'score',
            ${sql.json(config as never)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, ${opts.stageKind ?? "league"}, 'Stage',
            ${sql.json((opts.stageConfig ?? {}) as never)})
    returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Home', 1)
    returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Away', 2)
    returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id`;
  return { orgId, divisionId, stageId, fixtureId, home, away };
}

async function snapshotOf(fixtureId: string) {
  const [row] = await sql<{ config_snapshot: unknown; config_snapshot_at: Date | null }[]>`
    select config_snapshot, config_snapshot_at from fixtures where id = ${fixtureId}`;
  return row;
}

async function setDivisionConfig(divisionId: string, config: unknown): Promise<void> {
  await sql`update divisions set config = ${sql.json(config as never)} where id = ${divisionId}`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("fixture config snapshot (V347)", () => {
  it("takes no snapshot until there is history worth protecting", async () => {
    const s = await seed({});
    const before = await snapshotOf(s.fixtureId);
    // Null is meaningful, not an artefact: an organiser still setting the
    // division up must have the format they choose apply.
    expect(before.config_snapshot).toBeNull();
    expect(before.config_snapshot_at).toBeNull();

    // …and it really does apply. Flip the division to win_loss BEFORE any event
    // and the first append must be validated under the NEW config: a bare score
    // card with no winnerId is invalid there.
    await setDivisionConfig(s.divisionId, {
      ...GENERIC_SCORE_DRAWS,
      resultMode: "win_loss",
      allowDraws: false,
    });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await expect(
      appendEvent(s.orgId, s.fixtureId, 1, {
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 1 },
      }),
    ).rejects.toThrow(/win_loss mode requires/);
  });

  it("freezes the RESOLVED cfg — stage overlay applied — on the first append", async () => {
    const s = await seed({ stageConfig: { shootout: { bestOf: 5 }, placements: {} } });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });

    const { config_snapshot: snap, config_snapshot_at: at } = await snapshotOf(s.fixtureId);
    expect(at).toBeInstanceOf(Date);
    // The stage's decider overlay is baked IN. Freezing the raw division config
    // instead would leave `stageScopedCfg` to re-apply at read time against a
    // stage config that has since moved — the same drift one layer down.
    expect(snap).toEqual({ ...GENERIC_SCORE_DRAWS, shootout: { bestOf: 5 } });
    expect(snap).not.toEqual(GENERIC_SCORE_DRAWS);
    // …and only the two decider keys ride along, not the whole stage config.
    expect(snap).not.toHaveProperty("placements");
  });

  it("freezes once: a later append does not re-take it under the moved config", async () => {
    const s = await seed({});
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    const first = await snapshotOf(s.fixtureId);

    await setDivisionConfig(s.divisionId, { ...GENERIC_SCORE_DRAWS, points: { w: 1, d: 0, l: 0 } });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });

    const second = await snapshotOf(s.fixtureId);
    expect(second.config_snapshot).toEqual(first.config_snapshot);
    expect(second.config_snapshot_at).toEqual(first.config_snapshot_at);
    expect(second.config_snapshot).toEqual(GENERIC_SCORE_DRAWS);
  });

  it("a config edit does not lock the scorer out of a fixture mid-match", async () => {
    // THE UNRECOVERABLE ONE, on the surface it actually reaches in production.
    // `append-event` re-folds the WHOLE stream on every append, so an ungated
    // cfg-derived refusal (generic's allowDraws) starts throwing on events
    // already in the ledger the moment the flag flips. Every subsequent append
    // fails — including `core.void`, so there is no undo that recovers it, and
    // the fixture can never be finalized.
    //
    // Worth being precise about where the damage is NOT: `getFixtureState` and
    // the score page read the persisted `match_states` cache, so a config edit
    // does not brick a READ today. It bricks every further WRITE, and rewrites
    // the cache from a stream replayed under a config that was never in force
    // the moment one succeeds.
    const s = await seed({});
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    const scored = await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 1 },
    });
    expect(scored.outcome).toEqual({ kind: "draw" });

    await setDivisionConfig(s.divisionId, { ...GENERIC_SCORE_DRAWS, allowDraws: false });

    const finalized = await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "core.finalize",
      payload: {},
    });
    expect(finalized.status).toBe("finalized");
    // …and the result the organiser published is the one that got finalized.
    expect(finalized.outcome).toEqual({ kind: "draw" });
    expect(finalized.summary).toEqual(scored.summary);
  });

  it("a config edit does not brick a re-fold of an already-recorded fixture", async () => {
    const s = await seed({});
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    const scored = await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 1 },
    });
    expect(scored.outcome).toEqual({ kind: "draw" });

    await setDivisionConfig(s.divisionId, { ...GENERIC_SCORE_DRAWS, allowDraws: false });

    const rebuilt = await rebuildState(s.orgId, s.fixtureId);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.outcome).toEqual({ kind: "draw" });
    expect(rebuilt?.summary).toEqual(scored.summary);
  });

  it("a config edit does not silently rescore a decided fixture", async () => {
    // THE QUIET ONE, and arguably worse because nothing errors. A tennis match
    // won 2-0 under bestOf 3 becomes UNDECIDED the moment somebody raises bestOf
    // to 5 — a published, agreed result reverts to "in progress" with no trace.
    const s = await seed({ sportKey: "tennis", config: TENNIS_BEST_OF_3 });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "tennis.set_summary",
      payload: { home: 6, away: 4 },
    });
    const scored = await appendEvent(s.orgId, s.fixtureId, 2, {
      type: "tennis.set_summary",
      payload: { home: 6, away: 3 },
    });
    expect(scored.outcome).toMatchObject({ kind: "win", winner: s.home });

    await setDivisionConfig(s.divisionId, { ...TENNIS_BEST_OF_3, bestOf: 5 });

    const rebuilt = await rebuildState(s.orgId, s.fixtureId);
    expect(rebuilt?.outcome).toMatchObject({ kind: "win", winner: s.home });
    expect(rebuilt?.summary).toEqual(scored.summary);
  });

  it("a stage config edit does not reach back either", async () => {
    // The stage overlay is part of the resolved cfg, so it must be frozen with
    // it — otherwise the same bug simply moves one table across.
    const s = await seed({ stageConfig: { shootout: { bestOf: 5 } } });
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await sql`update stages set config = ${sql.json({ shootout: { bestOf: 11 } })} where id = ${s.stageId}`;

    const { config_snapshot: snap } = await snapshotOf(s.fixtureId);
    expect(snap).toMatchObject({ shootout: { bestOf: 5 } });
    // And the READ agrees with the column, not with the stage row.
    const rebuilt = await rebuildState(s.orgId, s.fixtureId);
    expect(rebuilt).not.toBeNull();
  });

  it("read and write folds stay byte-consistent across a config edit", async () => {
    // If only ONE of the two folds read the snapshot, `verifyStateConsistency`
    // would report drift on a fixture nobody touched — the phantom-drift failure
    // `fold.ts` warns about.
    const s = await seed({});
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 1 },
    });
    await setDivisionConfig(s.divisionId, { ...GENERIC_SCORE_DRAWS, allowDraws: false });

    const report = await verifyStateConsistency(50);
    expect(report.mismatches.filter((m) => m.fixtureId === s.fixtureId)).toHaveLength(0);
  });
});
