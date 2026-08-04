// #447 — the DURABLE half: a `constraints.hard` rule written through the API,
// read back off `schedule_settings.config` jsonb, and enforced on every non-AI
// surface.
//
// The sibling file (`schedule-durable-hard.test.ts`) pins the builders. This one
// pins the product: the rule is PERSISTED by `putScheduleSettings`, re-parsed by
// `loadSettings`, and then each of the four board entry points is driven for
// real against Postgres. Nothing here constructs a config — that is the point.
// Every engine test injects `hard` straight into a `VerifyConfig` literal, which
// bypasses the one function that dropped it, which is exactly why the suite was
// blind to this for a whole wave.
//
// WHY THE SPY. Three of the four surfaces RETURN their conflicts, so the rule
// binding is directly observable. `moveFixture` does not: it returns void and
// uses its conflict list only for `assertNoNewBlocking`, and an instruction
// conflict is warn-only, so nothing it does is observable from outside. Wrapping
// the two engine entry points and recording the config each surface hands them
// is therefore the only proof available that the durable rule reaches the
// verifier on the drag path — and it is a real proof: a config with no `hard`,
// no `tz` or no `ruleFixtures` is precisely the defect.
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { VerifyConfig } from "@seazn/engine/scheduling";

const seen = vi.hoisted(() => ({ configs: [] as unknown[] }));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    validateAssignments: (...args: Parameters<typeof actual.validateAssignments>) => {
      seen.configs.push(args[1]);
      return actual.validateAssignments(...args);
    },
    validateInstructionRules: (...args: Parameters<typeof actual.validateInstructionRules>) => {
      seen.configs.push(args[1]);
      return actual.validateInstructionRules(...args);
    },
  };
});

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const {
  putScheduleSettings,
  getScheduleSettings,
  autoSchedule,
  applySchedule,
  moveFixture,
  validateSchedule,
} = await import("../schedule");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

// The rule under test. Unit-free and wall-clock (#398): "no fixture may start
// before noon", stated once, stored once, and owed on every surface. Every
// fixture this board can produce starts at 09:00 or 09:30, so a surface that
// honours it reports and a surface that drops it is silent — no arithmetic in
// the assertions and no dependence on the placer's packing order.
const NOT_BEFORE_NOON = {
  type: "not_before" as const,
  time: "12:00",
  scope: { kind: "competition" as const },
};

async function seedProOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** Every config the surface just handed the engine must carry all three fields.
 *  Asserted together on purpose: `hard` without `tz` is a fix that binds
 *  nothing, and `hard` without `ruleFixtures` binds only half of
 *  `min_rest_minutes`. Any one of the three missing is the bug. */
function expectRuleReachedTheVerifier(surface: string): void {
  const configs = seen.configs as VerifyConfig[];
  expect(configs.length, `${surface} never called the verifier`).toBeGreaterThan(0);
  for (const c of configs) {
    expect(c.constraints?.hard, `${surface} dropped the durable rule`).toEqual([NOT_BEFORE_NOON]);
    expect(c.tz, `${surface} dropped the org zone`).toBe("UTC");
    expect((c.ruleFixtures ?? []).length, `${surface} dropped the rule fixtures`).toBeGreaterThan(0);
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  seen.configs.length = 0;
});

describe.skipIf(!HAS_DB)("a durable constraints.hard rule on the board paths (#447)", () => {
  it("binds on auto-schedule, the apply gate, the conflict report and the drag path", async () => {
    const auth = await seedProOrg();
    const competition = await createCompetition(auth, {
      name: "Durable Rules",
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
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [groups] = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 1 } } },
    ]);

    // --- persist ----------------------------------------------------------
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court 1", "Court 2"],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
        // The zod OUTPUT type: everything but `hard` carries a default, and a
        // defaulted field is REQUIRED downstream — which is exactly the reason
        // `hard` is `.optional()` rather than `.default([])`.
        constraints: {
          hard: [NOT_BEFORE_NOON],
          noBackToBack: false,
          startWindows: [],
          fieldFairness: "off",
          parallelism: "mixed",
          crossPersonClash: "warn",
        },
      },
      tz: "UTC",
    });
    // Durability, proven off the row rather than off the object we just passed:
    // this is `ScheduleConfig.parse` over `schedule_settings.config` jsonb, the
    // same read `loadSettings` does on every one of the four surfaces below.
    const stored = await sql<{ config: { constraints?: { hard?: unknown[] } } }[]>`
      select config from schedule_settings where division_id = ${division.id}`;
    expect(stored[0]!.config.constraints?.hard).toEqual([NOT_BEFORE_NOON]);
    expect((await getScheduleSettings(auth, division.id)).config.constraints?.hard).toEqual([
      NOT_BEFORE_NOON,
    ]);

    expect((await generateStageFixtures(auth, groups!.id)).created).toBe(6);

    // --- 1. auto-schedule -------------------------------------------------
    const proposal = await autoSchedule(auth, groups!.id, false);
    expect(proposal.assignments).toHaveLength(6);
    // Every card the placer produced starts before noon, so every one of them
    // breaches the stored rule. The placer has no term for a typed rule — it
    // reports only what it could not FIT — so before the fix this came back with
    // an empty conflict list and an organiser building a board saw nothing.
    const autoInstruction = proposal.conflicts.filter((c) => c.code === "warn.instruction");
    expect(autoInstruction).toHaveLength(6);
    expect(autoInstruction.every((c) => !c.blocking)).toBe(true);
    expect(autoInstruction[0]!.detail).toContain("violating not_before 12:00");
    expectRuleReachedTheVerifier("autoSchedule");

    // --- 2. the apply gate ------------------------------------------------
    seen.configs.length = 0;
    const applied = await applySchedule(auth, groups!.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });
    // THE PRODUCT DECISION, pinned. The write is REPORTED, not refused: an
    // instruction conflict is warn-only (`isBlockingConflict` covers court,
    // person_overlap, window and direct order alone) and `assertNoNewBlocking`
    // filters by exactly that predicate. So an organiser whose existing board
    // breaches a rule they stored can still save it — they are told, and they
    // are not locked out of the board they need in order to fix it.
    expect(applied.applied).toBe(6);
    expect(applied.conflicts.filter((c) => c.code === "warn.instruction")).toHaveLength(6);
    expect(applied.conflicts.every((c) => !c.blocking)).toBe(true);
    expectRuleReachedTheVerifier("applySchedule");

    // --- 3. the board conflict report -------------------------------------
    seen.configs.length = 0;
    const report = await validateSchedule(auth, division.id);
    const reported = report.conflicts.filter((c) => c.code === "warn.instruction");
    expect(reported).toHaveLength(6);
    expect(reported.every((c) => !c.blocking)).toBe(true);
    expectRuleReachedTheVerifier("validateSchedule");

    // --- 4. the drag path -------------------------------------------------
    seen.configs.length = 0;
    const [card] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${groups!.id} order by round_no, seq_in_round limit 1`;
    // 11:00 on an empty court: the applied board runs 09:00–10:30, so nothing
    // physical is in the way and the ONLY thing wrong with the destination is
    // the stored rule. Warn-only, so the move is accepted — and the config it
    // was judged against is the only thing that can show the rule was in force.
    await moveFixture(auth, card!.id, { scheduled_at: at(120), court_label: "Court 2" });
    expectRuleReachedTheVerifier("moveFixture");

    // The drag path's own conflict list is computed and then discarded
    // (`moveFixture` returns void), so the badge an organiser sees after a drop
    // comes from the report above. That is why surface 3 carries the assertion
    // on the moved card rather than surface 4.
    const afterMove = await validateSchedule(auth, division.id);
    expect(
      afterMove.conflicts.filter((c) => c.code === "warn.instruction" && c.fixture_id === card!.id),
    ).toHaveLength(1);
  });

  // Guard the guard: with no durable rule stored, none of the four surfaces may
  // invent one. Without this, an adapter that reported "instruction"
  // unconditionally would satisfy every assertion above.
  it("reports nothing when the organiser stored no rule", async () => {
    const auth = await seedProOrg();
    const competition = await createCompetition(auth, {
      name: "No Rules",
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
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [groups] = await createStages(auth, division.id, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 1 } } },
    ]);
    await putScheduleSettings(auth, division.id, {
      config: {
        startAt: T0,
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["Court 1", "Court 2"],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
        // A constraints object that is PRESENT and carries no `hard`. Omitting
        // `constraints` entirely would make the assertion at the end of this
        // test vacuous — `constraints?.hard` is undefined because `constraints`
        // itself is, which says nothing about whether `hard` is defaulted.
        constraints: {
          noBackToBack: false,
          startWindows: [],
          fieldFairness: "off",
          parallelism: "mixed",
          crossPersonClash: "warn",
        },
      },
      tz: "UTC",
    });
    await generateStageFixtures(auth, groups!.id);

    const proposal = await autoSchedule(auth, groups!.id, false);
    expect(proposal.conflicts.filter((c) => c.code === "warn.instruction")).toHaveLength(0);
    await applySchedule(auth, groups!.id, {
      assignments: proposal.assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      })),
      source: "auto",
    });
    const report = await validateSchedule(auth, division.id);
    expect(report.conflicts.filter((c) => c.code === "warn.instruction")).toHaveLength(0);
    // And the key stays ABSENT rather than defaulted to [] — the schema is
    // explicit that `hard` is `.optional()`, never `.default([])`. Asserted with
    // `in` on a constraints object we know is present, so the check cannot be
    // satisfied by `constraints` being undefined.
    const settings = await getScheduleSettings(auth, division.id);
    expect(settings.config.constraints).toBeDefined();
    expect("hard" in settings.config.constraints!).toBe(false);
  });
});
