// Task 6 review finding 3: nothing failed if the deferred(...) wrapper
// around discovery invalidation in invalidatePublicCache (scoring.ts) were
// dropped or reordered — Redis pub:v1:discovery:* + the ISR discovery tag
// would then run inline on the scoring hot path again (dropped), or race
// each other (reordered). `@/lib/deferred` is replaced with a capture (NOT
// auto-executed, so the test controls when the tail work runs) and
// `@/server/public-site/revalidate`'s two discovery functions are
// order-instrumented. A single core.start event is the smallest write that
// flips movesDiscovery = true (scoring.ts's scoreEvent), so it reaches the
// guarded branch without a full decide+finalize sequence. Real Postgres
// required; skipped without DATABASE_URL — scoring has no DB-free path (see
// scorers.test.ts).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const capture = vi.hoisted(() => ({ fns: [] as Array<() => unknown> }));
vi.mock("@/lib/deferred", () => ({
  deferred: vi.fn((fn: () => unknown) => {
    capture.fns.push(fn);
  }),
}));

const order = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...actual,
    // A microtask hop on invalidate: if the real code ever drops its `await`
    // before fireDiscoveryRevalidate, the (synchronous) revalidate push wins
    // the race and order.log comes out ["revalidate", "invalidate"].
    invalidateDiscoveryCache: vi.fn(async () => {
      await Promise.resolve();
      order.log.push("invalidate");
    }),
    fireDiscoveryRevalidate: vi.fn(() => {
      order.log.push("revalidate");
    }),
  };
});

import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

const VARIANT_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Deferred " + suffix}, ${"deferred-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(VARIANT_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/** Discoverable competition with one startable fixture — the smallest rig
 *  that reaches invalidatePublicCache's `movesDiscovery && row.discoverable`
 *  branch. */
async function discoverableFixtureRig(auth: AuthCtx): Promise<string> {
  const competition = await createCompetition(auth, {
    name: "Deferred Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B"].map((n, i) => ({
      kind: "individual" as const,
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  await startDivision(auth, division.id);
  await patchCompetition(auth, competition.id, { discoverable: true });
  return fixtures[0]!.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("scoring -> deferred discovery wiring (Task 6 review finding 3)", () => {
  it("wraps discovery invalidation in deferred(), and invalidateDiscoveryCache resolves before fireDiscoveryRevalidate fires", async () => {
    const { auth } = await seedOrg();
    const fixtureId = await discoverableFixtureRig(auth);

    // Rig setup's patchCompetition(discoverable: true) opt-in calls the
    // discovery functions directly (not through deferred) — isolate the
    // assertions below to just the scoring write under test.
    order.log.length = 0;
    capture.fns.length = 0;
    vi.mocked(deferred).mockClear();

    // core.start alone flips movesDiscovery = true (scoring.ts) — the
    // smallest write that reaches the guarded branch, no decide/finalize
    // sequence needed.
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });

    // invalidatePublicCache runs fire-and-forget off scoreEvent (`void
    // invalidatePublicCache(...)`) — poll for the deferred registration the
    // same way deferred.test.ts polls for the helper's own callback.
    await vi.waitFor(() => expect(deferred).toHaveBeenCalledTimes(1));

    // If the deferred(...) wrapper were ever dropped, `deferred` (fully
    // replaced here, not a passthrough spy) would never be called and the
    // waitFor above times out and fails — that's the regression signal for
    // "dropped". Nothing has actually run the discovery calls yet.
    expect(capture.fns).toHaveLength(1);
    expect(order.log).toEqual([]);

    await capture.fns[0]!();

    // If the wrapper were reordered (or the await before
    // fireDiscoveryRevalidate dropped), this would read
    // ["revalidate", "invalidate"] instead — that's the regression signal
    // for "reordered".
    expect(order.log).toEqual(["invalidate", "revalidate"]);
  });
});
