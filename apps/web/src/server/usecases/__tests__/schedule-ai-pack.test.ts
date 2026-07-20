// v4/01 §2 + v4/03 §2 — buildSchedulePack acceptance (Task 4). A 2-court,
// 8-entrant RR division with an applied schedule, a shared player, and an
// officials roster (blackout + entrant links). Asserts the pack is
// byte-for-byte deterministic, matches the §2 shape, carries officials
// availability, scopes repair rounds, and stays within the token budget.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { buildSchedulePack } from "../schedule-ai";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Fixed instants → the pack (times, offsets) is stable across runs.
const T0 = Date.parse("2026-08-01T09:00:00.000Z");
const MIN = 60_000;
const TZ = "Europe/London";

const SETTINGS_CONFIG = {
  startAt: "2026-08-01T09:00:00.000Z",
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1", "Court 2"],
  perEntrantMinRest: 20,
  blackouts: [{ court: "Court 2", from: "2026-08-01T12:00:00.000Z", to: "2026-08-01T13:00:00.000Z" }],
  sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T18:00:00.000Z" }],
  constraints: {
    restMin: 20,
    noBackToBack: false,
    startWindows: [],
    fieldFairness: "balance",
    parallelism: "mixed",
    crossPersonClash: "hard",
  },
};

// UUIDs are random per seed run; redact them to stable, first-seen placeholders
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

// Seed one full RR board (2 courts, 8 entrants, a shared player, an officials
// roster) in a FRESH pro org. Everything is persisted on STABLE domain keys —
// never fixture UUIDs — so re-seeding an identical board yields the same logical
// pack. Returns the org auth + division so a caller can reseed for determinism.
async function seedRrBoard(): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { name: "AI Arch", visibility: "public", branding: {} });
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
  expect(fixtures.length).toBe((8 * 7) / 2);

  // Persist a deterministic 2-court schedule on STABLE order (round_no,
  // seq_in_round) — NOT the fixture UUID — so the same logical board produces
  // the same current.at on every reseed (also avoids the Pro apply gate).
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

  // A player shared across the first two entrants → the shared-player map.
  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${auth.orgId}, 'Shared Player') returning id`;
  for (const e of [ents[0]!.id, ents[1]!.id]) {
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${e}, ${p!.id}, ${auth.orgId})`;
  }

  // Officials: one person-linked (entrant ids via the roster) with a blackout,
  // one entrant-linked (team-as-ref).
  const [o1] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys, max_per_day)
    values (${auth.orgId}, ${p!.id}, 'Aa Referee', ${sql.json(["referee"])}, 3) returning id`;
  await sql`
    insert into officials (org_id, entrant_id, display_name, role_keys)
    values (${auth.orgId}, ${ents[2]!.id}, 'Bb Umpire', ${sql.json(["umpire"])})`;
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

describe.skipIf(!HAS_DB)("buildSchedulePack (v4/01 §2)", () => {
  let auth: AuthCtx;
  let divisionId: string;
  const RR = (8 * 7) / 2; // 28 round-robin fixtures

  beforeAll(async () => {
    ({ auth, divisionId } = await seedRrBoard());
  });

  it("rebuilds byte-identical for an identical board reseeded with fresh UUIDs", async () => {
    // Two independent orgs, same logical board, different random UUIDs. The
    // pack must be identical once UUIDs are redacted — this fails when any
    // ordering (notably the greedy draft) falls back to raw fixture UUIDs.
    const boardA = await seedRrBoard();
    const boardB = await seedRrBoard();
    const packA = await buildSchedulePack(boardA.auth, boardA.divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    const packB = await buildSchedulePack(boardB.auth, boardB.divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });

  it("pack is deterministic and matches the 01 §2 shape", async () => {
    const a = await buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "Finish by 6pm." });
    const b = await buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "Finish by 6pm." });
    expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack));
    expect(redact(a.pack)).toMatchSnapshot();
    expect(a.pack.officials.length).toBeGreaterThan(0);
    // Officials availability wired through: blackout date + entrant links.
    const ref = a.pack.officials.find((o) => o.name === "Aa Referee")!;
    expect(ref.blackout_dates).toEqual(["2026-08-02"]);
    expect(ref.entrant_ids.length).toBe(2);
    expect(ref.max_per_day).toBe(3);
    // Shared-player map present.
    expect(a.pack.people.length).toBe(1);
    expect(a.pack.people[0]!.entrant_ids.length).toBe(2);
    // Every movable fixture is present; times carry the division tz offset.
    expect(a.pack.fixtures.movable.length).toBe(RR);
    expect(a.pack.draft.every((d) => /[+-]\d{2}:\d{2}$/.test(d.scheduled_at))).toBe(true);
    expect(a.pack.settings.constraints?.crossPersonClash).toBe("hard");
    expect(a.movableIds.size).toBe(RR);
  });

  it("repair scope excludes out-of-scope fixtures from movable and adds them as obstacles", async () => {
    const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
      mode: "repair", instruction: "Court 2 flooded", scope: { courts: ["Court 2"] },
    });
    for (const f of pack.fixtures.movable) {
      expect(f.current.court === "Court 2" || f.current.court === null).toBe(true);
    }
    expect(movableIds.size).toBeLessThan(RR);
    expect(movableIds.size).toBeGreaterThan(0);
    // Court 1 fixtures are now fixed obstacles.
    expect(pack.fixtures.obstacles.some((o) => o.court === "Court 1")).toBe(true);
  });

  it("repair draft is the movable set's current persisted slots", async () => {
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "repair", instruction: "reflow", scope: { courts: ["Court 2"] },
    });
    expect(pack.draft.length).toBe(pack.fixtures.movable.length);
    expect(pack.draft.every((d) => d.court_label === "Court 2")).toBe(true);
  });

  it("refine mode uses the prior proposal verbatim as the draft", async () => {
    const gen = await buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "x" });
    const prior = gen.pack.draft.map((d) => ({
      fixture_id: d.fixture_id, scheduled_at: d.scheduled_at, court_label: d.court_label,
    }));
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "refine", instruction: "later", prior: { instruction: "x", assignments: prior },
    });
    expect(pack.mode).toBe("refine");
    expect(pack.prior?.assignments.length).toBe(prior.length);
    expect(pack.draft.length).toBe(prior.length);
  });

  it("rejects a scope court that is not in settings.courts (400)", async () => {
    await expect(
      buildSchedulePack(auth, divisionId, {
        mode: "repair", instruction: "x", scope: { courts: ["Court 9"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("repair scope matching nothing is 422 AI_PLAN_EMPTY_SCOPE", async () => {
    await expect(
      buildSchedulePack(auth, divisionId, {
        mode: "repair", instruction: "x", scope: { from: "2099-01-01T00:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ status: 422, message: "AI_PLAN_EMPTY_SCOPE" });
  });

  // `scheduling_mode` used to gate this with a 409. The mode was never
  // selectable — absent from the creation flow and from every screen, reachable
  // only by hand-patching the API — so it shipped as three dead buttons for
  // anyone who reached it. The column survives (dormant) until a later
  // migration drops it; this proves nothing reads it any more.
  it("packs a division regardless of the dormant scheduling_mode column", async () => {
    const comp = await createCompetition(auth, { name: "Flex", visibility: "public", branding: {} });
    const flex = await createDivision(auth, comp.id, {
      name: "Flexi", slug: "flexi", sport_key: "generic", variant_key: "score",
      config: GENERIC_CONFIG, eligibility: [],
    });
    await sql`update divisions set scheduling_mode = 'flexible' where id = ${flex.id}`;
    // No fixtures, so the pack refuses on emptiness — not on the mode. Any
    // outcome other than AI_PLAN_UNSUPPORTED proves the guard is gone.
    await expect(
      buildSchedulePack(auth, flex.id, { mode: "generate", instruction: "x" }),
    ).rejects.not.toMatchObject({ message: "AI_PLAN_UNSUPPORTED" });
  });
});

// Bulk fixture seeder — direct inserts (no generator) to hit the size limits.
async function seedBigDivision(auth: AuthCtx, n: number): Promise<string> {
  const comp = await createCompetition(auth, {
    name: `Big ${randomUUID().slice(0, 6)}`, visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Big", slug: `big-${randomUUID().slice(0, 6)}`, sport_key: "generic",
    variant_key: "score", config: GENERIC_CONFIG, eligibility: [],
  });
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    select ${stage!.id}, ${division.id}, ${auth.orgId}, (g / 20)::int, (g % 20)::int, 'big-' || g, 'scheduled'
    from generate_series(1, ${n}) g`;
  return division.id;
}

describe.skipIf(!HAS_DB)("buildSchedulePack size limits", () => {
  it("500-fixture golden pack stays within the token budget", async () => {
    const { auth } = await seedOrg("pro");
    const divisionId = await seedBigDivision(auth, 500);
    const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Pack the day.",
    });
    expect(movableIds.size).toBe(500);
    // Rough chars/4 heuristic proxy; the live AI_EVAL=1 test uses count_tokens.
    expect(JSON.stringify(pack).length / 4).toBeLessThan(60_000);
  });

  it("more than 500 movable fixtures is 422 AI_PLAN_TOO_LARGE", async () => {
    const { auth } = await seedOrg("pro");
    const divisionId = await seedBigDivision(auth, 501);
    await expect(
      buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({ status: 422, message: "AI_PLAN_TOO_LARGE" });
  });
});
