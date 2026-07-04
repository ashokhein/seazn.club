// Integration tests for the persistence adapter (PROMPT-10 task 4). Require a
// real Postgres (the schema_v2 triggers, hash chains, RLS and advisory-lock
// concurrency can't be exercised in-memory). Skipped when DATABASE_URL is
// absent, so the DB-free unit job stays green; the CI `smoke` job runs them
// against its Postgres service container.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import {
  appendEvent,
  completeStageIfReady,
  rebuildState,
  recomputeStandings,
  verifyStateConsistency,
} from "../index";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

interface Seed {
  orgId: string;
  competitionId: string;
  divisionId: string;
  stageId: string;
  fixtureId: string;
  home: string;
  away: string;
}

// Seed a fresh org → competition → division → stage → 2 entrants → fixture as
// the superuser (bypasses RLS). Child rows omit org_id so the
// set_org_from_parent triggers are exercised.
async function seed(visibility: "private" | "public" = "private"): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id
  `;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing
  `;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, ${visibility})
    returning id
  `;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'generic', 'score',
            ${sql.json(DIVISION_CONFIG)}, '1.0.0')
    returning id
  `;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'league', 'League')
    returning id
  `;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Home', 1)
    returning id
  `;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed) values (${divisionId}, 'individual', 'Away', 2)
    returning id
  `;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${home}, ${away})
    returning id
  `;
  return { orgId, competitionId, divisionId, stageId, fixtureId, home, away };
}

// One shared postgres client for the file; close it once, after every suite —
// and uncache it, so a later DB test file in the same worker (isolate:false)
// lazily opens a fresh connection instead of hitting an ended one.
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("engine-db persistence adapter", () => {
  it("fills org_id via trigger and appends through the ledger", async () => {
    const s = await seed();
    const r1 = await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    expect(r1.seq).toBe(1);
    expect(r1.status).toBe("in_play");

    const r2 = await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    expect(r2.seq).toBe(2);
    expect(r2.outcome).toEqual({ kind: "win", winner: s.home, loser: s.away, method: "regulation" });
    expect(r2.status).toBe("decided");

    // org_id trigger populated the child rows.
    const [ev] = await sql<{ org_id: string }[]>`
      select org_id from score_events where fixture_id = ${s.fixtureId} order by seq desc limit 1
    `;
    expect(ev.org_id).toBe(s.orgId);
  });

  it("rejects an invalid event without touching the ledger (fold-validate)", async () => {
    const s = await seed();
    // generic.result before the module's config permits it? Sending a self-
    // contradicting payload must throw and leave the ledger empty.
    await expect(
      appendEvent(s.orgId, s.fixtureId, 0, {
        type: "generic.result",
        payload: { p1Score: 1, p2Score: 1, winnerId: s.home }, // draw score but a winner
      }),
    ).rejects.toBeInstanceOf(EngineError);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from score_events where fixture_id = ${s.fixtureId}
    `;
    expect(count).toBe(0);
  });

  it("serialises concurrent appends: two writers on the same seq → exactly one 409", async () => {
    const s = await seed();
    const attempt = () =>
      appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && EngineError.is(r.reason, "SEQ_CONFLICT"),
    );
    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from score_events where fixture_id = ${s.fixtureId}
    `;
    expect(count).toBe(1);
  });

  it("rebuildState reproduces the folded snapshot; verify finds no drift", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 0 },
    });

    const [stored] = await sql<{ state: unknown; last_seq: number }[]>`
      select state, last_seq from match_states where fixture_id = ${s.fixtureId}
    `;
    const rebuilt = await rebuildState(s.orgId, s.fixtureId);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lastSeq).toBe(stored.last_seq);
    expect(rebuilt?.state).toEqual(stored.state);

    const report = await verifyStateConsistency(50);
    expect(report.mismatches).toHaveLength(0);
  });

  it("hash chain verifies clean, then flags a tampered row", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 1, p2Score: 0 },
    });

    const [{ bad: cleanBad }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${s.fixtureId}) as bad
    `;
    expect(cleanBad).toBeNull();

    // Tamper the payload directly (the hash-chain trigger fires only on INSERT,
    // so row_hash is not recomputed — the chain must now fail verification).
    await sql`
      update score_events set payload = ${sql.json({ tampered: true })}
      where fixture_id = ${s.fixtureId} and seq = 1
    `;
    const [{ bad: tamperedBad }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${s.fixtureId}) as bad
    `;
    expect(tamperedBad).not.toBeNull();
  });

  it("recomputeStandings folds a decided fixture into a ranked table", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });
    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });

    const rows = await recomputeStandings(s.orgId, s.stageId);
    const winner = rows.find((r) => r.entrantId === s.home);
    const loser = rows.find((r) => r.entrantId === s.away);
    expect(winner?.points).toBe(3);
    expect(winner?.rank).toBe(1);
    expect(loser?.points).toBe(0);
    expect(loser?.rank).toBe(2);

    // Snapshot cached.
    const [snap] = await sql<{ rows: unknown[] }[]>`
      select rows from standings_snapshots where stage_id = ${s.stageId} and pool_id is null
    `;
    expect(snap.rows).toHaveLength(2);
  });

  it("completeStageIfReady marks a finished league complete + records the ledger", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "core.start", payload: {} });

    // Not complete while the only fixture is still live.
    const early = await completeStageIfReady(s.orgId, s.stageId);
    expect(early.completed).toBe(false);

    await appendEvent(s.orgId, s.fixtureId, 1, {
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    const done = await completeStageIfReady(s.orgId, s.stageId);
    expect(done.completed).toBe(true);
    expect(done.events.some((e) => e.type === "stage_completed")).toBe(true);

    const [stage] = await sql<{ status: string }[]>`
      select status from stages where id = ${s.stageId}
    `;
    expect(stage.status).toBe("complete");

    // division_events chain intact.
    const [{ bad }] = await sql<{ bad: string | null }[]>`
      select verify_division_events_chain(${s.divisionId}) as bad
    `;
    expect(bad).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("v2 RLS cross-tenant isolation", () => {
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  // withTenant switches to app_user + sets app.current_org, so a foreign row
  // must be invisible on every tenant table.
  async function visibleUnderTenant(orgId: string, table: string, id: string): Promise<number> {
    return sql.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${orgId}, true)`;
      await tx`set local role app_user`;
      const rows = await tx.unsafe(`select 1 from ${table} where id = $1`, [id]);
      return rows.length;
    }) as unknown as Promise<number>;
  }

  it("hides org A's rows from org B across v2 tables", async () => {
    // Own rows visible.
    expect(await visibleUnderTenant(a.orgId, "competitions", a.competitionId)).toBe(1);
    expect(await visibleUnderTenant(a.orgId, "fixtures", a.fixtureId)).toBe(1);

    // Foreign rows invisible.
    for (const [table, id] of [
      ["competitions", a.competitionId],
      ["divisions", a.divisionId],
      ["stages", a.stageId],
      ["entrants", a.home],
      ["fixtures", a.fixtureId],
    ] as const) {
      expect(await visibleUnderTenant(b.orgId, table, id)).toBe(0);
    }
  });

  it("appendEvent under the wrong tenant cannot see the fixture", async () => {
    await expect(
      appendEvent(b.orgId, a.fixtureId, 0, { type: "core.start", payload: {} }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
