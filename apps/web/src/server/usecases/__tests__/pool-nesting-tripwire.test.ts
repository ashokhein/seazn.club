// Tripwire for the connection-pool self-deadlock.
//
// `withTenant` is `getClient().begin()`, which PINS one pooled connection for
// the whole callback. Any query issued on the pooled `sql` proxy from inside
// that callback asks the SAME pool for a second connection while the first is
// still held. With the production pool (`max: 5`, lib/db.ts) five concurrent
// renders reaching such a line pin all five slots and queue for a sixth that
// can never exist. postgres.js has no queue-wait timeout, so the deadlock is
// PERMANENT: the process sits at ~0% CPU serving static routes 200 while every
// DB-touching route — `/api/health` included — hangs for ever. Observed live
// twice on 2026-08-05 (five connections per process `idle in transaction`,
// `wait_event=ClientRead`, no COMMIT ever sent).
//
// The guard here is a pool of ONE. At `max: 1` the same nesting deadlocks
// deterministically on a single call instead of only under five-way
// concurrency — no race, no load dependence — so a regression fails this test
// on the first run rather than in production one cold cache later.
//
// Adding a case: seed under the normal pool, then run the read path inside
// `withOneSlotPool`. Anything that must NOT nest a pooled query inside
// `withTenant` belongs here.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getCompetition, listCompetitions, createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, deleteStage } from "@/server/usecases/stages";
import { putScheduleSettings } from "@/server/usecases/schedule";
import { buildDivisionDocModel } from "@/server/usecases/exports";

const HAS_DB = !!process.env.DATABASE_URL;

/** Long enough that a slow local Postgres is never mistaken for a deadlock,
 *  short enough that the failure is a red test and not a hung suite. */
const DEADLOCK_TIMEOUT_MS = 5_000;

function deadlockMessage(what: string): string {
  return (
    `${what} did not settle within ${DEADLOCK_TIMEOUT_MS}ms against a ONE-SLOT connection pool. ` +
    `This is the connection-pool self-deadlock, not flakiness: something on this code path ran a ` +
    `query on the pooled \`sql\` proxy (an entitlement/limit helper, a cache-miss lookup, another ` +
    `usecase) while \`withTenant\` still held a pooled connection — a nested pooled query while a ` +
    `transaction was open. In production (max: 5) it hangs the whole server process once five ` +
    `concurrent requests reach it, permanently. Fix the call site the same way \`getCompetition\` ` +
    `and \`autoSchedule\` do: finish and CLOSE the transaction first, then do the pooled work.`
  );
}

/**
 * Run `fn` against a freshly built one-slot pool, failing fast instead of
 * hanging. `lib/db.ts` caches its client on globalThis and sizes it from
 * `DB_POOL_MAX`, so dropping the cached client with the env var set forces the
 * next `getClient()` to build a `max: 1` client; both are restored afterwards
 * so the rest of the suite keeps the normal pool.
 */
type CachedClient = { end?: (o: unknown) => Promise<void> };

async function withOneSlotPool<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { _sql?: CachedClient };
  const savedClient = g._sql;
  const savedMax = process.env.DB_POOL_MAX;
  process.env.DB_POOL_MAX = "1";
  delete g._sql;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = fn();
    // The losing side of the race must not surface as an unhandled rejection
    // when the one-slot client is destroyed below.
    void work.catch(() => {});
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(deadlockMessage(what))), DEADLOCK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Cast: the `delete` above narrows the property to `undefined` for the rest
    // of the function, but `getClient()` has since re-populated it.
    const oneSlot = g._sql as CachedClient | undefined;
    g._sql = savedClient;
    if (savedMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = savedMax;
    if (oneSlot?.end) await oneSlot.end({ timeout: 0 }).catch(() => {});
  }
}

/** Org + competition by raw SQL — seeding must not itself depend on the path
 *  under test, and it runs under the NORMAL pool, before the swap. */
async function seedCompetition(): Promise<{ auth: AuthCtx; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pool " + suffix}, ${"pool-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status)
    values (${orgId}, ${"Pool Cup " + suffix}, ${"pool-cup-" + suffix}, 'draft')
    returning id`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    compId,
  };
}

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/**
 * A competition + division + stage, built through the REAL usecases under the
 * NORMAL pool.
 *
 * Seeding through the usecases is safe here and raw SQL is not worth its
 * brittleness: a single sequential caller against `max: 5` needs at most two
 * slots even where a path still nests, so the seed cannot deadlock. Only the
 * call under test runs against the one-slot pool, and that is where the claim
 * lives.
 */
async function seedDivision(): Promise<{
  auth: AuthCtx;
  compId: string;
  divisionId: string;
  stageId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pool " + suffix}, ${"pool-" + suffix}) returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Pool Cup " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  return { auth, compId: competition.id, divisionId: division.id, stageId: stage.id };
}

/** Turn a boolean entitlement on for one org, bypassing the plan matrix. */
async function grant(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value)
    values (${orgId}, ${featureKey}, true)
    on conflict (org_id, feature_key) do update set bool_value = true`;
}

describe.skipIf(!HAS_DB)("connection-pool nesting tripwire", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("getCompetition completes against a one-slot pool", async () => {
    const { auth, compId } = await seedCompetition();

    const row = await withOneSlotPool("getCompetition", () => getCompetition(auth, compId));

    expect(row.id).toBe(compId);
    // The entitlement read is the query that used to nest — assert the field it
    // produces, so a "fix" that simply stopped computing `frozen` fails too.
    expect(row.frozen).toBe(false);
  });

  // The 404 guard moved OUT of the transaction with the fix; pin that it still
  // fires (and fires as a 404, not as the deadlock timeout).
  it("getCompetition still 404s for an unknown id, outside the transaction", async () => {
    const { auth } = await seedCompetition();

    await expect(
      withOneSlotPool("getCompetition(404)", () => getCompetition(auth, randomUUID())),
    ).rejects.toMatchObject({ status: 404 });
  });

  // The LIST endpoint, which is hotter than the detail one — an org home renders
  // it on every visit — and which carried the identical nesting.
  it("listCompetitions completes against a one-slot pool", async () => {
    const { auth, compId } = await seedCompetition();

    const result = await withOneSlotPool("listCompetitions", () =>
      listCompetitions(auth, { cursor: null, limit: 50 }),
    );

    expect(result.items.map((c) => c.id)).toEqual([compId]);
    // Same reason as the detail case: assert the field the entitlement read
    // produces, so a "fix" that simply dropped the read fails here too.
    expect(result.items[0]?.frozen).toBe(false);
  });

  // Pagination is the half a "close the transaction" refactor is most likely to
  // break: the cursor is minted from the OVER-FETCHED row set, so a fix that
  // trimmed the rows before handing them to `page()` would silently lose
  // `nextCursor` while every deadlock assertion above stayed green.
  it("listCompetitions still paginates, outside the transaction", async () => {
    const { auth } = await seedCompetition();
    // A second and third competition in the same org, so limit 2 over-fetches.
    const suffix = randomUUID().slice(0, 8);
    for (const n of [2, 3]) {
      await sql`
        insert into competitions (org_id, name, slug, status)
        values (${auth.orgId}, ${`Pool Cup ${suffix} ${n}`}, ${`pool-cup-${suffix}-${n}`}, 'draft')`;
    }

    const first = await withOneSlotPool("listCompetitions(page)", () =>
      listCompetitions(auth, { cursor: null, limit: 2 }),
    );

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items.every((c) => c.frozen === false)).toBe(true);
  });

  // ── The WRITE paths ───────────────────────────────────────────────────────
  //
  // Every one of these used to call `assertCompetitionNotFrozen(orgId, id, tx)`
  // from inside its own `withTenant`. Threading the ambient `tx` LOOKED like it
  // made the nested case safe and did not: `frozenCompetitionIds` opens with
  // `getLimit`, which queries the pooled `sql` proxy, and that happens BEFORE
  // the `tx` branch is ever reached. So all seventeen of those call sites were
  // nesting a pooled query inside an open transaction, on the org's main write
  // paths — creating a division, adding entrants, saving a format, saving
  // scheduling settings, deleting a stage.
  //
  // One case per FILE rather than per call site: they share a single helper, so
  // a regression in it reds several of these at once, and the shape is what is
  // being guarded rather than any individual line.

  it("createDivision completes against a one-slot pool", async () => {
    const { auth, compId } = await seedDivision();

    const row = await withOneSlotPool("createDivision", () =>
      createDivision(auth, compId, {
        name: "Second",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
        eligibility: [],
      }),
    );

    expect(row.name).toBe("Second");
  });

  it("createEntrants completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();

    const created = await withOneSlotPool("createEntrants", () =>
      createEntrants(auth, divisionId, [
        { kind: "individual", display_name: "A", seed: 1, members: [] },
        { kind: "individual", display_name: "B", seed: 2, members: [] },
      ]),
    );

    expect(created).toHaveLength(2);
  });

  it("createStages completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();

    const stages = await withOneSlotPool("createStages", () =>
      createStages(auth, divisionId, { seq: 2, kind: "league", name: "L2", config: {} }),
    );

    expect(stages[0]?.name).toBe("L2");
  });

  it("deleteStage completes against a one-slot pool", async () => {
    const { auth, stageId } = await seedDivision();

    const out = await withOneSlotPool("deleteStage", () => deleteStage(auth, stageId));

    expect(out.deleted).toBe(true);
  });

  it("putScheduleSettings completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();

    const settings = await withOneSlotPool("putScheduleSettings", () =>
      putScheduleSettings(auth, divisionId, {
        config: {
          startAt: "2026-08-01T09:00:00.000Z",
          matchMinutes: 30,
          gapMinutes: 0,
          courts: ["C1"],
          perEntrantMinRest: 0,
          blackouts: [],
          sessionWindows: [],
        },
        tz: "UTC",
      }),
    );

    expect(settings.config.courts).toEqual(["C1"]);
  });

  // A DIFFERENT nester from the freeze family: `buildDivisionDocModel` awaited
  // `brandingFor` (→ `hasFeature`, a pooled read) inside its transaction, and on
  // the `participants` kind it also called `participantRows`, which opens a
  // SECOND `withTenant` — a nested transaction, which is the same pool checkout
  // by another name. Both are inside one call, so one case covers both.
  it("buildDivisionDocModel completes against a one-slot pool", async () => {
    const { auth, divisionId } = await seedDivision();
    await grant(auth.orgId, "exports");

    const doc = await withOneSlotPool("buildDivisionDocModel", () =>
      buildDivisionDocModel(auth, divisionId, "participants", {
        printedAt: "2026-08-06T10:00:00.000Z",
      }),
    );

    expect(doc.title).toContain("Open");
  });

  // ── The guard still BITES ─────────────────────────────────────────────────
  //
  // Every assertion above is satisfied by simply DELETING the freeze check —
  // a call that no longer runs it cannot deadlock on it either. This is the case
  // that stops that: an org pinned to one active competition freezes the older
  // of two, and the write must still be refused, now from outside the
  // transaction. Ordering matters too: the 402 must beat the transaction's own
  // work, not arrive after a partial write.
  it("still refuses a write to a FROZEN competition, from outside the transaction", async () => {
    const { auth, compId } = await seedDivision();
    // A second, newer competition. `selectFrozen` keeps the most recently
    // active, so the one seeded above is the one that freezes.
    await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Newer " + randomUUID().slice(0, 8),
      visibility: "private",
      branding: {},
    });
    // PIN the quota rather than inheriting the live plan matrix, which moves.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'competitions.max_active', 1)
      on conflict (org_id, feature_key) do update set int_value = 1, bool_value = null`;

    await expect(
      withOneSlotPool("createDivision(frozen)", () =>
        createDivision(auth, compId, {
          name: "Blocked",
          sport_key: "generic",
          variant_key: "score",
          config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
          eligibility: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 402, featureKey: "competitions.max_active" });
  });
});
