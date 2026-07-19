// v4/03 §2 — buildOfficialsPack acceptance (Task 8). A 2-court, 8-entrant RR
// division with a persisted schedule and an officials roster (two referees, a
// blackout, entrant links, a per-day cap). Asserts the pack is byte-for-byte
// deterministic across a reseed with fresh UUIDs (the solver draft included —
// this fails if the draft leaks the engine's per-(official, fixture) UUID
// tiebreak), matches the §2 shape, surfaces cross-org busy windows non-empty,
// applies a dry-run schedule override, and 422s on an empty roster.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AssignPolicy } from "@seazn/engine/officials";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { claimPerson } from "../person-claims";
import { createOfficial, inviteOfficial, patchFixtureOfficials } from "../officials";
import { buildOfficialsPack } from "../officials-ai";
import { makeUser, seedOrg } from "./_seed";

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

const SETTINGS_CONFIG = {
  startAt: "2026-08-01T09:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1", "Court 2"],
  perEntrantMinRest: 20,
  blackouts: [],
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T23:00:00.000Z" }],
};

const POLICY: AssignPolicy = {
  roles: ["referee"],
  poolLock: false,
  blockStay: false,
  fairness: "tournament",
  teamRefKeepDivision: false,
  restMinMinutes: 20,
  blockGapMinutes: 30,
};

// UUIDs are random per seed run; redact them to stable first-seen placeholders
// so the structural snapshot survives re-seeding while ordering stays asserted.
function redact(pack: unknown): unknown {
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const map = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(pack).replace(re, (u) => {
      if (!map.has(u)) map.set(u, `<id:${map.size + 1}>`);
      return map.get(u)!;
    }),
  );
}

async function setSettings(divisionId: string): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${divisionId}, ${sql.json(SETTINGS_CONFIG)}, ${TZ}, now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
}

// Seed one full RR board (2 courts, 8 entrants, a shared player, two referees)
// in a FRESH pro org. Everything is persisted on STABLE domain keys — never
// fixture UUIDs — so re-seeding an identical board yields the same logical pack.
async function seedOfficialsBoard(): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { name: "AI Off", visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  const divisionId = division.id;
  await createEntrants(
    auth,
    divisionId,
    Array.from({ length: 8 }, (_, i) => ({
      kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [],
    })),
  );
  await setSettings(divisionId);
  const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);

  // Deterministic 2-court schedule on STABLE order (round_no, seq_in_round).
  const ordered = [...fixtures].sort(
    (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
  );
  for (let i = 0; i < ordered.length; i++) {
    await sql`
      update fixtures set
        scheduled_at = ${new Date(T0 + i * 30 * MIN).toISOString()},
        court_label = ${i % 2 === 0 ? "Court 1" : "Court 2"},
        schedule_source = 'auto'
      where id = ${ordered[i]!.id}`;
  }

  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${auth.orgId}, 'Shared Player') returning id`;
  for (const e of [ents[0]!.id, ents[1]!.id]) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${e}, ${p!.id}, ${auth.orgId})`;
  }

  // Two referees so the solver draft actually breaks fairness ties (the point
  // of the domain-ranked draft): one person-linked with a blackout + cap, one
  // team-as-ref (linked to E3, so it cannot officiate E3's fixtures).
  const [o1] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys, max_per_day)
    values (${auth.orgId}, ${p!.id}, 'Aa Referee', ${sql.json(["referee"])}, 3) returning id`;
  await sql`
    insert into officials (org_id, entrant_id, display_name, role_keys)
    values (${auth.orgId}, ${ents[2]!.id}, 'Bb Referee', ${sql.json(["referee"])})`;
  await sql`
    insert into official_availability (org_id, official_id, date, status, note)
    values (${auth.orgId}, ${o1!.id}, '2026-08-02', 'unavailable', 'holiday')`;

  return { auth, divisionId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("buildOfficialsPack (v4/03 §2)", () => {
  let auth: AuthCtx;
  let divisionId: string;
  const RR = (8 * 7) / 2; // 28 round-robin fixtures

  beforeAll(async () => {
    ({ auth, divisionId } = await seedOfficialsBoard());
  });

  it("rebuilds byte-identical for an identical board reseeded with fresh UUIDs", async () => {
    const boardA = await seedOfficialsBoard();
    const boardB = await seedOfficialsBoard();
    const packA = await buildOfficialsPack(boardA.auth, boardA.divisionId, {
      instruction: "Senior on the late games.", policy: POLICY,
    });
    const packB = await buildOfficialsPack(boardB.auth, boardB.divisionId, {
      instruction: "Senior on the late games.", policy: POLICY,
    });
    expect(redact(packA)).toEqual(redact(packB));
  });

  it("pack is deterministic and matches the §2 shape", async () => {
    const a = await buildOfficialsPack(auth, divisionId, { instruction: "x", policy: POLICY });
    const b = await buildOfficialsPack(auth, divisionId, { instruction: "x", policy: POLICY });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(redact(a)).toMatchSnapshot();

    expect(a.officials.length).toBe(2);
    const ref = a.officials.find((o) => o.name === "Aa Referee")!;
    expect(ref.blackout_dates).toEqual(["2026-08-02"]);
    expect(ref.entrant_ids.length).toBe(2);
    expect(ref.max_per_day).toBe(3);
    // Every fixture carries a time with the division tz offset (BST = +01:00).
    expect(a.fixtures.length).toBe(RR);
    expect(a.fixtures.every((f) => /[+-]\d{2}:\d{2}$/.test(f.start_at))).toBe(true);
    expect(a.fixtures.some((f) => f.start_at.endsWith("+01:00"))).toBe(true);
    // The solver draft is present and only ever assigns a referee.
    expect(a.draft.length).toBeGreaterThan(0);
    expect(a.draft.every((d) => d.roleKey === "referee")).toBe(true);
    expect(a.match_minutes).toBe(30);
    expect(a.policy.roles).toEqual(["referee"]);
    expect(a.prior).toBeNull();
  });

  it("a dry-run schedule overrides the persisted slot for a fixture", async () => {
    const base = await buildOfficialsPack(auth, divisionId, { instruction: "x", policy: POLICY });
    const target = base.fixtures[0]!;
    const overrideAt = "2026-08-05T14:00:00.000Z";
    const withOverride = await buildOfficialsPack(auth, divisionId, {
      instruction: "x", policy: POLICY,
      schedule: [{ fixture_id: target.id, scheduled_at: overrideAt, court_label: "Court 2" }],
    });
    const moved = withOverride.fixtures.find((f) => f.id === target.id)!;
    expect(new Date(moved.start_at).toISOString()).toBe(overrideAt);
    expect(moved.court).toBe("Court 2");
  });

  it("422 NO_OFFICIALS when the roster is empty", async () => {
    const { auth: emptyAuth } = await seedOrg("pro");
    const comp = await createCompetition(emptyAuth, { name: "Bare", visibility: "public", branding: {} });
    const div = await createDivision(emptyAuth, comp.id, {
      name: "Bare", slug: "bare", sport_key: "generic", variant_key: "score",
      config: GENERIC_CONFIG, eligibility: [],
    });
    await setSettings(div.id);
    await expect(
      buildOfficialsPack(emptyAuth, div.id, { instruction: "x", policy: POLICY }),
    ).rejects.toMatchObject({ status: 422, message: "NO_OFFICIALS" });
  });
});

// Cross-org "busy elsewhere" must reach the pack non-empty (T4 left the
// transform covered only when empty): a claimed official booked in org B shows
// as a busy timestamp in org A's pack — timestamp only, never the rival slot.
describe.skipIf(!HAS_DB)("buildOfficialsPack cross-org busy", () => {
  it("surfaces a claimed official's other-org booking as a busy_elsewhere time", async () => {
    const { auth: orgA } = await seedOrg("pro");
    const { auth: orgB } = await seedOrg("pro");
    const ref = await makeUser("shared-ref");

    const officialA = await createOfficial(orgA, { display_name: "Shared Ref", role_keys: ["referee"] });
    const officialB = await createOfficial(orgB, { display_name: "Shared Ref B", role_keys: ["referee"] });
    const invitedA = await inviteOfficial(orgA, officialA.id, ref.email);
    const invitedB = await inviteOfficial(orgB, officialB.id, ref.email);
    await claimPerson(invitedA.secret, ref.id, ref.email);
    await claimPerson(invitedB.secret, ref.id, ref.email);

    // Org A gets its own division so the pack has fixtures + roster.
    const compA = await createCompetition(orgA, { name: "A Cup", visibility: "public", branding: {} });
    const divA = await createDivision(orgA, compA.id, {
      name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
      config: GENERIC_CONFIG, eligibility: [],
    });
    await createEntrants(orgA, divA.id, ["A", "B"].map((n, i) => ({
      kind: "individual" as const, display_name: n, seed: i + 1, members: [],
    })));
    const [stageA] = await createStages(orgA, divA.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures: fA } = await generateStageFixtures(orgA, stageA!.id);
    await sql`update fixtures set scheduled_at = ${new Date(Date.now() + 7 * 86_400_000).toISOString()},
              court_label = 'Court 1' where id = ${fA[0]!.id}`;

    // Org B books its (same-person) official in a future fixture.
    const compB = await createCompetition(orgB, { name: "B Cup", visibility: "public", branding: {} });
    const divB = await createDivision(orgB, compB.id, {
      name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
      config: GENERIC_CONFIG, eligibility: [],
    });
    await createEntrants(orgB, divB.id, ["C", "D"].map((n, i) => ({
      kind: "individual" as const, display_name: n, seed: i + 1, members: [],
    })));
    const [stageB] = await createStages(orgB, divB.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures: fB } = await generateStageFixtures(orgB, stageB!.id);
    await sql`update fixtures set scheduled_at = ${new Date(Date.now() + 8 * 86_400_000).toISOString()},
              court_label = 'Court 1' where id = ${fB[0]!.id}`;
    await patchFixtureOfficials(orgB, fB[0]!.id, {
      set: [{ official_id: officialB.id, role_key: "referee", locked: false }],
    });

    const pack = await buildOfficialsPack(orgA, divA.id, { instruction: "x", policy: POLICY });
    const shared = pack.officials.find((o) => o.id === officialA.id)!;
    expect(shared.busy_elsewhere.length).toBe(1);
    expect(/[+-]\d{2}:\d{2}$/.test(shared.busy_elsewhere[0]!)).toBe(true);
  });
});
