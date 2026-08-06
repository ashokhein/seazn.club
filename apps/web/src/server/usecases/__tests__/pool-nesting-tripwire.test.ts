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
import { getCompetition } from "@/server/usecases/competitions";

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
});
