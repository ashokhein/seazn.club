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
import { buildSchedulePack, toModelPayload } from "../schedule-ai";
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
  it("pack carries participants for every movable fixture", async () => {
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(Object.keys(pack.participants).sort()).toEqual(
      pack.fixtures.movable.map((f) => f.id).sort(),
    );
    // Round-robin board: every fixture has both slots named, so participants
    // is exactly the union of the two entrants' rosters.
    const first = pack.fixtures.movable[0]!;
    expect(pack.participants[first.id]!.length).toBeGreaterThan(0);
  });

  it("pack carries an assumptions array", async () => {
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(Array.isArray(pack.assumptions)).toBe(true);
  });

  it("packs a division regardless of the dormant scheduling_mode column", async () => {
    const comp = await createCompetition(auth, { name: "Flex", visibility: "public", branding: {} });
    const flex = await createDivision(auth, comp.id, {
      name: "Flexi", slug: "flexi", sport_key: "generic", variant_key: "score",
      config: GENERIC_CONFIG, eligibility: [],
    });
    await sql`update divisions set scheduling_mode = 'flexible' where id = ${flex.id}`;
    // It used to throw 409 AI_PLAN_UNSUPPORTED before reading anything else.
    // Now it packs the division like any other — an empty one, since this
    // fixture has no fixtures — which is the proof the guard is gone.
    const pack = await buildSchedulePack(auth, flex.id, { mode: "generate", instruction: "x" });
    expect(pack.pack.division.name).toBe("Flexi");
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
    // Measures the PAYLOAD, not the pack: `participants`/`assumptions` are
    // enforcement inputs and never reach the model (see `toModelPayload`).
    expect(JSON.stringify(toModelPayload(pack)).length / 4).toBeLessThan(60_000);
  });

  it("more than 500 movable fixtures is 422 AI_PLAN_TOO_LARGE", async () => {
    const { auth } = await seedOrg("pro");
    const divisionId = await seedBigDivision(auth, 501);
    await expect(
      buildSchedulePack(auth, divisionId, { mode: "generate", instruction: "x" }),
    ).rejects.toMatchObject({ status: 422, message: "AI_PLAN_TOO_LARGE" });
  });
});

// ---------------------------------------------------------------------------
// Elimination-bracket seeders (#396). A round-robin board names both slots of
// every fixture, so it cannot exercise the advancer recursion at all — these
// build boards whose later fixtures are genuinely TBD.
// ---------------------------------------------------------------------------

/** Fresh pro org + competition + division + settings + one stage. */
async function seedKoDivision(
  name: string,
): Promise<{ auth: AuthCtx; divisionId: string; stageId: string }> {
  const { auth } = await seedOrg("pro");
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, {
    name: `${name} ${tag}`, visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name, slug: `${name.toLowerCase()}-${tag}`, sport_key: "generic",
    variant_key: "score", config: GENERIC_CONFIG, eligibility: [],
  });
  await setSettings(division.id);
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "KO", config: {},
  });
  return { auth, divisionId: division.id, stageId: stage!.id };
}

/**
 * 4 entrants, one person each, two semis feeding one final. The final's entrant
 * slots are NULL — the shape today's named-entrant derivation reports as having
 * nobody in it.
 */
async function seedSmallBracket(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  ids: { personIds: string[]; fixtureIds: { semi1: string; semi2: string; final: string } };
}> {
  const { auth, divisionId, stageId } = await seedKoDivision("Bracket");
  await createEntrants(
    auth,
    divisionId,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const, display_name: `K${i + 1}`, seed: i + 1, members: [],
    })),
  );
  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  const personIds: string[] = [];
  for (let i = 0; i < ents.length; i++) {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name)
      values (${auth.orgId}, ${`Bracket Player ${i + 1}`}) returning id`;
    personIds.push(p!.id);
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${ents[i]!.id}, ${p!.id}, ${auth.orgId})`;
  }

  const [final] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${stageId}, ${divisionId}, ${auth.orgId}, 2, 0, 'final', 'scheduled') returning id`;
  const semis: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [s] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id, winner_to_fixture, winner_to_slot)
      values (${stageId}, ${divisionId}, ${auth.orgId}, 1, ${i}, ${`semi-${i + 1}`}, 'scheduled',
              ${ents[i * 2]!.id}, ${ents[i * 2 + 1]!.id}, ${final!.id}, ${i + 1})
      returning id`;
    semis.push(s!.id);
  }
  return {
    auth,
    divisionId,
    ids: { personIds, fixtureIds: { semi1: semis[0]!, semi2: semis[1]!, final: final!.id } },
  };
}

/** The same board with one semi already played — it leaves the movable set and
 *  becomes a fixed obstacle, so the final's `feeds.after` dangles. */
async function seedSmallBracketWithFinishedSemi(): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth, divisionId, ids } = await seedSmallBracket();
  await sql`
    update fixtures set status = 'finalized',
      scheduled_at = ${new Date(T0).toISOString()}, court_label = 'Court 1'
    where id = ${ids.fixtureIds.semi1}`;
  return { auth, divisionId };
}

/**
 * `n` bracket fixtures, heap-shaped: fixture g feeds fixture floor(g / 2), so
 * fixture 1 is the final and every leaf carries two entrants with one person
 * each. The worst realistic case for participant-set size — the root's set is
 * every player in the division.
 */
async function seedBigBracket(n: number): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth, divisionId, stageId } = await seedKoDivision("BigKo");
  const leafFrom = Math.floor(n / 2) + 1; // fixtures with no children
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    select ${stageId}, ${divisionId}, ${auth.orgId},
           floor(log(2, g))::int, (g - power(2, floor(log(2, g))))::int,
           'kob-' || lpad(g::text, 4, '0'), 'scheduled'
    from generate_series(1, ${n}) g`;
  // Wire the feed chain by ext_key — never by UUID.
  await sql`
    update fixtures f
       set winner_to_fixture = p.id,
           winner_to_slot = case when (substr(f.ext_key, 5)::int) % 2 = 0 then 1 else 2 end
      from fixtures p
     where f.division_id = ${divisionId} and p.division_id = ${divisionId}
       and substr(f.ext_key, 5)::int >= 2
       and p.ext_key = 'kob-' || lpad((substr(f.ext_key, 5)::int / 2)::text, 4, '0')`;
  // Two entrants (one person each) on every leaf fixture.
  await sql`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    select ${divisionId}, ${auth.orgId}, 'individual',
           'B' || lpad(g::text, 4, '0') || (case when s = 1 then 'a' else 'b' end),
           (g - ${leafFrom}) * 2 + s
    from generate_series(${leafFrom}::int, ${n}::int) g, generate_series(1, 2) s`;
  await sql`
    insert into persons (org_id, full_name)
    select ${auth.orgId}, 'Big Player ' || e.display_name
    from entrants e where e.division_id = ${divisionId}`;
  await sql`
    insert into entrant_members (entrant_id, person_id, org_id)
    select e.id, p.id, ${auth.orgId}
    from entrants e
    join persons p on p.org_id = ${auth.orgId} and p.full_name = 'Big Player ' || e.display_name
    where e.division_id = ${divisionId}`;
  await sql`
    update fixtures f
       set home_entrant_id = h.id, away_entrant_id = a.id
      from entrants h, entrants a
     where f.division_id = ${divisionId}
       and substr(f.ext_key, 5)::int >= ${leafFrom}
       and h.division_id = ${divisionId} and a.division_id = ${divisionId}
       and h.display_name = 'B' || substr(f.ext_key, 5) || 'a'
       and a.display_name = 'B' || substr(f.ext_key, 5) || 'b'`;
  return { auth, divisionId };
}

describe.skipIf(!HAS_DB)("buildSchedulePack on an elimination bracket (#396)", () => {
  it("participants of a TBD fixture include every possible advancer", async () => {
    const { auth, divisionId, ids } = await seedSmallBracket();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    const final = pack.fixtures.movable.find((f) => f.ext_key === "final")!;
    expect(final.home).toBeNull();
    expect(final.away).toBeNull();
    // Today's named-entrant derivation would give zero people here.
    expect(pack.participants[final.id]).toHaveLength(4);
    expect(new Set(pack.participants[final.id])).toEqual(new Set(ids.personIds));
  });

  it("a feeder outside the movable set is stripped and recorded in assumptions", async () => {
    const { auth, divisionId } = await seedSmallBracketWithFinishedSemi();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    expect(pack.assumptions.some((a) => a.includes("treated as completed"))).toBe(true);
    for (const f of pack.fixtures.movable) {
      for (const dep of f.feeds.after) {
        expect(pack.fixtures.movable.some((m) => m.id === dep)).toBe(true);
      }
    }
  });

  it("rebuilds byte-identical for an identical BRACKET board reseeded", async () => {
    // The existing double-seed test seeds a round-robin, where every
    // `feeds.after` is empty and every slot is named — so it exercises neither
    // `participants` nor `feeds.after` ordering. This board populates both, and
    // carries a stripped-feeder assumption. Any array ordered on a raw UUID
    // fails here, because redact() maps UUIDs to FIRST-SEEN placeholders.
    const a = await seedSmallBracketWithFinishedSemi();
    const b = await seedSmallBracketWithFinishedSemi();
    const packA = await buildSchedulePack(a.auth, a.divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    const packB = await buildSchedulePack(b.auth, b.divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    expect(packA.pack.assumptions.length).toBeGreaterThan(0);
    expect(packA.pack.fixtures.movable.some((f) => f.feeds.after.length > 0)).toBe(true);
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });

  it("participants stay within the token budget on a 500-fixture bracket", async () => {
    const { auth, divisionId } = await seedBigBracket(500);
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Pack the day.",
    });
    // Measured 2026-08-02 on this board: the PAYLOAD is 51,341.5 proxy tokens
    // (fixtures.movable 39,571.5 + entrants 10,598.25 + draft 998.5); the pack
    // with `participants` inlined would be 100,252.5, of which participants is
    // 48,902.75 across 4,490 person-id entries. That measurement is the evidence
    // for the owner's decision to keep participants server-side: 500 bracket
    // fixtures with 500 named entrants already sit at 86% of the ceiling before
    // this wave adds anything.
    expect(JSON.stringify(toModelPayload(pack)).length / 4).toBeLessThan(60_000);
  });

  it("participants and assumptions never reach the model, and stay complete on the pack", async () => {
    // Pins the exclusion BOTH ways: a future refactor that re-inlines the pack
    // must fail a test rather than silently blow a token budget on a bracket.
    const { auth, divisionId } = await seedSmallBracket();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      mode: "generate", instruction: "Two rounds.",
    });
    const payload = toModelPayload(pack) as Record<string, unknown>;
    expect("participants" in payload).toBe(false);
    expect("assumptions" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("participants");
    // …while the pack the placer and the referee read is still complete.
    expect(Object.keys(pack.participants).sort()).toEqual(
      pack.fixtures.movable.map((f) => f.id).sort(),
    );
    const final = pack.fixtures.movable.find((f) => f.ext_key === "final")!;
    expect(pack.participants[final.id]).toHaveLength(4);
    // Everything else survives the trim byte-for-byte.
    const trimmed = Object.fromEntries(
      Object.entries(pack).filter(([k]) => k !== "participants" && k !== "assumptions"),
    );
    expect(payload).toEqual(trimmed);
  });
});
