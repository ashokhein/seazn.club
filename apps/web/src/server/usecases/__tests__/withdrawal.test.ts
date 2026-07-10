// Mid-tournament withdrawal cascade (spec 05 §5, organiser ask 2026-07-10).
// League <50% played → expunge (played games void, standings forget them);
// ≥50% → walkovers to opponents; pre-start → plain status flip, no surgery.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, getStandings } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;
const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Wdr " + suffix}, ${"wdr-" + suffix}) returning id`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'pro', 'active') on conflict (org_id) do update set plan_key = 'pro'`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

interface Fx {
  id: string;
  status: string;
  home_entrant_id: string;
  away_entrant_id: string;
  outcome: { kind?: string; winner?: string } | null;
}

async function rig(auth: AuthCtx, entrantNames: string[]) {
  const comp = await createCompetition(auth, {
    name: `W ${randomUUID().slice(0, 6)}`, visibility: "private", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
  });
  const entrants = await createEntrants(
    auth, division.id,
    entrantNames.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const byName = Object.fromEntries(entrants.map((e, i) => [entrantNames[i]!, e.id]));
  return { division, stage: stage!, byName };
}

const fixturesOf = (divisionId: string) => sql<Fx[]>`
  select id, status, home_entrant_id, away_entrant_id, outcome
  from fixtures where division_id = ${divisionId}`;

async function decide(auth: AuthCtx, fixtureId: string, homeWins: boolean) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, fixtureId, {
    expected_seq: 1,
    type: "generic.result",
    payload: homeWins ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 },
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("withdrawal cascade (spec 05 §5)", () => {
  it("league, nothing played → expunge: every fixture they touch abandons; standings forget them", async () => {
    const auth = await seedOrg();
    const { division, stage, byName } = await rig(auth, ["A", "B", "C", "D"]);

    const out = await withdrawEntrantCascade(auth, byName.A!);
    expect(out.policy).toBe("expunge");
    expect(out.voided).toBe(3); // round robin of 4: A plays 3
    expect(out.walkovers).toBe(0);

    const fixtures = await fixturesOf(division.id);
    for (const f of fixtures) {
      const involvesA = f.home_entrant_id === byName.A || f.away_entrant_id === byName.A;
      expect(f.status).toBe(involvesA ? "abandoned" : "scheduled");
    }
    const standings = await getStandings(auth, stage.id);
    const rows = standings.rows as { entrantId: string; played: number }[];
    expect(rows.find((r) => r.entrantId === byName.A)?.played ?? 0).toBe(0);

    const [entrant] = await sql<{ status: string }[]>`
      select status from entrants where id = ${byName.A!}`;
    expect(entrant!.status).toBe("withdrawn");

    // Double-withdraw answers a calm conflict.
    await expect(withdrawEntrantCascade(auth, byName.A!)).rejects.toThrow(HttpError);
  });

  it("league, ≥50% played → results stand, remaining games walk over to opponents", async () => {
    const auth = await seedOrg();
    const { division, byName } = await rig(auth, ["A", "B", "C", "D"]);
    const fixtures = await fixturesOf(division.id);
    const mine = fixtures.filter(
      (f) => f.home_entrant_id === byName.A || f.away_entrant_id === byName.A,
    );
    // A decides 2 of its 3 games (wins both) → award mode.
    for (const f of mine.slice(0, 2)) {
      await decide(auth, f.id, f.home_entrant_id === byName.A);
    }

    const out = await withdrawEntrantCascade(auth, byName.A!);
    expect(out.policy).toBe("walkover");
    expect(out.walkovers).toBe(1);
    expect(out.voided).toBe(0);

    const after = await fixturesOf(division.id);
    const last = after.find((f) => f.id === mine[2]!.id)!;
    expect(last.status).toBe("forfeited");
    const opponent =
      mine[2]!.home_entrant_id === byName.A ? mine[2]!.away_entrant_id : mine[2]!.home_entrant_id;
    expect((last.outcome as { winner?: string })?.winner).toBe(opponent);
    // The two played results stand untouched.
    for (const f of after.filter((x) => mine.slice(0, 2).some((m) => m.id === x.id))) {
      expect(f.status).toBe("decided");
    }
  });

  it("before the start there is no surgery — plain status flip", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, { name: "Pre", visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false }, eligibility: [],
    });
    const entrants = await createEntrants(auth, division.id, [
      { kind: "individual", display_name: "A", seed: 1, members: [] },
      { kind: "individual", display_name: "B", seed: 2, members: [] },
    ]);
    const out = await withdrawEntrantCascade(auth, entrants[0]!.id);
    expect(out.policy).toBe("none");
    expect(out.walkovers + out.voided).toBe(0);
    const [entrant] = await sql<{ status: string }[]>`
      select status from entrants where id = ${entrants[0]!.id}`;
    expect(entrant!.status).toBe("withdrawn");
  });
});
