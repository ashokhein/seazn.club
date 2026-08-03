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
import { validateAssignments } from "@seazn/engine/scheduling";
import { buildSchedulePack, isBlocking, toModelPayload, verifyConfig } from "../schedule-ai";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// #397: the pack builder reads no clock — `now` is injected, so a frozen
// instant here is what keeps the pack (and its golden snapshot) reproducible.
// 2026-08-06T23:30Z is already Friday the 7th in London, which is the point:
// the pack's "today" is a fact about the ORG zone, not about UTC.
const NOW_W2 = Date.parse("2026-08-06T23:30:00Z");


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

/** Override the org and/or division zone for one board (#397 tests). */
async function setZones(
  auth: AuthCtx,
  divisionId: string,
  zones: { org?: string | null; division?: string | null },
): Promise<void> {
  if (zones.org !== undefined) {
    await sql`update organizations set timezone = ${zones.org} where id = ${auth.orgId}`;
  }
  if (zones.division !== undefined) {
    await sql`update schedule_settings set tz = ${zones.division} where division_id = ${divisionId}`;
  }
}

/** Replace the settings config wholesale — used to drop startAt/sessionWindows. */
async function setConfig(divisionId: string, config: object): Promise<void> {
  await sql`update schedule_settings set config = ${sql.json(
    config as Parameters<typeof sql.json>[0],
  )} where division_id = ${divisionId}`;
}

/** The division's fixtures in board order, so a test can name one. */
async function fixtureIds(divisionId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from fixtures where division_id = ${divisionId}
    order by round_no, seq_in_round`;
  return rows.map((r) => r.id);
}

/** Unschedule the whole board — the state a division is in before its first
 *  auto-schedule, and the one that used to produce 1970 draft times. */
async function clearBoard(divisionId: string): Promise<void> {
  await sql`update fixtures set scheduled_at = null, court_label = null
            where division_id = ${divisionId}`;
}

// Seed one full RR board (2 courts, 8 entrants, a shared player, an officials
// roster) in a FRESH pro org. Everything is persisted on STABLE domain keys —
// never fixture UUIDs — so re-seeding an identical board yields the same logical
// pack. Returns the org auth + division so a caller can reseed for determinism.
async function seedRrBoard(): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth } = await seedOrg("pro");
  // The pack's ONE clock is the ORGANISATION zone (#397). This board has always
  // been a London board — it just said so on the division row. Saying it on the
  // org row too keeps the golden pack's offsets where they were, so the W2
  // snapshot diff is the four added keys and nothing else. The divergent-zone
  // case gets its own test rather than being smeared across the golden pack.
  await sql`update organizations set timezone = ${TZ} where id = ${auth.orgId}`;
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
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    const packB = await buildSchedulePack(boardB.auth, boardB.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });

  it("pack is deterministic and matches the 01 §2 shape", async () => {
    const a = await buildSchedulePack(auth, divisionId, { now: NOW_W2, mode: "generate", instruction: "Finish by 6pm." });
    const b = await buildSchedulePack(auth, divisionId, { now: NOW_W2, mode: "generate", instruction: "Finish by 6pm." });
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
    expect(a.pack.draft.every((d) => /[+-]\d{2}:\d{2}$/.test(String(d.scheduled_at)))).toBe(true);
    expect(a.pack.settings.constraints?.crossPersonClash).toBe("hard");
    expect(a.movableIds.size).toBe(RR);
  });

  it("repair scope excludes out-of-scope fixtures from movable and adds them as obstacles", async () => {
    const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
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
      now: NOW_W2,
      mode: "repair", instruction: "reflow", scope: { courts: ["Court 2"] },
    });
    expect(pack.draft.length).toBe(pack.fixtures.movable.length);
    expect(pack.draft.every((d) => d.court_label === "Court 2")).toBe(true);
  });

  it("refine mode uses the prior proposal verbatim as the draft", async () => {
    const gen = await buildSchedulePack(auth, divisionId, { now: NOW_W2, mode: "generate", instruction: "x" });
    // A prior proposal is by definition PLACED — #397 made only the DRAFT row
    // nullable, so an unplaced row is filtered out rather than coerced.
    const prior = gen.pack.draft
      .filter((d): d is typeof d & { scheduled_at: string } => d.scheduled_at !== null)
      .map((d) => ({
        fixture_id: d.fixture_id, scheduled_at: d.scheduled_at, court_label: d.court_label,
      }));
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "refine", instruction: "later", prior: { instruction: "x", assignments: prior },
    });
    expect(pack.mode).toBe("refine");
    expect(pack.prior?.assignments.length).toBe(prior.length);
    expect(pack.draft.length).toBe(prior.length);
  });

  it("rejects a scope court that is not in settings.courts (400)", async () => {
    await expect(
      buildSchedulePack(auth, divisionId, {
        now: NOW_W2,
        mode: "repair", instruction: "x", scope: { courts: ["Court 9"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("repair scope matching nothing is 422 AI_PLAN_EMPTY_SCOPE", async () => {
    await expect(
      buildSchedulePack(auth, divisionId, {
        now: NOW_W2,
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
      now: NOW_W2,
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
      now: NOW_W2,
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
    const pack = await buildSchedulePack(auth, flex.id, { now: NOW_W2, mode: "generate", instruction: "x" });
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
      now: NOW_W2,
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
      buildSchedulePack(auth, divisionId, { now: NOW_W2, mode: "generate", instruction: "x" }),
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

/** A fresh random UUID whose FIRST hex digit is `lead` — so two boards can be
 *  seeded with fixture ids that sort opposite ways without ever colliding on the
 *  primary key. Used to make "ordered on a raw UUID" a deterministic failure
 *  rather than a coin flip. */
function uuidLeading(lead: string): string {
  return lead + randomUUID().slice(1);
}

/**
 * 4 entrants, one person each, two semis feeding one final. The final's entrant
 * slots are NULL — the shape today's named-entrant derivation reports as having
 * nobody in it.
 *
 * `fixtureIds` forces the fixtures' primary keys instead of letting the DB pick
 * them; the determinism test uses it to seed two logically identical boards
 * whose raw UUIDs order the two feeders in opposite directions.
 */
async function seedSmallBracket(fixtureIds?: {
  semi1: string;
  semi2: string;
  final: string;
}): Promise<{
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

  const forcedFinal = fixtureIds?.final ?? randomUUID();
  const [final] = await sql<{ id: string }[]>`
    insert into fixtures (id, stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${forcedFinal}, ${stageId}, ${divisionId}, ${auth.orgId}, 2, 0, 'final', 'scheduled')
    returning id`;
  const semis: string[] = [];
  for (let i = 0; i < 2; i++) {
    const forcedSemi = (i === 0 ? fixtureIds?.semi1 : fixtureIds?.semi2) ?? randomUUID();
    const [s] = await sql<{ id: string }[]>`
      insert into fixtures (id, stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id, winner_to_fixture, winner_to_slot)
      values (${forcedSemi}, ${stageId}, ${divisionId}, ${auth.orgId}, 1, ${i}, ${`semi-${i + 1}`},
              'scheduled', ${ents[i * 2]!.id}, ${ents[i * 2 + 1]!.id}, ${final!.id}, ${i + 1})
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
 * One movable final fed by TWO already-finished semis that carry NO `ext_key`.
 * `fixtures.ext_key` is nullable, so both stripped-feeder assumptions keep a full
 * raw UUID in their message body — and a text sort of those strings therefore
 * orders on a per-seed random value. The semis' ids are forced so their UUID
 * order (semi-B first) contradicts their board order (semi-A first, round 1
 * seq 0), making that failure deterministic.
 */
async function seedNullExtKeyDanglingFeeders(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  semiA: string;
  semiB: string;
}> {
  const { auth, divisionId, stageId } = await seedKoDivision("Dangle");
  await createEntrants(
    auth,
    divisionId,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const, display_name: `D${i + 1}`, seed: i + 1, members: [],
    })),
  );
  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  const [final] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
    values (${stageId}, ${divisionId}, ${auth.orgId}, 2, 0, 'final', 'scheduled') returning id`;
  // semi-A sorts ABOVE semi-B as a raw string, but BELOW it on (round, seq).
  const ids = [uuidLeading("f"), uuidLeading("0")];
  for (let i = 0; i < 2; i++) {
    await sql`
      insert into fixtures (id, stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id, winner_to_fixture, winner_to_slot,
                            scheduled_at, court_label)
      values (${ids[i]!}, ${stageId}, ${divisionId}, ${auth.orgId}, 1, ${i}, null, 'finalized',
              ${ents[i * 2]!.id}, ${ents[i * 2 + 1]!.id}, ${final!.id}, ${i + 1},
              ${new Date(T0 + i * 30 * MIN).toISOString()}, 'Court 1')`;
  }
  return { auth, divisionId, semiA: ids[0]!, semiB: ids[1]! };
}

/**
 * ONE stripped feeder that feeds TWO dependents — the double-elimination shape,
 * where a single match legitimately feeds both the winners' and the losers'
 * bracket. Both dependents carry a NULL `ext_key` (the column is nullable), so
 * `stripByes` labels each of them by its raw UUID and both assumption messages
 * keep a per-seed random value inside the text.
 *
 * `fixtureIds` forces the dependents' primary keys so two logically identical
 * boards can order them in OPPOSITE directions as raw strings — which turns
 * "ranked per feeder instead of per (dependent, feeder) pair" from a coin flip
 * into a deterministic failure.
 */
async function seedSharedFeederTwoDependents(fixtureIds: {
  winners: string;
  losers: string;
}): Promise<{ auth: AuthCtx; divisionId: string; winners: string; losers: string }> {
  const { auth, divisionId, stageId } = await seedKoDivision("Dbl");
  await createEntrants(
    auth,
    divisionId,
    Array.from({ length: 2 }, (_, i) => ({
      kind: "individual" as const, display_name: `X${i + 1}`, seed: i + 1, members: [],
    })),
  );
  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  // The two TBD dependents, in board order: winners' bracket then losers'.
  for (const [seq, id] of [fixtureIds.winners, fixtureIds.losers].entries()) {
    await sql`
      insert into fixtures (id, stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      values (${id}, ${stageId}, ${divisionId}, ${auth.orgId}, 2, ${seq}, null, 'scheduled')`;
  }
  // …and the single finished match that feeds BOTH of them.
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                          home_entrant_id, away_entrant_id,
                          winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot,
                          scheduled_at, court_label)
    values (${stageId}, ${divisionId}, ${auth.orgId}, 1, 0, 'sf', 'finalized',
            ${ents[0]!.id}, ${ents[1]!.id},
            ${fixtureIds.winners}, 1, ${fixtureIds.losers}, 1,
            ${new Date(T0).toISOString()}, 'Court 1')`;
  return { auth, divisionId, winners: fixtureIds.winners, losers: fixtureIds.losers };
}

/**
 * Two movable fixtures that TIE on (round_no, seq_in_round) and whose `ext_key`
 * order contradicts their raw-UUID order. The only board shape on which the
 * pack's fixture comparator and its `participants` key comparator can disagree.
 */
async function seedTiedSeqBoard(): Promise<{
  auth: AuthCtx;
  divisionId: string;
  extA: string;
  extB: string;
}> {
  const { auth, divisionId, stageId } = await seedKoDivision("Tied");
  await createEntrants(
    auth,
    divisionId,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const, display_name: `T${i + 1}`, seed: i + 1, members: [],
    })),
  );
  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  const ids = { "ext-a": uuidLeading("f"), "ext-b": uuidLeading("0") };
  let i = 0;
  for (const [extKey, id] of Object.entries(ids)) {
    await sql`
      insert into fixtures (id, stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id)
      values (${id}, ${stageId}, ${divisionId}, ${auth.orgId}, 1, 0, ${extKey}, 'scheduled',
              ${ents[i * 2]!.id}, ${ents[i * 2 + 1]!.id})`;
    i++;
  }
  return { auth, divisionId, extA: ids["ext-a"], extB: ids["ext-b"] };
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

/**
 * Two anonymous registrations by one human, plus the three cases the guard must
 * treat differently. Five one-round fixtures, one entrant person each:
 *   g1 Bobby Fischer #1 | g2 Bobby Fischer #2  → same raw name, two persons rows
 *   g3 Cathy Case       | g4 "  cathy   CASE " → same name only once normalised
 *   g5 ""               | "   "               → blank names must NOT bucket
 * Exactly what the registration flow produces today: no backfill, no merge.
 */
async function seedTwoSameNamePlayers(): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth, divisionId, stageId } = await seedKoDivision("SameName");
  const names = [
    "Bobby Fischer", "Alice Alpha",
    "Bobby Fischer", "Bravo Beta",
    "Cathy Case", "Delta Dee",
    "  cathy   CASE ", "Echo Eee",
    "", "   ",
  ];
  await createEntrants(
    auth,
    divisionId,
    names.map((_, i) => ({
      kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [],
    })),
  );
  const ents = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} order by seed`;
  for (let i = 0; i < names.length; i++) {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, ${names[i]!}) returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id)
              values (${ents[i]!.id}, ${p!.id}, ${auth.orgId})`;
  }
  for (let g = 0; g < names.length / 2; g++) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status,
                            home_entrant_id, away_entrant_id)
      values (${stageId}, ${divisionId}, ${auth.orgId}, 1, ${g}, ${`g${g + 1}`}, 'scheduled',
              ${ents[g * 2]!.id}, ${ents[g * 2 + 1]!.id})`;
  }
  return { auth, divisionId };
}

async function personCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from persons where org_id = ${orgId}`;
  return Number(row!.n);
}

describe.skipIf(!HAS_DB)("scheduling-only same-name guard (#396)", () => {
  it("two entrants, same person name, different person_id ⇒ one participant key, persons untouched", async () => {
    const { auth, divisionId } = await seedTwoSameNamePlayers();
    const before = await personCount(auth.orgId);

    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });

    const byExtKey = (k: string): string => pack.fixtures.movable.find((f) => f.ext_key === k)!.id;
    const shared = pack.participants[byExtKey("g1")]!.filter((p) =>
      pack.participants[byExtKey("g2")]!.includes(p),
    );
    expect(shared.length).toBe(1);
    expect(shared[0]).toMatch(/^name:/);
    expect(pack.assumptions.some((a) => a.includes("Bobby Fischer"))).toBe(true);

    // The database is untouched — this is a scheduling key, never a merge.
    expect(await personCount(auth.orgId)).toBe(before);
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
      where org_id = ${auth.orgId} and full_name = 'Bobby Fischer'`;
    expect(Number(n)).toBe(2);
  });

  it("collapses on the NORMALISED name (case and inner whitespace)", async () => {
    const { auth, divisionId } = await seedTwoSameNamePlayers();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    const byExtKey = (k: string): string => pack.fixtures.movable.find((f) => f.ext_key === k)!.id;
    const shared = pack.participants[byExtKey("g3")]!.filter((p) =>
      pack.participants[byExtKey("g4")]!.includes(p),
    );
    expect(shared).toEqual(["name:cathy case"]);
  });

  it("blank names never bucket together, and the key never reaches the wire", async () => {
    const { auth, divisionId } = await seedTwoSameNamePlayers();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    const blanks = pack.participants[
      pack.fixtures.movable.find((f) => f.ext_key === "g5")!.id
    ]!;
    // "" and "   " normalise to the same empty string; collapsing them would
    // book two unrelated humans as one player.
    expect(blanks.length).toBe(2);
    expect(blanks.filter((p) => p.startsWith("name:"))).toEqual([]);
    expect(new Set(blanks).size).toBe(2);
    // `people` (the wire array) keeps REAL person ids — the synthetic key lives
    // only in `participants`, which never leaves the server.
    expect(pack.people.filter((p) => p.person_id.startsWith("name:"))).toEqual([]);
    expect(JSON.stringify(toModelPayload(pack))).not.toContain("name:");
  });

  it("two people with different names are never collapsed", async () => {
    const { auth, divisionId } = await seedSmallBracket();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Two rounds.",
    });
    expect(pack.participants).toBeDefined();
    for (const list of Object.values(pack.participants)) {
      expect(list.filter((p) => p.startsWith("name:"))).toEqual([]);
    }
    expect(pack.assumptions.some((a) => a.includes("no records were merged"))).toBe(false);
  });

  it("the same-name board rebuilds byte-identical when reseeded", async () => {
    const a = await seedTwoSameNamePlayers();
    const b = await seedTwoSameNamePlayers();
    const packA = await buildSchedulePack(a.auth, a.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    const packB = await buildSchedulePack(b.auth, b.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(packA.pack.assumptions.length).toBe(2);
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });
});

describe.skipIf(!HAS_DB)("buildSchedulePack on an elimination bracket (#396)", () => {
  it("participants of a TBD fixture include every possible advancer", async () => {
    const { auth, divisionId, ids } = await seedSmallBracket();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
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
      now: NOW_W2,
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
      now: NOW_W2,
      mode: "generate", instruction: "Two rounds.",
    });
    const packB = await buildSchedulePack(b.auth, b.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Two rounds.",
    });
    expect(packA.pack.assumptions.length).toBeGreaterThan(0);
    expect(packA.pack.fixtures.movable.some((f) => f.feeds.after.length > 0)).toBe(true);
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });

  it("a final that keeps TWO feeders orders feeds.after on the feeder's domain key, not its UUID", async () => {
    // The test above seeds a board whose final has exactly ONE surviving feeder,
    // so a one-element array can carry any comparator and `after.length > 0`
    // cannot tell the difference. Here BOTH semis stay movable, and the two
    // boards' fixture UUIDs are forced to sort in OPPOSITE directions:
    //   board A: semi-1 ('f…') > semi-2 ('0…')
    //   board B: semi-1 ('1…') < semi-2 ('e…')
    // Ordering on the raw UUID (`.sort(cmp)`) therefore emits [semi-2, semi-1]
    // for A and [semi-1, semi-2] for B, and — because redact() maps UUIDs to
    // FIRST-SEEN placeholders and `participants` has already numbered the semis
    // in board order — the redacted packs diverge. Ordering on the feeder's
    // (round_no, seq_in_round, ext_key) keeps both at [semi-1, semi-2].
    const a = await seedSmallBracket({
      semi1: uuidLeading("f"), semi2: uuidLeading("0"), final: uuidLeading("7"),
    });
    const b = await seedSmallBracket({
      semi1: uuidLeading("1"), semi2: uuidLeading("e"), final: uuidLeading("7"),
    });
    const packA = await buildSchedulePack(a.auth, a.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Two rounds.",
    });
    const packB = await buildSchedulePack(b.auth, b.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Two rounds.",
    });
    // The board really does exercise a multi-feeder array…
    const finalA = packA.pack.fixtures.movable.find((f) => f.ext_key === "final")!;
    expect(finalA.feeds.after.length).toBeGreaterThanOrEqual(2);
    expect(packA.pack.fixtures.movable.some((f) => f.feeds.after.length >= 2)).toBe(true);
    // …in the feeders' domain order, not their UUID order.
    expect(finalA.feeds.after).toEqual([a.ids.fixtureIds.semi1, a.ids.fixtureIds.semi2]);
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });

  it("stripped-feeder assumptions order on the board, not on the UUID a null ext_key leaves in the text", async () => {
    // `fixtures.ext_key` is NULLABLE, so the ext_key substitution leaves a full
    // raw UUID inside both messages and a text sort orders on a per-seed random
    // value — which redact()'s first-seen placeholders would then expose as a
    // determinism failure. The dependent+feeder (round_no, seq_in_round) tuple
    // puts them in board order regardless.
    const { auth, divisionId, semiA, semiB } = await seedNullExtKeyDanglingFeeders();
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Final only.",
    });
    const dangling = pack.assumptions.filter((a) => a.includes("treated as completed"));
    expect(dangling.length).toBe(2);
    const at = (id: string): number => dangling.findIndex((a) => a.includes(id));
    expect(at(semiA)).toBe(0);
    expect(at(semiB)).toBe(1);
    // The premise: a text sort would invert them.
    expect(semiA > semiB).toBe(true);
  });

  it("ONE feeder feeding TWO dependents ranks per pair, not per feeder", async () => {
    // The test above gives each dependent its own feeder, so a rank map keyed on
    // the feeder alone is never overwritten and reads correct. Double
    // elimination breaks that: one match feeds the winners' AND the losers'
    // bracket, so both dependents strip the SAME feeder, the second write wins,
    // and the two assumptions come out with identical ranks — falling through to
    // `cmp(text)`. With a null `ext_key` on the dependents, that text is a raw
    // per-seed UUID.
    //
    // Two logically identical boards whose dependent ids sort in OPPOSITE
    // directions, so the failure is deterministic instead of 1-in-2:
    //   board A: winners ('f…') > losers ('0…')
    //   board B: winners ('0…') < losers ('f…')
    const a = await seedSharedFeederTwoDependents({
      winners: uuidLeading("f"), losers: uuidLeading("0"),
    });
    const b = await seedSharedFeederTwoDependents({
      winners: uuidLeading("0"), losers: uuidLeading("f"),
    });
    const packA = await buildSchedulePack(a.auth, a.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Both brackets.",
    });
    const packB = await buildSchedulePack(b.auth, b.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Both brackets.",
    });

    // The board really is the shared-feeder shape…
    const danglingA = packA.pack.assumptions.filter((x) => x.includes("treated as completed"));
    expect(danglingA.length).toBe(2);
    expect(packA.pack.fixtures.movable.map((f) => f.id)).toEqual([a.winners, a.losers]);
    // …and the premise: a text sort would invert board A.
    expect(a.winners > a.losers).toBe(true);
    expect(b.winners < b.losers).toBe(true);

    // Board order is (round_no, seq_in_round) of the DEPENDENT: winners first.
    const at = (list: string[], id: string): number => list.findIndex((x) => x.includes(id));
    expect(at(danglingA, a.winners)).toBe(0);
    expect(at(danglingA, a.losers)).toBe(1);
    // …and the two boards are byte-identical once UUIDs are redacted.
    expect(redact(packA.pack)).toEqual(redact(packB.pack));
  });

  it("participants key order IS fixtures.movable order, not merely the same set", async () => {
    // `participants` serialises BEFORE `fixtures`, so its key order is what
    // assigns every fixture-id placeholder in the golden pack. Two comparators
    // that merely happen to agree on today's board would silently renumber that
    // snapshot the first time a board pulled them apart — so the two lists are
    // pinned in ORDER, on a board built to pull them apart: `ext-a`/`ext-b` tie
    // on (round_no, seq_in_round) and their raw UUIDs sort the other way, so any
    // call site that drops `ext_key` (or keeps only the id) diverges here.
    const tied = await seedTiedSeqBoard();
    const rr = await seedRrBoard();
    const { pack } = await buildSchedulePack(tied.auth, tied.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Tied seq.",
    });
    expect(pack.fixtures.movable.map((f) => f.ext_key)).toEqual(["ext-a", "ext-b"]);
    expect(tied.extA > tied.extB).toBe(true); // …while the UUIDs sort the other way
    expect(Object.keys(pack.participants)).toEqual(pack.fixtures.movable.map((f) => f.id));

    const { pack: rrPack } = await buildSchedulePack(rr.auth, rr.divisionId, {
      now: NOW_W2,
      mode: "generate", instruction: "Finish by 6pm.",
    });
    expect(Object.keys(rrPack.participants)).toEqual(rrPack.fixtures.movable.map((f) => f.id));
  });

  it("participants stay within the token budget on a 500-fixture bracket", async () => {
    const { auth, divisionId } = await seedBigBracket(500);
    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW_W2,
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
      now: NOW_W2,
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

// ===========================================================================
// W2 (#397) — the calendar anchor
// ===========================================================================
//
// A frozen instant: 2026-08-06T23:30Z is already Friday 2026-08-07 in London,
// which is the whole point — the pack's "today" is a fact about the ORG zone,
// not about UTC.
const NOW = NOW_W2;
const OPTS = { mode: "generate" as const, instruction: "", now: NOW };

// SETTINGS_CONFIG with no startAt and no sessionWindows — the state that
// produced the 1970 drafts. Everything else is unchanged, so only the anchor
// moves.
const NO_ANCHOR_CONFIG = (() => {
  const { startAt: _startAt, ...rest } = SETTINGS_CONFIG;
  return { ...rest, sessionWindows: [] };
})();

describe.skipIf(!HAS_DB)("pack calendar anchor (#397)", () => {
  it("carries the ORG zone, a clock, a window and session hours", async () => {
    const { auth, divisionId } = await seedRrBoard();
    await setConfig(divisionId, NO_ANCHOR_CONFIG);
    await clearBoard(divisionId);
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);

    expect(pack.tz).toBe("Europe/London");
    expect(pack.clock.now).toBe("2026-08-06T23:30:00.000Z");
    expect(pack.clock.today).toBe("2026-08-07");
    expect(pack.clock.tomorrow).toBe("2026-08-08");
    expect(pack.clock.nextWeekday.FRI).toBe("2026-08-14"); // never today
    expect(pack.sessionHours).toEqual({ start: "08:00", end: "22:00" });
    // No configured startAt/endAt: today plus the default 7-day horizon, in the
    // org zone — 00:00 BST is 23:00Z the day before.
    expect(pack.window.start).toBe("2026-08-07T00:00:00+01:00");
    expect(pack.window.end).toBe("2026-08-13T23:59:59+01:00");
  });

  it("keeps the division zone as display metadata and renders in the org zone", async () => {
    // The accepted cost of the one-clock decision (design §2.1): a Madrid
    // division under a London org is written in London time. division.tz stays
    // in the pack because the console still labels the board with it.
    const { auth, divisionId } = await seedRrBoard();
    await setZones(auth, divisionId, { division: "Europe/Madrid" });
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);

    expect(pack.division.tz).toBe("Europe/Madrid");
    expect(pack.tz).toBe("Europe/London");
    for (const d of pack.draft) expect(d.scheduled_at).toMatch(/\+01:00$/);
    for (const f of pack.fixtures.movable) {
      if (f.current.at !== null) expect(f.current.at).toMatch(/\+01:00$/);
    }
  });

  it("no longer emits 1970 draft times for a division with no configured start", async () => {
    // The bug #397 exists to kill: toSlotConfig(settings, 0) anchored the greedy
    // draft at the epoch, so the model was handed 1970-01-01 for every fixture.
    const { auth, divisionId } = await seedRrBoard();
    await setConfig(divisionId, NO_ANCHOR_CONFIG);
    await clearBoard(divisionId);
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);

    expect(pack.draft.length).toBeGreaterThan(0);
    for (const d of pack.draft) {
      expect(d.scheduled_at).not.toBeNull();
      expect(d.scheduled_at!.slice(0, 3)).not.toBe("197");
      expect(d.scheduled_at!.slice(0, 3)).not.toBe("196");
    }
    // The anchor is the first session hour of the window's first day in the org
    // zone — not midnight, and not the epoch.
    expect(pack.draft[0]!.scheduled_at).toBe("2026-08-07T08:00:00+01:00");
  });

  it("nulls an epoch sentinel already persisted on a fixture", async () => {
    // A repair round over a board written before this fix. A null draft time is
    // an honest 'unplaced'; 1970-01-01 is a lie the model anchors on.
    const { auth, divisionId } = await seedRrBoard();
    const ids = await fixtureIds(divisionId);
    await sql`update fixtures set scheduled_at = ${new Date(0).toISOString()}
              where id = ${ids[0]!}`;

    const { pack } = await buildSchedulePack(auth, divisionId, { ...OPTS, mode: "repair" });

    const row = pack.draft.find((d) => d.fixture_id === ids[0]);
    expect(row === undefined || row.scheduled_at === null).toBe(true);
    expect(pack.fixtures.movable.find((f) => f.id === ids[0])!.current.at).toBeNull();
    // …and the sentinel must not have dragged the window back to 1970.
    expect(pack.window.start.slice(0, 4)).toBe("2026");
  });

  it("widens the window to cover a board already scheduled beyond the horizon", async () => {
    // A repair round must not report every card it was asked to keep. Widening
    // is one-directional: the default horizon can only grow.
    const { auth, divisionId } = await seedRrBoard();
    await setConfig(divisionId, NO_ANCHOR_CONFIG);
    await clearBoard(divisionId);
    const ids = await fixtureIds(divisionId);
    await sql`update fixtures
              set scheduled_at = '2026-09-20T10:00:00Z', court_label = 'Court 1'
              where id = ${ids[0]!}`;

    const { pack } = await buildSchedulePack(auth, divisionId, { ...OPTS, mode: "repair" });
    expect(pack.window.start).toBe("2026-08-07T00:00:00+01:00");
    expect(pack.window.end).toBe("2026-09-20T23:59:59+01:00");
  });

  it("is byte-identical for two builds at the same injected instant", async () => {
    // The determinism contract: `now` is a parameter, so the pack does not move
    // between two builds a millisecond apart.
    const { auth, divisionId } = await seedRrBoard();
    const a = await buildSchedulePack(auth, divisionId, OPTS);
    const b = await buildSchedulePack(auth, divisionId, OPTS);
    expect(JSON.stringify(a.pack)).toBe(JSON.stringify(b.pack));
  });

  it("sends the anchor to the model but never the enforcement inputs", async () => {
    const { auth, divisionId } = await seedRrBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);
    const payload = toModelPayload(pack) as Record<string, unknown>;
    expect(payload.tz).toBe("Europe/London");
    expect(payload.clock).toEqual(pack.clock);
    expect(payload.window).toEqual(pack.window);
    expect(payload.sessionHours).toEqual(pack.sessionHours);
    expect("participants" in payload).toBe(false);
    expect("assumptions" in payload).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("verifyConfig carries the pack window (#397)", () => {
  it("reports a model assignment outside the window, without blocking it", async () => {
    const { auth, divisionId } = await seedRrBoard();
    const { pack } = await buildSchedulePack(auth, divisionId, OPTS);
    const conflicts = validateAssignments(
      [
        {
          fixtureId: pack.fixtures.movable[0]!.id,
          court: pack.settings.courts[0]!,
          startAt: Date.parse("2027-03-01T10:00:00Z"),
          endAt: Date.parse("2027-03-01T10:30:00Z"),
          entrants: [],
          people: [],
        },
      ],
      verifyConfig(pack),
    );
    const windowed = conflicts.filter((c) => c.reason === "window");
    expect(windowed).toHaveLength(1);
    // Warn-only until W4 (#399) makes it delta-blocking.
    expect(windowed.some(isBlocking)).toBe(false);
  });
});
