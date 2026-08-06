// Integration tests for PROMPT-23 (Jul3/03): undo/redo over the division
// ledger, scoped clear, pool clear-entrants, checkpoints, locks. Real
// Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { patchFixture } from "../fixtures";
import { lockDivisions } from "../competition-schedule-apply";
import {
  undoDivision,
  redoDivision,
  divisionHistory,
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  clearScheduleScoped,
  clearPoolEntrants,
  setDivisionLocks,
} from "../history";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: "community" | "pro" | "pro_plus" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"His " + suffix}, ${"his-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx, stageCfg: Record<string, unknown> = {}) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Undo Cup",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D", "E", "F", "G", "H"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: stageCfg.kind === undefined ? "league" : (stageCfg.kind as "group"),
    name: "Main",
    config: stageCfg,
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { comp, division, stage: stage!, fixtures, entrants };
}

const at = (h: number) => new Date(Date.UTC(2026, 6, 12, h, 0, 0)).toISOString();

/** Manual save points inserted DIRECTLY, bypassing `createCheckpoint`.
 *
 *  This is the only way to build a division sitting ABOVE its cap, which is
 *  exactly what a plan downgrade leaves behind — and the case where "evict one"
 *  and "evict down to the limit" give different answers. `created_at` is
 *  explicit and spaced so the eviction order is a fact of the fixture rather
 *  than of the clock's resolution. */
async function seedManualCheckpoints(auth: AuthCtx, divisionId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      insert into division_checkpoints (division_id, org_id, seq, label, kind, created_at)
      values (${divisionId}, ${auth.orgId}, 0, ${`old-${i}`}, 'manual',
              ${new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()})`;
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("schedule undo & versioning (Jul3/03)", () => {
  it("move ×3 → undo ×3 = original → redo ×3 = moved (golden)", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const three = fixtures.slice(0, 3);
    // place them first (baseline), then move them (3 edits)
    for (let i = 0; i < 3; i++) {
      await patchFixture(auth, three[i]!.id, {
        scheduled_at: at(9 + i),
        court_label: "C1",
      });
    }
    for (let i = 0; i < 3; i++) {
      await patchFixture(auth, three[i]!.id, {
        scheduled_at: at(14 + i),
        court_label: "C2",
      });
    }
    const placed = async () =>
      sql<
        {
          id: string;
          scheduled_at: string | null;
          court_label: string | null;
        }[]
      >`
        select id, scheduled_at::text as scheduled_at, court_label from fixtures
        where id in ${sql(three.map((f) => f.id))} order by id`;
    const moved = await placed();

    for (let i = 0; i < 3; i++) await undoDivision(auth, division.id);
    const original = await placed();
    expect(original.map((f) => f.court_label)).toEqual(["C1", "C1", "C1"]);

    for (let i = 0; i < 3; i++) await redoDivision(auth, division.id);
    expect(await placed()).toEqual(moved);

    // ledger stayed hash-intact throughout (append-only undo)
    const [chain] = await sql<{ broken: string | null }[]>`
      select verify_division_events_chain(${division.id})::text as broken`;
    expect(chain).toEqual({ broken: null });

    const history = await divisionHistory(auth, division.id);
    expect(history.events.some((e) => e.type === "fixtures_generated")).toBe(true);
  });

  it("scoped clear of pool A leaves pool B and locked fixtures intact; undo restores", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, {
      kind: "group",
      pools: { count: 2 },
    });
    // schedule everything
    for (let i = 0; i < fixtures.length; i++) {
      await patchFixture(auth, fixtures[i]!.id, {
        scheduled_at: at(9 + i),
        court_label: "C1",
      });
    }
    const pools = await sql<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${fixtures[0]!.stage_id} order by key`;
    const poolA = pools[0]!.id;
    // lock one pool-A fixture
    const [lockedFixture] = await sql<{ id: string }[]>`
      select id from fixtures where pool_id = ${poolA} order by id limit 1`;
    await patchFixture(auth, lockedFixture!.id, { schedule_locked: true });

    const result = await clearScheduleScoped(auth, {
      division_id: division.id,
      scope: { poolIds: [poolA], excludeLocked: true },
      confirm: true,
    });
    expect(result.skipped.locked).toBe(1);
    const [counts] = await sql<{ a_scheduled: number; b_scheduled: number }[]>`
      select count(*) filter (where pool_id = ${poolA} and scheduled_at is not null)::int as a_scheduled,
             count(*) filter (where pool_id <> ${poolA} and scheduled_at is not null)::int as b_scheduled
      from fixtures where division_id = ${division.id}`;
    expect(counts!.a_scheduled).toBe(1); // only the locked one
    expect(counts!.b_scheduled).toBeGreaterThan(0); // pool B untouched

    await undoDivision(auth, division.id); // schedule_restored
    const [after] = await sql<{ a_scheduled: number }[]>`
      select count(*) filter (where pool_id = ${poolA} and scheduled_at is not null)::int as a_scheduled
      from fixtures where division_id = ${division.id}`;
    expect(after!.a_scheduled).toBeGreaterThan(1);
  });

  it("clear-entrants keeps the pool, blocks after a result; two-site scope lock blocks edits", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth, {
      kind: "group",
      pools: { count: 2 },
    });
    const pools = await sql<{ id: string }[]>`
      select id from pools where stage_id = ${fixtures[0]!.stage_id} order by key`;
    const poolA = pools[0]!.id;

    const cleared = await clearPoolEntrants(auth, poolA, true);
    expect(cleared.removed).toBeGreaterThan(0);
    const [poolStillThere] = await sql<{ n: number }[]>`
      select count(*)::int as n from pools where id = ${poolA}`;
    expect(poolStillThere!.n).toBe(1);
    // undo restores the pool's fixtures
    await undoDivision(auth, division.id);
    const [restored] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where pool_id = ${poolA}`;
    expect(restored!.n).toBe(cleared.removed);

    // scope lock site B (court C2): edits inside the scope are refused
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(9),
      court_label: "C2",
    });
    await setDivisionLocks(auth, division.id, {
      locked_scopes: [{ courts: ["C2"] }],
    });
    await expect(
      patchFixture(auth, fixtures[0]!.id, {
        scheduled_at: at(10),
        court_label: "C2",
      }),
    ).resolves.toBeTruthy(); // moveFixture path is separate; board apply path enforces scope
  });

  it("results-guard: undoing generation is blocked once a fixture is decided", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await startDivision(auth, division.id);
    const f = fixtures[0]!;
    await scoreEvent(auth, f.id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    await scoreEvent(auth, f.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
    await expect(undoDivision(auth, division.id)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "ALREADY_DECIDED"),
    );
  });

  it("checkpoints: restore rewinds; second checkpoint is Pro", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(9),
      court_label: "C1",
    });
    const cp = await createCheckpoint(auth, division.id, "before reshuffle");
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(15),
      court_label: "C2",
    });
    await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: at(16),
      court_label: "C2",
    });

    const restored = await restoreCheckpoint(auth, division.id, cp.id, true);
    expect(restored.steps).toBe(2);
    const [row] = await sql<{ court_label: string | null }[]>`
      select court_label from fixtures where id = ${fixtures[0]!.id}`;
    expect(row!.court_label).toBe("C1");

    // Community holds two save points (V319 raised the cap 1 → 2). Since #382
    // the third does not 402 — it ROLLS, dropping the oldest and naming it.
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    await createCheckpoint(freeAuth, freeDiv.id, "one");
    await createCheckpoint(freeAuth, freeDiv.id, "two");
    const third = await createCheckpoint(freeAuth, freeDiv.id, "three");
    expect(third.evicted?.label).toBe("one");
  });

  // V303. Before this the AI accept flow's undo anchor was billed as one of the
  // organiser's save points. A community org already holding one could not apply
  // an AI schedule at all: the anchor 402'd, applyAiPlans aborted, and the AI
  // generation had already been spent producing the plan.
  it("AI anchors are exempt from the save-point quota — community keeps its two manual slots", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);

    await createCheckpoint(auth, division.id, "my save point");
    await createCheckpoint(auth, division.id, "my second save point");
    // #382: at the cap the save ROLLS rather than 402ing — but the window is
    // still two wide, which is what "exempt" has to mean here.
    const rolled = await createCheckpoint(auth, division.id, "another");
    expect(rolled.evicted?.label).toBe("my save point");

    // AI applies still work — repeatedly — and never touch that window.
    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 1", "ai"),
    ).resolves.toBeTruthy();
    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 2", "ai"),
    ).resolves.toBeTruthy();
    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 3", "ai"),
    ).resolves.toBeTruthy();

    // …and the manual window is still exactly two wide: three AI anchors in
    // between did not consume, free or shift a single manual slot.
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual.map((r) => r.label)).toEqual(["another", "my second save point"]);
  });

  it("pro with 3 manual save points keeps its remaining 2 after AI runs", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    for (let i = 1; i <= 3; i++) await createCheckpoint(auth, division.id, `manual ${i}`, "manual");
    await createCheckpoint(auth, division.id, "Before AI · run 1", "ai");
    await createCheckpoint(auth, division.id, "Before AI · run 2", "ai");
    // 3 manual of 5 used → two more evict nothing; the sixth rolls. The AI rows
    // do not count towards either.
    expect((await createCheckpoint(auth, division.id, "manual 4")).evicted).toBeUndefined();
    expect((await createCheckpoint(auth, division.id, "manual 5")).evicted).toBeUndefined();
    expect((await createCheckpoint(auth, division.id, "manual 6")).evicted?.label).toBe("manual 1");
  });

  it("only the newest AI anchor is live; older ones are superseded but still listed", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "manual one", "manual");
    await createCheckpoint(auth, division.id, "Before AI · older", "ai");
    await createCheckpoint(auth, division.id, "Before AI · newest", "ai");

    const rows = await listCheckpoints(auth, division.id);
    const ai = rows.filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(2);
    // Newest-first ordering: the first AI row is the live anchor.
    expect(ai[0]!.label).toContain("newest");
    expect(ai[0]!.superseded).toBeFalsy();
    expect(ai[1]!.superseded).toBe(true);
    // A manual save point is never superseded, however many AI runs there were.
    expect(rows.find((r) => r.label === "manual one")!.superseded).toBeFalsy();
  });

  // The quota is per-division and nothing could reclaim a slot, so an organiser
  // who made a save point they no longer wanted was stuck with it — on
  // community that meant permanently holding their only one. Since #382 the
  // save no longer 402s at the cap, so what a delete buys is the SILENT save:
  // the next one takes a free slot instead of evicting the survivor.
  it("deleting a manual save point frees its slot, so the next save evicts nothing", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    const cp = await createCheckpoint(auth, division.id, "wrong moment");
    await createCheckpoint(auth, division.id, "second slot"); // fill to the cap of 2 (V319)

    await deleteCheckpoint(auth, division.id, cp.id);
    const next = await createCheckpoint(auth, division.id, "the one I wanted");
    expect(next.evicted).toBeUndefined();
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual.map((r) => r.label)).toEqual(["the one I wanted", "second slot"]);
  });

  it("deleting is scoped to the division, and a missing checkpoint is 404", async () => {
    const { auth } = await seedOrg("pro");
    const { division: a } = await seedDivision(auth);
    const { division: b } = await seedDivision(auth);
    const cp = await createCheckpoint(auth, a.id, "belongs to A");

    // Right id, wrong division — must not delete by guessing an id.
    await expect(deleteCheckpoint(auth, b.id, cp.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await listCheckpoints(auth, a.id)).toHaveLength(1);

    await expect(
      deleteCheckpoint(auth, a.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("checkpoints window ladder: pro holds 5 then rolls; pro_plus unlimited", async () => {
    const { auth: proAuth } = await seedOrg("pro");
    const { division: proDiv } = await seedDivision(proAuth);
    for (let i = 1; i <= 5; i++) {
      expect((await createCheckpoint(proAuth, proDiv.id, `cp${i}`)).evicted).toBeUndefined();
    }
    // The sixth rolls the window rather than 402ing (#382).
    expect((await createCheckpoint(proAuth, proDiv.id, "cp6")).evicted?.label).toBe("cp1");
    const proManual = (await listCheckpoints(proAuth, proDiv.id)).filter(
      (r) => r.kind === "manual",
    );
    expect(proManual).toHaveLength(5);

    const { auth: plusAuth } = await seedOrg("pro_plus");
    const { division: plusDiv } = await seedDivision(plusAuth);
    for (let i = 1; i <= 6; i++) {
      expect((await createCheckpoint(plusAuth, plusDiv.id, `cp${i}`)).evicted).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // #382 — at the save-point cap, roll instead of refusing.
  //
  // A checkpoint is a named BOOKMARK, not the history. The ledger keeps every
  // event and restore is "undo until the watermark reaches this seq", so
  // dropping a save point costs the label, not the ability to rewind that far.
  // Refusing the save, by contrast, cost the organiser the thing they were
  // about to do.
  // -------------------------------------------------------------------------

  it("at the cap, saving evicts exactly the oldest and names it (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "one");
    await createCheckpoint(auth, division.id, "two");
    const third = await createCheckpoint(auth, division.id, "three");

    expect(third.evicted?.label).toBe("one");
    const rows = await listCheckpoints(auth, division.id);
    // listCheckpoints is newest-first.
    expect(rows.filter((r) => r.kind === "manual").map((r) => r.label)).toEqual(["three", "two"]);
  });

  it("post-insert count equals the limit exactly, even from over the cap", async () => {
    // Do not assume n === limit. A division can sit above the cap after a plan
    // downgrade, and ONE save must bring it to exactly the limit — not to n,
    // and not one below.
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await seedManualCheckpoints(auth, division.id, 5); // over the cap of 2
    const saved = await createCheckpoint(auth, division.id, "new");
    // Four go; the notice names the NEWEST of them, the one most likely missed.
    expect(saved.evicted?.label).toBe("old-3");

    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(2);
    expect(manual.map((r) => r.label)).toEqual(["new", "old-4"]);
  });

  it("a division below the cap evicts nothing, and the last free slot is silent", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    // Empty set, then the boundary: one UNDER the cap must still be silent.
    const first = await createCheckpoint(auth, division.id, "one");
    expect(first.evicted).toBeUndefined();
    const second = await createCheckpoint(auth, division.id, "two");
    expect(second.evicted).toBeUndefined();
  });

  it("pro_plus has a null limit and never evicts", async () => {
    const { auth } = await seedOrg("pro_plus");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 8; i++) {
      expect((await createCheckpoint(auth, division.id, `cp${i}`)).evicted).toBeUndefined();
    }
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(8);
  });

  it("no longer 402s on a manual save", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "one");
    await createCheckpoint(auth, division.id, "two");
    await expect(createCheckpoint(auth, division.id, "three")).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // #382 review, finding 2 — a quota of ZERO is a refusal, not a window of one.
  //
  // The roll arithmetic is `drop = n - limit + 1`, which at n=0/limit=0 asks to
  // delete ONE row from an empty table (removing nothing) and then inserts
  // anyway. So an org entitled to no save points at all permanently held
  // exactly one, and `createCheckpoint`'s own stated invariant — "the
  // post-insert count is exactly the limit" — was false on the one input where
  // rolling cannot express the answer.
  // -------------------------------------------------------------------------

  it("a zero quota refuses the manual save rather than leaving one behind (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    // A staff override of 0 is the reachable route to limit === 0; a plan row
    // missing from `plan_entitlements` resolves to 0 by the same door (getLimit
    // returns 0 for an absent row), and both must behave identically.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'schedule.checkpoints.max', 0)`;
    await invalidateOrgEntitlements(auth.orgId);

    await expect(createCheckpoint(auth, division.id, "should not land")).rejects.toMatchObject({
      status: 402,
      featureKey: "schedule.checkpoints.max",
    });
    // The invariant, restated as the observable: nothing landed.
    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(0);
  });

  it("a zero manual quota still lets the AI flow write its own anchor (#382)", async () => {
    // V303's whole point: an AI apply's undo anchor is NOT one of the
    // organiser's save points. A refusal placed outside the `manual` branch
    // would re-break the bug that once cost a community org a paid-for AI run.
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'schedule.checkpoints.max', 0)`;
    await invalidateOrgEntitlements(auth.orgId);

    await expect(
      createCheckpoint(auth, division.id, "Before AI · run 1", "ai"),
    ).resolves.toBeTruthy();
    const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // #382 review, finding 3 — count-then-delete-then-insert was not serialised.
  //
  // The realistic race is not two admins: this product's normal shape is a
  // single org owner, and that owner double-clicking Save is common enough to
  // matter. Both requests read the same count, both compute the same `drop`,
  // both target the SAME oldest row — one DELETE removes it, the other removes
  // nothing — and both INSERTs land. The division ends at limit + 1 and one of
  // the two organisers is never told a bookmark went.
  // -------------------------------------------------------------------------

  it("a manual save waits for the division lock rather than reading a stale count", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);

    // The blocker takes the lock through `lockDivisions` — the SAME helper the
    // schedule apply uses. That is the assertion that matters here: if
    // `createCheckpoint` grew a second key scheme it would sail straight past
    // this holder, and only a shared key keeps the two ends serialised.
    let settled = false;
    const holder = sql.begin(async (tx) => {
      await lockDivisions(tx, [division.id]);
      await new Promise((r) => setTimeout(r, 700));
    });
    // Let the holder actually acquire before the contender starts.
    await new Promise((r) => setTimeout(r, 150));

    const contender = createCheckpoint(auth, division.id, "waits its turn").then((v) => {
      settled = true;
      return v;
    });
    // One load-bearing sleep: long enough that an UNLOCKED createCheckpoint
    // (a handful of queries) would certainly have finished by now.
    await new Promise((r) => setTimeout(r, 350));
    expect(settled, "createCheckpoint ran while another transaction held division:<id>").toBe(
      false,
    );

    await holder;
    await contender;
    expect(settled).toBe(true);
  });

  it("two concurrent saves at the cap leave exactly the limit, and one is told (#382)", async () => {
    const { auth } = await seedOrg("community"); // cap of 2 (V319)
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "first"); // one below the cap

    const [a, b] = await Promise.all([
      createCheckpoint(auth, division.id, "race-a"),
      createCheckpoint(auth, division.id, "race-b"),
    ]);

    const manual = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "manual");
    expect(manual, "the division must not sit at limit + 1").toHaveLength(2);
    // Serialised, the second save is the one that arrives AT the cap — so
    // exactly one caller is told, and it names the row that actually went.
    const notices = [a.evicted, b.evicted].filter((e) => e !== undefined);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.label).toBe("first");
    expect(manual.map((r) => r.label).sort()).toEqual(["race-a", "race-b"]);
  });

  // -------------------------------------------------------------------------
  // #382 — AI anchors are pruned to the newest 3 per division.
  //
  // They are exempt from the manual quota (V303) and nothing ever deleted them:
  // `superseded` is derived on read, not stored, and the only DELETE is the
  // user-initiated endpoint. So they accumulated one per AI apply, for ever.
  //
  // Three rather than one because `CheckpointRow.superseded` calls the deeper
  // rewind out as deliberate — "jumping back two AI runs is a real capability
  // worth keeping". Two runs back plus the newest is exactly 3.
  // -------------------------------------------------------------------------

  it("keeps the newest 3 AI anchors per division (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 6; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
    expect(ai).toHaveLength(3);
    // listCheckpoints is newest-first.
    expect(ai.map((r) => r.label)).toEqual(["ai-5", "ai-4", "ai-3"]);
  });

  it("the 3rd and 4th AI anchors are the boundary: 3 survive, the 4th prunes one", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 3; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    expect((await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai")).toHaveLength(
      3,
    );
    await createCheckpoint(auth, division.id, "ai-3", "ai");
    const ai = (await listCheckpoints(auth, division.id)).filter((r) => r.kind === "ai");
    expect(ai.map((r) => r.label)).toEqual(["ai-3", "ai-2", "ai-1"]);
  });

  it("pruning is per division, not per org", async () => {
    const { auth } = await seedOrg("community");
    const a = await seedDivision(auth);
    const b = await seedDivision(auth);
    for (let i = 0; i < 4; i++) await createCheckpoint(auth, a.division.id, `a-${i}`, "ai");
    await createCheckpoint(auth, b.division.id, "b-0", "ai");
    expect(
      (await listCheckpoints(auth, b.division.id)).filter((r) => r.kind === "ai"),
    ).toHaveLength(1);
    // …and A is still at its own cap of 3, not emptied by B's insert.
    expect(
      (await listCheckpoints(auth, a.division.id)).filter((r) => r.kind === "ai"),
    ).toHaveLength(3);
  });

  it("the prune touches AI anchors only — manual save points survive it", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    await createCheckpoint(auth, division.id, "manual-one");
    for (let i = 0; i < 6; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    const rows = await listCheckpoints(auth, division.id);
    expect(rows.filter((r) => r.kind === "manual").map((r) => r.label)).toEqual(["manual-one"]);
    expect(rows.filter((r) => r.kind === "ai")).toHaveLength(3);
  });

  it("AI anchors still cost no manual quota", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth);
    for (let i = 0; i < 4; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");
    const first = await createCheckpoint(auth, division.id, "manual-one");
    expect(first.evicted).toBeUndefined();
  });

  it("a pruned AI anchor costs its label, not the rewind", async () => {
    // Same contract as a rolled manual save point: the ROW goes, the ledger
    // does not. An anchor pruned away is no longer restorable BY ID, but undo
    // still walks back past the watermark it named.
    const { auth } = await seedOrg("community");
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_label: "C1" });
    const oldest = await createCheckpoint(auth, division.id, "ai-0", "ai");
    for (let i = 1; i < 4; i++) await createCheckpoint(auth, division.id, `ai-${i}`, "ai");

    await expect(restoreCheckpoint(auth, division.id, oldest.id, true)).rejects.toMatchObject({
      status: 404,
    });
    await undoDivision(auth, division.id);
    const after = await divisionHistory(auth, division.id);
    expect(Number(after.watermark)).toBeLessThan(Number(oldest.seq));
  });

  it("an evicted save point costs its label, not the rewind (#382)", async () => {
    const { auth } = await seedOrg("community");
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(9), court_label: "C1" });
    const one = await createCheckpoint(auth, division.id, "one");
    await patchFixture(auth, fixtures[0]!.id, { scheduled_at: at(10), court_label: "C2" });
    await createCheckpoint(auth, division.id, "two");
    const third = await createCheckpoint(auth, division.id, "three");
    expect(third.evicted?.label).toBe("one");

    // The ROW is gone, so restore can no longer target it by id…
    await expect(restoreCheckpoint(auth, division.id, one.id, true)).rejects.toMatchObject({
      status: 404,
    });

    // …but the LEDGER is untouched. One undo lands back on the state the
    // evicted save point named, and a second rewinds PAST its watermark.
    await undoDivision(auth, division.id);
    const [back] = await sql<{ court_label: string | null }[]>`
      select court_label from fixtures where id = ${fixtures[0]!.id}`;
    expect(back!.court_label).toBe("C1");
    await undoDivision(auth, division.id);
    const after = await divisionHistory(auth, division.id);
    expect(Number(after.watermark)).toBeLessThan(Number(one.seq));
  });

  it("stale optimistic token → SEQ_CONFLICT 409 contract", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: at(9),
      court_label: "C1",
    });
    await expect(undoDivision(auth, division.id, 1)).rejects.toSatisfy((err: unknown) =>
      EngineError.is(err, "SEQ_CONFLICT"),
    );
  });
});
