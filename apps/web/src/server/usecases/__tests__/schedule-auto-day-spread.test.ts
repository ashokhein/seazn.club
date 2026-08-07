// The production bug this pins: a 3-day window, 2 courts, 15 fixtures — the
// solver's own objective minimizes makespan (build.ts T1), so with no day cap
// it piles every fixture onto day one (day one alone has capacity for all 15)
// and never touches day two or three. `withDefaultDaySpread` (schedule.ts)
// injects a `max_fixtures_per_day` hard rule sized to the window whenever the
// organiser set none of their own, so the auto pass spreads by default.
//
// Sized deliberately to fit under the R22 size gate (`canSolveWithin`) and
// actually reach z3, not just the greedy fallback: this is the path the
// production board (37 fixtures / 5 courts, ~77k fixture-slots) does NOT
// take — that board is still too large for the gate even at the 20s wall and
// falls back to greedy, which separately honors `max_fixtures_per_day` at
// placement time (`slotFixtures` in calendar.ts) — so the same default helps
// there too, just via a different code path this test does not exercise.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { sql } = await import("@/lib/db");
const { resetZ3 } = await import("@seazn/engine/scheduling");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings } = await import("../schedule");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

// Three daily 9-hour session windows (matches the real report's "Play hours
// (daily) 10:36-19:36" shape) — this is what actually bounds the lattice;
// startAt/endAt below just have to contain them.
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03"];
const SESSION_WINDOWS = DAYS.map((d) => ({ from: `${d}T10:00:00.000Z`, to: `${d}T19:00:00.000Z` }));

async function seedStage(entrantCount: number): Promise<{ auth: AuthCtx; stageId: string; fixtureCount: number }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Spread " + suffix}, ${"spread-" + suffix})
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
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Spread " + suffix,
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
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
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
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: SESSION_WINDOWS[0]!.from,
      endAt: SESSION_WINDOWS.at(-1)!.to,
      matchMinutes: 30,
      gapMinutes: 10,
      courts: ["C1", "C2"],
      perEntrantMinRest: 10,
      blackouts: [],
      sessionWindows: SESSION_WINDOWS,
    },
    tz: "UTC",
  });
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id, fixtureCount: fixtures.length };
}

afterAll(async () => {
  if (!HAS_DB) return;
  await resetZ3();
  await sql.end({ timeout: 5 });
});

beforeEach(() => undefined);

describe.skipIf(!HAS_DB)("autoSchedule default day spread", () => {
  it(
    "spreads a board that fits on day one across every available day instead of piling onto it",
    async () => {
      // 5 entrants round-robin to 10 fixtures; day one alone (2 courts × 9h ÷
      // 40min/slot ≈ 26 court-slots) has ample room for all of them, so a
      // makespan-only objective would place every fixture on day one absent a
      // cap. The default cap here (`ceil(10/3) = 4`) leaves slack (4×3=12 ≥
      // 10) rather than an exact knife-edge fit.
      //
      // Confirmed by A/B (temporarily bypassing `withDefaultDaySpread` at the
      // call site, not committed): THIS config already exhausts the full
      // `AUTO_SOLVER_WALL_MS` and falls back to greedy regardless of the day
      // cap (`elapsed_ms` ~20100 both ways, matching the reported bug's own
      // ~24.5s) — the wall spend is pre-existing here, not something this
      // change adds. Without the cap greedy placed all 10 on 2026-09-01
      // alone; with it, greedy (which independently honors
      // `max_fixtures_per_day` — `calendar.ts`'s `dayCapRulesFor`) spread them
      // 3/3/3 with one CAP-refused, which is why the assertions below tolerate
      // a day cap's own honest refusals rather than requiring every fixture
      // placed.
      const { auth, stageId, fixtureCount } = await seedStage(5);
      expect(fixtureCount).toBe(10);

      const out = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

      const perDay = new Map<string, number>();
      for (const a of out.assignments) {
        const day = a.scheduled_at.slice(0, 10);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }

      // THE REGRESSION. Without the default cap every placed fixture lands on
      // 2026-09-01 alone — exactly the shape of the reported bug (all
      // fixtures on the range's first day regardless of how wide the range
      // was configured).
      expect(out.assignments.length).toBeGreaterThan(0);
      expect(perDay.size).toBeGreaterThan(1);
      for (const [day, count] of perDay) {
        expect(DAYS).toContain(day);
        expect(count).toBeLessThanOrEqual(4); // the injected max_fixtures_per_day
      }
      // Every conflict, if any, is the day cap declining a slot honestly —
      // never a silent drop.
      for (const c of out.conflicts) expect(c.rule).toBe("CAP");
    },
    30_000,
  );
});
